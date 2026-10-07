"""Synthetic panel index tests: no production database or network."""
import asyncio
import json
import time
from types import SimpleNamespace

import aiosqlite
import pytest
from src.storage import antigravity_panel as panel
from src.antigravity_model_access import FAMILIES, MODELS, VALID_FOR
from src.error_classification import get_error_classifications
from test_antigravity_model_access import access_store, observe, NAME


async def add(store, name, **changes):
    await store.store_credential(name, {'refresh_token': 'synthetic-' + name}, 'antigravity')
    if changes:
        await store.update_credential_state(name, changes, 'antigravity')


async def test_page_only_heavy_cache_reuse_and_no_secret(access_store, monkeypatch):
    s = access_store
    for i in range(31):
        await add(s, f'p{i:02}.json', cycle_stats={'large': 'z' * 3000})
    scans, reads = [], []
    scan, read = s._panel_scan, s._panel_read
    async def track_scan(**kw):
        scans.append(kw)
        async for row in scan(**kw): yield row
    async def track_read(names, **kw):
        reads.append((names, kw))
        return await read(names, **kw)
    monkeypatch.setattr(s, '_panel_scan', track_scan)
    monkeypatch.setattr(s, '_panel_read', track_read)
    first = await s.get_antigravity_panel_summary(limit=20)
    second = await s.get_antigravity_panel_summary(offset=20, limit=20)
    assert len(scans) == 1
    assert [len(names) for names, kw in reads] == [20, 12]
    assert first['total'] == second['total'] == 32
    text = json.dumps(s._panel_index)
    assert 'refresh_token' not in text and 'credential_data' not in text and 'cycle_stats' not in text
    assert 'synthetic-p' not in text
    assert 'quota_credential_generation' not in first['items'][0]


async def test_filters_and_counts_match_legacy(access_store):
    s = access_store
    await observe(s, MODELS)
    for i in range(26):
        await add(s, f'm{i:02}.json', tier='pro' if i % 2 else 'free', remark='x' if i % 3 else '',
                  disabled=bool(i % 5 == 0), error_codes=[403] if i % 4 == 0 else [])
    for opts in ({}, {'status_filter':'disabled'}, {'status_filter':'enabled'},
                 {'tier_filter':'free'}, {'remark_filter':''}, {'error_code_filter':'403_other'},
                 {'cooldown_filter':'any_restricted'}):
        new = await s.get_antigravity_panel_summary(limit=20, **opts)
        old = await s.get_credentials_summary(mode='antigravity', limit=None,
                    include_error_classifications=True, **opts)
        assert new['total'] == old['total']
        assert [r['filename'] for r in new['items']] == [r['filename'] for r in old['items'][:20]]
        assert new['stats'] == old['stats']
        assert new['model_access_summary']['total'] == old['total']
    only = await s.get_antigravity_panel_summary(limit=20, model_access_filter='supported')
    assert only['total'] == 1
    assert only['model_access_summary']['total'] == 27


async def test_time_reprojection_and_ttl(access_store, monkeypatch):
    s = access_store
    await observe(s, MODELS)
    now = time.time()
    await s.update_credential_state(NAME, {'model_cooldowns': {'gemini-3-flash': now+2}}, 'antigravity')
    first = await s.get_antigravity_panel_summary()
    cached = s._panel_index
    monkeypatch.setattr(panel.time, 'time', lambda: now+3)
    second = await s.get_antigravity_panel_summary()
    assert s._panel_index is cached
    assert first['stats']['in_cooldown'] == 1 and second['stats']['in_cooldown'] == 0
    cached['started'] -= 6
    await s.get_antigravity_panel_summary()
    assert s._panel_index is not cached


async def test_count_only_commit_keeps_cache_but_policy_commit_invalidates(access_store):
    s = access_store
    await s.quota_ensure_generation(NAME)
    await s.get_antigravity_panel_summary()
    cached = s._panel_index
    await s._quota_atomic(NAME, lambda row: row.update(success_count=123))
    assert s._panel_index is cached
    result = await s.get_antigravity_panel_summary()
    assert result['items'][0]['success_count'] == 123
    await s.update_credential_state(NAME, {'disabled':True}, 'antigravity')
    assert s._panel_index is None
    result = await s.get_antigravity_panel_summary(status_filter='enabled')
    assert result['total'] == 0


