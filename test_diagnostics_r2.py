"""R2 classification and deterministic server/attempt lifecycle regressions."""
import asyncio
import json

import httpx
import pytest
import log

from src.diagnostics import semantic
from src.diagnostics.asgi import DiagnosticsMiddleware
from src.diagnostics.http import DiagnosticAsyncClient
from test_diagnostics_runtime import records, request_context, terminal, rt
from test_diagnostics_service import running, payload, read_records


def model_frame(kind='success'):
    candidate = {'content': {'parts': [{'text': ' ' if kind == 'empty' else 'synthetic answer'}]}}
    if kind != 'incomplete':
        candidate['finishReason'] = 'SAFETY' if kind == 'blocked' else 'STOP'
    return {'candidates': [candidate]}


@pytest.mark.parametrize('eof', [False, True])
@pytest.mark.parametrize('done', [False, True])
@pytest.mark.parametrize('kind', ['success','empty','blocked','incomplete','parse','http429','http503','frame_error'])
def test_reason_matrix(records, kind, done, eof):
    with request_context() as server:
        attempt = semantic.Attempt(1, 'synthetic')
        attempt.http_observed, attempt.http_eof = True, eof
        if kind.startswith('http'):
            attempt.chunk(httpx.Response(int(kind[4:])), False)
        elif kind == 'parse':
            attempt.line(b'data: {')
        else:
            obj = {'error': {'code': 503}} if kind == 'frame_error' else model_frame(kind)
            attempt.line('data: ' + json.dumps(obj))
        if done: attempt.line(b'data: [DONE]')
        semantic.safe_finish(attempt)
        terminal(server)
    data = next(r['data'] for r in records if r['event']=='upstream.attempt_finished')
    result = {'http429':'error', 'http503':'error', 'frame_error':'error', 'parse':'incomplete'}.get(kind, kind)
    if kind == 'success' and not eof: result = 'incomplete'
    expected = ('upstream', 'unknown')
    if kind == 'success': expected = ('none', 'none') if eof else ('local', 'read')
    elif kind == 'incomplete' and not eof and not done: expected = ('unknown', 'read')
    elif kind == 'parse': expected = ('upstream', 'parse')
    elif kind.startswith('http'): expected = ('upstream', 'dispatch')
    assert (data['resultClass'], data['failureOrigin'], data['failureStage'], data['eofSeen']) == (result, *expected, eof)
    expected_error = {'error':'other', 'success':'none'}.get(result, result)
    if kind == 'http429': expected_error = 'resource_exhausted_unknown'
    assert data['errorClass'] == expected_error


@pytest.mark.parametrize('ending', ['normal','cancel','disconnect','error'])
@pytest.mark.parametrize('late', ['close','eof'])
async def test_held_generator_settled_before_server_seal(records, ending, late):
    held, attempts, servers, messages = [], [], [], []
    obj = model_frame()
    frame = ('data: ' + json.dumps(obj) + '\n\n').encode()
    class Body(httpx.AsyncByteStream):
        closed = 0
        async def __aiter__(self):
            yield frame
            yield b'data: [DONE]\n\n'
        async def aclose(self): self.closed += 1
    body = Body()
    original = asyncio.CancelledError() if ending in ('cancel','disconnect') else RuntimeError('business')
    async def app(scope, receive, send):
        servers.append(rt.active_server())
        semantic.normalization_start({'contents':[]})
        attempt = semantic.Attempt(1, 'synthetic')
        attempts.append(attempt)
        async def source():
            async with DiagnosticAsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200, stream=body))) as client:
                async with client.stream('POST', 'https://third.test/') as response:
                    async for chunk in response.aiter_bytes(): yield chunk
        stream = semantic.observe_stream(source(), attempt, native=True)
        held.append(stream)  # Strong reference: no GC can settle this attempt.
        assert await anext(stream) == frame
        semantic.conversion_input(obj, 'gemini')
        semantic.conversion_output(obj, 'gemini')
        await send({'type':'http.response.start','status':200,'headers':[]})
        if ending == 'disconnect': await receive()
        if ending != 'normal': raise original
        await send({'type':'http.response.body','body':frame,'more_body':False})
    async def receive(): return {'type':'http.disconnect'}
    async def send(message): messages.append(message)
    try:
        middleware = DiagnosticsMiddleware(app)
        if ending == 'normal':
            await middleware({'type':'http','headers':[]}, receive, send)
            assert messages[-1]['body'] == frame
        else:
            with pytest.raises(type(original)) as caught:
                await middleware({'type':'http','headers':[]}, receive, send)
            assert caught.value is original
        finished = [r for r in records if r['event']=='upstream.attempt_finished']
        assert len(finished) == 1
        assert not [r for r in records if r['event']=='diag.call']
        server_record = next(r for r in records if r['event']=='diag.server')
        conversion = next(r for r in records if r['event']=='response.converted')
        assert conversion['logSeq'] < finished[0]['logSeq'] < server_record['logSeq']
        data = finished[0]['data']
        assert not data['eofSeen']
        assert data['resultClass'] == ('cancelled' if ending in ('cancel','disconnect') else 'incomplete')
        assert data['failureOrigin'] == ('client' if ending=='disconnect' else ('unknown' if ending=='cancel' else 'local'))
        assert not servers[0].open_attempts
        before = json.dumps(finished)
        if late == 'eof':
            assert [x async for x in held[0]] == [b'data: [DONE]\n\n']
        else:
            await held[0].aclose()
        assert json.dumps([r for r in records if r['event']=='upstream.attempt_finished']) == before
        assert len([r for r in records if r['event']=='diag.server']) == 1
        assert records[-1]['event']=='diag.call'
        assert records[-1]['data']['endReason'] == ('eof' if late=='eof' else 'closed_early')
        assert body.closed == 1 and attempts[0].done
    finally:
        for stream in held: await stream.aclose()


