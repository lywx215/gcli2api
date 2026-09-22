import asyncio
import io
import json
from dataclasses import replace
from unittest.mock import AsyncMock
import zipfile

from fastapi import FastAPI, HTTPException, UploadFile
import httpx
import pytest
from src import antigravity_import_limits as limits
from src.credential_manager import CredentialManager
from src.panel import antigravity_import as importer, creds


def upload(name, data):
    return UploadFile(filename=name, file=io.BytesIO(data))


def archive(items):
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w', compression=zipfile.ZIP_DEFLATED) as z:
        for name, data in items:
            z.writestr(name, data)
    return out.getvalue()


@pytest.fixture
def manager(monkeypatch):
    value = CredentialManager()
    value._initialized = True
    value._storage_adapter = AsyncMock()
    value._storage_adapter.store_credential.return_value = True
    monkeypatch.setattr(creds, 'credential_manager', value)
    return value


def configure(monkeypatch, **kwargs):
    policy = replace(limits.ImportLimits(), **kwargs)
    monkeypatch.setattr(limits.ImportLimits, 'load', classmethod(lambda cls: policy))
    return policy


@pytest.mark.parametrize('policy,files', [
    ({'json_bytes':4}, [('ok.json', b'{}'), ('large.json', b'{"x":1}')]),
    ({'expanded_bytes':3}, [('a.json', b'{}'), ('b.json', b'{}')]),
    ({'files':1}, [('a.json', b'{}'), ('b.json', b'{}')]),
    ({'request_bytes':3}, [('a.json', b'{}'), ('b.json', b'{}')]),
    ({'zip_entries':1}, [('a.zip', archive([('good.json',b'{}'),('notes.txt',b'note')]))]),
    ({'json_bytes':100}, [('a.zip', archive([('bomb.json',b' '*10000)]))]),
    ({'expanded_bytes':3}, [('a.zip', archive([('a.json',b'{}')])),('b.zip',archive([('b.json',b'{}')]))]),
])
async def test_limits_reject_whole_batch_before_writes(manager, monkeypatch, policy, files):
    configure(monkeypatch, **policy)
    uploads = [upload(name,data) for name,data in files]
    with pytest.raises(HTTPException) as exc:
        await creds.upload_credentials_common(uploads, mode='antigravity')
    assert exc.value.status_code == 413
    manager._storage_adapter.store_credential.assert_not_awaited()
    assert all(item.file.closed for item in uploads)


async def test_exact_limits_and_per_file_errors(manager, monkeypatch):
    configure(monkeypatch, json_bytes=8, expanded_bytes=26, zip_entries=7)
    data = archive([('dir/a.json',b'{}'), ('other/a.json',b'{}'),
                    ('bad.json',b'{'), ('utf.json',b'\xff'),('array.json',b'[]'),
                    ('nested.zip',b'not-read'), ('b.json',b'{"x": 1}')])
    response = await creds.upload_credentials_common([upload('test.zip',data)], mode='antigravity')
    body = json.loads(response.body)
    assert body['uploaded_count'] == 2
    assert body['total_count'] == 7
    codes = [item.get('error_code') for item in body['results']]
    assert codes == [None,'duplicate_filename','invalid_json','invalid_encoding','invalid_json','unsupported_entry',None]
    assert [call.args[0] for call in manager._storage_adapter.store_credential.await_args_list] == ['a.json','b.json']


async def test_actual_bytes_checked_even_when_zip_metadata_underreports(manager, monkeypatch):
    configure(monkeypatch, json_bytes=4)
    data = archive([('small.json',b'{}')])
    def forged_open(self, *args, **kwargs):
        return io.BytesIO(b'{"oversized":"synthetic"}')
    monkeypatch.setattr(zipfile.ZipFile, 'open', forged_open)
    with pytest.raises(HTTPException) as exc:
        await creds.upload_credentials_common([upload('test.zip',data)], mode='antigravity')
    assert exc.value.status_code == 413
    manager._storage_adapter.store_credential.assert_not_awaited()