async def test_403_classifications_cross_page_and_raw_bodies_not_retained(access_store):
    s = access_store
    for i in range(22):
        await add(s, f'e{i:02}.json', error_codes=[403], error_messages={'403': {'error': {'details': [{'reason':'TOS_VIOLATION' if i == 21 else 'OTHER'}]}}})
    await s.get_antigravity_panel_summary()
    result = await s.get_antigravity_panel_summary(error_code_filter='403_tos_violation')
    assert result['total'] == 1 and result['items'][0]['filename'] == 'e21.json'
    assert 'TOS_VIOLATION' not in json.dumps(s._panel_index)
    assert 'error_messages' not in json.dumps(s._panel_index)


async def test_overflow_stream_counts_keeps_only_page(access_store, monkeypatch):
    s=access_store
    for i in range(13): await add(s, f's{i:02}.json', error_codes=[403])
    monkeypatch.setattr(panel, 'MAX_ROWS', 3)
    result=await s.get_antigravity_panel_summary(offset=10, limit=3, error_code_filter='403_other')
    assert result['total'] == 13 and len(result['items']) == 3
    assert result['model_access_summary']['total'] == 13
    assert result['stats']['total'] == 14
    assert getattr(s, '_panel_index', None) is None


async def test_replacement_between_page_and_index_retries_once(access_store, monkeypatch):
    s=access_store
    original=s._panel_read
    calls=[]
    async def read(names, **kw):
        if not calls:
            await s.import_antigravity_credential(NAME, {'refresh_token':'replacement-synthetic'})
        calls.append(1)
        return await original(names, **kw)
    monkeypatch.setattr(s,'_panel_read',read)
    result=await s.get_antigravity_panel_summary()
    assert len(calls)==2 and result['total']==1


async def test_queue_limit_and_cancel_releases_slot(access_store, monkeypatch):
    s=access_store
    entered, release=asyncio.Event(),asyncio.Event()
    original=s._panel_attempt
    async def blocked(*a,**kw):
        entered.set()
        await release.wait()
        return await original(*a,**kw)
    monkeypatch.setattr(s,'_panel_attempt',blocked)
    running=asyncio.create_task(s.get_antigravity_panel_summary())
    await entered.wait()
    waiting=[asyncio.create_task(s.get_antigravity_panel_summary()) for _ in range(20)]
    await asyncio.sleep(0)
    with pytest.raises(panel.PanelListBusy): await s.get_antigravity_panel_summary()
    for task in waiting:task.cancel()
    await asyncio.gather(*waiting,return_exceptions=True)
    release.set()
    await running
    assert s._panel_waiters==0


async def test_permission_projection_and_lease_clear(access_store):
    s=access_store
    claim=await s.model_access_claim(NAME,force=True)
    before=(await s.manual_snapshot(NAME))['access']
    assert not await s.model_access_clear_lease(NAME,claim['generation'],'wrong')
    assert await s.model_access_clear_lease(NAME,claim['generation'],claim['lease_id'])
    after=(await s.manual_snapshot(NAME))['access']
    assert {k:v for k,v in before.items() if k!='lease'}=={k:v for k,v in after.items() if k!='lease'}
    snap=await s.manual_snapshot(NAME)
    result=await s.model_access_observe_with_projection(NAME,snap,MODELS)
    assert result['applied'] is True
    assert result['public']==await s.model_access_public(NAME)
    assert result['families']==await s.model_access_family_public(NAME)

async def test_slow_cohort_shares_result_without_extending_ttl(access_store,monkeypatch):
    s=access_store
    original=s._panel_attempt
    entered,release=asyncio.Event(),asyncio.Event()
    calls=[]
    async def delayed(*a,**kw):
        calls.append(1)
        entered.set()
        await release.wait()
        return await original(*a,**kw)
    monkeypatch.setattr(s,'_panel_attempt',delayed)
    monkeypatch.setattr(panel,'TTL',0.0)
    one=asyncio.create_task(s.get_antigravity_panel_summary())
    await entered.wait()
    two=asyncio.create_task(s.get_antigravity_panel_summary())
    await asyncio.sleep(0)
    one.cancel()
    with pytest.raises(asyncio.CancelledError):await one
    release.set()
    assert (await two)['total']==1
    assert len(calls)==1 and getattr(s,'_panel_index',None) is None
    await s.get_antigravity_panel_summary()
    assert len(calls)==2


