"""Import-only upserts against temporary SQLite and transactional driver doubles."""
import asyncio
import copy
import json
import re
import sqlite3
import time
from contextlib import asynccontextmanager
from types import SimpleNamespace

import aiosqlite
import pytest
from pymongo.errors import DuplicateKeyError

from src.storage.sqlite_manager import SQLiteManager
from src.storage.mysql_manager import MySQLManager
from src.storage.psql_manager import PSQLManager
from src.storage.mongodb_manager import MongoDBManager
from src.antigravity_model_access import MODELS, ROUTES

NAME = 'synthetic-import.json'
DATA = {'access_token': 'synthetic-one', 'project_id': 'synthetic-project'}
FIELDS = {'quota_credential_generation', 'model_access_state'}


@pytest.fixture
async def sqlite_store(tmp_path, monkeypatch):
    monkeypatch.setenv('CREDENTIALS_DIR', str(tmp_path))
    store = SQLiteManager()
    await store.initialize()
    try:
        yield store
    finally:
        await store.close()


async def test_sqlite_import_replaces_identity_preserves_state_and_fences_old_work(sqlite_store):
    store = sqlite_store
    assert await store.import_antigravity_credential(NAME, DATA, initial_state={'tier': 'ultra'})
    first = await store.model_access_snapshot(NAME)
    assert json.loads(first['raw']['error_messages']) == []
    assert await store.model_access_observe(NAME, first, list(ROUTES))
    admission = await store.quota_admit(NAME, MODELS[0])
    lease = await store.model_access_claim(NAME, force=True)
    await store.update_credential_state(NAME, {'disabled': True, 'tier': 'free', 'remark': 'keep'}, 'antigravity')
    async with aiosqlite.connect(store._db_path) as conn:
        await conn.execute('UPDATE antigravity_credentials SET quota_group_states=?, model_cooldowns=?, success_count=17 WHERE filename=?', ('broken-quota', 'broken-cooldown', NAME))
        await conn.commit()
    old = (await store._quota_rows(NAME))[0]
    store.model_access_storage_ready = False  # readiness is not column existence
    assert await store.import_antigravity_credential(NAME, {**DATA, 'access_token': 'synthetic-two'}, initial_state={'tier': 'pro', 'disabled': False})
    new = (await store._quota_rows(NAME))[0]
    changed = {key for key in new if old.get(key) != new[key]}
    assert changed == {'credential_data', 'quota_credential_generation', 'model_access_state'}
    assert new['quota_group_states'] == 'broken-quota' and new['model_cooldowns'] == 'broken-cooldown'
    assert new['disabled'] == 1 and new['tier'] == 'free' and new['success_count'] == 17
    assert json.loads(new['model_access_state']) == {}
    store.model_access_storage_ready = True
    assert not await store.model_access_observe(NAME, lease, list(ROUTES))
    assert not await store.model_access_observe(NAME, admission['model_access_snapshot'], model=MODELS[0], success=False)
    assert not await store.quota_refresh_credential(NAME, first['generation'], DATA, expected_version=first['version'])


async def test_sqlite_token_only_replacement_repeat_refresh_and_generic_store(sqlite_store):
    store = sqlite_store
    await store.import_antigravity_credential(NAME, DATA)
    first = await store.model_access_snapshot(NAME)
    await store.model_access_observe(NAME, first, [MODELS[0]])
    prior = await store.model_access_snapshot(NAME)
    assert await store.quota_refresh_credential(NAME, prior['generation'], {**DATA, 'access_token':'synthetic-refreshed'}, expected_version=prior['version'])
    assert (await store.model_access_snapshot(NAME))['generation'] == prior['generation']
    assert await store.quota_admit(NAME, MODELS[0])
    assert not await store.quota_admit(NAME, MODELS[2])
    await store.store_credential(NAME, DATA, 'antigravity')  # migration/generic operation retains generation
    assert (await store.model_access_snapshot(NAME))['generation'] == prior['generation']
    for data in (DATA, {**DATA, 'access_token':'synthetic-other'}):
        previous = (await store.model_access_snapshot(NAME))['generation']
        assert await store.import_antigravity_credential(NAME, data)
        assert (await store.model_access_snapshot(NAME))['generation'] != previous
        assert not await store.quota_admit(NAME, MODELS[0])
    await store.delete_credential(NAME, 'antigravity')
    await store.import_antigravity_credential(NAME, DATA)
    assert not await store.model_access_observe(NAME, prior, list(ROUTES))


