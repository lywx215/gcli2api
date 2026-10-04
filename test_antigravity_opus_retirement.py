"""Restored Opus 4.6 requests retain their version through protected routes."""
from urllib.parse import quote
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI

from src.api import antigravity as api
from src.router.antigravity import anthropic, gemini, openai
from src.storage._stats_common import normalize_antigravity_cooldown_key


@pytest.fixture
def protected_app(monkeypatch):
    from src.model_routing.compiler import compile_channel, parse_route_table
    async def empty_routes(channel, policy):
        return compile_channel(channel, parse_route_table({"routes": []}), policy)
    monkeypatch.setattr("src.model_routing.store.load_channel_routes", empty_routes)
    for setting in ("get_compatibility_mode_enabled", "get_return_thoughts_to_frontend", "get_antigravity_stream2nostream"):
        monkeypatch.setattr("config." + setting, AsyncMock(return_value=False))
    app = FastAPI()
    for module in (openai, anthropic, gemini):
        app.include_router(module.router)
    async def authenticate():
        return "synthetic-auth"
    app.dependency_overrides[openai.authenticate_bearer] = authenticate
    app.dependency_overrides[anthropic.authenticate_bearer] = authenticate
    app.dependency_overrides[gemini.authenticate_gemini_flexible] = authenticate
    return app


def test_opus_versions_still_share_cooldown_group():
    assert normalize_antigravity_cooldown_key("claude-opus-4-6-thinking") == "claude-gpt-shared"
    assert normalize_antigravity_cooldown_key("claude-opus-5-5-high") == "claude-gpt-shared"


@pytest.mark.parametrize("model", ["claude-opus-4-6", "claude-opus-4.6-thinking", "claude-opus-5-5-high"])
@pytest.mark.parametrize("feature", ["", "假流式/", "抗截断/", "流式抗截断/"])
@pytest.mark.parametrize("protocol,stream", [(p, s) for p in ("openai", "claude", "gemini") for s in (False, True)])
async def test_no_version_qualified_credential_is_preheader_json_503(protected_app, monkeypatch, model, feature, protocol, stream):
    selected = []
    class Manager:
        async def get_valid_credential(self, **kwargs):
            selected.append(kwargs["model_name"])
            return None
    monkeypatch.setattr(api, "credential_manager", Manager())
    monkeypatch.setattr(api, "get_antigravity_stream2nostream", AsyncMock(return_value=False))
    monkeypatch.setattr("config.get_return_thoughts_to_frontend", AsyncMock(return_value=False))
    forbidden = AsyncMock(side_effect=AssertionError("unqualified credential reached generation"))
    monkeypatch.setattr(api, "post_async", forbidden)
    monkeypatch.setattr(api, "stream_post_async", forbidden)
    for route in (openai, anthropic, gemini):
        monkeypatch.setattr(route, "record_logical_request", AsyncMock())
    requested = feature + model
    if protocol == "openai":
        url = "/antigravity/v1/chat/completions"
        body = {"model": requested, "messages": [{"role": "user", "content": "hi"}], "stream": stream}
    elif protocol == "claude":
        url = "/antigravity/v1/messages"
        body = {"model": requested, "messages": [{"role": "user", "content": "hi"}], "max_tokens": 8, "stream": stream}
    else:
        method = "streamGenerateContent" if stream else "generateContent"
        url = f"/antigravity/v1beta/models/{quote(requested, safe='')}:{method}"
        body = {"contents": [{"role": "user", "parts": [{"text": "hi"}]}]}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=protected_app), base_url="http://synthetic") as client:
        response = await client.post(url, json=body)
    assert response.status_code == 503
    assert response.headers["content-type"].startswith("application/json")
    assert response.json()["error"]["message"] == "The service is temporarily unavailable. Please try again later."
    assert selected and set(selected) == ({"claude-opus-5-5-high"} if "5-5" in model else {"claude-opus-4-6-thinking"})
    forbidden.assert_not_called()
