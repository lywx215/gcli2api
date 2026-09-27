"""Local ASGI safety matrix for the protected model-generation routes.

All upstream calls are replaced with in-process async generators/responses.
This test never creates a credential, network client, database connection, or
production request.
"""

import importlib
import json
from urllib.parse import quote

import httpx
import pytest
from fastapi import FastAPI, Response
from fastapi.responses import StreamingResponse

from src.router.model_api_errors import (
    ErrorOrigin,
    ModelApiErrorException,
    error_from_http_status,
    protect_streaming_response,
    protect_authentication,
)
from src.router import stream_passthrough
from src.utils import authenticate_bearer, authenticate_gemini_flexible


BACKENDS = ("geminicli", "antigravity")
PROTOCOLS = ("openai", "claude", "gemini")
MODES = ("nonstream", "fake", "stream", "anti")


def _app() -> FastAPI:
    app = FastAPI()
    from src.router.geminicli.openai import router as gcli_openai
    from src.router.geminicli.anthropic import router as gcli_claude
    from src.router.geminicli.gemini import router as gcli_gemini
    from src.router.antigravity.openai import router as anti_openai
    from src.router.antigravity.anthropic import router as anti_claude
    from src.router.antigravity.gemini import router as anti_gemini

    for router in (
        gcli_openai,
        gcli_claude,
        gcli_gemini,
        anti_openai,
        anti_claude,
        anti_gemini,
    ):
        app.include_router(router)

    async def auth_ok():
        return "matrix-token"

    app.dependency_overrides[protect_authentication(authenticate_bearer)] = auth_ok
    app.dependency_overrides[protect_authentication(authenticate_gemini_flexible)] = auth_ok
    return app


def _model(mode: str) -> str:
    prefix = {"fake": "假流式/", "anti": "流式抗截断/"}.get(mode, "")
    return prefix + "gemini-2.5-flash"


def _body(protocol: str, mode: str) -> dict:
    model = _model(mode)
    if protocol == "openai":
        return {"model": model, "messages": [{"role": "user", "content": "hello"}], "stream": mode != "nonstream"}
    if protocol == "claude":
        return {"model": model, "max_tokens": 32, "messages": [{"role": "user", "content": "hello"}], "stream": mode != "nonstream"}
    return {"contents": [{"role": "user", "parts": [{"text": "hello"}]}]}


def _path(backend: str, protocol: str, mode: str) -> str:
    prefix = "/antigravity" if backend == "antigravity" else ""
    model = quote(_model(mode), safe="")
    if protocol == "openai":
        return f"{prefix}/v1/chat/completions"
    if protocol == "claude":
        return f"{prefix}/v1/messages"
    suffix = "generateContent" if mode == "nonstream" else "streamGenerateContent"
    return f"{prefix}/v1beta/models/{model}:{suffix}"


def _upstream_payload(text: str = "hello [done]") -> dict:
    return {
        "response": {
            "candidates": [
                {
                    "index": 0,
                    "content": {"role": "model", "parts": [{"text": text}]},
                    "finishReason": "STOP",
                }
            ],
            "usageMetadata": {"promptTokenCount": 1, "candidatesTokenCount": 2},
        }
    }


def _response(payload: dict, status: int = 200) -> Response:
    return Response(
        content=json.dumps(payload, ensure_ascii=False),
        status_code=status,
        media_type="application/json",
    )


