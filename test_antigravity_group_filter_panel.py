"""Temporary SQLite and panel routes: capability negotiation, paging and no writes."""
import json
import sqlite3
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from src.panel import creds
from src.storage.sqlite_manager import SQLiteManager
from test_antigravity_group_filter import NOW, C, G
from test_antigravity_group_filter_backends import rows


@pytest.fixture
async def store(tmp_path, monkeypatch):
    monkeypatch.setenv('CREDENTIALS_DIR', str(tmp_path))
    manager = SQLiteManager()
    await manager.initialize()
    for row in rows():
        await manager.store_credential(row['filename'], {'kind': 'synthetic'}, 'antigravity')
    with sqlite3.connect(manager._db_path) as conn:
        for row in rows():
            conn.execute('UPDATE antigravity_credentials SET model_cooldowns=?, quota_group_states=?, disabled=?, permanent_disabled=?, tier=?, remark=?, error_codes=? WHERE filename=?',
                (json.dumps(row['model_cooldowns']), json.dumps(row['quota_group_states']) if isinstance(row['quota_group_states'],dict) else row['quota_group_states'], row['disabled'], row['permanent_disabled'], row['tier'],row['remark'],'[403]',row['filename']))
    monkeypatch.setattr('time.time', lambda: NOW)
    yield manager
    await manager.close()


async def test_sqlite_bounded_legacy_metadata_and_global_counts(store, monkeypatch):
    results = []
    for bounded in ('1','0'):
        monkeypatch.setenv('CREDENTIAL_SUMMARY_BOUNDED_FAST_PATH',bounded)
        data = await store.get_credentials_summary(mode='antigravity', limit=25)
        assert data['total'] == 7
        assert data['quota_group_filter_supported']
        assert data['stats']['quota_restricted'] == 4
        assert data['stats']['quota_unrestricted'] == 1
        assert data['stats']['quota_state_invalid'] == 1
        assert data['items'][4]['quota_state_invalid']
        results.append(data)
        filtered = await store.get_credentials_summary(mode='antigravity', limit=25,
            cooldown_filter='gemini_restricted',status_filter='enabled', tier_filter='pro',remark_filter='blue',error_code_filter='403')
        assert [i['filename'] for i in filtered['items']] == ['1.json','4.json']
        assert filtered['stats']['quota_restricted'] == 4
    assert results[0] == results[1]


@pytest.mark.parametrize('filter_name,expected', [('in_cooldown',['0.json','3.json','5.json','6.json']),
                                                ('no_cooldown',['1.json','2.json','4.json'])])
async def test_legacy_filters_remain_timestamp_only(store, filter_name, expected):
    data = await store.get_credentials_summary(mode='antigravity',cooldown_filter=filter_name)
    assert [i['filename'] for i in data['items']] == expected


@pytest.mark.parametrize('mode,value', [('antigravity','garbage'),('geminicli','any_restricted'),('geminicli','all_unrestricted')])
async def test_reject_invalid_before_read(monkeypatch, mode, value):
    forbidden = AsyncMock(side_effect=AssertionError('storage must not be read'))
    monkeypatch.setattr(creds,'get_storage_adapter',forbidden)
    with pytest.raises(HTTPException) as exc:
        await creds.get_creds_status_common(0,25,'all',mode,cooldown_filter=value)
    assert exc.value.status_code == 400
    forbidden.assert_not_awaited()


@pytest.mark.parametrize('class_support,result_support', [(False,False),(True,False)])
async def test_unsupported_or_failed_backend_does_not_advertise_capability(monkeypatch,class_support,result_support):
    async def summary(**kwargs): return {'items':[],'total':0,'quota_group_filter_supported':result_support}
    backend = SimpleNamespace(get_credentials_summary=summary,SUPPORTS_QUOTA_GROUP_FILTER=class_support)
    async def adapter(): return SimpleNamespace(_backend=backend,get_backend_info=AsyncMock(return_value={}))
    monkeypatch.setattr(creds,'get_storage_adapter',adapter)
    data = json.loads((await creds.get_creds_status_common(0,25,'all','antigravity')).body)
    assert 'antigravity.cooldown.group_filter' not in data.get('panel_capabilities',[])
    with pytest.raises(HTTPException) as exc:
        await creds.get_creds_status_common(0,25,'all','antigravity',cooldown_filter='any_restricted')
    assert exc.value.status_code == 501


