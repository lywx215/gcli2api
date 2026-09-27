"""Transport failures with synthetic credentials and no real network/storage."""

import importlib
import asyncio
import json
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import Response

from src.router.model_api_errors import (
    ErrorKind, ModelApiErrorException, get_attached_model_api_error, render_error,
)


def configure(monkeypatch, backend):
    api = importlib.import_module(f'src.api.{backend}')

    class Credentials:
        get_valid_credential = AsyncMock(return_value=(
            'synthetic.json', {'access_token': 'synthetic-token', 'project_id': 'synthetic-project'}
        ))

    monkeypatch.setattr(api, 'credential_manager', Credentials())
    monkeypatch.setattr(api, 'get_retry_config', AsyncMock(return_value={
        'max_retries': 1, 'retry_interval': 0, 'retry_enabled': True, 'smart_429': False,
    }))
    monkeypatch.setattr(api, 'get_auto_ban_error_codes', AsyncMock(return_value=[]))
    monkeypatch.setattr(api, 'record_api_call_success', AsyncMock())
    monkeypatch.setattr(api, 'record_api_call_error', AsyncMock())
    monkeypatch.setattr(api, 'is_smart_429_protection_enabled', lambda: False)
    monkeypatch.setattr(api, 'parse_and_log_cooldown', AsyncMock(return_value=None))
    monkeypatch.setattr(api, 'handle_error_with_retry', AsyncMock(return_value=True))
    if backend == 'antigravity':
        monkeypatch.setattr(api, 'get_antigravity_api_url', AsyncMock(return_value='https://upstream.invalid'))
        monkeypatch.setattr(api, 'get_antigravity_stream2nostream', AsyncMock(return_value=False))
        monkeypatch.setattr(api, 'wrap_cli_request', AsyncMock(return_value=({'request': {}}, 'synthetic')))
    else:
        monkeypatch.setattr(api, 'get_code_assist_endpoint', AsyncMock(return_value='https://upstream.invalid'))
        monkeypatch.setattr(api, 'prepare_request_headers_and_payload', AsyncMock(return_value=(
            {}, {'request': {}}, 'https://upstream.invalid',
        )))
    return api


@pytest.mark.parametrize('backend', ('geminicli', 'antigravity'))
@pytest.mark.parametrize('streaming', (False, True))
async def test_real_httpx_timeout_keeps_retry_budget_and_typed_504(monkeypatch, backend, streaming):
    api = configure(monkeypatch, backend)
    calls = 0

    async def post(**kwargs):
        nonlocal calls
        calls += 1
        raise httpx.ReadTimeout('SENTINEL-timeout')

    async def stream(**kwargs):
        await post(**kwargs)
        if False:
            yield b''

    monkeypatch.setattr(api, 'post_async', post)
    monkeypatch.setattr(api, 'stream_post_async', stream)
    body = {'model': 'synthetic', 'request': {}}
    if streaming:
        outputs = [x async for x in api.stream_request(body, events=True)]
        assert len(outputs) == 1
        response = outputs[0]
    else:
        response = await api.non_stream_request(body, protected=True, record_logical=False)
    assert calls == 2
    assert response.status_code == (503 if backend == 'geminicli' else 500)  # Legacy wire stays intact.
    error = get_attached_model_api_error(response)
    assert error.kind == ErrorKind.TIMEOUT and error.status == 504
    rendered = render_error(error, 'openai')
    assert rendered.status_code == 504 and b'SENTINEL' not in rendered.body


@pytest.mark.parametrize('backend', ('geminicli', 'antigravity'))
async def test_done_only_never_commits_success_before_empty_retry(monkeypatch, backend):
    api = configure(monkeypatch, backend)
    calls = 0

    async def stream(**kwargs):
        nonlocal calls
        calls += 1
        yield b'data: [DONE]\n\n'

    monkeypatch.setattr(api, 'stream_post_async', stream)
    generator = api.stream_request({'model': 'synthetic', 'request': {}}, events=True)
    with pytest.raises(ModelApiErrorException) as caught:
        await generator.__anext__()
    assert caught.value.error.status == 502 and calls == 2
    api.record_api_call_success.assert_not_awaited()


async def test_antigravity_empty_native_response_is_typed_502(monkeypatch):
    api = configure(monkeypatch, 'antigravity')
    post = AsyncMock(return_value=httpx.Response(200, content=b''))
    monkeypatch.setattr(api, 'post_async', post)
    response = await api.non_stream_request({'model': 'synthetic', 'request': {}}, protected=True, record_logical=False)
    assert post.await_count == 2 and response.status_code == 500
    assert get_attached_model_api_error(response).status == 502