@pytest.mark.parametrize('with_length', [False, True])
async def test_asgi_request_limit_runs_before_multipart_parser(manager, monkeypatch, with_length):
    configure(monkeypatch, request_bytes=100)
    reached = AsyncMock()
    async def downstream(scope, receive, send):
        await reached()
    app = limits.AntigravityUploadMiddleware(downstream)
    messages = iter([{'type':'http.request','body':b'a'*60,'more_body':True},
                     {'type':'http.request','body':b'b'*60,'more_body':False}])
    receive = AsyncMock(side_effect=lambda: next(messages))
    send = AsyncMock()
    scope = {'type':'http','method':'POST','path':'/creds/upload', 'query_string':b'mode=antigravity',
             'headers':[(b'content-length',b'120')] if with_length else []}
    await app(scope, receive, send)
    reached.assert_not_awaited()
    assert send.await_args_list[0].args[0]['status'] == 413


async def test_real_multipart_upload_and_legacy_bypass(manager, monkeypatch):
    app = FastAPI()
    app.add_middleware(limits.AntigravityUploadMiddleware)
    app.include_router(creds.router)
    app.dependency_overrides[creds.verify_panel_token] = lambda: 'synthetic'
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        response = await client.post('/creds/upload?mode=antigravity', files={'files':('a.json',b'{}','application/json')})
        assert response.status_code == 200 and response.json()['uploaded_count'] == 1
    configure(monkeypatch, request_bytes=1)
    reached = AsyncMock()
    app = limits.AntigravityUploadMiddleware(reached)
    scope = {'type':'http','method':'POST','path':'/creds/upload', 'query_string':b'mode=geminicli','headers':[]}
    receive = AsyncMock()
    await app(scope,receive,AsyncMock())
    reached.assert_awaited_once()
    receive.assert_not_awaited()


async def test_write_limit_is_shared_by_parallel_imports_and_tokens(manager):
    active = maximum = 0
    async def store(*args, **kwargs):
        nonlocal active, maximum
        active += 1
        maximum = max(maximum, active)
        try:
            await asyncio.sleep(.01)
            return True
        finally:
            active -= 1
    manager._storage_adapter.store_credential.side_effect = store
    tasks = [creds.upload_credentials_common([upload(f'{i}.json', b'{}')],mode='antigravity') for i in range(4)]
    tasks += [manager.add_antigravity_credential('token.json',{})]
    await asyncio.gather(*tasks)
    assert maximum == 1


async def test_request_gate_and_cancelled_waiter_release_files(manager, monkeypatch):
    configure(monkeypatch, requests=1)
    entered = asyncio.Event()
    release = asyncio.Event()
    async def owner():
        async with limits.import_slot():
            entered.set()
            await release.wait()
    task = asyncio.create_task(owner())
    await entered.wait()
    files = [upload('queued.json',b'{}')]
    pending = asyncio.create_task(creds.upload_credentials_common(files,mode='antigravity'))
    await asyncio.sleep(.01)
    pending.cancel()
    with pytest.raises(asyncio.CancelledError):
        await pending
    assert files[0].file.closed
    manager._storage_adapter.store_credential.assert_not_awaited()
    release.set()
    await task
    response = await creds.upload_credentials_common([upload('next.json',b'{}')],mode='antigravity')
    assert response.status_code == 200

async def test_token_endpoints_report_safe_failures_and_metadata_warning(manager, monkeypatch):
    monkeypatch.setattr(creds, '_exchange_refresh_token_to_credential', AsyncMock(return_value={'access_token':'synthetic'}))
    monkeypatch.setattr(creds, 'fetch_project_id_and_tier', AsyncMock(return_value=('project','pro')))
    monkeypatch.setattr(creds, 'get_antigravity_api_url', AsyncMock(return_value='https://example.test'))
    app = FastAPI()
    app.include_router(creds.router)
    app.dependency_overrides[creds.verify_panel_token] = lambda: 'synthetic'
    manager._storage_adapter.store_credential.side_effect = [False, True, False, True]
    manager._storage_adapter.update_credential_state.return_value = False
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        response = await client.post('/creds/upload-by-refresh-token',json={'mode':'antigravity','refresh_token':'synthetic-private-token'})
        assert response.status_code == 400
        assert response.json()['error_code'] == 'credential_store_failed'
        manager._storage_adapter.update_credential_state.assert_not_awaited()
        response = await client.post('/creds/upload-by-refresh-token-batch',json={'mode':'antigravity','refresh_tokens':['synthetic-private-one','synthetic-private-two']})
        assert response.json()['success_count'] == 1
        assert response.json()['failure_count'] == 1
        assert 'synthetic-private' not in response.text
        assert response.json()['results'][0]['warnings'][0]['code'] == 'credential_metadata_update_failed'
        response = await client.post('/creds/upload-by-refresh-token',json={'mode':'antigravity','refresh_token':'synthetic-private-token'})
        assert response.status_code == 200
        assert response.json()['warnings'][0]['code'] == 'credential_metadata_update_failed'


