"""No-network driver doubles for the actual panel SQL/Mongo readers."""
import copy
import asyncio
from contextlib import asynccontextmanager
import pytest
from src.storage import antigravity_panel as panel
from src.storage.mysql_manager import MySQLManager
from src.storage.psql_manager import PSQLManager
from src.storage.mongodb_manager import MongoDBManager


def rows():
    return [dict(filename=f'f{i:03}.json',rotation_order=i,disabled=False,
        permanent_disabled=False,tier='pro',remark='',error_codes=[],model_cooldowns={},
        quota_group_states={},quota_credential_generation='synthetic-generation',model_access_state={},
        credential_data={'refresh_token':f'synthetic-{i}'},error_messages={},user_email='',
        last_success=None,success_count=0,failure_count=0,cycle_stats={},last_cycle_stats={},enable_credit=False)
        for i in range(47)]


class Cursor:
    def __init__(self, db, selected=None):
        self.db, self.selected, self.pos = db, selected, 0
    async def __aenter__(self):return self
    async def __aexit__(self,*exc):self.db.open_cursor=False
    async def execute(self, sql, params=()):
        self.db.queries.append((sql,params))
        assert 'server_name = %s' in sql
        assert params[0]=='isolated'
        self.selected=copy.deepcopy(self.db.rows)
        if 'filename IN' in sql:self.selected=[r for r in self.selected if r['filename'] in params[1:]]
        self.db.open_cursor=True
    async def fetchmany(self, count):
        assert count<=500
        result=self.selected[self.pos:self.pos+count];self.pos+=len(result)
        return result
    async def fetchall(self):return self.selected
    def __aiter__(self):return self
    async def __anext__(self):
        if self.pos>=len(self.selected):raise StopAsyncIteration
        row=self.selected[self.pos];self.pos+=1;return row


class SQL:
    def __init__(self):self.rows=rows();self.queries=[];self.acquired=False;self.open_cursor=False
    @asynccontextmanager
    async def acquire(self):
        assert not self.acquired, 'nested acquire can deadlock a single-connection pool'
        self.acquired=True
        try:yield self
        finally:self.acquired=False
    @asynccontextmanager
    async def transaction(self):yield self
    async def rollback(self):assert not self.open_cursor
    def cursor(self, query, prefetch=None):
        if isinstance(query,str):
            assert prefetch==500
            self.queries.append((query,()))
            return Cursor(self,copy.deepcopy(self.rows))
        return Cursor(self)
    async def fetch(self,query,names):
        self.queries.append((query,names))
        assert 'filename = ANY($1::text[])' in query
        assert len(names)<=500
        return [copy.deepcopy(r) for r in self.rows if r['filename'] in names]


class MongoCursor:
    def __init__(self,db,selected):self.db,self.selected,self.pos=db,selected,0
    def sort(self,ordering):
        assert ordering==[('rotation_order',1),('_id',1)]
        self.selected.sort(key=lambda row:(row['rotation_order'],row.get('_id',row['filename'])))
        return self
    def batch_size(self,size):assert size==500;return self
    def __aiter__(self):return self
    async def __anext__(self):
        if self.pos>=len(self.selected):raise StopAsyncIteration
        row=self.selected[self.pos];self.pos+=1;return row
    async def close(self):self.db.closed+=1
    async def to_list(self,length):assert length==500;return self.selected


class Mongo:
    def __init__(self):self.rows=rows();self.queries=[];self.closed=0
    def find(self,query,projection):
        self.queries.append((query,projection))
        selected=self.rows
        if query:selected=[r for r in selected if r['filename'] in query['filename']['$in']]
        return MongoCursor(self,[{k:copy.deepcopy(v) for k,v in r.items() if k in projection or k=='_id'} for r in selected])


@pytest.fixture(params=['postgres','mysql','mongo'])
def store(request):
    engine=request.param
    cls={'postgres':PSQLManager,'mysql':MySQLManager,'mongo':MongoDBManager}[engine]
    s=cls.__new__(cls);s._initialized=True;s._server_name='isolated';s.model_access_storage_ready=True
    db=Mongo() if engine=='mongo' else SQL()
    s._pool=db;s._db={'antigravity_credentials':db}
    return s,db


