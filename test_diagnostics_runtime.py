import asyncio
import contextlib
import importlib
import json
import os
import subprocess
import sys
from pathlib import Path

import httpx
import pytest
from jsonschema import Draft202012Validator, FormatChecker

import log
from src.diagnostics.asgi import DiagnosticsMiddleware
from src.diagnostics.http import DiagnosticAsyncClient
from src.diagnostics.semantic import Attempt, observe_stream, usage

rt = importlib.import_module('src.diagnostics.runtime')
SCHEMA = json.loads((Path(__file__).parent / 'contracts/diagnostics/v1/record.schema.json').read_text(encoding='utf8'))
VALIDATOR = Draft202012Validator(SCHEMA, format_checker=FormatChecker())


@pytest.fixture
def records(monkeypatch):
    result = []
    monkeypatch.setattr(rt, '_runtime', None)
    monkeypatch.setattr(log, '_log_enabled', True)
    monkeypatch.setattr(log, '_cached_log_level', 0)
    monkeypatch.setenv('DIAG_PEERS', '')
    def writer(line, boot, basic):
        assert len(line.encode()) + 1 <= 4096
        record = json.loads(line)
        VALIDATOR.validate(record)
        assert not rt.record_issues(record)
        result.append(record)
        return True
    monkeypatch.setattr(log, 'write_diagnostic', writer)
    return result


@contextlib.contextmanager
def request_context(headers=()):
    server = rt.Server(headers)
    token = rt.current_server.set(server)
    try:
        yield server
    finally:
        rt.current_server.reset(token)


def terminal(server):
    server.emit('diag.server', dict(routeTemplate='/test', headersCommitted=True, wireStatus=200,
                                   endReason='finished', deliveryState='local_finished', totalMs=server.elapsed(), callCount=server.calls), terminal=True)


def peers(monkeypatch, origin='https://peer.test', prefix='/v1'):
    monkeypatch.setenv('DIAG_PEERS', json.dumps([dict(alias='peer', origin=origin, pathPrefix=prefix, service='gcli2api', deploymentId=None)]))


class Stream(httpx.AsyncByteStream):
    def __init__(self, error=None):
        self.error, self.closed = error, 0
    async def __aiter__(self):
        yield b'first'
        if self.error:
            raise self.error
        yield b'last'
    async def aclose(self):
        self.closed += 1


@pytest.mark.parametrize('mode,expected', [('eof','eof'), ('close','closed_early'), ('error','read_error'), ('cancel','cancelled')])
async def test_http_body_settles_once(records, mode, expected):
    stream = Stream(httpx.ReadError('synthetic') if mode == 'error' else (asyncio.CancelledError() if mode == 'cancel' else None))
    async def upstream(request):
        return httpx.Response(200, stream=stream)
    with request_context() as server:
        async with DiagnosticAsyncClient(transport=httpx.MockTransport(upstream)) as client:
            response = await client.send(client.build_request('GET','https://third.test/model'), stream=True)
            assert not [r for r in records if r['event'] == 'diag.call']
            if mode != 'close':
                try:
                    await response.aread()
                except (httpx.ReadError, asyncio.CancelledError):
                    pass
            await response.aclose()
            await response.aclose()
        terminal(server)
    calls = [r for r in records if r['event'] == 'diag.call']
    assert len(calls) == 1 and calls[0]['data']['endReason'] == expected
    assert stream.closed == 1


async def test_connect_error_and_mounts(records, monkeypatch):
    peers(monkeypatch)
    async def error(request):
        assert request.headers['traceparent']
        raise httpx.ConnectError('synthetic')
    with request_context() as server:
        async with DiagnosticAsyncClient(proxy='http://127.0.0.1:1', mounts={'https://peer.test': httpx.MockTransport(error)}) as client:
            with pytest.raises(httpx.ConnectError):
                await client.get('https://peer.test/v1/chat')
        terminal(server)
    assert [r['data']['endReason'] for r in records if r['event'] == 'diag.call'] == ['transport_error']