async def test_cancel_validation_waits_for_worker_and_never_writes(manager, monkeypatch):
    import threading
    entered, release = threading.Event(), threading.Event()
    original = importer._prepare
    output = []
    def slow_prepare(files, policy):
        entered.set()
        release.wait(2)
        prepared = original(files,policy)
        output.append(prepared)
        return prepared
    monkeypatch.setattr(importer,'_prepare',slow_prepare)
    files = [upload('sample.json',b'{}')]
    task = asyncio.create_task(creds.upload_credentials_common(files,mode='antigravity'))
    await asyncio.to_thread(entered.wait, 1)
    task.cancel()
    await asyncio.sleep(.01)
    assert not task.done()
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert output[0].data.closed and files[0].file.closed
    manager._storage_adapter.store_credential.assert_not_awaited()


async def test_forged_directory_count_is_checked_before_allocation(manager, monkeypatch):
    import struct
    configure(monkeypatch, zip_entries=1)
    data = bytearray(archive([('one.json',b'{}'),('two.json',b'{}')]))
    end = data.rfind(b'PK\x05\x06')
    struct.pack_into('<HH',data,end+8,1,1)
    with pytest.raises(HTTPException) as exc:
        await creds.upload_credentials_common([upload('test.zip',data)],mode='antigravity')
    assert exc.value.status_code == 413
    manager._storage_adapter.store_credential.assert_not_awaited()

async def test_corrupt_deflate_is_an_item_error(manager):
    import struct
    data = bytearray(archive([('broken.json',b'{}'),('good.json',b'{}')]))
    name_size, extra_size = struct.unpack_from('<HH',data,26)
    data[30+name_size+extra_size] = 0xff
    response = await creds.upload_credentials_common([upload('test.zip',data)],mode='antigravity')
    body = json.loads(response.body)
    assert body['uploaded_count'] == 1 and body['failed_count'] == 1
    assert body['results'][0]['error_code'] == 'unreadable_zip_entry'
    assert manager._storage_adapter.store_credential.await_args.args[0] == 'good.json'

async def test_oversized_chunked_upload_does_not_poison_next_http_request(monkeypatch, unused_tcp_port):
    from hypercorn.asyncio import serve
    from hypercorn.config import Config
    configure(monkeypatch, request_bytes=1024*1024)
    app = FastAPI()
    app.add_middleware(limits.AntigravityUploadMiddleware)
    @app.get('/ping')
    async def ping():
        return {'ok':True}
    config = Config()
    config.bind = [f'127.0.0.1:{unused_tcp_port}']
    config.accesslog = None
    config.errorlog = None
    stop = asyncio.Event()
    server = asyncio.create_task(serve(app, config, shutdown_trigger=stop.wait))
    try:
        for _ in range(100):
            try:
                _, writer = await asyncio.open_connection('127.0.0.1',unused_tcp_port)
                writer.close()
                await writer.wait_closed()
                break
            except OSError:
                await asyncio.sleep(.01)
        async with httpx.AsyncClient(base_url=f'http://127.0.0.1:{unused_tcp_port}', trust_env=False, timeout=2) as client:
            async def chunks():
                for _ in range(3):
                    yield b'x'*(1024*1024)
            response = await client.post('/creds/upload?mode=antigravity',content=chunks(),headers={'Content-Type':'multipart/form-data; boundary=test'})
            assert response.status_code == 413
            response = await client.get('/ping')
            assert response.status_code == 200 and response.json() == {'ok':True}
    finally:
        stop.set()
        await server