async def test_sqlite_concurrent_imports_preserve_winning_insert_defaults(sqlite_store):
    store = sqlite_store
    assert all(await asyncio.gather(*(store.import_antigravity_credential(NAME, {**DATA, 'marker': n}, initial_state={'tier': tier}) for n,tier in enumerate(['free','ultra','pro'] * 3))))
    row = (await store._quota_rows(NAME))[0]
    assert row['tier'] in ('free','pro','ultra')
    original_tier = row['tier']
    await asyncio.gather(store.import_antigravity_credential(NAME, DATA, initial_state={'tier':'ultra'}), store.import_antigravity_credential(NAME, DATA, initial_state={'tier':'free'}))
    assert (await store._quota_rows(NAME))[0]['tier'] == original_tier


@pytest.mark.parametrize('initial', [{'surprise': 1}, {'disabled': 'false'}, {'error_codes':[True]}, {'last_success':float('inf')}, {'tier':'unknown'}, {'user_email':42}])
async def test_invalid_initial_state_never_writes(sqlite_store, initial):
    with pytest.raises(ValueError):
        await sqlite_store.import_antigravity_credential(NAME, DATA, initial_state=initial)
    assert await sqlite_store.get_credential(NAME, 'antigravity') is None


async def test_sqlite_failed_atomic_write_does_not_fallback(sqlite_store):
    store = sqlite_store
    await store.import_antigravity_credential(NAME, DATA)
    before = (await store._quota_rows(NAME))[0]
    async with aiosqlite.connect(store._db_path) as conn:
        await conn.execute("CREATE TRIGGER reject_import BEFORE UPDATE ON antigravity_credentials BEGIN SELECT RAISE(ABORT, 'synthetic rejection'); END")
        await conn.commit()
    with pytest.raises(Exception):
        await store.import_antigravity_credential(NAME, {'access_token':'synthetic-replacement'})
    assert (await store._quota_rows(NAME))[0] == before


# Driver doubles use real SQLite transactions/unique constraints. They translate
# only parameter/conflict syntax; production SQL shape is asserted before use.
class SQLPool:
    def __init__(self, engine, protection):
        self.engine, self.lock, self.queries = engine, asyncio.Lock(), []
        self.db = sqlite3.connect(':memory:')
        self.db.row_factory = sqlite3.Row
        columns = ['filename TEXT', 'credential_data TEXT', 'rotation_order INTEGER',
                   'disabled INTEGER DEFAULT 0', 'tier TEXT', 'error_codes TEXT', 'user_email TEXT',
                   'last_success REAL', 'quota_group_states TEXT', 'model_cooldowns TEXT',
                   'remark TEXT DEFAULT \'\'', 'success_count INTEGER DEFAULT 0', 'created_at REAL', 'updated_at REAL']
        columns += [key + ' TEXT' for key in sorted(protection)]
        if engine == 'mysql': columns += ['server_name TEXT', 'UNIQUE(server_name, filename)']
        else: columns += ['UNIQUE(filename)']
        self.db.execute('CREATE TABLE credentials (' + ','.join(columns) + ')')
        self.fail_after_write = self.fail_probe = self.found_rows_noop = False

    @asynccontextmanager
    async def acquire(self):
        yield SQLConnection(self)

    def row(self, server='node-a'):
        query='SELECT * FROM credentials'
        args=()
        if self.engine=='mysql': query += ' WHERE server_name=?'; args=(server,)
        result=self.db.execute(query,args).fetchone()
        return dict(result) if result else None