async def test_actual_driver_projection_one_scan_two_pages(store):
    s,db=store
    result=await s.get_antigravity_panel_summary(offset=10,limit=20)
    assert result['total']==47
    assert [r['filename'] for r in result['items']]==[f'f{i:03}.json' for i in range(10,30)]
    assert result['stats']['normal']==47
    await s.get_antigravity_panel_summary(offset=30,limit=20)
    assert len(db.queries)==3 # one index scan + two page queries
    first=db.queries[0]
    if s.QUOTA_ENGINE=='mongo':
        assert 'credential_data' in first[1] and 'cycle_stats' not in first[1]
        assert db.closed==1
    else:
        assert 'credential_data' in first[0] and 'cycle_stats' not in first[0]
        assert 'error_messages' not in first[0]
        assert 'SELECT *' not in first[0]


async def test_streaming_overflow_driver_pool_one_and_counts(store,monkeypatch):
    s,db=store
    monkeypatch.setattr(panel,'MAX_ROWS',2)
    result=await s.get_antigravity_panel_summary(offset=40,limit=4,model_access_filter='unknown')
    assert result['total']==47 and result['model_access_summary']['total']==47
    assert result['stats']['total']==47 and len(result['items'])==4
    assert getattr(s,'_panel_index',None) is None
    assert len(db.queries)==2

from test_antigravity_quota_backends import backend

async def test_record_success_preserves_backend_counter_differences(success_backend):
    s,db=success_backend
    db.row.update(quota_credential_generation='stable',error_codes=[],error_messages={},
                  cycle_stats='{}',success_count=7,call_count=11,last_success=None)
    baseline=getattr(s,'_panel_epoch',0)
    await s.record_success(db.row['filename'],'gemini-3-flash','antigravity')
    assert getattr(s,'_panel_epoch',0)==baseline
    if s.QUOTA_ENGINE=='mysql':
        assert db.row['success_count']==7 and db.row['call_count']==11
        assert db.row['last_success'] is None
    else:
        assert db.row['success_count']==8 and db.row['call_count']==12
        assert db.row['last_success']
    db.row.update(error_codes=[403],error_messages={'403':'synthetic'})
    await s.record_success(db.row['filename'],'gemini-3-flash','antigravity')
    from src.error_classification import safe_json_list,safe_json_object
    assert safe_json_list(db.row['error_codes'])==[]
    assert safe_json_object(db.row['error_messages'])=={}
    assert getattr(s,'_panel_epoch',0)==baseline+1
    assert db.row['last_success']
    if s.QUOTA_ENGINE=='postgres':
        assert sum('INSERT INTO daily_stats' in q for q in db.queries)==2
        assert sum('INSERT INTO daily_model_stats' in q for q in db.queries)==2


@pytest.mark.parametrize('error_filter',['403','403_other'])
async def test_original_expiry_query_scope_with_error_filter(store,monkeypatch,error_filter):
    s,db=store
    monkeypatch.setattr(panel.time,'time',lambda:1000)
    db.rows=db.rows[:3]
    db.rows[0].update(disabled=True,error_codes=[403],model_cooldowns={'gemini-3-flash':1200})
    db.rows[1].update(disabled=True,error_codes=[500],model_cooldowns={'gemini-3-flash':1100})
    result=await s.get_antigravity_panel_summary(error_code_filter=error_filter)
    assert result['total']==1
    # Mongo's original candidate query applies error_code_filter before expiry;
    # Postgres/MySQL observe all rows matching status before the Python filter.
    assert result['stats']['quota_next_expiry']==(1200 if s.QUOTA_ENGINE=='mongo' else 1100)
    db.rows[2]['model_cooldowns']={'gemini-3-flash':1050}
    s.panel_index_invalidate()
    result=await s.get_antigravity_panel_summary(error_code_filter=error_filter)
    # Global normal-row quota stats still contribute even when the filter excludes it.
    assert result['stats']['quota_next_expiry']==1050


