"""Regression scenarios reported by three actual Claude code review rounds."""
import asyncio
import json
import time
from datetime import datetime, timezone
from types import SimpleNamespace

import aiosqlite
import httpx
import pytest

from src.api import antigravity
from src.antigravity_completion import validate_json
from src.router.model_api_errors import ErrorKind, ErrorOrigin, ModelApiErrorException, error_from_response, make_model_api_error
from src.storage_adapter import StorageAdapter
from test_antigravity_quota_policy import store, week, NAME, GEMINI, CLAUDE
from test_antigravity_completion_policy import client, candidate, event
from test_antigravity_quota_backends import backend


async def test_mixed_rolling_and_real_zero_preserves_timer_on_release(store):
    models, observation = week()
    deadline = time.time()+41*3600
    models['gemini-other'] = {'remaining': 0, 'resetTimeRaw': datetime.fromtimestamp(deadline,timezone.utc).isoformat()}
    result = await store.quota_sync(NAME, models, observation, await store.quota_snapshot(NAME))
    assert result['quota_group_states']['gemini-shared']['state'] == 'blocked_unknown'
    assert result['model_cooldowns']['gemini-other'] == pytest.approx(deadline)
    await store.quota_release(NAME, 'gemini-shared')
    assert await store.quota_admit(NAME, GEMINI) is None
    assert await store.quota_admit(NAME, CLAUDE)


async def test_old_revision_explicit_exhaustion_still_records_finite_timer(store):
    admission = await store.quota_admit(NAME, GEMINI)
    models, observation = week()
    await store.quota_sync(NAME, models, observation, await store.quota_snapshot(NAME))
    deadline = time.time()+41*3600
    assert await store.quota_record_result(NAME, admission, GEMINI, False, 429, deadline)
    await store.quota_release(NAME, 'gemini-shared')
    assert await store.quota_admit(NAME, GEMINI) is None
    assert (await store.quota_snapshot(NAME))['model_cooldowns'][GEMINI] == deadline


@pytest.mark.parametrize('stream', [True,False])
async def test_stale_candidate_reselected_without_upstream_retry(monkeypatch, client, stream):
    successes, failures, calls = client
    class Manager:
        async def get_valid_credential(self, **kwargs):
            name = 'b.json' if 'a.json' in kwargs.get('excluded_credentials',set()) else 'a.json'
            return name, {'access_token': name, 'project_id': 'synthetic', '_quota_generation': name}
        async def quota_admit(self, filename, *_):
            return None if filename == 'a.json' else {'generation': filename, 'revision':0, 'group':'gemini-shared'}
    async def post(**kwargs):
        calls.append(kwargs)
        return httpx.Response(200,json=candidate())
    async def streamed(**kwargs):
        calls.append(kwargs)
        yield event(candidate())
    monkeypatch.setattr(antigravity,'credential_manager',Manager())
    monkeypatch.setattr(antigravity,'post_async',post)
    monkeypatch.setattr(antigravity,'stream_post_async',streamed)
    body={'model':'gemini-test','request':{}}
    if stream:
        result=[item async for item in antigravity.stream_request(body)]
        assert 'synthetic answer' in ''.join(result)
    else:
        assert (await antigravity.non_stream_request(body,record_logical=False)).status_code == 200
    assert len(calls)==1 and calls[0]['headers']['Authorization']=='Bearer b.json'


async def test_selection_only_reads_initialized_candidates(store, monkeypatch):
    await store.quota_ensure_generation(NAME)
    async def forbidden(*args, **kwargs): raise AssertionError('selection acquired a write transaction')
    monkeypatch.setattr(store,'_quota_atomic',forbidden)
    assert (await store.get_next_available_credential('antigravity',GEMINI))[0]==NAME


