"""Antigravity model migration contracts; synthetic requests, no credentials or network."""
import copy
import json
from unittest.mock import AsyncMock, Mock

import httpx
import pytest
from fastapi import FastAPI, Response

from src import antigravity_models as models
from src.api import antigravity as api
from src.models import ClaudeRequest, GeminiRequest, OpenAIChatCompletionRequest
from src.router.antigravity import anthropic, gemini, openai
from src.router.model_api_errors import ModelApiErrorException

PREFIXES = ("", "假流式/", "抗截断/", "流式抗截断/")
MIGRATIONS = [(f"gemini-{version}-flash{suffix}", f"gemini-3.8-flash-{level}")
              for version in ("3.6", "3.7")
              for suffix, level in (("", "medium"), ("-high", "high"),
                                    ("-medium", "medium"), ("-low", "low"))]
MIGRATIONS += [("gemini-3.5-flash", "gemini-3.8-flash-medium")]
RETIRED = ("gemini-3.1-pro", "gemini-3.1-pro-high", "gemini-3.1-pro-low", "gemini-pro-agent")
UNCHANGED = ("gemini-3.5-flash-high", "gemini-3.5-flash-medium", "gemini-3.5-flash-low",
             "gemini-3.5-flash-extra-low", "gemini-3.5-flash-lite", "gemini-3.1-flash-image",
             "gemini-3.6-flash-tiered", "gemini-3.7-flash-tiered", "gemini-3.8-flash-tiered",
             "gemini-3.6-flash-unknown", "gemini-3.1-pro-agent-extra")


@pytest.fixture(autouse=True)
def isolate(monkeypatch):
    monkeypatch.setattr("config._config_initialized", True)
    monkeypatch.setattr("config._config_cache", {})
    from src.model_routing.compiler import compile_channel, parse_route_table
    from src.model_routing.policy import build_policy_snapshot
    policy = build_policy_snapshot()
    compiled = {channel: compile_channel(channel, parse_route_table({"routes": []}), policy)
                for channel in ("geminicli", "antigravity")}
    async def routes(channel, snapshot):
        assert snapshot.digest == policy.digest
        return compiled[channel]
    monkeypatch.setattr("src.model_routing.store.load_channel_routes", routes)
    for getter, value in (("get_compatibility_mode_enabled", False),
                          ("get_antigravity_stream2nostream", False),
                          ("get_antigravity_flash_non_stream_mode", "inherit"),
                          ("get_antigravity_native_timeout_seconds", 480)):
        monkeypatch.setattr("config." + getter, AsyncMock(return_value=value))
    monkeypatch.setattr("config.get_return_thoughts_to_frontend", AsyncMock(return_value=True))
    monkeypatch.setattr("config.is_smart_429_protection_enabled", lambda: False)
    monkeypatch.setattr("src.logical_request_stats.record_logical_request", AsyncMock())
    monkeypatch.setattr("src.router.stream_passthrough.record_logical_request", AsyncMock())
    for router in (gemini, openai, anthropic):
        monkeypatch.setattr(router, "record_logical_request", AsyncMock())
        monkeypatch.setattr(router, "get_anti_truncation_max_attempts", AsyncMock(return_value=1))


@pytest.mark.parametrize("prefix", PREFIXES)
@pytest.mark.parametrize("old,new", MIGRATIONS)
def test_exact_migration_resolution(prefix, old, new):
    assert models.resolve_antigravity_model_id(prefix + old) == new
    assert not models.is_retired_antigravity_model(prefix + old)


@pytest.mark.parametrize("prefix", PREFIXES)
@pytest.mark.parametrize("name", RETIRED)
def test_precise_retired_ids(prefix, name):
    assert models.is_retired_antigravity_model(prefix + name)


@pytest.mark.parametrize("prefix", PREFIXES)
@pytest.mark.parametrize("name", UNCHANGED)
def test_service_and_unrelated_ids_are_preserved(prefix, name):
    assert models.resolve_antigravity_model_id(prefix + name) == name
    assert not models.is_retired_antigravity_model(prefix + name)


async def call_route(protocol, name, stream):
    if protocol == "gemini":
        handler = gemini.stream_generate_content if stream else gemini.generate_content
        return await handler(GeminiRequest(contents=[{"role": "user", "parts": [{"text": "Synthetic migration request"}]}]), model=name)
    if protocol == "openai":
        return await openai.chat_completions(OpenAIChatCompletionRequest(
            model=name, messages=[{"role": "user", "content": "Synthetic migration request"}], stream=stream))
    return await anthropic.messages(ClaudeRequest(
        model=name, messages=[{"role": "user", "content": "Synthetic migration request"}], max_tokens=64, stream=stream))