async def test_invalid_infinite_cooldown_stats_preserved(store):
    s,db=store
    db.rows=db.rows[:1]
    db.rows[0]['model_cooldowns']={'gemini-3-flash':float('inf')}
    result=await s.get_antigravity_panel_summary()
    assert result['stats']['in_cooldown']==1 and result['stats']['no_cooldown']==0
    assert result['stats']['quota_state_invalid']==1
    assert result['items'][0]['model_cooldowns']=={}
    assert result['items'][0]['quota_state_invalid'] is True


async def test_partial_schema_never_projects_permission_columns(store):
    s,db=store
    s.model_access_storage_ready=False
    for row in db.rows:
        row.pop('model_access_state')
        row.pop('quota_credential_generation')
    result=await s.get_antigravity_panel_summary(limit=25)
    assert result['total']==47 and len(result['items'])==25
    assert result['model_access_summary']['family_counts']['claude-opus-5-5']['unknown']==47
    for query,fields in db.queries:
        projection=fields if s.QUOTA_ENGINE=='mongo' else query
        assert 'model_access_state' not in projection
        assert 'quota_credential_generation' not in projection


async def test_mongo_tied_rotation_has_stable_id_order():
    s=MongoDBManager.__new__(MongoDBManager)
    s._initialized=True
    s.model_access_storage_ready=True
    db=Mongo()
    db.rows=db.rows[:4]
    for i,row in enumerate(db.rows):
        row.update(rotation_order=1,_id=4-i)
    s._db={'antigravity_credentials':db}
    result=await s.get_antigravity_panel_summary(offset=1,limit=2)
    assert [row['filename'] for row in result['items']]==['f002.json','f001.json']


@pytest.fixture
def success_backend(backend,monkeypatch):
    s,db=backend
    if s.QUOTA_ENGINE=='mongo':
        async def atomic_increment(query,updates,*,projection,return_document):
            from pymongo import ReturnDocument
            assert query=={'filename':db.row['filename']}
            assert return_document==ReturnDocument.BEFORE
            assert updates['$inc']=={'success_count':1,'call_count':1}
            await asyncio.sleep(0)
            async with db.lock:
                previous={key:copy.deepcopy(db.row[key]) for key in projection if key in db.row}
                for key,delta in updates['$inc'].items():
                    db.row[key]=db.row.get(key,0)+delta
                db.row.update(copy.deepcopy(updates['$set']))
                db.queries.append('find_one_and_update:$inc')
                return previous
        monkeypatch.setattr(db,'find_one_and_update',atomic_increment,raising=False)
    return s,db


async def test_success_accounting_failure_keeps_legacy_return_and_safe_log(success_backend,monkeypatch):
    s,db=success_backend
    logs=[]
    monkeypatch.setattr(panel.log,'error',logs.append)
    async def fail(*args,**kwargs):
        raise RuntimeError('synthetic credential text must never be logged')
    if s.QUOTA_ENGINE=='mongo':
        monkeypatch.setattr(db,'find_one_and_update',fail)
    else:
        monkeypatch.setattr(s,'_quota_atomic',fail)
    epoch=getattr(s,'_panel_epoch',0)
    assert await s.record_success(db.row['filename'],'gemini-3-flash','antigravity') is None
    assert getattr(s,'_panel_epoch',0)==epoch
    assert len(logs)==1 and 'RuntimeError' in logs[0]
    assert 'synthetic credential' not in logs[0]


async def test_mongo_concurrent_success_uses_one_atomic_increment_each(success_backend):
    s,db=success_backend
    if s.QUOTA_ENGINE!='mongo':
        return
    db.row.update(success_count=0,call_count=0,error_codes=[403],error_messages={'403':'synthetic'})
    epoch=getattr(s,'_panel_epoch',0)
    await asyncio.gather(*(s.record_success(db.row['filename'],mode='antigravity') for _ in range(128)))
    assert db.row['success_count']==db.row['call_count']==128
    assert db.row['error_codes']==[] and db.row['error_messages']=={}
    assert db.queries==['find_one_and_update:$inc']*128
    assert db.cas_conflicts==0
    assert s._panel_epoch==epoch+1
    assert db.row['quota_credential_generation'] is None