def _sse(payload: dict) -> bytes:
    return ("data: " + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n\n").encode()


def _api_module(backend: str):
    return importlib.import_module(f"src.api.{backend}")


@pytest.mark.asyncio
@pytest.mark.parametrize("backend", BACKENDS)
@pytest.mark.parametrize("protocol", PROTOCOLS)
@pytest.mark.parametrize("mode", MODES)
async def test_two_backend_three_protocol_four_mode_success_matrix(monkeypatch, backend, protocol, mode):
    app = _app()
    api = _api_module(backend)
    stats = []

    async def record(model, backend_mode, success):
        stats.append((model, backend_mode, success))

    monkeypatch.setattr(stream_passthrough, "record_logical_request", record)
    for module_name in (
        "src.router.geminicli.openai", "src.router.geminicli.anthropic", "src.router.geminicli.gemini",
        "src.router.antigravity.openai", "src.router.antigravity.anthropic", "src.router.antigravity.gemini",
    ):
        monkeypatch.setattr(importlib.import_module(module_name), "record_logical_request", record)

    async def fake_non_stream(*args, **kwargs):
        assert kwargs.get("record_logical") is False
        return _response(_upstream_payload())

    async def fake_stream(*args, **kwargs):
        assert kwargs.get("events") is True
        yield _sse(_upstream_payload())
        yield b"data: [DONE]\n\n"

    monkeypatch.setattr(api, "non_stream_request", fake_non_stream)
    monkeypatch.setattr(api, "stream_request", fake_stream)

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://matrix") as client:
        response = await client.post(_path(backend, protocol, mode), json=_body(protocol, mode))

    assert response.status_code == 200, response.text
    assert "SENTINEL" not in response.text
    assert len(stats) == 1
    assert stats[0][1] == backend
    assert stats[0][2] is True


@pytest.mark.asyncio
@pytest.mark.parametrize("backend", BACKENDS)
@pytest.mark.parametrize("protocol", PROTOCOLS)
async def test_http200_error_and_retirement_are_fixed_once(monkeypatch, backend, protocol):
    app = _app()
    api = _api_module(backend)
    stats = []

    async def record(model, backend_mode, success):
        stats.append((model, backend_mode, success))

    monkeypatch.setattr(stream_passthrough, "record_logical_request", record)
    for module_name in (
        "src.router.geminicli.openai", "src.router.geminicli.anthropic", "src.router.geminicli.gemini",
        "src.router.antigravity.openai", "src.router.antigravity.anthropic", "src.router.antigravity.gemini",
    ):
        monkeypatch.setattr(importlib.import_module(module_name), "record_logical_request", record)

    async def fake_non_stream(*args, **kwargs):
        return _response({"error": {"code": 503, "message": "SENTINEL", "model": "SECRET-MODEL"}})

    monkeypatch.setattr(api, "non_stream_request", fake_non_stream)
    mode = "nonstream"
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://matrix") as client:
        error_response = await client.post(_path(backend, protocol, mode), json=_body(protocol, mode))

    assert error_response.status_code == 503
    assert "SENTINEL" not in error_response.text
    assert "SECRET-MODEL" not in error_response.text
    assert len(stats) == 1 and stats[0][2] is False

    stats.clear()

    async def retired_stream(*args, **kwargs):
        if False:
            yield b""
        raise ModelApiErrorException(error_from_http_status(404, origin=ErrorOrigin.UPSTREAM))

    monkeypatch.setattr(api, "stream_request", retired_stream)
    stream_mode = "stream"
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://matrix") as client:
        retirement_response = await client.post(_path(backend, protocol, stream_mode), json=_body(protocol, stream_mode))

    assert retirement_response.status_code == 404
    assert "SECRET-MODEL" not in retirement_response.text
    assert len(stats) == 1 and stats[0][2] is False


@pytest.mark.asyncio
async def test_converter_failure_is_fixed_and_counted_once(monkeypatch):
    app = _app()
    api = _api_module("geminicli")
    module = importlib.import_module("src.converter.openai2gemini")
    stats = []

    async def record(model, backend_mode, success):
        stats.append((model, backend_mode, success))

    monkeypatch.setattr(importlib.import_module("src.router.geminicli.openai"), "record_logical_request", record)

    async def fake_non_stream(*args, **kwargs):
        return _response(_upstream_payload())

    def fail_converter(*args, **kwargs):
        raise ValueError("SENTINEL-CONVERTER")

    monkeypatch.setattr(api, "non_stream_request", fake_non_stream)
    monkeypatch.setattr(module, "convert_gemini_to_openai_response", fail_converter, raising=False)

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://matrix") as client:
        response = await client.post(_path("geminicli", "openai", "nonstream"), json=_body("openai", "nonstream"))

    assert response.status_code == 500
    assert "SENTINEL-CONVERTER" not in response.text
    assert len(stats) == 1 and stats[0][2] is False


@pytest.mark.asyncio
@pytest.mark.parametrize("backend", BACKENDS)
@pytest.mark.parametrize("protocol", PROTOCOLS)
async def test_postcommit_error_is_terminal_without_replay_or_success_tail(monkeypatch, backend, protocol):
    app = _app()
    api = _api_module(backend)
    stats = []
    calls = 0

    async def record(model, backend_mode, success):
        stats.append((model, backend_mode, success))

    monkeypatch.setattr(stream_passthrough, "record_logical_request", record)
    for module_name in (
        "src.router.geminicli.openai", "src.router.geminicli.anthropic", "src.router.geminicli.gemini",
        "src.router.antigravity.openai", "src.router.antigravity.anthropic", "src.router.antigravity.gemini",
    ):
        monkeypatch.setattr(importlib.import_module(module_name), "record_logical_request", record)

    async def stream_then_error(*args, **kwargs):
        nonlocal calls
        calls += 1
        payload = _upstream_payload("first chunk")
        del payload["response"]["candidates"][0]["finishReason"]
        yield _sse(payload)
        raise ModelApiErrorException(
            error_from_http_status(503, origin=ErrorOrigin.UPSTREAM)
        )

    monkeypatch.setattr(api, "stream_request", stream_then_error)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://matrix") as client:
        response = await client.post(_path(backend, protocol, "stream"), json=_body(protocol, "stream"))

    assert response.status_code == 200
    assert "first chunk" in response.text
    assert "SENTINEL" not in response.text
    assert "service is temporarily unavailable" in response.text.casefold()
    assert "message_stop" not in response.text
    assert calls == 1
    assert len(stats) == 1 and stats[0][2] is False


@pytest.mark.asyncio
async def test_cancelled_protected_stream_closes_upstream_iterator():
    closed = False

    async def upstream():
        nonlocal closed
        try:
            yield b"data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n\n"
            await __import__("asyncio").sleep(60)
        finally:
            closed = True

    response = await protect_streaming_response(
        StreamingResponse(upstream()), "openai"
    )
    iterator = response.body_iterator
    await iterator.__anext__()
    await iterator.aclose()
    assert closed is True


@pytest.mark.asyncio
async def test_count_tokens_is_outside_generation_statistics(monkeypatch):
    app = _app()
    stats = []

    async def record(model, backend_mode, success):
        stats.append((model, backend_mode, success))

    monkeypatch_modules = (
        "src.router.geminicli.openai", "src.router.geminicli.anthropic", "src.router.geminicli.gemini",
        "src.router.antigravity.openai", "src.router.antigravity.anthropic", "src.router.antigravity.gemini",
    )
    for module_name in monkeypatch_modules:
        monkeypatch.setattr(importlib.import_module(module_name), "record_logical_request", record)

    payload = {"model": "gemini-2.5-flash", "messages": [{"role": "user", "content": "hello"}], "max_tokens": 8}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://matrix") as client:
        response = await client.post("/v1/messages/count_tokens", json=payload)
    assert response.status_code == 200
    assert stats == []


@pytest.fixture
def captured_stats(monkeypatch):
    stats = []

    async def record(model, mode, success):
        stats.append((model, mode, success))

    monkeypatch.setattr(stream_passthrough, "record_logical_request", record)
    for backend in BACKENDS:
        for protocol in ("openai", "anthropic", "gemini"):
            monkeypatch.setattr(importlib.import_module(f"src.router.{backend}.{protocol}"), "record_logical_request", record)
    return stats


@pytest.mark.parametrize("backend", BACKENDS)
@pytest.mark.parametrize("protocol", PROTOCOLS)
@pytest.mark.parametrize("mode", ("nonstream", "fake"))
@pytest.mark.parametrize("body,status", [
    ('{"error":{"code":429,"message":"SENTINEL"},"response":{"candidates":[]}}', 429),
    ('{"response":{"response":{"error":{"code":403,"message":"SENTINEL"}}}}', 403),
    ('{"error":{}}', 502),
    ('{"error":""}', 502),
    ('[]', 502),
    ('"SENTINEL"', 502),
    ('{"response":[]}', 502),
    ('{SENTINEL', 502),
])
async def test_precommit_error_matrix(monkeypatch, captured_stats, backend, protocol, mode, body, status):
    async def upstream(**kwargs):
        return Response(body, headers={"x-upstream": "SENTINEL", "Retry-After": "991"})

    monkeypatch.setattr(_api_module(backend), "non_stream_request", upstream)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=_app()), base_url="http://matrix") as client:
        response = await client.post(_path(backend, protocol, mode), json=_body(protocol, mode))
    assert response.status_code == status, response.text
    assert response.headers['content-type'] == 'application/json'
    assert 'SENTINEL' not in response.text and '[DONE]' not in response.text
    assert 'x-upstream' not in response.headers and 'retry-after' not in response.headers
    assert len(captured_stats) == 1 and captured_stats[0][2] is False