async def test_remote_selection_is_read_only_and_admission_ignores_stat_contention(backend, monkeypatch):
    manager, db = backend
    await manager.quota_ensure_generation(NAME)
    original=manager._quota_atomic
    async def forbidden(*args, **kwargs): raise AssertionError('selection write lock')
    monkeypatch.setattr(manager,'_quota_atomic',forbidden)
    assert await manager.get_next_available_credential('antigravity',GEMINI)
    monkeypatch.setattr(manager,'_quota_atomic',original)
    if manager.QUOTA_ENGINE=='mongo':
        update=db.update_one
        async def concurrent_count(query,changes):
            db.row['call_count']+=1
            return await update(query,changes)
        monkeypatch.setattr(db,'update_one',concurrent_count)
        assert await manager.quota_admit(NAME,GEMINI)
        assert db.row['call_count']==1


async def test_local_settlement_failure_is_not_upstream_bad_format(monkeypatch,client):
    async def post(**kwargs): return httpx.Response(200,json=candidate())
    async def fail(*args,**kwargs):
        raise ModelApiErrorException(make_model_api_error(origin=ErrorOrigin.LOCAL,kind=ErrorKind.HTTP,status=503))
    monkeypatch.setattr(antigravity,'post_async',post)
    monkeypatch.setattr(antigravity,'record_api_call_success',fail)
    response=await antigravity.non_stream_request({'model':'gemini-test','request':{}},record_logical=False)
    assert response.status_code==503
    assert error_from_response(response).origin==ErrorOrigin.LOCAL
    assert b'Invalid upstream' not in response.body


@pytest.mark.parametrize('finish',['SAFETY','RECITATION','PROHIBITED_CONTENT','IMAGE_SAFETY'])
def test_filtered_candidate_is_valid_without_body(finish):
    payload=candidate([],finish)
    assert validate_json(json.dumps(payload))==payload


async def test_old_refresh_cannot_overwrite_same_generation_upload(store):
    snapshot=await store.quota_snapshot(NAME)
    await store.store_credential(NAME,{'access_token':'new-upload'},'antigravity')
    assert (await store.quota_snapshot(NAME))['quota_credential_generation']==snapshot['quota_credential_generation']
    assert not await store.quota_refresh_credential(NAME,snapshot['quota_credential_generation'],{'access_token':'old-refresh'},snapshot['_quota_credential_version'])
    current=await store.quota_snapshot(NAME)
    assert await store.quota_refresh_credential(NAME,current['quota_credential_generation'],{'access_token':'fresh'},current['_quota_credential_version'])
    assert (await store.get_credential(NAME,'antigravity'))['access_token']=='fresh'


async def test_corrupt_policy_does_not_break_upload_or_control_read(store):
    adapter=StorageAdapter();adapter._backend=store;adapter._initialized=True
    async with aiosqlite.connect(store._db_path) as conn:
        await conn.execute("UPDATE antigravity_credentials SET quota_group_states='corrupt' WHERE filename=?",(NAME,));await conn.commit()
    assert await adapter.store_credential(NAME,{'access_token':'replacement'},'antigravity')
    assert (await adapter.get_credential_state(NAME,'antigravity'))['quota_state_invalid'] is True
    assert await store.get_next_available_credential('antigravity',GEMINI) is None
    async with aiosqlite.connect(store._db_path) as conn:
        row=await (await conn.execute('SELECT quota_group_states FROM antigravity_credentials WHERE filename=?',(NAME,))).fetchone()
    assert row[0]=='corrupt'


async def test_complete_positive_snapshot_clears_escaped_keys_on_each_backend(backend):
    manager, _ = backend
    await manager.set_model_cooldown(NAME, GEMINI, time.time()+1000, "antigravity")
    snapshot=await manager.quota_snapshot(NAME)
    result=await manager.quota_sync(NAME,{GEMINI:{"remaining":1}}, {},snapshot,required_models=[GEMINI])
    assert result["model_cooldowns"]=={}
    assert await manager.quota_admit(NAME,GEMINI)