@pytest.mark.parametrize('target', ['https://third.test/v1', 'https://peer.test/private', 'https://peer.test/v1/next'])
@pytest.mark.parametrize('business', [False, True])
async def test_real_httpx_redirect_final_hooks(records, monkeypatch, target, business):
    peers(monkeypatch)
    sent = []
    async def hook(request):
        if sent:
            assert 'traceparent' not in request.headers
            assert 'tracestate' not in request.headers
            assert not any(k.startswith('x-diag-') for k in request.headers)
            if business:
                request.headers['traceparent'] = 'explicit-new-hop'
    async def upstream(request):
        sent.append(request)
        return httpx.Response(302, headers={'location':target}, content=b'') if len(sent) == 1 else httpx.Response(200, content=b'ok')
    with request_context() as server:
        async with DiagnosticAsyncClient(transport=httpx.MockTransport(upstream), follow_redirects=True, event_hooks={'request':[hook]}) as client:
            original = client.build_request('GET','https://peer.test/v1/chat',headers={'x-request-id':'old', 'traceparent':'explicit-old'})
            response = await client.send(original)
            assert original.headers['traceparent'] == 'explicit-old'
            assert response.content == b'ok'
        terminal(server)
    calls = [r for r in records if r['event'] == 'diag.call']
    assert len(calls) == 2 and [r['callNo'] for r in calls] == [1,2]
    assert calls[1]['data']['callKind'] == 'redirect'
    if '/v1/next' in target:
        assert sent[1].headers['traceparent'] != sent[0].headers['traceparent']
    else:
        assert sent[1].headers.get('traceparent') == ('explicit-new-hop' if business else None)
        assert 'x-diag-request-id' not in sent[1].headers
    assert sent[1].headers['x-request-id'] == 'old'


async def test_concurrent_asgi_and_stream_task_context(records):
    async def app(scope, receive, send):
        before = rt.active_server()
        async def producer():
            assert rt.active_server() is before
            async with DiagnosticAsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200, content=b'body'))) as client:
                await asyncio.gather(*(client.get('https://third.test/') for _ in range(3)))
            await send({'type':'http.response.start','status':201,'headers':[(b'x-diag-request-id',b'peer'),(b'X-Diag-Unknown',b'private'),(b'x-request-id',b'old')]})
            await asyncio.sleep(0)
            await send({'type':'http.response.body','body':b'body','more_body':False})
        await asyncio.create_task(producer())
    middleware = DiagnosticsMiddleware(app)
    async def one():
        messages = []
        async def receive(): return {'type':'http.request','body':b''}
        async def send(message): messages.append(message)
        await middleware({'type':'http','headers':[(b'x-request-id',b'reused')]}, receive, send)
        assert rt.current_server.get() is None
        headers = messages[0]['headers']
        assert len([k for k,v in headers if k.lower().startswith(b'x-diag-')]) == 2
        assert (b'x-request-id',b'old') in headers
    await asyncio.gather(*(one() for _ in range(20)))
    servers = [r for r in records if r['event'] == 'diag.server']
    assert len({r['traceId'] for r in servers}) == 20
    for server in servers:
        calls = [r for r in records if r['event'] == 'diag.call' and r['serverSpanId'] == server['spanId']]
        assert sorted(r['callNo'] for r in calls) == [1,2,3]
        assert all(r['traceId'] == server['traceId'] for r in calls)


async def test_asgi_cancel_and_committed_error(records):
    async def app(scope, receive, send):
        await send({'type':'http.response.start','status':200,'headers':[]})
        raise asyncio.CancelledError
    async def send(message): pass
    with pytest.raises(asyncio.CancelledError):
        await DiagnosticsMiddleware(app)({'type':'http','headers':[]}, None, send)
    record = records[-1]
    assert record['data']['wireStatus'] == 200
    assert record['data']['endReason'] == 'client_cancel'
    assert rt.active_server() is None