@pytest.mark.parametrize("backend", BACKENDS)
@pytest.mark.parametrize("protocol", PROTOCOLS)
async def test_fake_retirement_is_http404_before_stream(monkeypatch, captured_stats, backend, protocol):
    async def upstream(**kwargs):
        return _response(_upstream_payload("Gemini gemini-2.5-flash is no longer available."))

    monkeypatch.setattr(_api_module(backend), "non_stream_request", upstream)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=_app()), base_url="http://matrix") as client:
        response = await client.post(_path(backend, protocol, "fake"), json=_body(protocol, "fake"))
    assert response.status_code == 404 and '[DONE]' not in response.text
    assert len(captured_stats) == 1 and captured_stats[0][2] is False


@pytest.mark.parametrize("backend", BACKENDS)
@pytest.mark.parametrize("protocol", PROTOCOLS)
@pytest.mark.parametrize("mode", ("nonstream", "fake", "stream"))
async def test_nullable_error_and_quoted_retirement_are_success(monkeypatch, captured_stats, backend, protocol, mode):
    payload = _upstream_payload('The phrase "is no longer available; please switch to" is quoted here.')
    payload['error'] = None
    payload['response']['error'] = None

    async def upstream(**kwargs):
        return _response(payload)

    async def stream(**kwargs):
        yield _sse(payload)
        yield b'data: [DONE]\n\n'

    monkeypatch.setattr(_api_module(backend), "non_stream_request", upstream)
    monkeypatch.setattr(_api_module(backend), "stream_request", stream)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=_app()), base_url="http://matrix") as client:
        response = await client.post(_path(backend, protocol, mode), json=_body(protocol, mode))
    assert response.status_code == 200
    assert len(captured_stats) == 1 and captured_stats[0][2] is True