async def test_concurrent_refresh_reuses_winner_without_overwriting(store,monkeypatch):
    import copy
    import src.credential_manager as cm
    expiry=datetime.fromtimestamp(time.time()-60,timezone.utc).isoformat()
    await store.store_credential(NAME,{"access_token":"expired","refresh_token":"synthetic-refresh", "expiry":expiry},"antigravity")
    _, selected=await store.get_next_available_credential("antigravity",GEMINI)
    manager=cm.CredentialManager.__new__(cm.CredentialManager)
    manager._initialized=True;manager._storage_adapter=SimpleNamespace(_backend=store)
    barrier=asyncio.Event();entered=0
    class Credentials:
        @classmethod
        def from_dict(cls,data):
            obj=cls();obj.refresh_token=data['refresh_token'];return obj
        async def refresh(self):
            nonlocal entered
            entered+=1;self.access_token='fresh-'+str(entered)
            self.expires_at=datetime.fromtimestamp(time.time()+3600,timezone.utc)
            if entered==2:barrier.set()
            await barrier.wait()
    monkeypatch.setattr(cm,'Credentials',Credentials)
    results=await asyncio.gather(*(manager._refresh_token(copy.deepcopy(selected),NAME,'antigravity') for _ in range(2)))
    saved=await store.get_credential(NAME,'antigravity')
    assert all(result and result['access_token']==saved['access_token'] for result in results)
    assert not any(key.startswith('_quota_') for key in saved)
    for result in results:
        assert await manager.quota_admit(NAME, GEMINI, result['_quota_generation'], result['_quota_credential_version'])


@pytest.mark.parametrize('stream',[True,False])
async def test_malformed_tool_terminal_preserves_upstream_semantics(monkeypatch,client,stream):
    async def post(**kwargs):return httpx.Response(200,json=candidate([],"MALFORMED_FUNCTION_CALL"))
    async def streamed(**kwargs):yield event(candidate([],"MALFORMED_FUNCTION_CALL"))
    monkeypatch.setattr(antigravity,'post_async',post)
    monkeypatch.setattr(antigravity,'stream_post_async',streamed)
    body={'model':'gemini-test','request':{}}
    if stream:
        result=[chunk async for chunk in antigravity.stream_request(body)]
        assert 'MALFORMED_FUNCTION_CALL' in ''.join(result)
    else:
        result=await antigravity.non_stream_request(body,record_logical=False)
        assert result.status_code==200 and b'MALFORMED_FUNCTION_CALL' in result.body


@pytest.mark.parametrize('finish',['STOP','MAX_TOKENS','MALFORMED_FUNCTION_CALL','SAFETY'])
def test_thought_only_remains_invalid_even_with_non_success_terminal(finish):
    with pytest.raises(ModelApiErrorException):
        validate_json(json.dumps(candidate([{'thought':True,'text':'thinking'}],finish)))


async def test_old_business_403_cannot_disable_overwritten_credential(store):
    from src.api.utils import handle_auto_ban
    from src.credential_manager import CredentialManager
    manager=CredentialManager.__new__(CredentialManager)
    manager._initialized=True;manager._storage_adapter=SimpleNamespace(_backend=store)
    admission=await manager.quota_admit(NAME,GEMINI)
    await store.store_credential(NAME,{'access_token':'replacement'},'antigravity')
    await handle_auto_ban(manager,403,NAME,'antigravity',admission)
    current=await manager.quota_admit(NAME,GEMINI)
    assert current and current['generation']==admission['generation']
    assert current['credentialVersion']!=admission['credentialVersion']
    assert await manager.quota_admit(NAME,GEMINI,admission['generation'],admission['credentialVersion']) is None
    await handle_auto_ban(manager,403,NAME,'antigravity',current)
    assert await manager.quota_admit(NAME,GEMINI) is None


@pytest.mark.parametrize('missing_refresh',[True,False])
async def test_old_refresh_failure_cannot_disable_overwritten_credential(store,monkeypatch,missing_refresh):
    import src.credential_manager as cm
    _,selected=await store.get_next_available_credential('antigravity',GEMINI)
    await store.store_credential(NAME,{'access_token':'replacement'},'antigravity')
    class InvalidGrant(Exception):
        status_code=400
    class Credentials:
        @classmethod
        def from_dict(cls,data):
            obj=cls();obj.refresh_token=None if missing_refresh else 'synthetic-refresh';return obj
        async def refresh(self):raise InvalidGrant('invalid_grant')
    monkeypatch.setattr(cm,'Credentials',Credentials)
    manager=cm.CredentialManager.__new__(cm.CredentialManager)
    manager._initialized=True;manager._storage_adapter=SimpleNamespace(_backend=store)
    assert await manager._refresh_token(selected,NAME,'antigravity') is None
    assert await manager.quota_admit(NAME,GEMINI)
    assert (await store.get_credential(NAME,'antigravity'))['access_token']=='replacement'