@pytest.mark.parametrize('failure', ('empty', 'timeout', 'malformed', 'typed'))
async def test_protected_collector_preserves_type(monkeypatch, failure):
    from src.api.utils import collect_streaming_response
    from src.router.model_api_errors import error_from_http_status

    async def stream():
        if failure == 'timeout':
            raise httpx.ReadTimeout('SENTINEL')
        if failure == 'malformed':
            yield b'data: {SENTINEL}\n\n'
        if failure == 'typed':
            raise ModelApiErrorException(error_from_http_status(429))

    response = await collect_streaming_response(stream(), protected=True)
    expected = {'empty': 502, 'timeout': 504, 'malformed': 502, 'typed': 429}[failure]
    error = get_attached_model_api_error(response)
    assert error.status == expected
    assert b'SENTINEL' not in render_error(error, 'gemini').body


async def test_antigravity_collector_opts_into_normalized_events(monkeypatch):
    api = configure(monkeypatch, 'antigravity')
    monkeypatch.setattr(api, 'get_antigravity_stream2nostream', AsyncMock(return_value=True))
    closed = False

    async def stream(**kwargs):
        nonlocal closed
        assert kwargs['events'] is True
        try:
            yield b'data: {"response":{"usageMetadata":{"totalTokenCount":1}}}\n\n'
            yield b'data: [DONE]\n\n'
        finally:
            closed = True

    monkeypatch.setattr(api, 'stream_request', stream)
    response = await api.non_stream_request({'model': 'synthetic'}, protected=True, record_logical=False)
    assert response.status_code == 200 and closed


@pytest.mark.parametrize('backend', ('geminicli', 'antigravity'))
async def test_local_capacity_breaker_attaches_only_computed_retry(monkeypatch, backend):
    api = configure(monkeypatch, backend)
    monkeypatch.setattr(api, 'is_smart_429_protection_enabled', lambda: True)
    monkeypatch.setattr(api.smart_429_service, 'capacity_admission_retry_after', lambda *args: 7)
    response = api._capacity_breaker_response('synthetic')
    error = get_attached_model_api_error(response)
    assert error.retry_after == 7
    assert render_error(error, 'claude').headers['retry-after'] == '7'