@pytest.mark.parametrize("backend", BACKENDS)
@pytest.mark.parametrize("protocol", PROTOCOLS)
@pytest.mark.parametrize("mode", ("nonstream", "fake", "stream"))
@pytest.mark.parametrize("local", (True, False))
async def test_only_local_retry_after_survives(monkeypatch, captured_stats, backend, protocol, mode, local):
    from src.router.model_api_errors import local_retry_response

    def result():
        if local:
            return local_retry_response(content='SENTINEL', status_code=503, retry_after=7)
        return Response('SENTINEL', status_code=503, headers={'Retry-After': '991', 'x-upstream': 'SENTINEL'})

    async def upstream(**kwargs):
        return result()

    async def stream(**kwargs):
        yield result()

    monkeypatch.setattr(_api_module(backend), "non_stream_request", upstream)
    monkeypatch.setattr(_api_module(backend), "stream_request", stream)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=_app()), base_url="http://matrix") as client:
        response = await client.post(_path(backend, protocol, mode), json=_body(protocol, mode))
    assert response.status_code == 503
    assert response.headers.get('retry-after') == ('7' if local else None)
    assert 'SENTINEL' not in response.text and 'x-upstream' not in response.headers
    assert len(captured_stats) == 1 and captured_stats[0][2] is False


@pytest.mark.parametrize("backend", BACKENDS)
@pytest.mark.parametrize("protocol", PROTOCOLS)
@pytest.mark.parametrize("wrong_key", (False, True))
async def test_real_local_auth_origin(monkeypatch, captured_stats, backend, protocol, wrong_key):
    from src import utils

    async def password():
        return 'synthetic-local-password'

    monkeypatch.setattr(utils, 'get_api_password', password)
    app = _app()
    app.dependency_overrides.clear()
    headers = {'Authorization': 'Bearer synthetic-wrong'} if wrong_key else {}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://matrix") as client:
        response = await client.post(_path(backend, protocol, 'nonstream'), json=_body(protocol, 'nonstream'), headers=headers)
    assert response.status_code == (403 if wrong_key else 401)
    expected = 'Access denied.' if wrong_key else 'Authentication failed.'
    assert response.json()['error']['message'].startswith(expected)
    assert response.headers.get('www-authenticate') == (None if wrong_key else 'Bearer')
    assert captured_stats == []