async def test_remote_disable_and_admission_require_current_content(backend):
    manager,db=backend
    admission=await manager.quota_admit(NAME,GEMINI)
    db.row['credential_data']={'access_token':'replacement'}
    assert not await manager.quota_disable(NAME,admission['generation'],admission['credentialVersion'])
    assert await manager.quota_admit(NAME,GEMINI,generation=admission['generation'],expected_version=admission['credentialVersion']) is None
    current=await manager.quota_admit(NAME,GEMINI)
    assert current and current['generation']==admission['generation']
    assert await manager.quota_disable(NAME,current['generation'],current['credentialVersion'])
    assert await manager.quota_admit(NAME,GEMINI) is None


@pytest.mark.parametrize('replacement_at',['refresh','project',None])
async def test_project_verification_never_reverts_concurrent_upload(store,monkeypatch,replacement_at):
    from fastapi import HTTPException
    from src.panel import creds as panel
    adapter=StorageAdapter();adapter._backend=store;adapter._initialized=True
    async def replacement():
        await store.store_credential(NAME,{'access_token':'replacement'},'antigravity')
        await store.update_credential_state(NAME,{'disabled':True,'tier':'replacement-tier'},'antigravity')
    class Credentials:
        access_token='refreshed'
        @classmethod
        def from_dict(cls,data):return cls()
        async def refresh_if_needed(self):
            if replacement_at=='refresh':await replacement()
            return True
        def to_dict(self):return {'access_token':self.access_token,'project_id':'old-project'}
    async def get_adapter():return adapter
    async def get_url():return 'https://synthetic.invalid'
    async def project(**kwargs):
        if replacement_at=='project':await replacement()
        return 'verified-project','pro',None
    monkeypatch.setattr(panel,'Credentials',Credentials)
    monkeypatch.setattr(panel,'get_storage_adapter',get_adapter)
    monkeypatch.setattr(panel,'get_antigravity_api_url',get_url)
    monkeypatch.setattr(panel,'fetch_project_id_and_tier',project)
    if replacement_at:
        with pytest.raises(HTTPException) as error:
            await panel.verify_credential_project_common(NAME,'antigravity')
        assert error.value.status_code==409
        assert (await store.get_credential(NAME,'antigravity'))=={'access_token':'replacement'}
        state=await store.get_credential_state(NAME,'antigravity')
        assert state['disabled'] and state['tier']=='replacement-tier'
    else:
        assert (await panel.verify_credential_project_common(NAME,'antigravity')).status_code==200
        assert (await store.get_credential(NAME,'antigravity'))['project_id']=='verified-project'
        assert (await store.get_credential_state(NAME,'antigravity'))['tier']=='pro'


@pytest.mark.parametrize('replacement_at',['refresh','email',None])
async def test_email_lookup_fences_tokens_and_cached_metadata(store,monkeypatch,replacement_at):
    from src.credential_manager import CredentialManager
    from src import google_oauth_api as oauth
    adapter=StorageAdapter();adapter._backend=store;adapter._initialized=True
    manager=CredentialManager.__new__(CredentialManager)
    manager._initialized=True;manager._storage_adapter=adapter
    async def replacement():
        await store.store_credential(NAME,{'access_token':'replacement'},'antigravity')
    class Credentials:
        @classmethod
        def from_dict(cls,data):return cls()
        async def refresh_if_needed(self):
            if replacement_at=='refresh':await replacement()
            return True
        def to_dict(self):return {'access_token':'refreshed'}
    async def email(credentials):
        if replacement_at=='email':await replacement()
        return 'synthetic@example.invalid'
    monkeypatch.setattr(oauth,'Credentials',Credentials)
    monkeypatch.setattr(oauth,'get_user_email',email)
    result=await manager.get_or_fetch_user_email(NAME,'antigravity')
    state=await store.get_credential_state(NAME,'antigravity')
    data=await store.get_credential(NAME,'antigravity')
    if replacement_at:
        assert result is None and not state.get('user_email')
        assert data=={'access_token':'replacement'}
    else:
        assert result==state['user_email']=='synthetic@example.invalid'
        assert data=={'access_token':'refreshed'}