class SQLConnection:
    def __init__(self,pool): self.pool=pool; self.result=[]; self.rowcount=0
    async def begin(self):
        await self.pool.lock.acquire(); self.pool.db.execute('BEGIN')
    async def commit(self): self.pool.db.commit(); self.pool.lock.release()
    async def rollback(self): self.pool.db.rollback(); self.pool.lock.release()
    @asynccontextmanager
    async def transaction(self):
        await self.begin()
        try:
            yield
            await self.commit()
        except BaseException:
            await self.rollback(); raise
    @asynccontextmanager
    async def cursor(self): yield self
    async def fetch(self,query,*args):
        assert 'table_schema = current_schema()' in query
        if self.pool.fail_probe: raise RuntimeError('synthetic schema probe failure')
        return [{'column_name':row[1]} for row in self.pool.db.execute('PRAGMA table_info(credentials)')]
    async def fetchval(self,query,*args):
        return self.pool.db.execute(query,args).fetchone()[0]
    async def fetchone(self): return self.result[0] if self.result else None
    async def fetchall(self): return self.result
    async def execute(self,query,*args):
        assert self.pool.lock.locked()
        self.pool.queries.append(query)
        if query.startswith('SHOW COLUMNS'):
            if self.pool.fail_probe: raise RuntimeError('synthetic schema probe failure')
            self.result=[(row[1],) for row in self.pool.db.execute('PRAGMA table_info(credentials)')]; return
        params=args[0] if self.pool.engine=='mysql' and args else args
        if query.startswith('SELECT'):
            self.result=self.pool.db.execute(query.replace('%s','?'),params).fetchall(); return
        if self.pool.engine=='mysql':
            assert 'ON DUPLICATE KEY UPDATE' in query and 'server_name' in query
            columns=query.split('(',1)[1].split(')',1)[0].split(', ')
            server=params[columns.index('server_name')]
            existed=self.pool.row(server) is not None
            query=query.replace('%s','?').replace('ON DUPLICATE KEY UPDATE','ON CONFLICT(server_name, filename) DO UPDATE SET')
            query=re.sub(r'VALUES\((\w+)\)', r'excluded.\1',query)
            self.rowcount=1 if self.pool.found_rows_noop else (2 if existed else 1)
        else:
            assert 'ON CONFLICT (filename) DO UPDATE SET' in query
            query=re.sub(r'\$\d+', '?', query)
        self.pool.db.execute(query,params)
        if self.pool.fail_after_write: raise RuntimeError('synthetic execution failure')


@pytest.fixture(params=['postgres','mysql'])
def sql_store(request):
    engine=request.param
    store=(PSQLManager if engine=='postgres' else MySQLManager)()
    store._initialized=True; store._server_name='node-a'; store._get_table_name=lambda mode:'credentials'
    store._redis_enabled=False
    return store,engine


@pytest.mark.parametrize('protection', [set(), {'quota_credential_generation'}, {'model_access_state'}, FIELDS])
async def test_sql_driver_partial_columns_atomic_insert_and_overwrite(sql_store, protection):
    store,engine=sql_store; pool=SQLPool(engine,protection); store._pool=pool
    store.model_access_storage_ready=False
    try:
        assert await store.import_antigravity_credential(NAME,DATA,initial_state={'tier':'ultra','disabled':True})
        first=pool.row()
        pool.db.execute("UPDATE credentials SET quota_group_states='broken',model_cooldowns='broken',remark='preserve',success_count=19")
        pool.db.commit()
        before=pool.row()
        assert await store.import_antigravity_credential(NAME,{'access_token':'synthetic-new'},initial_state={'tier':'free','disabled':False})
        after=pool.row()
        assert {k for k in after if after[k]!=before[k]} <= {'credential_data',*protection}
        assert after['tier']=='ultra' and after['disabled']==1 and after['quota_group_states']=='broken'
        if 'quota_credential_generation' in protection: assert after['quota_credential_generation']!=first['quota_credential_generation']
        if 'model_access_state' in protection: assert json.loads(after['model_access_state'])=={}
        pool.fail_after_write=True
        with pytest.raises(RuntimeError): await store.import_antigravity_credential(NAME,DATA)
        assert pool.row()==after
        pool.fail_after_write=False; pool.fail_probe=True
        with pytest.raises(RuntimeError): await store.import_antigravity_credential(NAME,DATA)
        assert pool.row()==after
    finally: pool.db.close()


