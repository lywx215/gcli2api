import asyncio
import json
from contextlib import asynccontextmanager

import httpx
import pytest
from fastapi import HTTPException

import config
from src.api import geminicli as geminicli_module
from src import httpx_client as http_module
from src.models import ConfigSaveRequest
from src.panel import config_routes
from src.panel.utils import get_env_locked_keys
from src.smart_429 import smart_429_service
from src.streaming_latency import StreamFailure, StreamLatencyConfig, StreamRequestTrace
from src.router.stream_passthrough import build_streaming_response_or_error


def _clear_stream_env(monkeypatch):
    for spec in config.STREAM_LATENCY_CONFIG_SPECS.values():
        monkeypatch.delenv(spec["env"], raising=False)


def test_stream_runtime_defaults_and_environment_override(monkeypatch):
    _clear_stream_env(monkeypatch)
    monkeypatch.setattr(config, "_stream_latency_runtime_cache", {})

    defaults = StreamLatencyConfig.from_env()
    assert defaults.response_header_timeout == 30
    assert defaults.guard_enabled is True
    assert defaults.transport_max_attempts == 2
    assert defaults.upstream_http2_enabled is False

    monkeypatch.setenv("UPSTREAM_RESPONSE_HEADER_TIMEOUT", "45")
    monkeypatch.setenv("STREAM_LATENCY_GUARD_ENABLED", "false")
    overridden = StreamLatencyConfig.from_env()
    assert overridden.response_header_timeout == 45
    assert overridden.guard_enabled is False
    assert "upstream_response_header_timeout" in get_env_locked_keys()
    assert "stream_latency_guard_enabled" in get_env_locked_keys()


def test_stream_request_trace_keeps_runtime_snapshot(monkeypatch):
    _clear_stream_env(monkeypatch)
    monkeypatch.setattr(
        config,
        "_stream_latency_runtime_cache",
        {"upstream_response_header_timeout": 30.0},
    )
    trace = StreamRequestTrace(model="snapshot")
    config._stream_latency_runtime_cache["upstream_response_header_timeout"] = 60.0

    assert trace.config_snapshot.response_header_timeout == 30.0
    assert StreamRequestTrace(model="new").config_snapshot.response_header_timeout == 60.0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("key", "invalid"),
    [
        ("stream_latency_guard_enabled", "false"),
        ("upstream_response_header_timeout", True),
        ("upstream_response_header_timeout", float("nan")),
        ("upstream_response_header_timeout", 0),
        ("stream_transport_max_attempts", 1.5),
        ("geminicli_stream_header_hedge_max_inflight", 101),
    ],
)
async def test_panel_rejects_invalid_stream_runtime_values(
    monkeypatch, key, invalid
):
    _clear_stream_env(monkeypatch)
    with pytest.raises(HTTPException) as caught:
        await config_routes.save_config(
            ConfigSaveRequest(config={key: invalid}), token="test"
        )
    assert caught.value.status_code == 400


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "payload",
    [
        {
            "geminicli_stream_header_hedge_delay": 30,
            "upstream_response_header_timeout": 30,
        },
        {
            "upstream_response_header_timeout": 80,
            "stream_first_content_timeout": 75,
        },
        {
            "upstream_first_event_timeout": 80,
            "stream_first_content_timeout": 75,
        },
    ],
)
async def test_panel_rejects_invalid_stream_runtime_relationships(
    monkeypatch, payload
):
    _clear_stream_env(monkeypatch)
    with pytest.raises(HTTPException) as caught:
        await config_routes.save_config(
            ConfigSaveRequest(config=payload), token="test"
        )
    assert caught.value.status_code == 400


