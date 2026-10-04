import asyncio
import json
from unittest.mock import AsyncMock

import httpx
import pytest
from src import antigravity_limits as limits
from src.api import antigravity
from src.router import stream_passthrough as router
from src.httpx_client import _bounded_response
from test_antigravity_stream_replay import _configure_stream

BODY = b'data: {"candidates":[{"content":{"parts":[{"text":"hello"}]}}]}\n\n'


@pytest.fixture
def short_limits(monkeypatch):
    policy = limits.GenerationLimits(first=.08, idle=.08, total=.10, headers=.03)
    monkeypatch.setattr(limits.GenerationLimits, 'load', classmethod(lambda cls: policy))
    counter = AsyncMock()
    monkeypatch.setattr(router, 'record_logical_request', counter)
    return policy, counter


@pytest.mark.parametrize('frame', [
    {'candidates':[{'content':{'parts':[{'thought':True,'text':'thinking'}]}}]},
    {'candidates':[{'content':{'parts':[{'functionCall':{'name':'lookup','args':{}}}]}}]},
    {'candidates':[{'content':{'parts':[{'inlineData':{'data':'synthetic'}}]}}]},
    {'choices':[{'delta':{'tool_calls':[{'index':0,'function':{'arguments':'{'}}]}}]},
    {'delta':{'type':'thinking_delta','thinking':'work'}},
    {'delta':{'type':'input_json_delta','partial_json':'{}'}},
])
def test_content_shapes_are_progress(frame):
    assert limits.meaningful_frame('data: '+json.dumps(frame))


@pytest.mark.parametrize('frame', [b': ping', b'', b'data: [DONE]',
    b'data: {"usageMetadata":{"totalTokenCount":3}}', b'data: {"choices":[{"delta":{"role":"assistant"}}]}'])
def test_metadata_is_not_progress(frame):
    assert not limits.meaningful_frame(frame)


async def test_first_deadline_closes_stream_and_counts_once(short_limits):
    closed = asyncio.Event()
    async def stalled():
        try:
            await asyncio.sleep(5)
            yield BODY
        finally:
            closed.set()
    response = await router.build_streaming_response_or_error(stalled(), mode='antigravity', model_name='test')
    assert response.status_code == 504
    assert closed.is_set()
    short_limits[1].assert_awaited_once_with('test', 'antigravity', False)


@pytest.mark.parametrize('protocol', ['gemini','openai','anthropic'])
async def test_idle_error_is_protocol_event_and_not_success(short_limits, protocol):
    async def stream():
        yield BODY
        while True:
            await asyncio.sleep(.01)
            yield b': ping\n\n'
    response = await router.build_streaming_response_or_error(stream(), mode='antigravity', model_name='test', protocol=protocol)
    chunks = [chunk async for chunk in response.body_iterator]
    assert b'timeout_error' in chunks[-1]
    assert (chunks[-1].startswith(b'event: error')) == (protocol == 'anthropic')
    assert b'[DONE]' not in chunks[-1]
    short_limits[1].assert_awaited_once_with('test', 'antigravity', False)


async def test_heartbeats_do_not_extend_first_deadline(short_limits):
    async def stream():
        while True:
            yield b': ping\n\n'
            await asyncio.sleep(.01)
    response = await router.build_streaming_response_or_error(stream(), mode='antigravity', model_name='test')
    chunks = [c async for c in response.body_iterator]
    assert b'DEADLINE_EXCEEDED' in chunks[-1]


async def test_active_stream_outlives_first_and_total(short_limits):
    async def stream():
        for _ in range(8):
            await asyncio.sleep(.025)
            yield BODY
    response = await router.build_streaming_response_or_error(stream(), mode='antigravity', model_name='test')
    chunks = [c async for c in response.body_iterator]
    assert chunks == [BODY]*8
    short_limits[1].assert_awaited_once_with('test', 'antigravity', True)


