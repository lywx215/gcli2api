"""Review regressions: observation must not change business outcomes."""
import asyncio
import json
import os
import subprocess
import sys

import httpx
import pytest

import log
from src.diagnostics import semantic
from src.diagnostics.http import DiagnosticAsyncClient, compatible_httpx
from test_diagnostics_runtime import records, request_context, terminal, peers, rt, Stream


@pytest.mark.parametrize('debug', [False, True])
@pytest.mark.parametrize('body', [b'[]', b'"text"', b'[' * 2000 + b'0' + b']' * 2000, b'{'])
async def test_buffered_malformed_observation_is_passthrough(records, debug, body):
    log.set_log_level('debug' if debug else 'info')
    response = httpx.Response(200, content=body)
    async def business(): return response
    with request_context() as server:
        result = await semantic.observe_post(business(), semantic.Attempt(1, 'synthetic'))
        assert result is response and result.content == body
        terminal(server)
    if debug:
        data = next(r['data'] for r in records if r['event'] == 'upstream.attempt_finished')
        assert data['resultClass'] == 'incomplete' and data['failureStage'] == 'parse'


@pytest.mark.parametrize('cancel', [False, True])
async def test_observation_and_cleanup_preserve_original_error(records, monkeypatch, cancel):
    original = asyncio.CancelledError() if cancel else httpx.ReadError('original')
    class Source:
        count = 0
        def __aiter__(self): return self
        async def __anext__(self):
            self.count += 1
            if self.count == 1: return b'data: {}'
            raise original
        async def aclose(self): raise RuntimeError('cleanup')
    def bad(*args): raise RecursionError('diagnostic only')
    monkeypatch.setattr(semantic.Summary, 'observe', bad)
    with request_context() as server:
        stream = semantic.observe_stream(Source(), semantic.Attempt(1, 'synthetic'))
        assert await anext(stream) == b'data: {}'
        with pytest.raises(type(original)) as caught: await anext(stream)
        assert caught.value is original
        terminal(server)
    data = next(r['data'] for r in records if r['event'] == 'upstream.attempt_finished')
    assert data['failureOrigin'] == ('unknown' if cancel else 'upstream')


async def test_chunk_and_finish_observer_failures_do_not_escape(records, monkeypatch):
    def bad(*args, **kwargs): raise RuntimeError('observation')
    async def source(): yield b'unchanged'
    with request_context() as server:
        attempt = semantic.Attempt(1, 'synthetic')
        monkeypatch.setattr(attempt, 'line', bad)
        assert [chunk async for chunk in semantic.observe_stream(source(), attempt)] == [b'unchanged']
        attempt = semantic.Attempt(2, 'synthetic')
        attempt.buffer = b'pending'
        monkeypatch.setattr(attempt, 'line', bad)
        assert [chunk async for chunk in semantic.observe_stream(source(), attempt)] == [b'unchanged']
        terminal(server)
    assert records[-1]['data']['coverage']['droppedForSpan'] == 1


@pytest.mark.parametrize('allowed', [False, True])
async def test_raw_byte_headers_preserve_case_duplicates_and_nonascii(records, monkeypatch, allowed):
    if allowed: peers(monkeypatch)
    captured = []
    async def upstream(request):
        captured.append(request.headers.raw)
        return httpx.Response(200, content=b'ok')
    headers = [(b'X-Custom-Case', b'\xff\x80'), (b'X-Duplicate', b'one'), (b'X-Duplicate', b'two'), (b'X-Diag-Remove', b'value')]
    with request_context() as server:
        async with DiagnosticAsyncClient(transport=httpx.MockTransport(upstream)) as client:
            assert (await client.get('https://peer.test/v1/test', headers=headers)).content == b'ok'
        terminal(server)
    assert all(pair in captured[0] for pair in headers[:3])
    assert headers[3] not in captured[0]


def test_private_seam_guard_and_fallback():
    assert compatible_httpx(httpx.AsyncClient, '0.28.1')
    assert not compatible_httpx(httpx.AsyncClient, '0.29.0')
    class Changed(httpx.AsyncClient):
        async def _send_single_request(self, request, extra): pass
    assert not compatible_httpx(Changed, '0.28.1')
    code = '''
import httpx
httpx.__version__ = 'future'
from src.diagnostics.http import DiagnosticAsyncClient
from src.diagnostics.runtime import CAPABILITIES
assert DiagnosticAsyncClient is httpx.AsyncClient
assert 'http_outbound' not in CAPABILITIES
'''
    subprocess.run([sys.executable, '-c', code], check=True, env=dict(os.environ, ENABLE_LOG='0'))


def test_writer_size_cap_and_open_failure_circuit(tmp_path, monkeypatch):
    log._stop_writer_thread()
    monkeypatch.setattr(log, '_diag_files', {})
    monkeypatch.setattr(log, '_diag_sizes', {})
    monkeypatch.setattr(log, '_diag_disabled', set())
    monkeypatch.setattr(log, '_DIAG_MAX_FILE_BYTES', 6)
    path = str(tmp_path/'bounded.jsonl')
    start = log._diag_dropped
    log._write_diagnostic_line(path, '{}')
    log._write_diagnostic_line(path, '{}')
    log._write_diagnostic_line(path, '{}')
    assert (tmp_path/'bounded.jsonl').read_bytes() == b'{}\n{}\n'
    assert log._diag_dropped == start + 1
    calls = []
    def forbidden(*args, **kwargs):
        calls.append(args)
        raise PermissionError('read-only')
    monkeypatch.setattr(log, 'open', forbidden, raising=False)
    failed = str(tmp_path/'failed.jsonl')
    for _ in range(5): log._write_diagnostic_line(failed, '{}')
    assert len(calls) == 1 and log._diag_dropped == start + 6
    assert not (tmp_path/'failed.jsonl').exists()