def test_pseudo_stream_error_does_not_emit_nonstream_conversion(tmp_path):
    expected = []
    with running(tmp_path,'fake','upstream',scenario='error') as (fake,_):
        with running(tmp_path,'gcli','gcli',fake,nonstream=True) as (origin,root):
            for protocol in ('openai','claude'):
                path,body = payload(protocol,True)
                body['model'] = '假流式/' + body['model']
                response = httpx.post(origin+path,json=body,headers={'authorization':'Bearer synthetic-local-password'},trust_env=False,timeout=10)
                assert response.status_code == 200 and '[DONE]' in response.text
                expected.append(response.headers['x-diag-request-id'])
    rows = read_records(root)
    for request_id in expected:
        assert not [r for r in rows if r['requestId']==request_id and r['event']=='response.converted']


def test_holder_keeps_only_pending_debug_attempts(records, monkeypatch):
    with request_context() as server:
        for number in range(1, 51):
            attempt = semantic.Attempt(number, 'synthetic')
            assert list(server.open_attempts.values()) == [attempt]
            semantic.safe_finish(attempt)
            assert not server.open_attempts
        broken = semantic.Attempt(51, 'synthetic')
        def fail(*args): raise RuntimeError('observer failure')
        monkeypatch.setattr(broken, '_finish_observation', fail)
        semantic.finish_attempts(server)
        assert broken.done and not server.open_attempts
        interrupted = semantic.Attempt(52, 'synthetic')
        log.set_log_level('info')
        disabled = semantic.Attempt(53, 'synthetic')
        assert list(server.open_attempts.values()) == [interrupted]
        count = len(records)
        semantic.finish_attempts(server)
        semantic.safe_finish(disabled)
        semantic.finish_attempts(server)
        assert not server.open_attempts and len(records) == count
        terminal(server)
    assert records[-1]['data']['coverage']['debugCapture']=='interrupted'
    assert records[-1]['data']['coverage']['droppedForSpan']==1


async def test_claude_placeholder_zero_is_only_converted_usage(records):
    from src.converter.anthropic2gemini import gemini_stream_to_anthropic_stream
    frame = ('data: ' + json.dumps(model_frame('incomplete')) + '\n\n').encode()
    async def source(): yield frame
    with request_context() as server:
        semantic.normalization_start({'contents':[]})
        stream = gemini_stream_to_anthropic_stream(source(), 'synthetic', 200)
        start = await anext(stream)
        assert b'message_start' in start
        delivered = json.loads(start.decode().split('data: ',1)[1])
        assert delivered['message']['usage']['output_tokens']==0
        semantic.finish_conversions(server)
        terminal(server)
        await stream.aclose()
    conversion = next(r['data'] for r in records if r['event']=='response.converted')
    assert conversion['deliveredUsage']['outputTotal']==dict(value=0, present=True, source='converted')
    assert conversion['upstreamUsage']['candidate']==dict(value=None, present=False, source='unknown')


@pytest.mark.parametrize('protocol', ['openai','claude'])
def test_non_2xx_error_converter_returns_before_observation(records, protocol):
    from src.converter.openai2gemini import convert_gemini_to_openai_response
    from src.converter.anthropic2gemini import gemini_to_anthropic_response
    convert = convert_gemini_to_openai_response if protocol=='openai' else gemini_to_anthropic_response
    with request_context() as server:
        semantic.normalization_start({'contents':[]})
        assert 'error' in convert({'error': {'code':503, 'message':'synthetic'}}, 'synthetic', 503)
        terminal(server)
    assert not [r for r in records if r['event']=='response.converted']