@pytest.mark.asyncio
@pytest.mark.parametrize("workers", ["1", "2"])
async def test_panel_reports_hot_and_restart_stream_settings(monkeypatch, workers):
    _clear_stream_env(monkeypatch)
    stored = {}
    reload_calls = []

    class Adapter:
        async def set_config(self, key, value):
            stored[key] = value

    async def get_adapter():
        return Adapter()

    async def reload_config(**kwargs):
        reload_calls.append(kwargs)

    async def password():
        return "pwd"

    async def reconfigure():
        return None

    monkeypatch.setenv("WORKERS", workers)
    monkeypatch.setattr(config_routes, "get_storage_adapter", get_adapter)
    monkeypatch.setattr(config_routes.config, "reload_config", reload_config)
    monkeypatch.setattr(config_routes.config, "get_api_password", password)
    monkeypatch.setattr(config_routes.config, "get_panel_password", password)
    monkeypatch.setattr(config_routes.config, "get_server_password", password)
    monkeypatch.setattr(smart_429_service, "reconfigure", reconfigure)

    response = await config_routes.save_config(
        ConfigSaveRequest(
            config={
                "upstream_response_header_timeout": 40,
                "upstream_http2_enabled": True,
            }
        ),
        token="test",
    )
    payload = json.loads(response.body)

    assert stored == {
        "upstream_response_header_timeout": 40.0,
        "upstream_http2_enabled": True,
    }
    assert "upstream_http2_enabled" in payload["restart_required"]
    if workers == "1":
        assert "upstream_response_header_timeout" in payload["hot_updated"]
        assert "upstream_response_header_timeout" not in payload["restart_required"]
    else:
        assert payload["hot_updated"] == []
        assert "upstream_response_header_timeout" in payload["restart_required"]
    assert reload_calls[0]["reload_stream_latency"] is (workers == "1")
    assert reload_calls[0]["reload_http_transport"] is False


@pytest.mark.asyncio
async def test_guard_off_disables_hedge_and_transport_credential_switch(monkeypatch):
    _clear_stream_env(monkeypatch)
    monkeypatch.setenv("STREAM_LATENCY_GUARD_ENABLED", "false")
    monkeypatch.setenv("GEMINICLI_STREAM_HEADER_HEDGE_ENABLED", "true")
    monkeypatch.setenv("STREAM_TRANSPORT_MAX_ATTEMPTS", "2")
    upstream_calls = 0
    credential_calls = 0

    async def get_credential(**kwargs):
        nonlocal credential_calls
        del kwargs
        credential_calls += 1
        name = "primary.json" if credential_calls == 1 else "backup.json"
        return name, {"token": name, "project_id": name}

    async def endpoint():
        return "https://upstream.test"

    async def failed_stream(**kwargs):
        nonlocal upstream_calls
        del kwargs
        upstream_calls += 1
        raise StreamFailure(
            "headers failed",
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

    runtime = StreamLatencyConfig.from_env()
    assert runtime.guard_enabled is False
    assert runtime.header_hedge_enabled is False
    stream = geminicli_module.stream_request(
        {"model": "gemini-test", "request": {}}
    )
    with pytest.raises(StreamFailure):
        await stream.__anext__()
    assert upstream_calls == 1
    assert credential_calls == 1


@pytest.mark.asyncio
async def test_guard_off_disables_first_content_budget(monkeypatch):
    _clear_stream_env(monkeypatch)
    monkeypatch.setenv("STREAM_LATENCY_GUARD_ENABLED", "false")
    monkeypatch.setenv("STREAM_FIRST_CONTENT_TIMEOUT", "0.01")

    async def delayed_stream():
        await asyncio.sleep(0.03)
        yield b"data: first\n\n"
        await asyncio.sleep(0.03)
        yield b"data: second\n\n"

    response = await build_streaming_response_or_error(
        delayed_stream(), model="guard-off", protocol="gemini"
    )
    chunks = [chunk async for chunk in response.body_iterator]
    assert response.status_code == 200
    assert chunks == [b"data: first\n\n", b"data: second\n\n"]


@pytest.mark.asyncio
async def test_guard_off_keeps_response_header_hard_timeout(monkeypatch):
    _clear_stream_env(monkeypatch)
    monkeypatch.setenv("STREAM_LATENCY_GUARD_ENABLED", "false")
    monkeypatch.setenv("UPSTREAM_RESPONSE_HEADER_TIMEOUT", "0.01")

    async def delayed_headers(request):
        del request
        await asyncio.sleep(0.05)
        return httpx.Response(200, content=b"data: late\n\n")

    client = httpx.AsyncClient(transport=httpx.MockTransport(delayed_headers))

    @asynccontextmanager
    async def fake_streaming_client(**kwargs):
        del kwargs
        yield client

    monkeypatch.setattr(
        http_module.http_client, "get_streaming_client", fake_streaming_client
    )
    try:
        with pytest.raises(StreamFailure) as caught:
            async with http_module.open_stream_post(
                "https://upstream.test", {"request": {}}
            ):
                pass
    finally:
        await client.aclose()
    assert caught.value.stage == "response_headers"
    assert caught.value.status_code == 504