async def test_sql_driver_concurrent_upsert_and_mysql_isolation(sql_store):
    store,engine=sql_store; pool=SQLPool(engine,FIELDS); store._pool=pool
    try:
        await asyncio.gather(*(store.import_antigravity_credential(NAME,{'marker':n},initial_state={'tier':'ultra' if n==0 else 'free'}) for n in range(5)))
        assert pool.row()['tier']=='ultra'
        if engine=='mysql':
            original=pool.row(); store._server_name='node-b'
            await store.import_antigravity_credential(NAME,DATA,initial_state={'tier':'pro'})
            assert pool.row('node-a')==original and pool.row('node-b')['tier']=='pro'
    finally: pool.db.close()


@pytest.mark.parametrize('protection',[set(),{'quota_credential_generation'},{'model_access_state'},FIELDS])
async def test_sqlite_legacy_partial_columns(tmp_path,protection):
    store=SQLiteManager(); store._initialized=True; store._db_path=str(tmp_path/'legacy.db')
    base='filename TEXT UNIQUE, credential_data TEXT, rotation_order INTEGER, tier TEXT, disabled INTEGER DEFAULT 0'
    async with aiosqlite.connect(store._db_path) as conn:
        await conn.execute('CREATE TABLE antigravity_credentials ('+base+''.join(', '+key+' TEXT' for key in protection)+')')
        await conn.commit()
    assert await store.import_antigravity_credential(NAME,DATA,initial_state={'tier':'ultra'})
    assert await store.import_antigravity_credential(NAME,{'access_token':'synthetic-new'},initial_state={'tier':'free'})
    async with aiosqlite.connect(store._db_path) as conn:
        assert (await (await conn.execute('SELECT tier FROM antigravity_credentials')).fetchone())[0]=='ultra'


class MongoCollection:
    def __init__(self): self.rows={}; self.lock=asyncio.Lock(); self.duplicate=False; self.fail=False
    async def find_one(self,*args,**kwargs):
        return {'rotation_order': max((r.get('rotation_order',0) for r in self.rows.values()),default=-1)}
    async def update_one(self,query,update,upsert=False):
        assert not set(update.get('$set',{})) & set(update.get('$setOnInsert',{}))
        async with self.lock:
            name=query['filename']
            if self.fail: raise RuntimeError('synthetic write failure')
            if self.duplicate and upsert:
                self.duplicate=False
                self.rows[name]={'filename':name,'tier':'free','disabled':True,'quota_group_states':'broken','marker':'concurrent winner'}
                raise DuplicateKeyError('synthetic collision')
            if name not in self.rows:
                if not upsert: return SimpleNamespace(matched_count=0)
                self.rows[name]=copy.deepcopy(update['$setOnInsert']); inserted=True
            else: inserted=False
            self.rows[name].update(copy.deepcopy(update['$set']))
            return SimpleNamespace(matched_count=0 if inserted else 1,upserted_id='new' if inserted else None)


