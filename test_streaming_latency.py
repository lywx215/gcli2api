import asyncio
import json
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from fastapi.responses import StreamingResponse

import src.httpx_client as http_module
import src.storage_adapter as storage_module
import src.api.geminicli as geminicli_module
import src.google_oauth_api as oauth_module
import config
from src.api.utils import handle_error_with_retry
from src.credential_manager import CredentialManager, _CredentialManagerSingleton
from src.google_oauth_api import Credentials, TokenError
from src.hedge_stats import HedgeReservation
from src.httpx_client import HttpxClientManager, stream_post_async
from src.log_safety import credential_log_id, safe_exception
from src.router.stream_passthrough import build_streaming_response_or_error
from src.smart_429 import ModelCapacityGuard
from src.storage.sqlite_manager import SQLiteManager
from src.streaming_latency import (
    StreamFailure,
    StreamLatencyConfig,
    StreamRequestTrace,
    bind_stream_trace,
    reset_stream_trace,
)


@pytest.fixture(autouse=True)
def isolate_hedge_budget_storage(monkeypatch):
    """Keep stream unit tests independent from the developer's local database."""

    async def reserve(credential_name, model_name, daily_budget):
        del model_name
        if daily_budget <= 0:
            return None, "daily_budget_exhausted"
        return (
            HedgeReservation(
                "2099-01-01",
                credential_name,
                "test-family",
            ),
            None,
        )

    monkeypatch.setattr(geminicli_module.hedge_stats_service, "reserve", reserve)
    monkeypatch.setattr(
        geminicli_module.hedge_stats_service,
        "record_outcome",
        lambda *args, **kwargs: None,
    )


def test_diagnostics_are_disabled_by_default(monkeypatch):
    monkeypatch.delenv("STREAM_DIAGNOSTICS_ENABLED", raising=False)
    monkeypatch.setattr(config, "_stream_diagnostics_enabled_cache", False)
    assert StreamLatencyConfig.from_env().diagnostics_enabled is False

    messages = []
    monkeypatch.setattr("src.streaming_latency.log.info", messages.append)
    StreamRequestTrace(model="test").finish("error", force_log=True)
    assert messages == []


def test_http2_and_header_hedge_are_disabled_by_default(monkeypatch):
    monkeypatch.delenv("UPSTREAM_HTTP2_ENABLED", raising=False)
    monkeypatch.delenv("GEMINICLI_STREAM_HEADER_HEDGE_ENABLED", raising=False)
    monkeypatch.setattr(
        config, "_geminicli_stream_header_hedge_enabled_cache", False
    )
    value = StreamLatencyConfig.from_env()
    assert value.upstream_http2_enabled is False
    assert value.header_hedge_enabled is False


def test_diagnostics_can_be_enabled(monkeypatch):
    monkeypatch.setenv("STREAM_DIAGNOSTICS_ENABLED", "true")
    messages = []
    monkeypatch.setattr("src.streaming_latency.log.info", messages.append)
    StreamRequestTrace(model="test").finish("error", force_log=True)
    assert len(messages) == 1
    assert messages[0].startswith("STREAM_PERF_SUMMARY ")


@pytest.mark.asyncio
@pytest.mark.parametrize("enabled", [False, True])
async def test_server_timing_follows_diagnostics_switch(monkeypatch, enabled):
    monkeypatch.setenv("STREAM_DIAGNOSTICS_ENABLED", str(enabled).lower())

    async def one_chunk():
        yield b"data: ok\n\n"

    response = await build_streaming_response_or_error(
        one_chunk(), model="test", protocol="gemini"
    )
    assert bool(response.headers.get("server-timing")) is enabled
    assert response.headers.get("x-request-id")


@pytest.mark.asyncio
async def test_server_timing_includes_hedge_when_decided_before_response(monkeypatch):
    monkeypatch.setenv("STREAM_DIAGNOSTICS_ENABLED", "true")
    trace = StreamRequestTrace(model="test")
    trace.timings_ms["hedge"] = 15000.0

    async def one_chunk():
        yield b"data: ok\n\n"

    token = bind_stream_trace(trace)
    try:
        response = await build_streaming_response_or_error(
            one_chunk(), model="test", protocol="gemini"
        )
    finally:
        reset_stream_trace(token)

    assert "hedge;dur=15000.0" in response.headers["server-timing"]


@pytest.mark.asyncio
async def test_request_id_middleware_covers_nonstream_response():
    from web import ensure_request_id_header

    async def call_next(request):
        del request
        return geminicli_module.Response(content=b"ok", status_code=200)

    response = await ensure_request_id_header(object(), call_next)
    assert response.headers.get("x-request-id")


@pytest.mark.asyncio
async def test_first_content_timeout_returns_504(monkeypatch):
    monkeypatch.setenv("STREAM_LATENCY_GUARD_ENABLED", "true")
    monkeypatch.setenv("STREAM_FIRST_CONTENT_TIMEOUT", "0.01")

    async def delayed_stream():
        await asyncio.sleep(0.05)
        yield b"data: late\n\n"

    response = await build_streaming_response_or_error(
        delayed_stream(), model="test", protocol="openai"
    )
    assert response.status_code == 504
    assert response.headers.get("x-request-id")


@pytest.mark.asyncio
async def test_credential_acquire_timeout_is_typed(monkeypatch):
    monkeypatch.setenv("CREDENTIAL_ACQUIRE_TIMEOUT", "0.01")

    async def slow_credential(**kwargs):
        del kwargs
        await asyncio.sleep(0.05)
        return None

    monkeypatch.setattr(
        geminicli_module.credential_manager,
        "get_valid_credential",
        slow_credential,
        raising=False,
    )
    stream = geminicli_module.stream_request({"model": "gemini-test", "request": {}})
    with pytest.raises(StreamFailure) as caught:
        await stream.__anext__()
    assert caught.value.stage == "credential"
    assert caught.value.status_code == 504


@pytest.mark.asyncio
async def test_midstream_failure_emits_terminal_error_without_replay():
    calls = 0

    async def broken_stream():
        nonlocal calls
        calls += 1
        yield b'data: {"choices":[{"delta":{"content":"once"}}]}\n\n'
        raise StreamFailure(
            "upstream disconnected",
            stage="stream_idle",
            status_code=504,
        )

    response = await build_streaming_response_or_error(
        broken_stream(), model="test", protocol="openai"
    )
    assert isinstance(response, StreamingResponse)
    chunks = [chunk async for chunk in response.body_iterator]
    payload = b"".join(chunks)
    assert calls == 1
    assert payload.count(b"once") == 1
    assert b"upstream_stream_error" in payload
    assert payload.endswith(b"data: [DONE]\n\n")


@pytest.mark.asyncio
async def test_anthropic_midstream_failure_uses_error_event_without_done():
    async def broken_stream():
        yield b"event: message_start\ndata: {}\n\n"
        raise StreamFailure("upstream disconnected", stage="streaming", status_code=502)

    response = await build_streaming_response_or_error(
        broken_stream(), model="test", protocol="anthropic"
    )
    payload = b"".join([chunk async for chunk in response.body_iterator])
    assert b"event: error\n" in payload
    assert b"upstream disconnected" in payload
    assert b"[DONE]" not in payload


@pytest.mark.asyncio
async def test_gemini_midstream_failure_uses_gemini_error_shape():
    async def broken_stream():
        yield b'data: {"candidates":[]}\n\n'
        raise StreamFailure("upstream timed out", stage="stream_idle", status_code=504)

    response = await build_streaming_response_or_error(
        broken_stream(), model="test", protocol="gemini"
    )
    payload = b"".join([chunk async for chunk in response.body_iterator])
    assert b'"status": "DEADLINE_EXCEEDED"' in payload
    assert b'"type": "upstream_stream_error"' not in payload
    assert payload.endswith(b"data: [DONE]\n\n")


