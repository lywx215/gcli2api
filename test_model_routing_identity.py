import asyncio
from copy import deepcopy
from dataclasses import replace
import json

import pytest
from fastapi import Response
from fastapi.responses import StreamingResponse
from starlette.background import BackgroundTask
from starlette.requests import Request

from src.model_routing.public_response import adapt_public_response, rewrite_success_identity
from src.router.model_api_errors import (
    ModelApiProtocol, activate_logical_request_recording, attach_model_api_error,
    error_from_http_status, is_rendered_model_api_error, protect_streaming_response,
    render_error, render_error_event,
)
from test_model_routing_transport import context


def ctx(protocol='gemini', name='public-alpha-high-search'):
    return replace(context(), protocol=ModelApiProtocol(protocol), requested_model=name)


@pytest.mark.parametrize('wrapped', [False, True])
def test_gemini_identity_whitelist_and_deep_fidelity(wrapped):
    nested = {
        'candidates': [{'content': {'parts': [
            {'text': 'synthetic-target', 'thoughtSignature': 'synthetic-signature'},
            {'functionCall': {'name': 'lookup', 'args': {'model': 'synthetic-target'}}},
        ]}, 'groundingMetadata': {'groundingChunks': [{'web': {'uri': 'https://example.com/synthetic-target'}}]}}],
        'usageMetadata': {'promptTokenCount': 0}, 'modelVersion': 'synthetic-target', 'model': 'synthetic-target',
    }
    payload = {'response': nested, 'modelVersion': 'outer-target'} if wrapped else nested
    original = deepcopy(payload)
    result = rewrite_success_identity(payload, protocol='gemini', requested_model='public-alpha-high-search')
    obj = result['response'] if wrapped else result
    obj['modelVersion'], obj['model'] = nested['modelVersion'], nested['model']
    if wrapped:
        result['modelVersion'] = payload['modelVersion']
    assert result == original and payload == original


def test_gemini_hi_without_version_gets_full_requested_identity():
    payload = {'candidates': [{'content': {'parts': [{'text': 'Hi!'}]}, 'finishReason': 'STOP'}]}
    result = rewrite_success_identity(payload, protocol='gemini', requested_model='Hi-public-high')
    assert result['modelVersion'] == 'Hi-public-high' and result['candidates'] == payload['candidates']


@pytest.mark.parametrize('protocol,payload,identity_path', [
    ('openai', {'model': 'synthetic-target', 'choices': [{'message': {'content': 'synthetic-target', 'model': 'inside'}}]}, ('model',)),
    ('openai', {'choices': [], 'usage': {'total_tokens': 0}}, ('model',)),
    ('claude', {'type': 'message', 'model': 'synthetic-target', 'content': [{'type': 'tool_use', 'input': {'model': 'inside'}}]}, ('model',)),
    ('claude', {'type': 'message_start', 'message': {'model': 'synthetic-target', 'content': [{'model': 'inside'}]}}, ('message', 'model')),
])
def test_compatibility_identity_never_rewrites_nested_user_model(protocol, payload, identity_path):
    original = deepcopy(payload)
    result = rewrite_success_identity(payload, protocol=protocol, requested_model='public-alpha')
    expected = deepcopy(payload)
    target = expected
    for key in identity_path[:-1]:
        target = target[key]
    target[identity_path[-1]] = 'public-alpha'
    assert result == expected and payload == original


async def test_json_adaptation_preserves_response_private_state_background_headers():
    background = BackgroundTask(lambda: None)
    response = Response(json.dumps({'candidates': [], 'modelVersion': 'synthetic-target'}), media_type='application/json', headers={'x-test': 'keep'}, background=background)
    response.private = object()
    token = response.private
    adapted = await adapt_public_response(response, route_context=ctx())
    assert adapted is response and adapted.private is token and adapted.background is background
    assert adapted.headers['content-length'] == str(len(adapted.body))
    assert adapted.headers['content-type'] == 'application/json' and adapted.headers['x-test'] == 'keep'
    assert json.loads(adapted.body)['modelVersion'] == 'public-alpha-high-search'
    assert await adapt_public_response(adapted, route_context=ctx()) is response