@pytest.mark.parametrize("backend", BACKENDS)
@pytest.mark.parametrize("protocol", ('claude', 'gemini'))
async def test_invalid_count_payload_is_fixed_and_not_counted(monkeypatch, captured_stats, backend, protocol):
    prefix = '/antigravity' if backend == 'antigravity' else ''
    suffix = '/v1/messages/count_tokens' if protocol == 'claude' else '/v1beta/models/gemini-2.5-flash:countTokens'
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=_app()), base_url="http://matrix") as client:
        response = await client.post(prefix + suffix, content='{SENTINEL', headers={'Content-Type': 'application/json'})
    assert response.status_code == 400
    assert response.json()['error']['message'] == 'Invalid request. Check the request parameters and try again.'
    assert 'SENTINEL' not in response.text and captured_stats == []


async def test_combined_openai_error_done_is_failed_once(monkeypatch, captured_stats):
    from src.router.model_api_errors import render_error_event

    async def stream():
        yield b'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'
        yield render_error_event(error_from_http_status(503), 'openai')

    response = await stream_passthrough.build_streaming_response_or_error(
        stream(), model_name='synthetic', mode='geminicli', protected=True, protocol='openai'
    )
    assert len([x async for x in response.body_iterator]) == 2
    assert captured_stats == [('synthetic', 'geminicli', False)]


@pytest.mark.parametrize('backend,alias,expected', [
    ('geminicli', 'gemini-3.5-flash-preview', 'gemini-3-flash'),
    ('antigravity', 'gemini-3.7-flash', 'gemini-3.7-flash-medium'),
])
@pytest.mark.parametrize('protocol', PROTOCOLS)
@pytest.mark.parametrize('mode', MODES)
@pytest.mark.parametrize('success', (True, False))
async def test_alias_uses_one_normalized_statistics_key_in_every_mode(
    monkeypatch, captured_stats, backend, alias, expected, protocol, mode, success
):
    def model_name(selected_mode):
        prefix = {'fake': '假流式/', 'anti': '流式抗截断/'}.get(selected_mode, '')
        return prefix + alias

    monkeypatch.setattr(importlib.import_module(__name__), '_model', model_name)

    async def upstream(**kwargs):
        if success:
            return _response(_upstream_payload())
        return _response({'error': {'code': 503, 'message': 'synthetic'}}, 503)

    async def stream(**kwargs):
        if success:
            yield _sse(_upstream_payload())
            yield b'data: [DONE]\n\n'
        else:
            yield _response({'error': {'code': 503, 'message': 'synthetic'}}, 503)

    monkeypatch.setattr(_api_module(backend), 'non_stream_request', upstream)
    monkeypatch.setattr(_api_module(backend), 'stream_request', stream)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=_app()), base_url='http://matrix') as client:
        response = await client.post(_path(backend, protocol, mode), json=_body(protocol, mode))
    assert response.status_code == (200 if success else 503), response.text
    assert captured_stats == [(expected, backend, success)]


@pytest.mark.parametrize('backend', BACKENDS)
@pytest.mark.parametrize('protocol', PROTOCOLS)
@pytest.mark.parametrize('kind,expected', [('timeout', 504), ('bad_format', 502)])
async def test_postcommit_response_preserves_private_error(monkeypatch, captured_stats, backend, protocol, kind, expected):
    from src.router.model_api_errors import attach_model_api_error, make_model_api_error, ErrorKind

    async def stream(**kwargs):
        payload = _upstream_payload('partial')
        del payload['response']['candidates'][0]['finishReason']
        yield _sse(payload)
        yield attach_model_api_error(Response('SENTINEL', status_code=500), make_model_api_error(
            origin=ErrorOrigin.UPSTREAM, kind=ErrorKind(kind),
        ))

    monkeypatch.setattr(_api_module(backend), 'stream_request', stream)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=_app()), base_url='http://matrix') as client:
        response = await client.post(_path(backend, protocol, 'stream'), json=_body(protocol, 'stream'))
    assert response.status_code == 200 and 'SENTINEL' not in response.text
    message = 'The request timed out.' if expected == 504 else 'The service received an invalid response.'
    assert response.text.count(message) == 1
    assert len(captured_stats) == 1 and captured_stats[0][2] is False