async def test_native_and_family_public_expiry_reprojected(access_store,monkeypatch):
    s=access_store
    now=time.time()
    await observe(s,MODELS,now=now)
    first=await s.get_antigravity_panel_summary()
    cache=s._panel_index
    monkeypatch.setattr(panel.time,'time',lambda:now+VALID_FOR)
    second=await s.get_antigravity_panel_summary()
    assert s._panel_index is cache
    assert first['items'][0]['model_access_families'][FAMILIES[0]]['state']=='supported'
    assert second['items'][0]['model_access_families'][FAMILIES[0]]['state']=='unknown'
    assert all(v['state']=='unknown' for v in second['items'][0]['model_access_state'].values())


async def test_record_success_without_cache_does_not_invalidate_counters(access_store):
    s=access_store
    await s.quota_ensure_generation(NAME)
    before=getattr(s,'_panel_epoch',0)
    await s.record_success(NAME,'gemini-3-flash','antigravity')
    assert s._panel_epoch==before
    row=(await s._quota_rows(NAME))[0]
    assert row['success_count']==1 and row['call_count']==1
    assert row['last_success']
    await s.update_credential_state(NAME,{'error_codes':[403],'error_messages':{'403':'synthetic-error'}},'antigravity')
    before=s._panel_epoch
    await s.record_success(NAME,'gemini-3-flash','antigravity')
    assert s._panel_epoch==before+1
    row=(await s._quota_rows(NAME))[0]
    assert row['success_count']==2 and json.loads(row['error_codes'])==[]
    assert json.loads(row['error_messages'])=={}


async def test_failed_build_is_not_cached_and_next_request_recovers(access_store,monkeypatch):
    s=access_store
    original=s._panel_scan
    async def fail(**kw):
        raise RuntimeError('synthetic-read-failed')
        yield
    monkeypatch.setattr(s,'_panel_scan',fail)
    with pytest.raises(RuntimeError,match='synthetic-read-failed'):
        await s.get_antigravity_panel_summary()
    assert getattr(s,'_panel_index',None) is None
    monkeypatch.setattr(s,'_panel_scan',original)
    assert (await s.get_antigravity_panel_summary())['total']==1


async def test_last_cancel_closes_producer_and_releases_scan_lane(access_store,monkeypatch):
    s=access_store
    entered,closed=asyncio.Event(),asyncio.Event()
    async def scan(**kw):
        try:
            entered.set()
            await asyncio.Event().wait()
            yield
        finally:closed.set()
    monkeypatch.setattr(s,'_panel_scan',scan)
    waiter=asyncio.create_task(s.get_antigravity_panel_summary())
    await entered.wait()
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):await waiter
    await asyncio.wait_for(closed.wait(),1)
    await asyncio.sleep(0)
    assert not s._panel_lock.locked()
    assert not s._panel_jobs and not s._panel_job_readers


async def test_plain_listing_survives_missing_permission_columns(access_store, monkeypatch):
    s=access_store
    async with aiosqlite.connect(s._db_path) as conn:
        await conn.execute('ALTER TABLE antigravity_credentials DROP COLUMN model_access_state')
        await conn.execute('ALTER TABLE antigravity_credentials DROP COLUMN quota_credential_generation')
        await conn.commit()
    s.model_access_storage_ready=False
    s.SUPPORTS_QUOTA_GROUP_FILTER=False
    async def forbidden_legacy(**kw):
        raise AssertionError('partial schema must retain bounded light/page reads')
    monkeypatch.setattr(s, 'get_credentials_summary', forbidden_legacy)
    result=await s.get_antigravity_panel_summary(limit=25)
    assert result['total']==1 and len(result['items'])==1
    assert result['model_access_summary']['counts']['any']['unknown']==1
    assert result['quota_group_filter_supported'] is False
    assert s._panel_index is not None
    assert all(v['state']=='unknown' for v in result['items'][0]['model_access_families'].values())


async def test_same_value_state_and_store_do_not_drop_cache(access_store):
    s=access_store
    await s.quota_ensure_generation(NAME)
    await s.get_antigravity_panel_summary()
    cached=s._panel_index
    before=s._panel_epoch
    assert await s.update_credential_state(NAME,{'disabled':False,'error_codes':[]},'antigravity')
    assert s._panel_index is cached and s._panel_epoch==before
    original=await s.get_credential(NAME,'antigravity')
    assert await s.store_credential(NAME,original,'antigravity')
    assert s._panel_index is cached and s._panel_epoch==before
    s._panel_index=None
    assert await s.update_credential_state(NAME,{'disabled':False},'antigravity')
    assert s._panel_epoch==before