async def test_hundreds_combined_filter_before_pagination_and_read_only(store,monkeypatch):
    from src.antigravity_model_access import MODELS
    with sqlite3.connect(store._db_path) as conn:
        conn.execute('DELETE FROM antigravity_credentials')
        for i in range(603):
            access={m:{'state':'supported' if i%3==0 else 'unavailable','checked_at':NOW} for m in MODELS}
            conn.execute('INSERT INTO antigravity_credentials (filename,credential_data,rotation_order,tier,remark,error_codes,model_cooldowns,quota_group_states,model_access_state) VALUES (?,?,?,?,?,?,?,?,?)',
              (f'item-{i:04d}.json','{}',i,'pro','blue','[403]',json.dumps({G:NOW+100} if i%2==0 else {}),'{}',json.dumps(access)))
        before = conn.execute('SELECT * FROM antigravity_credentials').fetchall()
    async def access_reader():
        return {f'item-{i:04d}.json':{m:{'state':'supported' if i%3==0 else 'unavailable','checked_at':NOW} for m in MODELS} for i in range(603)}
    monkeypatch.setattr(store,'model_access_list_public',access_reader)
    forbidden = AsyncMock(side_effect=AssertionError('list performed network or write'))
    for name in ('quota_sync','quota_snapshot','quota_admit','_quota_atomic','update_credential_state','record_request_result'):
        monkeypatch.setattr(store,name,forbidden,raising=False)
    monkeypatch.setattr(creds,'fetch_quota_info',forbidden)
    async def adapter(): return SimpleNamespace(_backend=store,get_backend_info=AsyncMock(return_value={'backend_type':'sqlite'}))
    monkeypatch.setattr(creds,'get_storage_adapter',adapter)
    data=json.loads((await creds.get_creds_status_common(25,25,'enabled','antigravity',
        cooldown_filter='gemini_restricted',tier_filter='pro',error_code_filter='403',remark_filter='blue',
        model_access_filter='supported',model_access_tier='high')).body)
    assert data['total']==101
    assert [i['filename'] for i in data['items']]==[f'item-{i:04d}.json' for i in range(150,300,6)]
    assert data['has_more']
    assert data['stats']['quota_restricted']==302
    assert 'antigravity.cooldown.group_filter' in data['panel_capabilities']
    assert all(i['quota_groups'][G]['restricted'] for i in data['items'])
    forbidden.assert_not_awaited()
    with sqlite3.connect(store._db_path) as conn:
        assert conn.execute('SELECT * FROM antigravity_credentials').fetchall()==before


@pytest.mark.parametrize('deadline', [float('nan'),float('inf'),10**400])
async def test_invalid_numeric_cooldown_is_json_safe_fail_closed(store,monkeypatch,deadline):
    with sqlite3.connect(store._db_path) as conn:
        conn.execute('UPDATE antigravity_credentials SET model_cooldowns=? WHERE filename=?',
                     (json.dumps({G:deadline}),'2.json'))
    async def adapter(): return SimpleNamespace(_backend=store,get_backend_info=AsyncMock(return_value={}))
    monkeypatch.setattr(creds,'get_storage_adapter',adapter)
    response = await creds.get_creds_status_common(0,25,'all','antigravity',cooldown_filter='any_restricted')
    data=json.loads(response.body)
    item=next(i for i in data['items'] if i['filename']=='2.json')
    assert item['quota_state_invalid']
    assert all(item['quota_groups'][g]['restricted'] for g in (C,G))
    assert item['model_cooldowns']=={}


@pytest.mark.parametrize('disabled', [False,True])
async def test_empty_api_unrestricted_page_retains_hidden_candidate_expiry(store,monkeypatch,disabled):
    with sqlite3.connect(store._db_path) as conn:
        conn.execute("DELETE FROM antigravity_credentials WHERE filename != '0.json'")
        conn.execute('UPDATE antigravity_credentials SET disabled=?,model_cooldowns=?',
            (disabled,json.dumps({'claude-opus-4-6':NOW+10,'claude-opus-5-5-high':NOW+100,G:NOW+80})))
    async def adapter(): return SimpleNamespace(_backend=store,get_backend_info=AsyncMock(return_value={}))
    monkeypatch.setattr(creds,'get_storage_adapter',adapter)
    for now,expiry,total in ((NOW,NOW+80,0),(NOW+80,NOW+100,0),(NOW+100,0,1)):
        monkeypatch.setattr('time.time',lambda:now)
        data=json.loads((await creds.get_creds_status_common(0,25,'disabled' if disabled else 'enabled','antigravity',
            cooldown_filter='all_unrestricted')).body)
        assert data['total']==total
        assert len(data['items'])==total
        assert data['stats']['quota_next_expiry']==expiry
        assert data['stats']['quota_restricted']==(0 if disabled or total else 1)


async def test_sqlite_bounded_legacy_expiry_includes_disabled_off_page_candidate(store,monkeypatch):
    with sqlite3.connect(store._db_path) as conn:
        conn.execute("DELETE FROM antigravity_credentials WHERE filename NOT IN ('0.json','1.json')")
        conn.execute('UPDATE antigravity_credentials SET disabled=0,quota_group_states=?,model_cooldowns=? WHERE filename=?',
                     ('{}',json.dumps({G:NOW+200}),'0.json'))
        conn.execute('UPDATE antigravity_credentials SET disabled=1,quota_group_states=?,model_cooldowns=? WHERE filename=?',
                     ('{}',json.dumps({C:NOW+50}),'1.json'))
        before=conn.execute('SELECT * FROM antigravity_credentials ORDER BY filename').fetchall()
    results=[]
    for enabled in ('1','0'):
        monkeypatch.setenv('CREDENTIAL_SUMMARY_BOUNDED_FAST_PATH',enabled)
        result=await store.get_credentials_summary(mode='antigravity',status_filter='all',offset=0,limit=1)
        assert [i['filename'] for i in result['items']]==['0.json']
        assert result['stats']['quota_next_expiry']==NOW+50
        assert result['stats']['quota_restricted']==1
        results.append(result)
    assert results[0]==results[1]
    with sqlite3.connect(store._db_path) as conn:
        assert conn.execute('SELECT * FROM antigravity_credentials ORDER BY filename').fetchall()==before