class _SlowByteStream(httpx.AsyncByteStream):
    async def __aiter__(self):
        await asyncio.sleep(0.05)
        yield b"data: late\n\n"


@pytest.mark.asyncio
async def test_first_upstream_event_timeout_is_typed(monkeypatch):
    monkeypatch.setenv("UPSTREAM_FIRST_EVENT_TIMEOUT", "0.01")
    monkeypatch.setenv("UPSTREAM_RESPONSE_HEADER_TIMEOUT", "1")

    transport = httpx.MockTransport(lambda request: httpx.Response(200, stream=_SlowByteStream()))
    client = httpx.AsyncClient(transport=transport)

    @asynccontextmanager
    async def fake_streaming_client(**kwargs):
        del kwargs
        yield client

    monkeypatch.setattr(http_module.http_client, "get_streaming_client", fake_streaming_client)
    try:
        with pytest.raises(StreamFailure) as caught:
            async for _ in stream_post_async("https://upstream.test/stream", {}):
                pass
        assert caught.value.stage == "first_event"
        assert caught.value.status_code == 504
        assert caught.value.retryable is True
    finally:
        await client.aclose()


class _BlankThenLateByteStream(httpx.AsyncByteStream):
    async def __aiter__(self):
        for _ in range(10):
            await asyncio.sleep(0.005)
            yield b"\n"
        yield b"data: late\n\n"


@pytest.mark.asyncio
async def test_blank_lines_do_not_extend_first_event_deadline(monkeypatch):
    monkeypatch.setenv("UPSTREAM_FIRST_EVENT_TIMEOUT", "0.02")
    monkeypatch.setenv("UPSTREAM_RESPONSE_HEADER_TIMEOUT", "1")

    transport = httpx.MockTransport(
        lambda request: httpx.Response(200, stream=_BlankThenLateByteStream())
    )
    client = httpx.AsyncClient(transport=transport)

    @asynccontextmanager
    async def fake_streaming_client(**kwargs):
        del kwargs
        yield client

    monkeypatch.setattr(http_module.http_client, "get_streaming_client", fake_streaming_client)
    try:
        with pytest.raises(StreamFailure) as caught:
            async for _ in stream_post_async("https://upstream.test/stream", {}):
                pass
        assert caught.value.stage == "first_event"
        assert caught.value.status_code == 504
    finally:
        await client.aclose()


class _IdleAfterFirstByteStream(httpx.AsyncByteStream):
    async def __aiter__(self):
        yield b"data: first\n\n"
        await asyncio.sleep(0.05)
        yield b"data: late\n\n"


@pytest.mark.asyncio
async def test_adjacent_chunk_idle_timeout_is_typed(monkeypatch):
    monkeypatch.setenv("UPSTREAM_STREAM_IDLE_TIMEOUT", "0.01")
    monkeypatch.setenv("UPSTREAM_RESPONSE_HEADER_TIMEOUT", "1")

    transport = httpx.MockTransport(
        lambda request: httpx.Response(200, stream=_IdleAfterFirstByteStream())
    )
    client = httpx.AsyncClient(transport=transport)

    @asynccontextmanager
    async def fake_streaming_client(**kwargs):
        del kwargs
        yield client

    monkeypatch.setattr(http_module.http_client, "get_streaming_client", fake_streaming_client)
    chunks = []
    try:
        with pytest.raises(StreamFailure) as caught:
            async for chunk in stream_post_async("https://upstream.test/stream", {}):
                chunks.append(chunk)
        assert caught.value.stage == "stream_idle"
        assert caught.value.status_code == 504
        assert any(b"first" in chunk for chunk in chunks)
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_response_header_timeout_is_typed(monkeypatch):
    monkeypatch.setenv("UPSTREAM_RESPONSE_HEADER_TIMEOUT", "0.01")

    async def delayed_headers(request):
        del request
        await asyncio.sleep(0.05)
        return httpx.Response(200, content=b"data: ok\n\n")

    client = httpx.AsyncClient(transport=httpx.MockTransport(delayed_headers))

    @asynccontextmanager
    async def fake_streaming_client(**kwargs):
        del kwargs
        yield client

    monkeypatch.setattr(http_module.http_client, "get_streaming_client", fake_streaming_client)
    try:
        with pytest.raises(StreamFailure) as caught:
            async for _ in stream_post_async("https://upstream.test/stream", {}):
                pass
        assert caught.value.stage == "response_headers"
        assert caught.value.status_code == 504
    finally:
        await client.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("protocol", "expected"),
    [
        ("openai", "service_unavailable_error"),
        ("gemini", "UNAVAILABLE"),
        ("anthropic", "overloaded_error"),
    ],
)
async def test_precontent_http_error_uses_protocol_native_shape(protocol, expected):
    async def failed_stream():
        raise StreamFailure(
            "upstream busy",
            stage="upstream_status",
            status_code=503,
            body=b'{"error":{"code":503,"message":"busy","status":"UNAVAILABLE"}}',
        )
        yield b"unreachable"

    response = await build_streaming_response_or_error(
        failed_stream(), model="test", protocol=protocol
    )
    payload = json.loads(response.body)
    assert response.status_code == 503
    assert response.headers.get("x-request-id")
    assert expected in json.dumps(payload)


@pytest.mark.asyncio
async def test_typed_http_error_closes_upstream_response(monkeypatch):
    seen = []

    def upstream_error(request):
        del request
        response = httpx.Response(503, json={"error": {"message": "busy"}})
        seen.append(response)
        return response

    client = httpx.AsyncClient(transport=httpx.MockTransport(upstream_error))

    @asynccontextmanager
    async def fake_streaming_client(**kwargs):
        del kwargs
        yield client

    monkeypatch.setattr(http_module.http_client, "get_streaming_client", fake_streaming_client)
    try:
        with pytest.raises(StreamFailure) as caught:
            async for _ in stream_post_async(
                "https://upstream.test/stream", {}, typed_errors=True
            ):
                pass
        assert caught.value.status_code == 503
        assert caught.value.stage == "upstream_status"
        assert seen[0].is_closed
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_shared_http_client_is_reused_and_closed(monkeypatch):
    for name in (
        "ALL_PROXY",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "NO_PROXY",
        "all_proxy",
        "https_proxy",
        "http_proxy",
        "no_proxy",
    ):
        monkeypatch.delenv(name, raising=False)

    async def no_proxy():
        return None

    monkeypatch.setattr(http_module, "get_proxy_config", no_proxy)
    manager = HttpxClientManager()
    async with manager.get_client() as first:
        async with manager.get_client() as second:
            assert first is second
            assert not first.is_closed
    await manager.close()
    assert first.is_closed


@pytest.mark.asyncio
async def test_direct_client_ignores_malformed_system_no_proxy(monkeypatch):
    """A host-injected IPv6 CIDR must not break application direct mode."""
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost,::1,::1/128")
    monkeypatch.setenv("no_proxy", "127.0.0.1,localhost,::1,::1/128")

    async def no_proxy():
        return None

    monkeypatch.setattr(http_module, "get_proxy_config", no_proxy)
    manager = HttpxClientManager()
    async with manager.get_client() as client:
        assert not client.is_closed
    await manager.close()
    assert client.is_closed


@pytest.mark.asyncio
async def test_proxy_change_drains_old_client_after_active_stream(monkeypatch):
    for name in (
        "ALL_PROXY",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "NO_PROXY",
        "all_proxy",
        "https_proxy",
        "http_proxy",
        "no_proxy",
    ):
        monkeypatch.delenv(name, raising=False)

    proxy = None

    async def current_proxy():
        return proxy

    monkeypatch.setattr(http_module, "get_proxy_config", current_proxy)
    manager = HttpxClientManager()
    async with manager.get_client() as old_client:
        proxy = "http://127.0.0.1:9"
        async with manager.get_client() as new_client:
            assert new_client is not old_client
            assert not old_client.is_closed
        assert not old_client.is_closed
    assert old_client.is_closed
    await manager.close()