@pytest.mark.parametrize('rendered', [False, True])
async def test_existing_error_response_marker_preserved(rendered):
    error = error_from_http_status(429)
    response = render_error(error, 'gemini') if rendered else attach_model_api_error(Response(status_code=429), error)
    assert await adapt_public_response(response, route_context=ctx()) is response
    assert is_rendered_model_api_error(response) is rendered


@pytest.mark.parametrize('protocol', ['gemini', 'openai', 'claude'])
async def test_sse_final_protocol_events_controls_bytes_and_metadata(protocol):
    if protocol == 'gemini':
        payload = {'candidates': [{'index': 7, 'content': {'parts': [{'text': '你好', 'thoughtSignature': 'synthetic'}]}}], 'modelVersion': 'synthetic-target'}
        tail = {'usageMetadata': {'totalTokenCount': 0}, 'modelVersion': 'synthetic-tail'}
    elif protocol == 'openai':
        payload = {'choices': [{'index': 0, 'delta': {'content': '你好'}}], 'model': 'synthetic-target'}
        tail = {'choices': [], 'usage': {'total_tokens': 0}, 'model': 'synthetic-tail'}
    else:
        payload = {'type': 'message_start', 'message': {'model': 'synthetic-target', 'usage': {'input_tokens': 0}}}
        tail = {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn'}, 'usage': {'output_tokens': 0}}
    raw = ': heartbeat\r\n\r\nevent: message_start\r\nid: synthetic-id\r\nretry: 0\r\ndata: ' + json.dumps(payload, ensure_ascii=False) + '\r\n\r\nevent: tail\r\ndata: ' + json.dumps(tail) + '\r\n\r\ndata: [DONE]\r\n\r\n'
    closed = []
    async def source():
        try:
            for byte in raw.encode():
                yield bytes([byte])
        finally:
            closed.append(True)
    response = StreamingResponse(source(), headers={'content-length': 'wrong'})
    original = response
    response = await adapt_public_response(response, route_context=ctx(protocol))
    body = b''.join([item async for item in response.body_iterator])
    assert response is original and 'content-length' not in response.headers
    assert b'event: message_start\n' in body and b'event: tail\n' in body
    assert b'id: synthetic-id\nretry: 0\n' in body and b': heartbeat\n\n' in body
    assert b'synthetic-target' not in body and b'synthetic-tail' not in body
    assert body.count(b'data: [DONE]') == 1 and closed == [True]
    outputs = [json.loads(line[6:]) for line in body.decode().split('\n') if line.startswith('data: {')]
    assert outputs[0] == rewrite_success_identity(payload, protocol=protocol, requested_model=ctx(protocol).requested_model)
    assert outputs[1] == rewrite_success_identity(tail, protocol=protocol, requested_model=ctx(protocol).requested_model)


async def test_first_bad_frame_is_safe_before_headers_and_closes_background_once():
    closed, background = [], []
    async def source():
        try:
            yield b'data: {synthetic-target}\n\n'
        finally:
            closed.append(True)
    response = StreamingResponse(source(), background=BackgroundTask(lambda: background.append(True)))
    adapted = await adapt_public_response(response, route_context=ctx('openai'))
    assert adapted.status_code == 502 and is_rendered_model_api_error(adapted)
    assert b'synthetic-target' not in adapted.body and closed == background == [True]


@pytest.mark.parametrize('already_protected', [False, True])
async def test_parse_failure_inside_protection_and_single_logical_outcome(already_protected):
    closed, recorded = [], []
    async def source():
        try:
            yield b'data: {"choices":[{"delta":{"content":"body"}}],"model":"synthetic-target"}\n\n'
            yield b'data: {synthetic-target}\n\n'
        finally:
            closed.append(True)
    request = Request({'type': 'http', 'method': 'POST', 'path': '/', 'headers': []})
    async def record(request, success):
        recorded.append(success)
    activate_logical_request_recording(request, record)
    response = StreamingResponse(source())
    if already_protected:
        response = await protect_streaming_response(response, 'openai', request=request, recorder=record)
    response = await adapt_public_response(response, route_context=ctx('openai'))
    response = await protect_streaming_response(response, 'openai', request=request, recorder=record)
    result = b''.join([item async for item in response.body_iterator])
    assert result.count(b'"error"') == 1 and result.count(b'data: [DONE]') == 1
    assert b'synthetic-target' not in result and b'body' in result
    assert recorded == [False] and closed == [True]


@pytest.mark.parametrize('protocol', ['gemini', 'openai', 'claude'])
async def test_fixed_rendered_error_event_not_translated_again(protocol):
    error_event = render_error_event(error_from_http_status(429), protocol)
    async def source():
        yield b': heartbeat\n\n'
        yield error_event
        raise AssertionError('should not resume after rendered terminal error')
    response = await adapt_public_response(StreamingResponse(source()), route_context=ctx(protocol))
    result = [x async for x in response.body_iterator]
    assert result[-1] is error_event and b''.join(result).count(b'data: {') == 1


async def test_cancellation_closes_upstream_without_success_recording():
    closed = []
    async def source():
        try:
            yield b': heartbeat\n\n'
            raise asyncio.CancelledError()
        finally:
            closed.append(True)
    response = await adapt_public_response(StreamingResponse(source()), route_context=ctx())
    with pytest.raises(asyncio.CancelledError):
        _ = [x async for x in response.body_iterator]
    assert closed == [True]


async def test_concurrent_responses_keep_request_names_independent():
    async def run(name):
        response = Response('{"model":"synthetic-target","choices":[]}', media_type='application/json')
        adapted = await adapt_public_response(response, route_context=ctx('openai', name))
        return json.loads(adapted.body)['model']
    assert await asyncio.gather(run('public-a'), run('public-b')) == ['public-a', 'public-b']


@pytest.mark.parametrize('channel', ['geminicli', 'antigravity'])
@pytest.mark.parametrize('bad', [False, True])
async def test_real_stream_builder_identity_closes_and_records_one_outcome(monkeypatch, channel, bad):
    from src.router import stream_passthrough
    outcomes, closed = [], []
    async def record(model, mode, success):
        outcomes.append((model, mode, success))
    monkeypatch.setattr(stream_passthrough, 'record_logical_request', record)
    async def source():
        try:
            yield b'data: {"candidates":[{"content":{"parts":[{"text":"body"}]},"finishReason":"STOP"}],"modelVersion":"synthetic-target"}\n\n'
            if bad:
                yield b'data: {"candidates":[{"content":{"parts":[{"text":"Gemini synthetic-model is no longer available."}]}}]}\n\n'
            else:
                yield b'data: [DONE]\n\n'
        finally:
            closed.append(True)
    response = await stream_passthrough.build_streaming_response_or_error(source(), model_name='synthetic-target', mode=channel, protected=True, protocol='gemini')
    response = await adapt_public_response(response, route_context=replace(ctx(), channel=channel))
    body = b''.join([x async for x in response.body_iterator])
    assert outcomes == [('synthetic-target', channel, not bad)] and closed == [True]
    assert b'public-alpha-high-search' in body and b'synthetic-target' not in body
    assert (b'"error"' in body) is bad


@pytest.mark.parametrize('channel', ['geminicli', 'antigravity'])
@pytest.mark.parametrize('already_protected', [False, True])
async def test_header_disconnect_closes_actual_prefetched_source_once(monkeypatch, channel, already_protected):
    from src.router import stream_passthrough
    outcomes = []
    async def record(*args):
        outcomes.append(args)
    monkeypatch.setattr(stream_passthrough, 'record_logical_request', record)
    class Source:
        def __init__(self):
            self.closes = 0
        def __aiter__(self):
            return self
        async def __anext__(self):
            return b'data: {"candidates":[{"content":{"parts":[{"text":"body"}]},"finishReason":"STOP"}]}\n\n'
        async def aclose(self):
            self.closes += 1
    source = Source()
    response = await stream_passthrough.build_streaming_response_or_error(source, model_name='synthetic-target', mode=channel, protected=True, protocol='gemini')
    if already_protected:
        response = await protect_streaming_response(response, 'gemini')
    response = await adapt_public_response(response, route_context=replace(ctx(), channel=channel))
    async def send(message):
        raise RuntimeError('synthetic header disconnect')
    async def receive():
        return {'type': 'http.disconnect'}
    with pytest.raises(RuntimeError, match='synthetic header disconnect'):
        await response({'type': 'http', 'asgi': {'spec_version': '2.4'}, 'method': 'POST', 'path': '/', 'headers': []}, receive, send)
    assert source.closes == 1 and outcomes == []


async def test_preprotected_custom_iterator_close_is_idempotent():
    class Source:
        def __init__(self):
            self.closes, self.cursor = 0, 0
        def __aiter__(self):
            return self
        async def __anext__(self):
            self.cursor += 1
            if self.cursor > 1:
                raise StopAsyncIteration()
            return b'data: {"choices":[],"model":"synthetic-target"}\n\n'
        async def aclose(self):
            self.closes += 1
    source = Source()
    response = await protect_streaming_response(StreamingResponse(source), 'openai')
    response = await adapt_public_response(response, route_context=ctx('openai'))
    _ = [x async for x in response.body_iterator]
    assert source.closes == 1


@pytest.mark.parametrize('already_protected', [False, True])
async def test_header_cancel_scope_shields_required_resource_cleanup(monkeypatch, already_protected):
    import anyio
    from src.antigravity_limits import GenerationBudget
    from src.router import stream_passthrough

    outcomes, budget_closes = [], []
    async def record(*args):
        outcomes.append(args)
    monkeypatch.setattr(stream_passthrough, 'record_logical_request', record)
    original_close = GenerationBudget.close
    async def close_budget(self):
        await anyio.sleep(0)
        await original_close(self)
        budget_closes.append(True)
    monkeypatch.setattr(GenerationBudget, 'close', close_budget)

    class Source:
        closes = 0
        def __aiter__(self):
            return self
        async def __anext__(self):
            return b'data: {"candidates":[{"content":{"parts":[{"text":"body"}]},"finishReason":"STOP"}]}\n\n'
        async def aclose(self):
            await anyio.sleep(0)
            self.closes += 1
    source = Source()
    response = await stream_passthrough.build_streaming_response_or_error(
        source, model_name='synthetic-target', mode='antigravity', protected=True, protocol='gemini')
    if already_protected:
        response = await protect_streaming_response(response, 'gemini')
    response = await adapt_public_response(response, route_context=ctx())
    with anyio.CancelScope() as cancel_scope:
        async def send(message):
            cancel_scope.cancel()
            await anyio.sleep(0)
        async def receive():
            return {'type': 'http.disconnect'}
        await response({'type': 'http', 'asgi': {'spec_version': '2.4'}, 'method': 'POST',
                        'path': '/', 'headers': []}, receive, send)
    assert source.closes == 1
    assert budget_closes == [True]
    assert outcomes == []


@pytest.mark.parametrize('protocol', ['gemini', 'openai', 'claude'])
async def test_public_unicode_separators_stay_escaped_without_changing_payload(protocol):
    separators = '\u0085\u2028\u2029'
    if protocol == 'gemini':
        payload = {'candidates': [{'content': {'parts': [
            {'text': '正文' + separators, 'thoughtSignature': 'synthetic' + separators}]}}]}
    elif protocol == 'openai':
        payload = {'choices': [{'delta': {'content': '正文' + separators,
                   'tool_calls': [{'function': {'arguments': separators}}]}}]}
    else:
        payload = {'type': 'content_block_delta', 'delta': {
            'type': 'text_delta', 'text': '正文' + separators}, 'signature': 'synthetic' + separators}
    async def source():
        yield ('data: ' + json.dumps(payload, ensure_ascii=False) + '\n\n').encode()
    response = await adapt_public_response(StreamingResponse(source()), route_context=ctx(protocol))
    body = b''.join([event async for event in response.body_iterator])
    assert not any(char.encode() in body for char in separators)
    assert json.loads(body[6:]) == rewrite_success_identity(
        payload, protocol=protocol, requested_model=ctx(protocol).requested_model)