@pytest.mark.parametrize('duplicate',[False,True])
async def test_mongo_import_new_conflict_and_rollback(duplicate):
    store=MongoDBManager(); store._initialized=True; store._redis_enabled=False
    collection=MongoCollection(); store._get_collection_name=lambda mode:'credentials'; store._db={'credentials':collection}
    collection.duplicate=duplicate
    assert await store.import_antigravity_credential(NAME,DATA,initial_state={'tier':'ultra'})
    first=copy.deepcopy(collection.rows[NAME])
    if not duplicate: assert first['error_messages'] == []
    assert first['tier']==('free' if duplicate else 'ultra')
    assert await store.import_antigravity_credential(NAME,{'access_token':'synthetic-new'},initial_state={'tier':'pro','disabled':False})
    second=copy.deepcopy(collection.rows[NAME])
    assert {key for key in second if second[key]!=first[key]}=={'credential_data','quota_credential_generation'}
    assert second['tier']==first['tier'] and second['disabled']==first['disabled']
    await asyncio.gather(*(store.import_antigravity_credential(NAME,DATA,initial_state={'tier':'pro'}) for _ in range(5)))
    assert collection.rows[NAME]['tier']==first['tier']
    before=copy.deepcopy(collection.rows[NAME]); collection.fail=True
    with pytest.raises(RuntimeError): await store.import_antigravity_credential(NAME,DATA)
    assert collection.rows[NAME]==before


async def test_sqlite_import_and_latest_control_update_do_not_overwrite_each_other(sqlite_store):
    store = sqlite_store
    await store.import_antigravity_credential(NAME, DATA)
    await asyncio.gather(
        store.import_antigravity_credential(NAME, {**DATA, 'access_token':'synthetic-new'}, initial_state={'disabled':False}),
        store.update_credential_state(NAME, {'disabled':True, 'remark':'concurrent control'}, 'antigravity'),
        store.set_model_cooldown(NAME, 'claude-gpt-shared', time.time()+600, 'antigravity'),
    )
    row = (await store._quota_rows(NAME))[0]
    assert row['disabled'] == 1 and row['remark'] == 'concurrent control'
    assert json.loads(row['model_cooldowns'])['claude-gpt-shared'] > time.time()
    assert json.loads(row['credential_data'])['access_token'] == 'synthetic-new'


@pytest.mark.parametrize('engine', ['mongo', 'mysql'])
async def test_import_cache_uses_inserted_tier_only(engine):
    store = MongoDBManager() if engine == 'mongo' else MySQLManager()
    store._initialized = True
    calls = []
    async def cache(*args, **kwargs): calls.append((args,kwargs))
    store._redis_add_cred = cache
    if engine == 'mongo':
        store._get_collection_name = lambda mode:'credentials'
        store._db = {'credentials':MongoCollection()}
    else:
        store._get_table_name = lambda mode:'credentials'
        store._server_name='node-a'; store._pool=SQLPool(engine,FIELDS)
    try:
        await store.import_antigravity_credential(NAME, DATA, initial_state={'tier':'ultra'})
        await store.import_antigravity_credential(NAME, DATA, initial_state={'tier':'free'})
        assert len(calls)==1 and calls[0][1]['tier']=='ultra'
    finally:
        if engine=='mysql': store._pool.db.close()


@pytest.mark.parametrize('disabled', [True, False])
async def test_mysql_found_rows_cache_respects_existing_policy(disabled):
    store=MySQLManager(); store._initialized=True; store._server_name='node-a'
    store._get_table_name=lambda mode:'credentials'; pool=SQLPool('mysql',set()); store._pool=pool
    calls=[]
    async def cache(*args,**kwargs): calls.append(kwargs)
    store._redis_add_cred=cache
    try:
        await store.import_antigravity_credential(NAME,DATA,initial_state={'disabled':disabled,'tier':'ultra'})
        calls.clear(); before=pool.row(); pool.found_rows_noop=True
        await store.import_antigravity_credential(NAME,DATA,initial_state={'disabled':False,'tier':'free'})
        assert pool.row()==before
        if disabled:
            assert calls==[]
        else:
            assert len(calls)==1 and calls[0]['tier']=='ultra'
    finally: pool.db.close()