async def test_disconnect_closes_upstream_without_outcome(short_limits):
    closed = asyncio.Event()
    async def stream():
        try:
            yield BODY
            await asyncio.sleep(5)
        finally:
            closed.set()
    response = await router.build_streaming_response_or_error(stream(), mode='antigravity', model_name='test')
    assert await anext(response.body_iterator) == BODY
    task = asyncio.create_task(anext(response.body_iterator))
    await asyncio.sleep(.01)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert closed.is_set()
    short_limits[1].assert_not_awaited()


async def test_retry_and_credential_wait_share_budget(short_limits, monkeypatch):
    calls = 0
    async def upstream(**kwargs):
        nonlocal calls
        calls += 1
        assert kwargs['timeout'].connect == 15
        await asyncio.sleep(.01 if calls == 1 else 5)
        raise httpx.ConnectTimeout('synthetic')
        yield
    await _configure_stream(monkeypatch, upstream)
    chunks = [c async for c in antigravity.stream_request({'model':'test'})]
    assert calls == 2
    assert chunks[-1].status_code == 504


async def test_nonstream_and_fake_stream_have_total_budget(short_limits, monkeypatch):
    async def stalled(**kwargs):
        await asyncio.sleep(5)
    monkeypatch.setattr(antigravity, '_non_stream_request', stalled)
    response = await antigravity.non_stream_request({'model':'test'}, record_logical=False)
    assert response.status_code == 504
    async def fake():
        yield await antigravity.non_stream_request({'model':'test'}, record_logical=False)
    response = await router.build_streaming_response_or_error(fake(), mode='antigravity', model_name='test', non_stream=True)
    assert response.status_code == 504


async def test_nested_continuation_does_not_reset_budget(short_limits):
    budget = limits.GenerationBudget(short_limits[0])
    async def attempt():
        assert limits.current_budget.get() is budget
        await asyncio.sleep(.05)
    await budget.run(attempt())
    with pytest.raises(limits.GenerationTimeout):
        await budget.run(attempt())


async def test_header_timer_starts_after_body_transmission():
    closed = asyncio.Event()
    class Client:
        def build_request(self, *args, **kwargs):
            return kwargs['extensions']['trace']
        async def send(self, trace, **kwargs):
            try:
                await asyncio.sleep(.06)  # request transmission may exceed header timeout
                await trace('http11.send_request_body.complete', {})
                await asyncio.sleep(5)
            finally:
                closed.set()
    with pytest.raises(TimeoutError):
        async with _bounded_response(Client(), 'https://example.test', header_timeout=.03):
            pytest.fail('headers never arrived')
    assert closed.is_set()


async def test_header_response_is_closed_on_cancellation():
    response = httpx.Response(200)
    response.aclose = AsyncMock()
    class Client:
        def build_request(self, *args, **kwargs):
            return None
        async def send(self, *args, **kwargs):
            return response
    async with _bounded_response(Client(), 'https://example.test', header_timeout=.03):
        pass
    response.aclose.assert_awaited_once()