@pytest.mark.parametrize("protocol", ["gemini", "openai", "anthropic"])
@pytest.mark.parametrize("stream", [False, True])
@pytest.mark.parametrize("prefix", PREFIXES)
@pytest.mark.parametrize("old,new", MIGRATIONS + [(name, name) for name in UNCHANGED[:9]])
async def test_protocols_pass_migrated_id_to_api(monkeypatch, protocol, stream, prefix, old, new):
    captured = []
    async def nonstream(body, **kwargs):
        captured.append(copy.deepcopy(body))
        return Response(status_code=503)
    async def streamed(body, **kwargs):
        captured.append(copy.deepcopy(body))
        yield Response(status_code=503)
    monkeypatch.setattr(api, "non_stream_request", nonstream)
    monkeypatch.setattr(api, "stream_request", streamed)
    result = await call_route(protocol, prefix + old, stream)
    assert result.status_code == 503
    assert len(captured) == 1
    assert captured[0]["model"] == new


@pytest.fixture
def forbidden_side_effects(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("Retired model must stop before credentials, admission, retry or upstream access")
    manager = Mock()
    for method in ("get_valid_credential", "quota_admit", "initialize", "_refresh_token",
                   "quota_record_result", "set_model_cooldown", "get_storage_adapter"):
        getattr(manager, method).side_effect = forbidden
    monkeypatch.setattr(api, "credential_manager", manager)
    for name in ("post_async", "stream_post_async", "get_retry_config", "get_auto_ban_error_codes",
                 "record_api_call_success", "record_api_call_error", "handle_auto_ban"):
        if hasattr(api, name):
            monkeypatch.setattr(api, name, forbidden)
    return forbidden


def assert_fixed_404(response, protocol):
    assert response.status_code == 404
    payload = response.json()
    assert payload["error"]["message"] == "Resource unavailable."
    if protocol == "gemini":
        assert payload["error"]["code"] == 404
        assert payload["error"]["status"] == "NOT_FOUND"
    else:
        assert payload["error"]["type"] == "not_found_error"
        if protocol == "anthropic":
            assert payload["type"] == "error"


@pytest.mark.parametrize("protocol", ["gemini", "openai", "anthropic"])
@pytest.mark.parametrize("stream", [False, True])
@pytest.mark.parametrize("prefix", PREFIXES)
@pytest.mark.parametrize("name", RETIRED)
async def test_retired_http_requests_return_protocol_404(monkeypatch, forbidden_side_effects, protocol, stream, prefix, name, prompt="Synthetic migration request"):
    # Even entering the API layer is forbidden: public routes reject locally.
    monkeypatch.setattr(api, "non_stream_request", forbidden_side_effects)
    monkeypatch.setattr(api, "stream_request", forbidden_side_effects)
    app = FastAPI()
    module = {"gemini": gemini, "openai": openai, "anthropic": anthropic}[protocol]
    app.include_router(module.router)
    async def authenticated(): return "synthetic"
    dependency = module.authenticate_gemini_flexible if protocol == "gemini" else module.authenticate_bearer
    app.dependency_overrides[dependency] = authenticated
    if protocol == "gemini":
        method = "streamGenerateContent" if stream else "generateContent"
        path = f"/antigravity/v1beta/models/{prefix}{name}:{method}"
        body = {"contents": [{"role": "user", "parts": [{"text": prompt}]}]}
    else:
        path = "/antigravity/v1/messages" if protocol == "anthropic" else "/antigravity/v1/chat/completions"
        body = {"model": prefix + name, "messages": [{"role": "user", "content": prompt}], "stream": stream, "max_tokens": 64}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://synthetic.invalid") as client:
        assert_fixed_404(await client.post(path, json=body), protocol)


@pytest.mark.parametrize("stream", [False, True])
@pytest.mark.parametrize("prefix", PREFIXES)
@pytest.mark.parametrize("name", RETIRED)
async def test_direct_api_rejects_retired_before_any_side_effect(monkeypatch, forbidden_side_effects, stream, prefix, name):
    monkeypatch.setattr("src.logical_request_stats.record_logical_request", forbidden_side_effects)
    body = {"model": prefix + name, "request": {}}
    try:
        if stream:
            results = [item async for item in api.stream_request(body)]
            assert len(results) == 1
            response = results[0]
        else:
            response = await api.non_stream_request(body)
    except ModelApiErrorException as exc:
        assert exc.error.status == 404
    else:
        assert response.status_code == 404
        assert json.loads(response.body)["error"]["message"] == "Resource unavailable."


@pytest.mark.parametrize("origin", ["manual", "legacy"])
@pytest.mark.parametrize("prefix", PREFIXES)
@pytest.mark.parametrize("name", RETIRED)
async def test_panel_retires_before_credential_read(monkeypatch, forbidden_side_effects, origin, prefix, name):
    from src.panel import creds, antigravity_manual
    monkeypatch.setattr(creds, "get_storage_adapter", forbidden_side_effects)
    monkeypatch.setattr(antigravity_manual, "prepare", forbidden_side_effects)
    monkeypatch.setattr("src.httpx_client.post_async", forbidden_side_effects)
    response = await creds.test_credential_common("synthetic.json", mode="antigravity", model=prefix + name, origin=origin)
    payload = json.loads(response.body)
    assert payload["success"] is False
    assert payload["status_code"] == 404
    assert payload["error"] == "Resource unavailable."




@pytest.mark.parametrize("protocol", ["gemini", "openai", "anthropic"])
@pytest.mark.parametrize("stream", [False, True])
async def test_retired_health_check_cannot_bypass_preflight(monkeypatch, forbidden_side_effects, protocol, stream):
    await test_retired_http_requests_return_protocol_404(
        monkeypatch, forbidden_side_effects, protocol, stream, "", "gemini-3.1-pro-high", prompt="Hi")


@pytest.mark.parametrize("prefix", PREFIXES)
async def test_manual_retired_search_stops_before_prepare(monkeypatch, forbidden_side_effects, prefix):
    from src.panel import antigravity_manual
    monkeypatch.setattr(antigravity_manual, "prepare", forbidden_side_effects)
    response = await antigravity_manual.test("synthetic.json", prefix + "gemini-3.1-pro-high-search")
    assert response.status_code == 404
    payload = json.loads(response.body)
    assert payload["success"] is False
    assert payload["error"] == "Resource unavailable."


@pytest.mark.parametrize("stream", [False, True])
@pytest.mark.parametrize("prefix", PREFIXES)
async def test_direct_api_migration_preserves_caller_and_uses_final_statistics_key(monkeypatch, stream, prefix):
    original = {"model": prefix + "gemini-3.6-flash-high", "request": {"contents": []}}
    snapshot = copy.deepcopy(original)
    captured = []
    recorder = AsyncMock()
    async def nonstream(body, **kwargs):
        captured.append(copy.deepcopy(body))
        return Response(status_code=503)
    async def streamed(body, **kwargs):
        captured.append(copy.deepcopy(body))
        yield Response(status_code=503)
    monkeypatch.setattr(api, "_non_stream_request", nonstream)
    monkeypatch.setattr(api, "_stream_request", streamed)
    monkeypatch.setattr("src.logical_request_stats.record_logical_request", recorder)
    if stream:
        result = [item async for item in api.stream_request(original)]
        assert len(result) == 1 and result[0].status_code == 503
        # Streaming logical statistics belong to the protected route, not this API wrapper.
        recorder.assert_not_awaited()
    else:
        assert (await api.non_stream_request(original)).status_code == 503
        recorder.assert_awaited_once_with("gemini-3.8-flash-high", "antigravity", False)
    assert original == snapshot
    assert captured == [{"model": "gemini-3.8-flash-high", "request": {"contents": []}}]


@pytest.mark.parametrize("protocol", ["gemini", "openai", "anthropic"])
@pytest.mark.parametrize("stream", [False, True])
async def test_protocol_statistics_use_final_converter_model(monkeypatch, protocol, stream):
    name = "gemini-3.6-flash-high-search"
    final_model = "gemini-3.8-flash-high"
    captured = []
    recorder = AsyncMock()
    async def nonstream(body, **kwargs):
        captured.append(body["model"])
        return Response(status_code=503)
    async def streamed(body, **kwargs):
        captured.append(body["model"])
        yield Response(status_code=503)
    monkeypatch.setattr(api, "non_stream_request", nonstream)
    monkeypatch.setattr(api, "stream_request", streamed)
    monkeypatch.setattr("src.router.stream_passthrough.record_logical_request", recorder)
    module = {"gemini": gemini, "openai": openai, "anthropic": anthropic}[protocol]
    monkeypatch.setattr(module, "record_logical_request", recorder)
    app = FastAPI()
    app.include_router(module.router)
    async def authenticated(): return "synthetic"
    dependency = module.authenticate_gemini_flexible if protocol == "gemini" else module.authenticate_bearer
    app.dependency_overrides[dependency] = authenticated
    if protocol == "gemini":
        method = "streamGenerateContent" if stream else "generateContent"
        path = f"/antigravity/v1beta/models/{name}:{method}"
        body = {"contents": [{"role": "user", "parts": [{"text": "Synthetic migration request"}]}]}
    else:
        path = "/antigravity/v1/messages" if protocol == "anthropic" else "/antigravity/v1/chat/completions"
        body = {"model": name, "messages": [{"role": "user", "content": "Synthetic migration request"}], "stream": stream, "max_tokens": 64}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://synthetic.invalid") as client:
        response = await client.post(path, json=body)
    assert response.status_code == 503
    assert captured == [final_model]
    recorder.assert_awaited_once_with(final_model, "antigravity", False)
