"""Hi stays local and bypasses routing config, while public identity is exact."""

import importlib
from urllib.parse import quote

import httpx
import pytest
from fastapi import FastAPI

from src.router.model_api_errors import protect_authentication
from src.utils import authenticate_bearer, authenticate_gemini_flexible


@pytest.mark.asyncio
@pytest.mark.parametrize("channel", ["geminicli", "antigravity"])
@pytest.mark.parametrize("protocol", ["openai", "anthropic", "gemini"])
async def test_hi_bypasses_config_and_returns_exact_identity(monkeypatch, channel, protocol):
    module = importlib.import_module(f"src.router.{channel}.{protocol}")
    app = FastAPI()
    app.include_router(module.router)

    async def auth_ok():
        return "isolated-test-auth"

    app.dependency_overrides[protect_authentication(authenticate_bearer)] = auth_ok
    app.dependency_overrides[protect_authentication(authenticate_gemini_flexible)] = auth_ok

    async def forbidden(*args, **kwargs):
        raise AssertionError("Hi must not read routing or call the upstream")

    monkeypatch.setattr(module, "prepare_route_context", forbidden)
    api = importlib.import_module(f"src.api.{channel}")
    monkeypatch.setattr(api, "non_stream_request", forbidden)
    requested = "假流式/public-alpha-high-search"
    prefix = "/antigravity" if channel == "antigravity" else ""
    if protocol == "gemini":
        path = f"{prefix}/v1/models/{quote(requested, safe='')}:generateContent"
        body = {"contents": [{"role": "user", "parts": [{"text": "Hi"}]}]}
    elif protocol == "openai":
        path = f"{prefix}/v1/chat/completions"
        body = {"model": requested, "messages": [{"role": "user", "content": "Hi"}]}
    else:
        path = f"{prefix}/v1/messages"
        body = {"model": requested, "max_tokens": 20, "messages": [{"role": "user", "content": "Hi"}]}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post(path, json=body)
    assert response.status_code == 200
    payload = response.json()
    key = "modelVersion" if protocol == "gemini" else "model"
    assert payload[key] == requested