@pytest.mark.parametrize('protocol', ['gemini', 'openai', 'anthropic'])
@pytest.mark.parametrize('kind', ['normal', 'fake', 'continuation'])
async def test_real_routes_timeout_before_first_content(short_limits, monkeypatch, protocol, kind):
    from src.router.antigravity import gemini, openai, anthropic
    from src.models import GeminiRequest, OpenAIChatCompletionRequest, ClaudeRequest
    from src.converter import antigravity_fix, openai2gemini, anthropic2gemini
    module = {'gemini':gemini, 'openai':openai, 'anthropic':anthropic}[protocol]
    # Mode selection is now captured once by the real routing snapshot. Use
    # the existing public prefixes rather than patching obsolete local helpers.
    model = {'fake': '假流式/', 'continuation': '抗截断/'}.get(kind, '') + 'gemini-3.7-flash'
    monkeypatch.setattr(module, 'get_anti_truncation_max_attempts', AsyncMock(return_value=2))
    async def normalized(body, **kwargs):
        return dict(body)
    monkeypatch.setattr(antigravity_fix, 'normalize_antigravity_request', normalized)
    monkeypatch.setattr(openai2gemini, 'convert_openai_to_gemini_request', normalized)
    monkeypatch.setattr(anthropic2gemini, 'anthropic_to_gemini_request', normalized)
    async def source(**kwargs):
        await asyncio.sleep(5)
        yield BODY
    async def nonstream(**kwargs):
        await asyncio.sleep(5)
    monkeypatch.setattr(antigravity, 'stream_request', source)
    monkeypatch.setattr(antigravity, 'non_stream_request', nonstream)
    if protocol == 'gemini':
        request = GeminiRequest(contents=[{'role':'user','parts':[{'text':'synthetic prompt'}]}])
        response = await module.stream_generate_content(request, model=model)
    elif protocol == 'openai':
        request = OpenAIChatCompletionRequest(model=model, messages=[{'role':'user','content':'synthetic prompt'}], stream=True)
        response = await module.chat_completions(request)
    else:
        request = ClaudeRequest(model=model, messages=[{'role':'user','content':'synthetic prompt'}], max_tokens=50, stream=True)
        response = await module.messages(request)
    assert response.status_code == 504
    short_limits[1].assert_awaited_once_with('gemini-3.7-flash-medium', 'antigravity', False)

async def test_stream_collection_applies_idle_inside_total_budget(short_limits):
    budget = limits.GenerationBudget(short_limits[0], non_stream=True, streaming=True)
    budget.observe(BODY)
    with pytest.raises(limits.GenerationTimeout):
        await budget.run(asyncio.sleep(.09))


async def test_nested_converter_cannot_swallow_timeout(short_limits):
    budget = limits.GenerationBudget(short_limits[0])
    async def converter():
        try:
            await budget.run(asyncio.sleep(5))
        except TimeoutError:
            return 'normal completion'
    with pytest.raises(limits.GenerationTimeout):
        await budget.run(converter())

async def test_real_http_header_trickle_is_bounded():
    handlers = []
    async def serve(reader, writer):
        handlers.append(asyncio.current_task())
        try:
            await reader.readuntil(b'\r\n\r\n')
            # Keep individual socket reads active, but never finish the headers.
            writer.write(b'HTTP/1.1 200 OK\r\nX-Slow: ')
            await writer.drain()
            while True:
                writer.write(b'x')
                await writer.drain()
                await asyncio.sleep(.005)
        finally:
            writer.close()
    server = await asyncio.start_server(serve, '127.0.0.1', 0)
    port = server.sockets[0].getsockname()[1]
    try:
        async with httpx.AsyncClient(trust_env=False, timeout=httpx.Timeout(connect=1,write=1,pool=1,read=None)) as client:
            with pytest.raises(TimeoutError):
                async with _bounded_response(client, f'http://127.0.0.1:{port}', header_timeout=.04, json={}):
                    pytest.fail('incomplete headers must time out')
    finally:
        server.close()
        await server.wait_closed()
        for handler in handlers:
            handler.cancel()
        await asyncio.gather(*handlers, return_exceptions=True)

async def test_disconnect_while_sending_headers_closes_prefetched_source(short_limits):
    closed = asyncio.Event()
    async def source():
        try:
            yield BODY
        finally:
            closed.set()
    response = await router.build_streaming_response_or_error(source(), mode='antigravity', model_name='test')
    async def send(message):
        assert message['type'] == 'http.response.start'
        raise asyncio.CancelledError()
    with pytest.raises(asyncio.CancelledError):
        await response({'type':'http','asgi':{'spec_version':'2.4'}}, AsyncMock(), send)
    assert closed.is_set()
    short_limits[1].assert_not_awaited()
