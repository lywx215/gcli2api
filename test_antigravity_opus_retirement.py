"""Retired Opus requests stop locally before any account or generation side effect."""

from unittest.mock import AsyncMock, Mock
from urllib.parse import quote

import httpx
import pytest
from fastapi import FastAPI

import config
from src.antigravity_models import (
    describe_antigravity_model,
    is_retired_antigravity_opus_model,
    resolve_antigravity_opus_model,
)
from src.api import antigravity as api
from src.converter import antigravity_fix, gemini_fix
from src.router.antigravity import anthropic, gemini, openai
from src.router.model_api_errors import ModelApiErrorException
from src.storage._stats_common import normalize_antigravity_cooldown_key
from src.utils import normalize_antigravity_model_alias


RETIRED = [
    "claude-opus-4-6", "claude-opus-4-6-thinking", "claude-opus-4-6-high",
    "claude-opus-4.6", "claude-opus-4.6-thinking", " CLAUDE-OPUS-4-6 ",
    "假流式/claude-opus-4-6-thinking", "抗截断/claude-opus-4-6",
    "流式抗截断/claude-opus-4-6", " 假流式/ 抗截断/ CLAUDE-OPUS-4.6-thinking ",
    "models/claude-opus-4-6-thinking", "arbitrary/claude-opus-4.6-high",
    "arbitrary/ CLAUDE-OPUS-4-6-thinking ",
    "claude-opus-4-6-thinking/foo", "claude-opus-4.6/",
    "prefix-claude-opus-4-6", "notclaude-opus-4.6-thinking",
    "models/claude-opus-4-6-thinking/foo",
]
CURRENT = ["claude-opus-5-5-low", "claude-opus-5-5-medium", "claude-opus-5-5-high"]
MESSAGE = "Invalid request. Check the request parameters and try again."


@pytest.mark.parametrize("model", RETIRED)
def test_retired_detection_leaves_history_readable(model):
    assert is_retired_antigravity_opus_model(model)
    metadata = describe_antigravity_model(model)
    assert metadata["rawModelId"] == model
    assert metadata["visible"] is False
    assert metadata["public"] is False
    assert metadata["availability"] == "unavailable"
    assert normalize_antigravity_model_alias(model) == model
    with pytest.raises(ModelApiErrorException) as error:
        resolve_antigravity_opus_model(model)
    assert error.value.error.status == 400


def test_retired_history_still_uses_shared_cooldown_group():
    assert normalize_antigravity_cooldown_key("claude-opus-4-6-thinking") == "claude-gpt-shared"
    assert normalize_antigravity_cooldown_key("claude-opus-5-5-high") == "claude-gpt-shared"


@pytest.mark.parametrize("model", [*CURRENT, "claude-opus-5-5", "claude-opus-5-5-thinking",
    "claude-sonnet-4-6", "claude-sonnet-4-6-thinking", "claude-opus-4-60", "claude-opus-4.60", "models/claude-opus-4-60", "arbitrary/ claude-opus-4.60-high ",
    "prefix-claude-opus-4-60", "notclaude-opus-4.60-thinking", None])
def test_retirement_is_limited_to_opus_46(model):
    assert not is_retired_antigravity_opus_model(model)


@pytest.fixture
def no_side_effects(monkeypatch):
    mocks = []
    def deny(target, name, asynchronous=True):
        mocked = AsyncMock(side_effect=AssertionError("retired request reached a side effect")) if asynchronous else Mock(side_effect=AssertionError("retired request reached a side effect"))
        monkeypatch.setattr(target, name, mocked)
        mocks.append(mocked)

    from src import logical_request_stats
    from src.diagnostics import antigravity as diagnostics, semantic
    from src.antigravity_limits import GenerationLimits

    deny(api.credential_manager, "get_valid_credential")
    deny(api.credential_manager, "quota_admit")
    deny(api.credential_manager, "_refresh_token")
    deny(api, "post_async")
    deny(api, "get_antigravity_stream2nostream")
    deny(config, "get_return_thoughts_to_frontend")
    deny(logical_request_stats, "record_logical_request")
    deny(diagnostics, "requested_model", False)
    deny(semantic, "normalization_start", False)
    deny(GenerationLimits, "load", False)
    for route in (openai, anthropic, gemini):
        deny(route, "record_logical_request")
        deny(route, "activate_logical_request_recording", False)
    yield
    for mocked in mocks:
        mocked.assert_not_called()