@pytest.mark.asyncio
async def test_http2_change_creates_new_transport_generation(monkeypatch):
    async def no_proxy():
        return None

    monkeypatch.setattr(http_module, "get_proxy_config", no_proxy)
    monkeypatch.setenv("UPSTREAM_HTTP2_ENABLED", "false")
    manager = HttpxClientManager()
    async with manager.get_client() as http1_client:
        assert http1_client._transport._pool._http2 is False
        monkeypatch.setenv("UPSTREAM_HTTP2_ENABLED", "true")
        async with manager.get_client() as http2_client:
            assert http2_client is not http1_client
            assert http2_client._transport._pool._http2 is True
            assert http2_client._transport._pool._http1 is True
            assert not http1_client.is_closed
        assert not http1_client.is_closed
    assert http1_client.is_closed
    await manager.close()
    assert http2_client.is_closed


@pytest.mark.asyncio
async def test_attempt_trace_records_negotiated_http_version(monkeypatch):
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200,
            content=b"data: ok\n\n",
            extensions={"http_version": b"HTTP/2"},
        )
    )
    client = httpx.AsyncClient(transport=transport)

    @asynccontextmanager
    async def fake_streaming_client(**kwargs):
        del kwargs
        yield client

    monkeypatch.setattr(
        http_module.http_client, "get_streaming_client", fake_streaming_client
    )
    trace = StreamRequestTrace(model="test", diagnostics_enabled=True)
    attempt = trace.begin_attempt("one.json")
    token = bind_stream_trace(trace)
    try:
        chunks = [
            chunk
            async for chunk in stream_post_async(
                "https://upstream.test/stream", {}, attempt=attempt
            )
        ]
    finally:
        reset_stream_trace(token)
        await client.aclose()

    assert chunks == [b"data: ok", b""]
    assert trace.attempt_details[0]["http_version"] == "HTTP/2"


@pytest.mark.asyncio
async def test_oauth_refresh_singleflight_for_200_waiters(monkeypatch):
    manager = CredentialManager()
    manager._initialized = True
    manager._storage_adapter = object()
    calls = 0

    async def refresh(data, filename, mode="geminicli"):
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.01)
        return {**data, "token": "new-token", "filename": filename, "mode": mode}

    monkeypatch.setattr(manager, "_refresh_token", refresh)
    credential = {
        "token": "old-token",
        "refresh_token": "refresh-token",
        "expiry": (datetime.now(timezone.utc) + timedelta(seconds=30)).isoformat(),
    }
    results = await asyncio.gather(
        *(manager._wait_for_refresh(credential, "one.json", mode="geminicli") for _ in range(200))
    )
    assert calls == 1
    assert all(result and result["token"] == "new-token" for result in results)
    await manager.close()


@pytest.mark.parametrize(
    ("message", "status_code", "expected"),
    [
        ("invalid_grant", 400, True),
        ("unauthorized", 401, True),
        ("forbidden", 403, True),
        ("bad request", 400, False),
        ("server unavailable", 503, False),
        ("timed out", None, False),
    ],
)
def test_oauth_permanent_failure_is_strict(message, status_code, expected):
    manager = CredentialManager()
    assert manager._is_permanent_refresh_failure(message, status_code) is expected


@pytest.mark.asyncio
async def test_oauth_invalid_grant_body_is_preserved(monkeypatch):
    async def invalid_grant(*args, **kwargs):
        del args, kwargs
        request = httpx.Request("POST", "https://oauth.test/token")
        return httpx.Response(
            400,
            json={"error": "invalid_grant", "error_description": "expired"},
            request=request,
        )

    monkeypatch.setattr(oauth_module, "post_async", invalid_grant)
    credentials = Credentials("", refresh_token="refresh")
    with pytest.raises(TokenError) as caught:
        await credentials.refresh()
    assert caught.value.status_code == 400
    assert "invalid_grant" in str(caught.value)


@pytest.mark.asyncio
async def test_credential_singleton_never_publishes_partial_instance(monkeypatch):
    wrapper = _CredentialManagerSingleton()
    wrapper._instance = None
    initialized = asyncio.Event()
    calls = 0

    async def initialize(manager):
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.01)
        manager._storage_adapter = object()
        manager._initialized = True
        initialized.set()

    monkeypatch.setattr(CredentialManager, "initialize", initialize)
    managers = await asyncio.gather(*(wrapper._get_or_create() for _ in range(200)))
    assert initialized.is_set()
    assert calls == 1
    assert len({id(manager) for manager in managers}) == 1
    assert all(manager._initialized for manager in managers)


@pytest.mark.asyncio
async def test_storage_singleton_never_publishes_partial_adapter(monkeypatch):
    original = storage_module._storage_adapter
    storage_module._storage_adapter = None
    calls = 0

    async def initialize(adapter):
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.01)
        adapter._backend = object()
        adapter._initialized = True

    monkeypatch.setattr(storage_module.StorageAdapter, "initialize", initialize)
    try:
        adapters = await asyncio.gather(*(storage_module.get_storage_adapter() for _ in range(200)))
        assert calls == 1
        assert len({id(adapter) for adapter in adapters}) == 1
        assert all(adapter._initialized for adapter in adapters)
    finally:
        storage_module._storage_adapter = original


@pytest.mark.asyncio
async def test_retry_decision_does_not_sleep(monkeypatch):
    sleeps = 0

    async def fake_sleep(delay):
        nonlocal sleeps
        sleeps += 1

    async def no_auto_ban(status_code):
        return False

    monkeypatch.setattr("src.api.utils.asyncio.sleep", fake_sleep)
    monkeypatch.setattr("src.api.utils.check_should_auto_ban", no_auto_ban)
    assert await handle_error_with_retry(
        object(), 503, "one.json", True, 0, 1, 1.0, mode="geminicli"
    )
    assert sleeps == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("smart_enabled", [False, True])
async def test_status_retry_sleeps_exactly_once(monkeypatch, smart_enabled):
    sleeps = []
    refresh_calls = 0

    async def fake_sleep(delay):
        sleeps.append(delay)

    async def warmed_credential():
        return "two.json", {"token": "two", "project_id": "two"}

    async def refresh():
        nonlocal refresh_calls
        refresh_calls += 1
        return True

    monkeypatch.setattr(geminicli_module.asyncio, "sleep", fake_sleep)
    monkeypatch.setattr(
        geminicli_module,
        "is_smart_429_protection_enabled",
        lambda: smart_enabled,
    )
    task = asyncio.create_task(warmed_credential())
    switched, pending = await geminicli_module._switch_credential_for_retry(
        next_cred_task=task,
        retry_interval=1.25,
        refresh_credential_fast=refresh,
        apply_cred_result=lambda result: result[0] == "two.json",
        log_prefix="[TEST]",
    )
    assert switched is True
    assert pending is None
    assert refresh_calls == 0
    assert sleeps == [1.25]