async def test_generator_does_not_reset_foreign_context(records):
    async def source():
        assert rt.current_attempt.get() is not None
        yield b'data: {"candidates":[{"content":{"parts":[{"text":"x"}]},"finishReason":"STOP"}]}'
        yield b'data: {"usageMetadata":{"candidatesTokenCount":0}}'
    with request_context() as server:
        stream = observe_stream(source(), Attempt(1, 'private-filename'))
        await anext(stream)
        assert rt.current_attempt.get() is None
        await asyncio.create_task(anext(stream))
        await asyncio.create_task(stream.aclose())
        terminal(server)
    attempt = next(r for r in records if r['event']=='upstream.attempt_finished')
    assert attempt['data']['resultClass'] == 'incomplete'
    assert attempt['data']['usage']['candidate']['value'] == 0
    assert 'private-filename' not in json.dumps(records)


def test_debug_transition_and_access_independence(records, monkeypatch):
    with request_context() as server:
        log.set_log_level('info')
        log.set_log_level('debug')
        assert not server.debug()
        terminal(server)
    assert records[-1]['data']['coverage']['debugCapture'] == 'interrupted'
    log.set_log_level('info')
    with request_context() as server:
        log.set_log_level('debug')
        assert not server.debug()
        terminal(server)
    assert records[-1]['data']['coverage']['debugCapture'] == 'none'
    monkeypatch.setattr(log, '_log_enabled', False)
    count = len(records)
    with request_context() as server:
        terminal(server)
    assert len(records) == count


def test_truncated_terminal_and_late_observations(records):
    with request_context() as server:
        server.emit('request.normalized', {'synthetic': 'x'*9000})
        terminal(server)
        terminal(server)
    assert records[-2]['event']=='diag.truncated'
    assert records[-1]['data']['coverage']['truncatedEvents']==1
    assert records[-1]['data']['coverage']['expectedLastLogSeq']==records[-1]['logSeq']==2


def test_usage_missing_zero_and_cumulative():
    from src.diagnostics.semantic import Summary
    assert usage()['candidate']==dict(value=None,present=False,source='unknown')
    assert usage({'candidatesTokenCount':0})['candidate']==dict(value=0,present=True,source='upstream')
    summary = Summary()
    for _ in range(3): summary.observe({'usageMetadata':{'candidatesTokenCount':87,'thoughtsTokenCount':5}})
    assert summary.raw['candidatesTokenCount']==87
    assert usage(summary.raw)['outputTotal']['value'] is None


def test_config_reload_disables_previous_peers(records, monkeypatch):
    peers(monkeypatch)
    assert rt.runtime().peers.match('https://peer.test/v1')
    monkeypatch.setenv('DIAG_PEERS','invalid')
    assert not rt.runtime().peers.match('https://peer.test/v1')
    assert records[-1]['data']['configStatus']=='config_invalid'


def test_jsonl_writer_and_reserved_capacity(tmp_path, monkeypatch):
    log._stop_writer_thread()
    monkeypatch.setattr(log, '_cached_log_file', str(tmp_path/'log'))
    monkeypatch.setattr(log, '_log_enabled', True)
    monkeypatch.setattr(log, '_cached_log_level', 1)
    monkeypatch.setattr(rt, '_runtime', None)
    with request_context() as server: terminal(server)
    log._stop_writer_thread()
    files = list(tmp_path.glob('*.jsonl'))
    assert len(files)==1
    for line in files[0].read_text(encoding='utf8').splitlines(): VALIDATOR.validate(json.loads(line))
    monkeypatch.setattr(log, '_start_writer_thread', lambda: None)
    try:
        log._log_deque.extend(['legacy']*(log._MAX_QUEUE_SIZE-256))
        assert not log.write_diagnostic('{}', 'synthetic', False)
        assert log.write_diagnostic('{}', 'synthetic', True)
    finally:
        log._log_deque.clear()


def test_worker_pid_change_reinitializes_identity(records, monkeypatch):
    previous = rt.runtime()
    monkeypatch.setattr(rt.os, 'getpid', lambda: previous.pid+1)
    restarted = rt.runtime()
    assert restarted.resource['bootId'] != previous.resource['bootId']
    assert restarted.process_seq == 1