@pytest.mark.parametrize('debug', [False, True])
async def test_antitruncation_nondict_frames_route_passthrough(records, monkeypatch, debug):
    from src.router.antigravity import gemini
    from src.api import antigravity
    from src.converter.anti_truncation import AntiTruncationStreamProcessor
    from src.models import GeminiRequest
    log.set_log_level('debug' if debug else 'info')
    frames = [b'data: []\n\n', b'data: "text"\n\n', b'data: [DONE]\n\n']
    async def source(**kwargs): yield b'data: {}'
    async def processed(self):
        for frame in frames: yield frame
    monkeypatch.setattr(antigravity, 'stream_request', source)
    monkeypatch.setattr(AntiTruncationStreamProcessor, 'process_stream', processed)
    with request_context() as server:
        response = await gemini.stream_generate_content(GeminiRequest(contents=[{'role':'user','parts':[{'text':'synthetic'}]}]), model='抗截断/gemini-3.7-flash', api_key='synthetic')
        assert [chunk async for chunk in response.body_iterator] == frames
        terminal(server)


async def test_shared_helper_closes_unread_and_partial_response(records, monkeypatch):
    import contextlib
    from src import httpx_client
    streams = []
    async def upstream(request):
        stream = Stream()
        streams.append(stream)
        return httpx.Response(200, stream=stream)
    @contextlib.asynccontextmanager
    async def client(**kwargs):
        async with DiagnosticAsyncClient(transport=httpx.MockTransport(upstream)) as value: yield value
    monkeypatch.setattr(httpx_client.http_client, 'get_streaming_client', client)
    with request_context() as server:
        iterator = httpx_client.stream_post_async('https://third.test/', {}, native=True)
        assert await anext(iterator) == b'first'
        await iterator.aclose()
        terminal(server)
    assert streams[0].closed == 1
    assert [r['data']['endReason'] for r in records if r['event'] == 'diag.call'] == ['closed_early']


async def test_server_creation_failure_is_passthrough(monkeypatch):
    from src.diagnostics import asgi
    def fail(*args): raise RuntimeError('diagnostic')
    calls = []
    async def app(scope, receive, send): calls.append(scope)
    monkeypatch.setattr(asgi, 'Server', fail)
    scope = {'type':'http'}
    await asgi.DiagnosticsMiddleware(app)(scope, None, None)
    assert calls == [scope]


@pytest.mark.parametrize('debug', [False, True])
async def test_malformed_stream_frames_do_not_change_bytes(records, debug):
    log.set_log_level('debug' if debug else 'info')
    frames = [b'data: []\n', b'data: "text"\n', b'data: ' + b'['*2000 + b'0' + b']'*2000 + b'\n', b'data: [DONE]\n']
    async def source():
        for frame in frames: yield frame
    with request_context() as server:
        assert [x async for x in semantic.observe_stream(source(), semantic.Attempt(1, 'synthetic'), native=True)] == frames
        terminal(server)


async def test_http_eof_is_retained_when_business_iterator_stops(records):
    frame = b'data: {"candidates":[{"content":{"parts":[{"text":"x"}]},"finishReason":"STOP"}]}'
    with request_context() as server:
        attempt = semantic.Attempt(1, 'synthetic')
        async def source():
            async with DiagnosticAsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200, content=frame))) as client:
                response = await client.post('https://third.test/')
                yield response.content
                yield b'data: [DONE]'
        iterator = semantic.observe_stream(source(), attempt)
        assert await anext(iterator) == frame
        await iterator.aclose()
        assert not attempt.eof and attempt.http_eof
        terminal(server)
    data = next(r['data'] for r in records if r['event']=='upstream.attempt_finished')
    assert data['eofSeen'] and data['resultClass']=='success'


async def test_redirect_eof_does_not_mask_final_body_early_close(records):
    frame = b'data: {"candidates":[{"content":{"parts":[{"text":"x"}]},"finishReason":"STOP"}]}'
    class Body(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield frame
            yield b'data: [DONE]'
        async def aclose(self): pass
    async def upstream(request):
        if request.url.path == '/first': return httpx.Response(302, headers={'location':'/final'}, content=b'')
        return httpx.Response(200, stream=Body())
    with request_context() as server:
        attempt = semantic.Attempt(1, 'synthetic')
        async def source():
            async with DiagnosticAsyncClient(transport=httpx.MockTransport(upstream), follow_redirects=True) as client:
                async with client.stream('POST', 'https://third.test/first') as response:
                    async for chunk in response.aiter_bytes(): yield chunk
        iterator = semantic.observe_stream(source(), attempt)
        assert await anext(iterator) == frame
        await iterator.aclose()
        assert attempt.http_calls == 2 and attempt.http_eofs == 1 and not attempt.http_eof
        terminal(server)
    data = next(r['data'] for r in records if r['event']=='upstream.attempt_finished')
    assert not data['eofSeen'] and data['resultClass']=='incomplete'