@pytest.mark.asyncio
async def test_credential_exclusion_works_with_smart_429_disabled(tmp_path, monkeypatch):
    monkeypatch.setenv("CREDENTIALS_DIR", str(tmp_path))
    monkeypatch.setattr(config, "_smart_429_enabled_cache", False)
    manager = SQLiteManager()
    await manager.initialize()
    try:
        await manager.store_credential(
            "only.json",
            {
                "token": "token",
                "project_id": "project",
                "expiry": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
            },
        )
        selected = await manager.get_next_available_credential(
            mode="geminicli",
            model_name="gemini-2.5-flash",
            excluded_credentials={"only.json"},
        )
        assert selected is None
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_geminicli_transport_failure_switches_credential_once(monkeypatch):
    selected = []
    upstream_calls = 0

    async def get_credential(mode="geminicli", model_name=None, excluded_credentials=None):
        del mode, model_name
        excluded = set(excluded_credentials or ())
        name = "two.json" if "one.json" in excluded else "one.json"
        selected.append((name, excluded))
        return name, {"token": name, "project_id": name}

    async def endpoint():
        return "https://upstream.test"

    async def fake_stream_post_async(**kwargs):
        nonlocal upstream_calls
        del kwargs
        upstream_calls += 1
        if upstream_calls == 1:
            raise StreamFailure(
                "first event timeout",
                stage="first_event",
                status_code=504,
                retryable=True,
            )
        yield b'data: {"response":{"candidates":[]}}'

    async def no_record(*args, **kwargs):
        del args, kwargs

    monkeypatch.setenv("STREAM_TRANSPORT_MAX_ATTEMPTS", "2")
    monkeypatch.setenv("RETRY_429_ENABLED", "false")
    monkeypatch.setenv("RETRY_429_MAX_RETRIES", "0")
    monkeypatch.setattr(
        geminicli_module.credential_manager,
        "get_valid_credential",
        get_credential,
        raising=False,
    )
    monkeypatch.setattr(geminicli_module, "get_code_assist_endpoint", endpoint)
    monkeypatch.setattr(geminicli_module, "stream_post_async", fake_stream_post_async)
    monkeypatch.setattr(geminicli_module, "record_api_call_success", no_record)

    chunks = [
        chunk
        async for chunk in geminicli_module.stream_request({"model": "gemini-test", "request": {}})
    ]
    assert chunks == [b'data: {"response":{"candidates":[]}}']
    assert upstream_calls == 2
    assert selected[0][0] == "one.json"
    assert selected[1] == ("two.json", {"one.json"})


@pytest.mark.asyncio
async def test_geminicli_does_not_retry_after_upstream_started(monkeypatch):
    upstream_calls = 0

    async def get_credential(**kwargs):
        del kwargs
        return "one.json", {"token": "token", "project_id": "project"}

    async def endpoint():
        return "https://upstream.test"

    async def broken_stream(**kwargs):
        nonlocal upstream_calls
        del kwargs
        upstream_calls += 1
        yield b'data: {"response":{"candidates":[{"content":{}}]}}'
        raise StreamFailure(
            "idle timeout",
            stage="stream_idle",
            status_code=504,
            retryable=True,
        )

    async def no_record(*args, **kwargs):
        del args, kwargs

    monkeypatch.setattr(
        geminicli_module.credential_manager,
        "get_valid_credential",
        get_credential,
        raising=False,
    )
    monkeypatch.setattr(geminicli_module, "get_code_assist_endpoint", endpoint)
    monkeypatch.setattr(geminicli_module, "stream_post_async", broken_stream)
    monkeypatch.setattr(geminicli_module, "record_api_call_success", no_record)

    stream = geminicli_module.stream_request({"model": "gemini-test", "request": {}})
    first = await stream.__anext__()
    assert b"candidates" in first
    with pytest.raises(StreamFailure) as caught:
        await stream.__anext__()
    assert caught.value.retryable is False
    assert upstream_calls == 1


@pytest.mark.asyncio
async def test_header_hedge_backup_wins_and_primary_is_closed_before_delivery(
    monkeypatch,
):
    calls = []
    closed = []

    async def get_credential(**kwargs):
        assert kwargs["excluded_credentials"] == {"primary.json"}
        return "backup.json", {"token": "backup", "project_id": "backup"}

    async def fake_stream_post_async(**kwargs):
        project = kwargs["body"]["project"]
        calls.append(project)
        try:
            if project == "primary":
                await asyncio.sleep(0.05)
                yield b"data: primary\n\n"
            else:
                await asyncio.sleep(0.002)
                yield b"data: backup\n\n"
                yield b"data: backup-done\n\n"
        finally:
            closed.append(project)

    monkeypatch.setattr(
        geminicli_module.credential_manager,
        "get_valid_credential",
        get_credential,
        raising=False,
    )
    monkeypatch.setattr(geminicli_module, "stream_post_async", fake_stream_post_async)
    trace = StreamRequestTrace(model="gemini-test")
    trace.hedge["enabled"] = True
    primary_attempt = trace.begin_attempt("primary.json")
    config_value = StreamLatencyConfig(
        header_hedge_enabled=True,
        header_hedge_delay=0.005,
        header_hedge_max_inflight=20,
        header_hedge_sample_rate=1.0,
    )

    stream = geminicli_module._hedged_stream_post_async(
        url="https://upstream.test",
        body={"project": "primary"},
        native=False,
        headers={"Authorization": "Bearer primary"},
        model_name="gemini-test",
        primary_file="primary.json",
        primary_credential={"token": "primary", "project_id": "primary"},
        primary_attempt=primary_attempt,
        excluded_credentials=set(),
        trace=trace,
        config=config_value,
    )
    selection = await stream.__anext__()
    assert isinstance(selection, geminicli_module._HedgeSelection)
    assert selection.filename == "backup.json"
    assert "primary" in closed
    chunks = [chunk async for chunk in stream]

    assert calls == ["primary", "backup"]
    assert chunks == [b"data: backup\n\n", b"data: backup-done\n\n"]
    assert trace.retries["hedge"] == 1
    assert trace.hedge["winner_attempt"] == 2
    assert trace.hedge["loser_outcome"] == "superseded"
    assert trace.attempt_details[0]["outcome"] == "superseded"


@pytest.mark.asyncio
async def test_header_hedge_primary_can_win_after_backup_launch(monkeypatch):
    closed = []

    async def get_credential(**kwargs):
        del kwargs
        return "backup.json", {"token": "backup", "project_id": "backup"}

    async def fake_stream_post_async(**kwargs):
        project = kwargs["body"]["project"]
        try:
            await asyncio.sleep(0.015 if project == "primary" else 0.04)
            yield f"data: {project}\n\n".encode()
        finally:
            closed.append(project)

    monkeypatch.setattr(
        geminicli_module.credential_manager,
        "get_valid_credential",
        get_credential,
        raising=False,
    )
    monkeypatch.setattr(geminicli_module, "stream_post_async", fake_stream_post_async)
    trace = StreamRequestTrace(model="gemini-test")
    trace.hedge["enabled"] = True
    primary_attempt = trace.begin_attempt("primary.json")

    items = [
        item
        async for item in geminicli_module._hedged_stream_post_async(
            url="https://upstream.test",
            body={"project": "primary"},
            native=False,
            headers={},
            model_name="gemini-test",
            primary_file="primary.json",
            primary_credential={"token": "primary", "project_id": "primary"},
            primary_attempt=primary_attempt,
            excluded_credentials=set(),
            trace=trace,
            config=StreamLatencyConfig(
                header_hedge_enabled=True,
                header_hedge_delay=0.005,
                header_hedge_sample_rate=1.0,
            ),
        )
    ]

    assert items[0].filename == "primary.json"
    assert items[1] == b"data: primary\n\n"
    assert "backup" in closed
    assert trace.hedge["launched"] is True
    assert trace.hedge["winner_attempt"] == 1
    assert trace.hedge["loser_outcome"] == "superseded"