@pytest.mark.skipif(not hasattr(os, 'fork'), reason='POSIX fork unavailable on Windows; spawn/restart exercised over real HTTP')
def test_actual_fork_child_identity_and_writer(tmp_path):
    code = '''
import os,json
from src.diagnostics.runtime import runtime
parent=runtime().resource
pid=os.fork()
if pid==0:
    child=runtime().resource
    assert child['bootId']!=parent['bootId']
    assert child['instanceId']==parent['instanceId']
    os._exit(0)
_, status=os.waitpid(pid,0)
assert os.waitstatus_to_exitcode(status)==0
'''
    env = dict(os.environ, ENABLE_LOG='0', DIAG_INSTANCE_ID='synthetic-replica')
    assert subprocess.run([sys.executable,'-c',code],env=env,capture_output=True).returncode==0


async def test_real_proxy_final_destination_and_hook_order(records, monkeypatch):
    received=[]
    async def proxy(reader, writer):
        request=await reader.readuntil(b'\r\n\r\n')
        received.append(request)
        writer.write(b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok')
        await writer.drain()
        writer.close()
        await writer.wait_closed()
    listener=await asyncio.start_server(proxy,'127.0.0.1',0)
    number=listener.sockets[0].getsockname()[1]
    peers(monkeypatch, origin='http://synthetic-peer.invalid')
    async def business_hook(request):
        request.headers['traceparent']='explicit-business'
        request.headers['x-diag-untrusted']='removed'
    try:
        with request_context() as server:
            async with DiagnosticAsyncClient(proxy=f'http://127.0.0.1:{number}', trust_env=False,event_hooks={'request':[business_hook]}) as client:
                response=await client.get('http://synthetic-peer.invalid/v1/chat')
                assert response.content==b'ok'
            terminal(server)
    finally:
        listener.close()
        await listener.wait_closed()
    assert received[0].startswith(b'GET http://synthetic-peer.invalid/v1/chat HTTP/1.1')
    assert b'explicit-business' not in received[0] and b'x-diag-untrusted' not in received[0]
    assert b'traceparent: 00-' in received[0]


def test_no_detailed_collection_when_disabled(records, monkeypatch):
    from src.diagnostics import semantic
    log.set_log_level('info')
    def forbidden(*args,**kwargs): raise AssertionError('hidden summary')
    monkeypatch.setattr(semantic,'Summary',forbidden)
    monkeypatch.setattr(semantic,'structure',forbidden)
    with request_context() as server:
        assert semantic.normalization_start({'contents':[]}) is None
        assert Attempt(1,'private').summary is None
        semantic.converted({}, {})
        terminal(server)
    assert all(r['recordKind']=='basic' for r in records)


def test_dropped_event_consumes_sequence(records, monkeypatch):
    from src.diagnostics.semantic import normalization_start, normalization_end
    with request_context() as server:
        before=normalization_start({'contents':[]})
        original=log.write_diagnostic
        monkeypatch.setattr(log,'write_diagnostic',lambda *args:False)
        normalization_end(before,{'contents':[]},[])
        monkeypatch.setattr(log,'write_diagnostic',original)
        terminal(server)
    assert records[-1]['logSeq']==2
    assert records[-1]['data']['coverage']['droppedForSpan']==1


async def test_collector_cleanup_failure_does_not_replace_response(monkeypatch):
    from src.api import antigravity
    async def enabled(): return True
    async def source(**kwargs):
        try:
            yield b'data: {"candidates":[{"content":{"parts":[{"text":"synthetic"}]},"finishReason":"STOP"}]}'
            yield b'data: [DONE]'
        finally:
            raise RuntimeError('synthetic close failure')
    monkeypatch.setattr(antigravity,'get_antigravity_stream2nostream',enabled)
    monkeypatch.setattr(antigravity,'stream_request',source)
    response = await antigravity._non_stream_request({'model':'synthetic'})
    assert response.status_code==200
    assert json.loads(response.body)['candidates'][0]['content']['parts'][0]['text']=='synthetic'