async def test_infinite_cooldown_preserves_legacy_stats_but_quota_fails_closed(access_store):
    s=access_store
    # Malformed persisted policy is simulated directly in the isolated temporary DB.
    async with aiosqlite.connect(s._db_path) as conn:
        await conn.execute('UPDATE antigravity_credentials SET model_cooldowns = ?',
                           (json.dumps({'gemini-3-flash': float('inf')}),))
        await conn.commit()
    old=await s.get_credentials_summary(mode='antigravity', limit=None)
    new=await s.get_antigravity_panel_summary()
    assert new['stats']==old['stats']
    assert new['stats']['in_cooldown']==1
    assert new['stats']['quota_state_invalid']==1
    assert new['items'][0]['model_cooldowns']=={}
    assert new['items'][0]['quota_state_invalid'] is True


def test_light_credential_json_decoded_once_and_invalid_json_fails_closed(monkeypatch):
    from test_antigravity_panel_index_backends import rows
    row=rows()[0]
    row['credential_data']=json.dumps(row['credential_data'])
    original=json.loads
    decoded=[]
    def counting(value,*args,**kwargs):
        if value==row['credential_data']:decoded.append(value)
        return original(value,*args,**kwargs)
    monkeypatch.setattr(panel.json,'loads',counting)
    result=panel._light(row,True)
    assert len(decoded)==1
    assert 'credential_data' not in result
    row['credential_data']='{broken synthetic'
    result=panel._light(row,True)
    assert len(decoded)==2
    assert all(v['state']=='unknown' for v in result['model_access_families'].values())


@pytest.mark.parametrize('target',['unrelated','page'])
async def test_final_uncached_read_survives_continuous_policy_writes(access_store,monkeypatch,target):
    s=access_store
    await add(s,'unrelated.json')
    read=s._panel_read
    calls=[]
    async def competing_write(names,**kwargs):
        calls.append(1)
        filename='unrelated.json' if target=='unrelated' else names[0]
        await s.update_credential_state(filename,{'remark':str(len(calls))},'antigravity')
        return await read(names,**kwargs)
    monkeypatch.setattr(s,'_panel_read',competing_write)
    result=await s.get_antigravity_panel_summary(limit=1)
    assert result['total']==2 and len(result['items'])==1
    assert len(calls)==3
    assert s._panel_index is None


@pytest.mark.parametrize('mutation',['generation','version','delete'])
async def test_final_uncached_read_still_fences_page_identity(access_store,monkeypatch,mutation):
    s=access_store
    read=s._panel_read
    async def replace(names,**kwargs):
        result=await read(names,**kwargs)
        if mutation=='delete':
            result.clear()
        elif mutation=='generation':
            result[names[0]]['quota_credential_generation']='replacement-generation'
        else:
            result[names[0]]['credential_data']={'refresh_token':'synthetic-replacement'}
        return result
    monkeypatch.setattr(s,'_panel_read',replace)
    with pytest.raises(panel.PanelListChanged,match='panel_page_changed'):
        await s.get_antigravity_panel_summary(limit=1)
    assert s._panel_index is None


async def test_sqlite_success_database_failure_remains_logged_and_suppressed(access_store,monkeypatch):
    s=access_store
    logs=[]
    monkeypatch.setattr(panel.log,'error',logs.append)
    async with aiosqlite.connect(s._db_path) as conn:
        await conn.execute('DROP TABLE antigravity_credentials')
        await conn.commit()
    epoch=getattr(s,'_panel_epoch',0)
    assert await s.record_success(NAME,mode='antigravity') is None
    assert getattr(s,'_panel_epoch',0)==epoch
    assert logs==['Antigravity success accounting failed (sqlite, OperationalError)']


async def test_sqlite_success_keeps_missing_generation_and_suppresses_stats_error(access_store,monkeypatch):
    s=access_store
    async with aiosqlite.connect(s._db_path) as conn:
        await conn.execute('UPDATE antigravity_credentials SET quota_credential_generation=NULL')
        await conn.commit()
    async def fail_stats(*args,**kwargs):
        raise RuntimeError('synthetic-stat-failure')
    monkeypatch.setattr(s,'_quota_result_stats',fail_stats)
    epoch=getattr(s,'_panel_epoch',0)
    assert await s.record_success(NAME,mode='antigravity') is None
    row=(await s._quota_rows(NAME))[0]
    assert row['success_count']==1 and row['call_count']==1
    assert row['quota_credential_generation'] is None
    assert getattr(s,'_panel_epoch',0)==epoch