@pytest.mark.asyncio
async def test_header_hedge_is_not_launched_after_primary_headers(monkeypatch):
    calls = []

    async def get_credential(**kwargs):
        del kwargs
        return "backup.json", {"token": "backup", "project_id": "backup"}

    async def fake_stream_post_async(**kwargs):
        calls.append(kwargs["body"]["project"])
        kwargs["headers_received_event"].set()
        await asyncio.sleep(0.03)
        yield b"data: primary\n\n"

    monkeypatch.setattr(
        geminicli_module.credential_manager,
        "get_valid_credential",
        get_credential,
        raising=False,
    )
    monkeypatch.setattr(geminicli_module, "stream_post_async", fake_stream_post_async)
    trace = StreamRequestTrace(model="gemini-test")
    trace.hedge["enabled"] = True
    primary_attempt = trace.begin_attempt("primary.json")
    config_value = StreamLatencyConfig(
        header_hedge_enabled=True,
        header_hedge_delay=0.005,
        header_hedge_sample_rate=1.0,
    )

    items = [
        item
        async for item in geminicli_module._hedged_stream_post_async(
            url="https://upstream.test",
            body={"project": "primary"},
            native=False,
            headers={},
            model_name="gemini-test",
            primary_file="primary.json",
            primary_credential={"token": "primary", "project_id": "primary"},
            primary_attempt=primary_attempt,
            excluded_credentials=set(),
            trace=trace,
            config=config_value,
        )
    ]

    assert calls == ["primary"]
    assert items[1:] == [b"data: primary\n\n"]
    assert trace.hedge["launched"] is False
    assert trace.hedge["skipped_reason"] == "headers_received"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("sample_rate", "backup_available", "limited", "expected_reason"),
    [
        (0.0, True, False, "sampled_out"),
        (1.0, False, False, "no_backup_credential"),
        (1.0, True, True, "concurrency_limit"),
    ],
)
async def test_header_hedge_skip_paths_keep_single_upstream_call(
    monkeypatch, sample_rate, backup_available, limited, expected_reason
):
    calls = 0

    async def get_credential(**kwargs):
        del kwargs
        if not backup_available:
            return None
        return "backup.json", {"token": "backup", "project_id": "backup"}

    async def fake_stream_post_async(**kwargs):
        nonlocal calls
        del kwargs
        calls += 1
        await asyncio.sleep(0.01)
        yield b"data: primary\n\n"

    limiter = geminicli_module._HedgeLimiter()
    if limited:
        limiter._active = 1
    monkeypatch.setattr(geminicli_module, "_stream_header_hedge_limiter", limiter)
    monkeypatch.setattr(
        geminicli_module.credential_manager,
        "get_valid_credential",
        get_credential,
        raising=False,
    )
    monkeypatch.setattr(geminicli_module, "stream_post_async", fake_stream_post_async)
    trace = StreamRequestTrace(model="gemini-test")
    trace.hedge["enabled"] = True
    primary_attempt = trace.begin_attempt("primary.json")
    config_value = StreamLatencyConfig(
        header_hedge_enabled=True,
        header_hedge_delay=0.001,
        header_hedge_max_inflight=1,
        header_hedge_sample_rate=sample_rate,
    )

    items = [
        item
        async for item in geminicli_module._hedged_stream_post_async(
            url="https://upstream.test",
            body={"project": "primary"},
            native=False,
            headers={},
            model_name="gemini-test",
            primary_file="primary.json",
            primary_credential={"token": "primary", "project_id": "primary"},
            primary_attempt=primary_attempt,
            excluded_credentials=set(),
            trace=trace,
            config=config_value,
        )
    ]

    assert calls == 1
    assert items[-1] == b"data: primary\n\n"
    assert trace.hedge["launched"] is False
    assert trace.hedge["skipped_reason"] == expected_reason


@pytest.mark.asyncio
async def test_header_hedge_cancellation_reclaims_both_upstreams(monkeypatch):
    started = asyncio.Event()
    closed = []
    outcomes = []

    async def get_credential(**kwargs):
        del kwargs
        return "backup.json", {"token": "backup", "project_id": "backup"}

    async def fake_stream_post_async(**kwargs):
        project = kwargs["body"]["project"]
        if project == "backup":
            started.set()
        try:
            await asyncio.sleep(10)
            yield b"unreachable"
        finally:
            closed.append(project)

    limiter = geminicli_module._HedgeLimiter()
    monkeypatch.setattr(geminicli_module, "_stream_header_hedge_limiter", limiter)
    monkeypatch.setattr(
        geminicli_module.credential_manager,
        "get_valid_credential",
        get_credential,
        raising=False,
    )
    monkeypatch.setattr(geminicli_module, "stream_post_async", fake_stream_post_async)
    monkeypatch.setattr(
        geminicli_module.hedge_stats_service,
        "record_outcome",
        lambda reservation, outcome, **kwargs: outcomes.append(outcome),
    )
    trace = StreamRequestTrace(model="gemini-test")
    trace.hedge["enabled"] = True
    primary_attempt = trace.begin_attempt("primary.json")
    stream = geminicli_module._hedged_stream_post_async(
        url="https://upstream.test",
        body={"project": "primary"},
        native=False,
        headers={},
        model_name="gemini-test",
        primary_file="primary.json",
        primary_credential={"token": "primary", "project_id": "primary"},
        primary_attempt=primary_attempt,
        excluded_credentials=set(),
        trace=trace,
        config=StreamLatencyConfig(
            header_hedge_enabled=True,
            header_hedge_delay=0.01,
            header_hedge_max_inflight=1,
            header_hedge_sample_rate=1.0,
        ),
    )

    read_task = asyncio.create_task(stream.__anext__())
    await asyncio.wait_for(started.wait(), timeout=0.2)
    read_task.cancel()
    await asyncio.gather(read_task, return_exceptions=True)
    await stream.aclose()

    assert sorted(closed) == ["backup", "primary"]
    assert limiter._active == 0
    assert outcomes == ["client_cancelled"]


@pytest.mark.asyncio
async def test_header_hedge_daily_budget_zero_keeps_primary_only(monkeypatch):
    upstream_calls = []

    async def get_credential(**kwargs):
        del kwargs
        return "backup.json", {"token": "backup", "project_id": "backup"}

    async def fake_stream_post_async(**kwargs):
        upstream_calls.append(kwargs["body"]["project"])
        await asyncio.sleep(0.015)
        yield b"data: primary\n\n"

    monkeypatch.setattr(
        geminicli_module.credential_manager,
        "get_valid_credential",
        get_credential,
        raising=False,
    )
    monkeypatch.setattr(geminicli_module, "stream_post_async", fake_stream_post_async)
    trace = StreamRequestTrace(model="gemini-2.5-pro")
    primary_attempt = trace.begin_attempt("primary.json")
    stream = geminicli_module._hedged_stream_post_async(
        url="https://upstream.test",
        body={"project": "primary"},
        native=False,
        headers={},
        model_name="gemini-2.5-pro",
        primary_file="primary.json",
        primary_credential={"token": "primary", "project_id": "primary"},
        primary_attempt=primary_attempt,
        excluded_credentials=set(),
        trace=trace,
        config=StreamLatencyConfig(
            header_hedge_enabled=True,
            header_hedge_delay=0.001,
            header_hedge_max_inflight=1,
            header_hedge_sample_rate=1.0,
            header_hedge_daily_budget=0,
        ),
    )
    selection = await stream.__anext__()
    assert selection.launched is False
    assert await stream.__anext__() == b"data: primary\n\n"
    await stream.aclose()

    assert upstream_calls == ["primary"]
    assert trace.hedge["skipped_reason"] == "daily_budget_exhausted"