async def test_control_metadata_shares_refresh_fence_on_remote_backends(backend):
    manager,db=backend
    snapshot=await manager.quota_snapshot(NAME)
    assert await manager.quota_refresh_credential(NAME,snapshot['quota_credential_generation'],None,
        snapshot['_quota_credential_version'],{'tier':'pro','user_email':'synthetic@example.invalid'})
    assert db.row['tier']=='pro' and db.row['user_email']=='synthetic@example.invalid'
    db.row['credential_data']={'access_token':'replacement'}
    assert not await manager.quota_refresh_credential(NAME,snapshot['quota_credential_generation'],{'access_token':'stale'},
        snapshot['_quota_credential_version'],{'tier':'stale','user_email':'stale@example.invalid','disabled':False})
    assert db.row['credential_data']=={'access_token':'replacement'} and db.row['tier']=='pro'


@pytest.mark.parametrize('column',['quota_group_states','model_cooldowns'])
@pytest.mark.parametrize('operation',['project','email'])
async def test_control_refresh_survives_corrupt_quota_without_unblocking(store,monkeypatch,column,operation):
    from src.panel import creds as panel
    from src.credential_manager import CredentialManager
    from src import google_oauth_api as oauth
    async with aiosqlite.connect(store._db_path) as conn:
        await conn.execute(f"UPDATE antigravity_credentials SET {column}=? WHERE filename=?",('corrupt',NAME))
        await conn.commit()
    adapter=StorageAdapter();adapter._backend=store;adapter._initialized=True
    class Credentials:
        access_token='refreshed'
        @classmethod
        def from_dict(cls,data):return cls()
        async def refresh_if_needed(self):return True
        def to_dict(self):return {'access_token':'refreshed'}
    async def get_adapter():return adapter
    async def get_url():return 'https://synthetic.invalid'
    async def project(**kwargs):return 'verified-project','pro',None
    async def email(credentials):return 'synthetic@example.invalid'
    monkeypatch.setattr(panel,'Credentials',Credentials)
    monkeypatch.setattr(panel,'get_storage_adapter',get_adapter)
    monkeypatch.setattr(panel,'get_antigravity_api_url',get_url)
    monkeypatch.setattr(panel,'fetch_project_id_and_tier',project)
    monkeypatch.setattr(oauth,'Credentials',Credentials)
    monkeypatch.setattr(oauth,'get_user_email',email)
    if operation=='project':
        assert (await panel.verify_credential_project_common(NAME,'antigravity')).status_code==200
    else:
        manager=CredentialManager.__new__(CredentialManager)
        manager._initialized=True;manager._storage_adapter=adapter
        assert await manager.get_or_fetch_user_email(NAME,'antigravity')=='synthetic@example.invalid'
    assert (await store.get_credential(NAME,'antigravity'))['access_token']=='refreshed'
    async with aiosqlite.connect(store._db_path) as conn:
        row=await (await conn.execute(f'SELECT {column} FROM antigravity_credentials WHERE filename=?',(NAME,))).fetchone()
    assert row[0]=='corrupt'
    assert (await adapter.get_credential_state(NAME,'antigravity'))['quota_state_invalid']
    assert await store.get_next_available_credential('antigravity',GEMINI) is None


async def test_remote_control_refresh_preserves_corrupt_policy_and_content_fence(backend):
    manager,db=backend
    db.row['quota_group_states']='corrupt'
    fence=await manager.quota_credential_fence(NAME)
    assert await manager.quota_refresh_credential(NAME,fence['quota_credential_generation'],{'access_token':'fresh'},
        fence['_quota_credential_version'],{'tier':'pro'})
    assert db.row['quota_group_states']=='corrupt'
    assert not await manager.quota_refresh_credential(NAME,fence['quota_credential_generation'],{'access_token':'stale'},fence['_quota_credential_version'])
    assert await manager.get_next_available_credential('antigravity',GEMINI) is None