@pytest.fixture
def protected_app():
    app = FastAPI()
    for module in (openai, anthropic, gemini):
        app.include_router(module.router)
    async def authenticate():
        return "synthetic-auth"
    app.dependency_overrides[openai.authenticate_bearer] = authenticate
    app.dependency_overrides[anthropic.authenticate_bearer] = authenticate
    app.dependency_overrides[gemini.authenticate_gemini_flexible] = authenticate
    return app


@pytest.mark.parametrize("model", RETIRED)
@pytest.mark.parametrize("protocol,stream", [(p, s) for p in ("openai", "claude", "gemini") for s in (False, True)])
async def test_protected_generation_rejects_before_stream_and_side_effects(protected_app, no_side_effects, model, protocol, stream):
    if protocol == "openai":
        url = "/antigravity/v1/chat/completions"
        body = {"model": model, "messages": [{"role": "user", "content": "hi"}], "stream": stream}
    elif protocol == "claude":
        url = "/antigravity/v1/messages"
        body = {"model": model, "messages": [{"role": "user", "content": "hi"}], "max_tokens": 8, "stream": stream}
    else:
        method = "streamGenerateContent" if stream else "generateContent"
        url = f"/antigravity/v1beta/models/{quote(model, safe='')}:{method}"
        body = {"contents": [{"role": "user", "parts": [{"text": "hi"}]}]}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=protected_app), base_url="http://synthetic") as client:
        response = await client.post(url, json=body)
    assert response.status_code == 400
    assert response.headers["content-type"].startswith("application/json")
    payload = response.json()
    assert payload["error"]["message"] == MESSAGE
    if protocol == "gemini":
        assert payload["error"]["status"] == "INVALID_ARGUMENT"
        assert payload["error"]["code"] == 400
    else:
        assert payload["error"]["type"] == "invalid_request_error"
        if protocol == "claude":
            assert payload["type"] == "error"
        else:
            assert payload["error"]["code"] == 400


@pytest.mark.parametrize("protocol", ["claude", "gemini-v1", "gemini-v1beta"])
@pytest.mark.parametrize("model", RETIRED)
async def test_count_tokens_rejects_retired_model(protected_app, no_side_effects, protocol, model):
    if protocol == "claude":
        url = "/antigravity/v1/messages/count_tokens"
        body = {"model": model, "messages": [{"role": "user", "content": "hi"}]}
    else:
        version = protocol.split("-", 1)[1]
        url = f"/antigravity/{version}/models/{quote(model, safe='')}:countTokens"
        body = {"contents": [{"role": "user", "parts": [{"text": "hi"}]}]}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=protected_app), base_url="http://synthetic") as client:
        response = await client.post(url, json=body)
    assert response.status_code == 400
    assert response.json()["error"]["message"] == MESSAGE


@pytest.mark.parametrize("entry", ["converter", "shared_converter", "private_converter", "stream", "private_stream", "nonstream", "private_nonstream"])
@pytest.mark.parametrize("model", RETIRED)
async def test_direct_entrypoints_cannot_bypass_retirement(no_side_effects, entry, model):
    request = {"model": model, "contents": []}
    with pytest.raises(ModelApiErrorException) as error:
        if entry == "converter":
            await antigravity_fix.normalize_antigravity_request(request)
        elif entry == "shared_converter":
            await gemini_fix.normalize_gemini_request(request, mode="antigravity")
        elif entry == "private_converter":
            antigravity_fix._normalize_antigravity_request(request, model, {}, True)
        elif entry in ("stream", "private_stream"):
            iterator = (api.stream_request if entry == "stream" else api._stream_request)(request)
            try:
                await anext(iterator)
            finally:
                await iterator.aclose()
        else:
            await (api.non_stream_request if entry == "nonstream" else api._non_stream_request)(request)
    assert error.value.error.status == 400