@pytest.mark.asyncio
async def test_header_hedge_records_backup_win_and_confirmed_rescue(monkeypatch):
    outcomes = []

    async def get_credential(**kwargs):
        del kwargs
        return "backup.json", {"token": "backup", "project_id": "backup"}

    async def fake_stream_post_async(**kwargs):
        project = kwargs["body"]["project"]
        if project == "primary":
            await asyncio.sleep(0.003)
            yield geminicli_module.Response(content=b"failed", status_code=503)
            return
        await asyncio.sleep(0.006)
        yield b"data: rescued\n\n"

    monkeypatch.setattr(
        geminicli_module.credential_manager,
        "get_valid_credential",
        get_credential,
        raising=False,
    )
    monkeypatch.setattr(geminicli_module, "stream_post_async", fake_stream_post_async)
    monkeypatch.setattr(
        geminicli_module.hedge_stats_service,
        "record_outcome",
        lambda reservation, outcome, **kwargs: outcomes.append(
            (reservation.credential_name, outcome, kwargs)
        ),
    )
    trace = StreamRequestTrace(model="gemini-2.5-pro")
    primary_attempt = trace.begin_attempt("primary.json")
    stream = geminicli_module._hedged_stream_post_async(
        url="https://upstream.test",
        body={"project": "primary"},
        native=False,
        headers={},
        model_name="gemini-2.5-pro",
        primary_file="primary.json",
        primary_credential={"token": "primary", "project_id": "primary"},
        primary_attempt=primary_attempt,
        excluded_credentials=set(),
        trace=trace,
        config=StreamLatencyConfig(
            header_hedge_enabled=True,
            header_hedge_delay=0.001,
            header_hedge_max_inflight=1,
            header_hedge_sample_rate=1.0,
        ),
    )
    selection = await stream.__anext__()
    assert selection.launched is True
    assert await stream.__anext__() == b"data: rescued\n\n"
    await stream.aclose()

    assert outcomes == [
        (
            "backup.json",
            "backup_wins",
            {"confirmed_rescue": True},
        )
    ]


@pytest.mark.asyncio
async def test_header_hedge_http_400_aborts_other_without_credential_penalty(
    monkeypatch,
):
    upstream_calls = 0
    recorded_errors = 0
    primary_closed = False

    async def get_credential(mode="geminicli", model_name=None, excluded_credentials=None):
        del mode, model_name
        excluded = set(excluded_credentials or ())
        name = "backup.json" if "primary.json" in excluded else "primary.json"
        return name, {"token": name, "project_id": name}

    async def endpoint():
        return "https://upstream.test"

    async def fake_stream(**kwargs):
        nonlocal upstream_calls, primary_closed
        upstream_calls += 1
        project = kwargs["body"]["project"]
        if project == "backup.json":
            await asyncio.sleep(0.002)
            yield geminicli_module.Response(
                content=b'{"error":{"message":"invalid request"}}',
                status_code=400,
            )
            return
        try:
            await asyncio.sleep(1)
            yield b"data: primary\n\n"
        finally:
            primary_closed = True

    async def retry_config():
        return {
            "max_retries": 5,
            "retry_interval": 0.001,
            "retry_enabled": True,
            "smart_429": False,
        }

    async def auto_ban_codes():
        return [400, 403]

    async def record_error(*args, **kwargs):
        nonlocal recorded_errors
        del args, kwargs
        recorded_errors += 1

    monkeypatch.setenv("GEMINICLI_STREAM_HEADER_HEDGE_ENABLED", "true")
    monkeypatch.setenv("GEMINICLI_STREAM_HEADER_HEDGE_DELAY", "0.01")
    monkeypatch.setenv("GEMINICLI_STREAM_HEADER_HEDGE_SAMPLE_RATE", "1")
    monkeypatch.setattr(
        geminicli_module.credential_manager,
        "get_valid_credential",
        get_credential,
        raising=False,
    )
    monkeypatch.setattr(geminicli_module, "get_code_assist_endpoint", endpoint)
    monkeypatch.setattr(geminicli_module, "stream_post_async", fake_stream)
    monkeypatch.setattr(geminicli_module, "get_retry_config", retry_config)
    monkeypatch.setattr(geminicli_module, "get_auto_ban_error_codes", auto_ban_codes)
    monkeypatch.setattr(geminicli_module, "record_api_call_error", record_error)

    stream = geminicli_module.stream_request(
        {"model": "gemini-test", "request": {}}
    )
    with pytest.raises(StreamFailure) as caught:
        await stream.__anext__()

    assert caught.value.status_code == 400
    assert upstream_calls == 2
    assert primary_closed is True
    assert recorded_errors == 0


@pytest.mark.asyncio
async def test_header_hedge_two_transport_failures_do_not_start_third_attempt(
    monkeypatch,
):
    upstream_calls = 0

    async def get_credential(mode="geminicli", model_name=None, excluded_credentials=None):
        del mode, model_name
        excluded = set(excluded_credentials or ())
        name = "backup.json" if "primary.json" in excluded else "primary.json"
        return name, {"token": name, "project_id": name}

    async def endpoint():
        return "https://upstream.test"

    async def failed_stream(**kwargs):
        nonlocal upstream_calls
        del kwargs
        upstream_calls += 1
        await asyncio.sleep(0.015)
        raise StreamFailure(
            "response header timeout",
            stage="response_headers",
            status_code=504,
            retryable=True,
        )
        yield b"unreachable"

    async def retry_config():
        return {
            "max_retries": 5,
            "retry_interval": 0.001,
            "retry_enabled": True,
            "smart_429": False,
        }

    async def auto_ban_codes():
        return [403]

    monkeypatch.setenv("GEMINICLI_STREAM_HEADER_HEDGE_ENABLED", "true")
    monkeypatch.setenv("GEMINICLI_STREAM_HEADER_HEDGE_DELAY", "0.01")
    monkeypatch.setenv("GEMINICLI_STREAM_HEADER_HEDGE_SAMPLE_RATE", "1")
    monkeypatch.setenv("STREAM_TRANSPORT_MAX_ATTEMPTS", "2")
    monkeypatch.setattr(
        geminicli_module.credential_manager,
        "get_valid_credential",
        get_credential,
        raising=False,
    )
    monkeypatch.setattr(geminicli_module, "get_code_assist_endpoint", endpoint)
    monkeypatch.setattr(geminicli_module, "stream_post_async", failed_stream)
    monkeypatch.setattr(geminicli_module, "get_retry_config", retry_config)
    monkeypatch.setattr(geminicli_module, "get_auto_ban_error_codes", auto_ban_codes)

    trace = StreamRequestTrace(model="gemini-test")
    token = bind_stream_trace(trace)
    try:
        stream = geminicli_module.stream_request(
            {"model": "gemini-test", "request": {}}
        )
        with pytest.raises(StreamFailure) as caught:
            await stream.__anext__()
    finally:
        reset_stream_trace(token)

    assert caught.value.status_code == 504
    assert upstream_calls == 2
    assert trace.attempts == 2
    assert trace.retries["hedge"] == 1
    assert trace.hedge["launched"] is True