@pytest.mark.parametrize('streaming', (False, True))
async def test_antigravity_final_http_error_still_wins_over_later_timeout(monkeypatch, streaming):
    api = configure(monkeypatch, 'antigravity')
    calls = 0

    async def post(**kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(429, json={'error': {'code': 429, 'message': 'synthetic'}})
        raise httpx.ReadTimeout('SENTINEL')

    async def stream(**kwargs):
        result = await post(**kwargs)
        yield Response(result.content, status_code=result.status_code)

    monkeypatch.setattr(api, 'post_async', post)
    monkeypatch.setattr(api, 'stream_post_async', stream)
    body = {'model': 'synthetic', 'request': {}}
    if streaming:
        response = [x async for x in api.stream_request(body, events=True)][0]
    else:
        response = await api.non_stream_request(body, protected=True, record_logical=False)
    assert calls == 2 and response.status_code == 429
    assert get_attached_model_api_error(response) is None


@pytest.mark.parametrize('backend', ('geminicli', 'antigravity'))
async def test_api_data_then_exception_never_replays(monkeypatch, backend):
    api = configure(monkeypatch, backend)
    calls = 0
    closed = False

    async def stream(**kwargs):
        nonlocal calls, closed
        calls += 1
        try:
            yield b'data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}\n\n'
            raise RuntimeError('synthetic-after-body')
        finally:
            closed = True

    monkeypatch.setattr(api, 'stream_post_async', stream)
    generator = api.stream_request({'model': 'synthetic', 'request': {}}, events=True)
    assert b'partial' in await anext(generator)
    with pytest.raises(RuntimeError, match='synthetic-after-body'):
        await anext(generator)
    assert calls == 1 and closed


@pytest.mark.parametrize('backend', ('geminicli', 'antigravity'))
@pytest.mark.parametrize('streaming', (True, False))
async def test_empty_credential_pool_is_local_503_for_protected_callers(monkeypatch, backend, streaming):
    api = configure(monkeypatch, backend)
    api.credential_manager.get_valid_credential.return_value = None
    body = {'model': 'synthetic', 'request': {}}
    if streaming:
        outputs = [x async for x in api.stream_request(body, events=True)]
        assert len(outputs) == 1
        response = outputs[0]
    else:
        response = await api.non_stream_request(body, protected=True, record_logical=False)
    assert response.status_code == 500  # Unprotected legacy callers keep their wire contract.
    error = get_attached_model_api_error(response)
    assert error.status == 503 and error.origin.value == 'local'
    assert render_error(error, 'gemini').status_code == 503


@pytest.mark.parametrize('backend', ('geminicli', 'antigravity'))
@pytest.mark.parametrize('mode', ('stream-return', 'stream-close', 'stream-cancel', 'nonstream-return', 'nonstream-cancel'))
async def test_request_settles_pending_credential_prefetch(monkeypatch, backend, mode):
    api = configure(monkeypatch, backend)
    started, cancelled, switching = asyncio.Event(), asyncio.Event(), asyncio.Event()
    credential_calls = 0

    async def credentials(**kwargs):
        nonlocal credential_calls
        credential_calls += 1
        if credential_calls == 1:
            return 'synthetic.json', {'access_token': 'synthetic-token', 'project_id': 'synthetic-project'}
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    async def retry(*args, **kwargs):
        await asyncio.wait_for(started.wait(), 1)
        return mode.endswith('cancel')

    async def switch(**kwargs):
        switching.set()
        await asyncio.Event().wait()  # Simulates cooldown sleep while the prefetch runs independently.

    async def stream(**kwargs):
        yield Response('{"error":{"code":429}}', status_code=429)

    monkeypatch.setattr(api.credential_manager, 'get_valid_credential', credentials)
    monkeypatch.setattr(api, 'stream_post_async', stream)
    monkeypatch.setattr(api, 'post_async', AsyncMock(return_value=httpx.Response(429, json={'error': {'code': 429}})))
    monkeypatch.setattr(api, 'handle_error_with_retry', retry)
    monkeypatch.setattr(api, '_switch_credential_for_retry', switch)
    body = {'model': 'synthetic', 'request': {}}
    generator = api.stream_request(body, events=True) if mode.startswith('stream') else None
    if mode.endswith('cancel'):
        request_task = asyncio.create_task(anext(generator) if generator else api.non_stream_request(body, record_logical=False))
        await asyncio.wait_for(switching.wait(), 1)
        request_task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await request_task
    elif mode == 'stream-close':
        assert isinstance(await anext(generator), Response)
        await generator.aclose()
    elif generator:
        assert len([x async for x in generator]) == 1
    else:
        assert isinstance(await api.non_stream_request(body, record_logical=False), Response)
    assert started.is_set() and cancelled.is_set()


@pytest.mark.parametrize('backend', ('geminicli', 'antigravity'))
@pytest.mark.parametrize('failure,expected_status', [('timeout', 504), ('bad_format', 502), ('retirement', 404), ('http', 503)])
async def test_anti_truncation_round_two_failure_keeps_type_and_stops(monkeypatch, backend, failure, expected_status):
    from fastapi.responses import StreamingResponse
    from src.converter.anti_truncation import AntiTruncationStreamProcessor
    from src.httpx_client import normalize_sse_events, _retirement_checked_events
    from src.router.model_api_errors import attach_model_api_error, make_model_api_error, ErrorOrigin, protect_streaming_response

    api = configure(monkeypatch, backend)
    monkeypatch.setattr(api, 'get_retry_config', AsyncMock(return_value={
        'max_retries': 0, 'retry_interval': 0, 'retry_enabled': True, 'smart_429': False,
    }))
    calls = 0
    closed = []

    async def upstream(**kwargs):
        nonlocal calls
        calls += 1
        number = calls
        try:
            if number == 1:
                yield b'data: {"candidates":[{"content":{"parts":[{"text":"partial answer"}]}}]}\n\n'
                yield b'data: [DONE]\n\n'
            elif failure == 'timeout':
                raise httpx.ReadTimeout('SENTINEL')
            elif failure == 'bad_format':
                yield attach_model_api_error(Response('SENTINEL', status_code=400), make_model_api_error(
                    origin=ErrorOrigin.UPSTREAM, kind=ErrorKind.BAD_FORMAT,
                ))
            elif failure == 'http':
                yield Response('SENTINEL', status_code=503)
            else:
                async def raw():
                    yield b'data: {"candidates":[{"content":{"parts":[{"text":"Gemini synthetic-retired is no longer available."}]}}]}\n\n'
                async for event in _retirement_checked_events(normalize_sse_events(raw())):
                    yield event
        finally:
            closed.append(number)

    monkeypatch.setattr(api, 'stream_post_async', upstream)

    async def request(body):
        return StreamingResponse(api.stream_request(body, events=True))

    processor = AntiTruncationStreamProcessor(request, {'model': 'synthetic', 'request': {'contents': []}}, max_attempts=3)
    response = await protect_streaming_response(StreamingResponse(processor.process_stream()), 'openai')
    chunks = [x async for x in response.body_iterator]
    errors = [json.loads(line[6:])['error'] for chunk in chunks for line in chunk.splitlines() if line.startswith(b'data: {') and b'"error"' in line]
    assert len(errors) == 1 and errors[0]['code'] == expected_status
    assert calls == processor.current_attempt == 2 and closed == [1, 2]
    assert b'SENTINEL' not in b''.join(chunks) and b'synthetic-retired' not in b''.join(chunks)
    assert b''.join(chunks).count(b'data: [DONE]') == 1  # Error renderer only, no success tail.