@pytest.mark.asyncio
async def test_header_hedge_double_capacity_updates_model_guard_once(monkeypatch):
    capacity_body = json.dumps(
        {
            "error": {
                "code": 429,
                "status": "RESOURCE_EXHAUSTED",
                "details": [{"reason": "MODEL_CAPACITY_EXHAUSTED"}],
            }
        }
    ).encode()
    upstream_calls = 0
    guard_calls = 0
    recorded_errors = 0

    async def get_credential(mode="geminicli", model_name=None, excluded_credentials=None):
        del mode, model_name
        excluded = set(excluded_credentials or ())
        name = "backup.json" if "primary.json" in excluded else "primary.json"
        return name, {"token": name, "project_id": name}

    async def endpoint():
        return "https://upstream.test"

    async def capacity_stream(**kwargs):
        nonlocal upstream_calls
        upstream_calls += 1
        project = kwargs["body"]["project"]
        await asyncio.sleep(0.025 if project == "primary.json" else 0.01)
        yield geminicli_module.Response(content=capacity_body, status_code=429)

    async def retry_config():
        return {
            "max_retries": 5,
            "retry_interval": 0.001,
            "retry_enabled": True,
            "smart_429": False,
        }

    async def auto_ban_codes():
        return [403]

    async def record_error(*args, **kwargs):
        nonlocal recorded_errors
        del args, kwargs
        recorded_errors += 1

    def record_guard(*args, **kwargs):
        nonlocal guard_calls
        del args, kwargs
        guard_calls += 1
        return 5

    monkeypatch.setenv("GEMINICLI_STREAM_HEADER_HEDGE_ENABLED", "true")
    monkeypatch.setenv("GEMINICLI_STREAM_HEADER_HEDGE_DELAY", "0.01")
    monkeypatch.setenv("GEMINICLI_STREAM_HEADER_HEDGE_SAMPLE_RATE", "1")
    monkeypatch.setattr(config, "_geminicli_capacity_fast_fail_enabled_cache", True)
    monkeypatch.delenv("GEMINICLI_CAPACITY_FAST_FAIL_ENABLED", raising=False)
    geminicli_module.model_capacity_guard.reset()
    monkeypatch.setattr(
        geminicli_module.credential_manager,
        "get_valid_credential",
        get_credential,
        raising=False,
    )
    monkeypatch.setattr(geminicli_module, "get_code_assist_endpoint", endpoint)
    monkeypatch.setattr(geminicli_module, "stream_post_async", capacity_stream)
    monkeypatch.setattr(geminicli_module, "get_retry_config", retry_config)
    monkeypatch.setattr(geminicli_module, "get_auto_ban_error_codes", auto_ban_codes)
    monkeypatch.setattr(geminicli_module, "record_api_call_error", record_error)
    monkeypatch.setattr(
        geminicli_module, "is_smart_429_protection_enabled", lambda: False
    )
    monkeypatch.setattr(
        geminicli_module.model_capacity_guard, "record_failure", record_guard
    )

    stream = geminicli_module.stream_request(
        {"model": "gemini-test", "request": {}}
    )
    with pytest.raises(StreamFailure) as caught:
        await stream.__anext__()

    assert caught.value.status_code == 503
    assert caught.value.headers["retry-after"] == "5"
    assert upstream_calls == 2
    assert guard_calls == 1
    assert recorded_errors == 0


def test_trace_schema_v2_separates_retry_kinds_and_redacts_credential(monkeypatch):
    monkeypatch.setenv("STREAM_DIAGNOSTICS_ENABLED", "true")
    messages = []
    monkeypatch.setattr("src.streaming_latency.log.info", messages.append)
    trace = StreamRequestTrace(model="test", protocol="openai")
    trace.set_client_request_id("new-api:request-1")
    trace.begin_attempt("person@example.com.json")
    trace.record_failure(
        stage="connect",
        error_type="ConnectTimeout",
        status_code=504,
        retryable=True,
    )
    trace.record_retry("transport", "connect")
    trace.finish("error_connect", force_log=True)

    payload = json.loads(messages[0].split(" ", 1)[1])
    assert payload["schema_version"] == 2
    assert payload["client_request_id"] == "new-api:request-1"
    assert payload["retries"]["transport"] == 1
    assert payload["retries"]["status"] == 0
    assert payload["last_failure"]["error_type"] == "ConnectTimeout"
    assert "person@example.com.json" not in messages[0]
    assert payload["attempt_details"][0]["credential"]


def test_log_safety_redacts_tokens_email_and_proxy_auth():
    raw = (
        "access_token=secret person@example.com "
        "https://proxy-user:proxy-pass@proxy.example/path?api_key=key"
    )
    rendered = safe_exception(RuntimeError(raw))
    assert "secret" not in rendered
    assert "person@example.com" not in rendered
    assert "proxy-user" not in rendered
    assert "proxy-pass" not in rendered
    assert "api_key=key" not in rendered
    assert credential_log_id("/tmp/person@example.com.json") == credential_log_id(
        "person@example.com.json"
    )


@pytest.mark.asyncio
async def test_client_cancel_records_output_phase(monkeypatch):
    monkeypatch.setenv("STREAM_DIAGNOSTICS_ENABLED", "true")
    messages = []
    monkeypatch.setattr("src.streaming_latency.log.info", messages.append)

    async def stream():
        yield b"data: first\n\n"
        raise asyncio.CancelledError

    response = await build_streaming_response_or_error(
        stream(), model="test", protocol="openai"
    )
    iterator = response.body_iterator
    assert await iterator.__anext__() == b"data: first\n\n"
    with pytest.raises(asyncio.CancelledError):
        await iterator.__anext__()

    payload = json.loads(messages[-1].split(" ", 1)[1])
    assert payload["result"] == "client_cancelled"
    assert payload["stream"]["first_content_emitted"] is True
    assert payload["stream"]["events_out"] == 1
    assert payload["stream"]["bytes_out"] == len(b"data: first\n\n")
    assert payload["stream"]["cancel_phase"] == "after_first_content"


def test_capacity_guard_opens_and_allows_one_half_open_probe(monkeypatch):
    monkeypatch.setattr(
        config, "_geminicli_capacity_fast_fail_enabled_cache", True
    )
    monkeypatch.delenv("GEMINICLI_CAPACITY_FAST_FAIL_ENABLED", raising=False)
    guard = ModelCapacityGuard()
    assert guard.admission_retry_after("geminicli", "MODEL") == 0
    assert guard.record_failure("geminicli", "model") == 0
    assert guard.record_failure("geminicli", "MODEL") == 5
    assert guard.admission_retry_after("geminicli", "model") >= 1
    guard._open_until[("geminicli", "model")] = 0
    assert guard.admission_retry_after("geminicli", "model") == 0
    assert guard.admission_retry_after("geminicli", "model") == 1
    assert guard.record_failure("geminicli", "model") == 10
    guard.record_success("geminicli", "model")
    assert guard.admission_retry_after("geminicli", "model") == 0


@pytest.mark.parametrize(
    ("exc", "stage", "status"),
    [
        (httpx.PoolTimeout("pool"), "pool", 504),
        (httpx.ConnectTimeout("connect"), "connect", 504),
        (httpx.ConnectError("connect"), "connect", 502),
        (httpx.WriteTimeout("write"), "write", 504),
        (httpx.WriteError("write"), "write", 502),
        (httpx.ReadTimeout("read"), "response_headers", 504),
        (httpx.RemoteProtocolError("protocol"), "response_headers", 502),
    ],
)
def test_transport_failures_preserve_stage_and_exception_type(exc, stage, status):
    failure = http_module._transport_failure(exc, "response_headers")
    assert failure.stage == stage
    assert failure.status_code == status
    assert failure.error_type == type(exc).__name__


@pytest.mark.asyncio
@pytest.mark.parametrize("smart_enabled", [False, True])
async def test_capacity_fast_fail_limits_stream_to_two_upstream_calls(
    monkeypatch, smart_enabled
):
    capacity_body = json.dumps(
        {
            "error": {
                "code": 429,
                "status": "RESOURCE_EXHAUSTED",
                "details": [{"reason": "MODEL_CAPACITY_EXHAUSTED"}],
            }
        }
    ).encode()
    upstream_calls = 0
    recorded_errors = 0
    smart_capacity_records = 0
    sleeps = []

    async def get_credential(mode="geminicli", model_name=None, excluded_credentials=None):
        del mode, model_name
        excluded = set(excluded_credentials or ())
        name = "two.json" if "one.json" in excluded else "one.json"
        return name, {"token": name, "project_id": name}

    async def endpoint():
        return "https://upstream.test"

    async def failed_stream(**kwargs):
        nonlocal upstream_calls
        del kwargs
        upstream_calls += 1
        yield geminicli_module.Response(content=capacity_body, status_code=429)

    async def retry_config():
        return {
            "max_retries": 5,
            "retry_interval": 0.01,
            "retry_enabled": True,
            "smart_429": False,
        }

    async def auto_ban_codes():
        return [403]

    async def record_error(*args, **kwargs):
        nonlocal recorded_errors
        del args, kwargs
        recorded_errors += 1

    async def no_sleep(delay):
        sleeps.append(delay)

    async def apply_smart(*args, **kwargs):
        nonlocal smart_capacity_records
        del args, kwargs
        smart_capacity_records += 1
        return geminicli_module.Upstream429Kind.MODEL_CAPACITY_EXHAUSTED, None

    monkeypatch.setattr(config, "_geminicli_capacity_fast_fail_enabled_cache", True)
    monkeypatch.setattr(
        config, "_geminicli_stream_header_hedge_enabled_cache", False
    )
    monkeypatch.delenv("GEMINICLI_CAPACITY_FAST_FAIL_ENABLED", raising=False)
    monkeypatch.delenv("GEMINICLI_STREAM_HEADER_HEDGE_ENABLED", raising=False)
    geminicli_module.model_capacity_guard.reset()
    geminicli_module.smart_429_service._reset_runtime_guards()
    monkeypatch.setattr(
        geminicli_module.credential_manager,
        "get_valid_credential",
        get_credential,
        raising=False,
    )
    monkeypatch.setattr(geminicli_module, "get_code_assist_endpoint", endpoint)
    monkeypatch.setattr(geminicli_module, "stream_post_async", failed_stream)
    monkeypatch.setattr(geminicli_module, "get_retry_config", retry_config)
    monkeypatch.setattr(geminicli_module, "get_auto_ban_error_codes", auto_ban_codes)
    monkeypatch.setattr(geminicli_module, "record_api_call_error", record_error)
    monkeypatch.setattr(geminicli_module.asyncio, "sleep", no_sleep)
    monkeypatch.setattr(
        geminicli_module,
        "is_smart_429_protection_enabled",
        lambda: smart_enabled,
    )
    monkeypatch.setattr(geminicli_module, "_apply_smart_429_state", apply_smart)

    stream = geminicli_module.stream_request(
        {"model": "gemini-test", "request": {}}
    )
    with pytest.raises(StreamFailure) as caught:
        await stream.__anext__()
    assert caught.value.status_code == 503
    assert caught.value.headers["retry-after"] == "5"
    assert upstream_calls == 2
    assert recorded_errors == 0
    assert smart_capacity_records == 0
    assert len(sleeps) == 1


@pytest.mark.asyncio
async def test_capacity_fast_fail_limits_nonstream_to_two_upstream_calls(monkeypatch):
    capacity_payload = {
        "error": {
            "code": 429,
            "status": "RESOURCE_EXHAUSTED",
            "details": [{"reason": "MODEL_CAPACITY_EXHAUSTED"}],
        }
    }
    upstream_calls = 0
    recorded_errors = 0

    async def get_credential(mode="geminicli", model_name=None, excluded_credentials=None):
        del mode, model_name
        excluded = set(excluded_credentials or ())
        name = "two.json" if "one.json" in excluded else "one.json"
        return name, {"token": name, "project_id": name}

    async def endpoint():
        return "https://upstream.test"

    async def failed_post(**kwargs):
        nonlocal upstream_calls
        del kwargs
        upstream_calls += 1
        return httpx.Response(
            429,
            json=capacity_payload,
            request=httpx.Request("POST", "https://upstream.test"),
        )

    async def retry_config():
        return {
            "max_retries": 5,
            "retry_interval": 0.01,
            "retry_enabled": True,
            "smart_429": False,
        }

    async def auto_ban_codes():
        return [403]

    async def record_error(*args, **kwargs):
        nonlocal recorded_errors
        del args, kwargs
        recorded_errors += 1

    async def no_sleep(delay):
        del delay

    monkeypatch.setattr(config, "_geminicli_capacity_fast_fail_enabled_cache", True)
    monkeypatch.delenv("GEMINICLI_CAPACITY_FAST_FAIL_ENABLED", raising=False)
    geminicli_module.model_capacity_guard.reset()
    monkeypatch.setattr(
        geminicli_module.credential_manager,
        "get_valid_credential",
        get_credential,
        raising=False,
    )
    monkeypatch.setattr(geminicli_module, "get_code_assist_endpoint", endpoint)
    monkeypatch.setattr(geminicli_module, "post_async", failed_post)
    monkeypatch.setattr(geminicli_module, "get_retry_config", retry_config)
    monkeypatch.setattr(geminicli_module, "get_auto_ban_error_codes", auto_ban_codes)
    monkeypatch.setattr(geminicli_module, "record_api_call_error", record_error)
    monkeypatch.setattr(geminicli_module.asyncio, "sleep", no_sleep)
    monkeypatch.setattr(
        geminicli_module, "is_smart_429_protection_enabled", lambda: False
    )

    response = await geminicli_module.non_stream_request(
        {"model": "gemini-test", "request": {}}
    )
    assert response.status_code == 503
    assert response.headers["retry-after"] == "5"
    assert upstream_calls == 2
    assert recorded_errors == 0


@pytest.mark.asyncio
async def test_capacity_fast_fail_disabled_preserves_legacy_retry_count(monkeypatch):
    upstream_calls = 0
    recorded_errors = 0
    payload = {
        "error": {
            "code": 429,
            "status": "RESOURCE_EXHAUSTED",
            "details": [{"reason": "MODEL_CAPACITY_EXHAUSTED"}],
        }
    }

    async def get_credential(**kwargs):
        excluded = set(kwargs.get("excluded_credentials") or ())
        name = f"{len(excluded) + 1}.json"
        return name, {"token": name, "project_id": name}

    async def endpoint():
        return "https://upstream.test"

    async def failed_post(**kwargs):
        nonlocal upstream_calls
        del kwargs
        upstream_calls += 1
        return httpx.Response(
            429,
            json=payload,
            request=httpx.Request("POST", "https://upstream.test"),
        )

    async def retry_config():
        return {
            "max_retries": 2,
            "retry_interval": 0.01,
            "retry_enabled": True,
            "smart_429": False,
        }

    async def record_error(*args, **kwargs):
        nonlocal recorded_errors
        del args, kwargs
        recorded_errors += 1

    async def auto_ban_codes():
        return [403]

    async def yes_retry(*args, **kwargs):
        del args, kwargs
        return True

    async def no_sleep(delay):
        del delay

    monkeypatch.setattr(config, "_geminicli_capacity_fast_fail_enabled_cache", False)
    monkeypatch.delenv("GEMINICLI_CAPACITY_FAST_FAIL_ENABLED", raising=False)
    monkeypatch.setattr(
        geminicli_module.credential_manager,
        "get_valid_credential",
        get_credential,
        raising=False,
    )
    monkeypatch.setattr(geminicli_module, "get_code_assist_endpoint", endpoint)
    monkeypatch.setattr(geminicli_module, "post_async", failed_post)
    monkeypatch.setattr(geminicli_module, "get_retry_config", retry_config)
    monkeypatch.setattr(geminicli_module, "get_auto_ban_error_codes", auto_ban_codes)
    monkeypatch.setattr(geminicli_module, "record_api_call_error", record_error)
    monkeypatch.setattr(geminicli_module, "handle_error_with_retry", yes_retry)
    monkeypatch.setattr(geminicli_module.asyncio, "sleep", no_sleep)
    monkeypatch.setattr(
        geminicli_module, "is_smart_429_protection_enabled", lambda: False
    )

    response = await geminicli_module.non_stream_request(
        {"model": "gemini-test", "request": {}}
    )
    assert response.status_code == 503
    assert upstream_calls == 3
    assert recorded_errors == 3
