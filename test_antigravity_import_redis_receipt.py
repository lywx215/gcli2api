"""Receipt uploads stay selectable independently of stale advisory Redis pools."""
import asyncio
import copy
import time
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest

from src.antigravity_directory_runtime import AtomicRegistry, SettlementPending
from src.storage.antigravity_quota import credential_version
from src.storage.mongodb_manager import MongoDBManager
from src.storage.mysql_manager import MySQLManager
from test_antigravity_import_atomic import DATA, FIELDS, NAME, MongoCollection, SQLPool, SQLConnection


class RedisPool:
    """A healthy nonempty stale pool; public AG selection must never read it."""
    def __init__(self):
        self.members = {'zz-existing.json'}
        self.reads = 0

    async def scard(self, key):
        self.reads += 1
        return len(self.members)

    async def srandmember(self, key, count):
        self.reads += 1
        return sorted(self.members)[:count]


class ReadableMongoCollection(MongoCollection):
    async def find_one(self, query, **kwargs):
        if 'filename' in query:
            return copy.deepcopy(self.rows.get(query['filename']))
        return await super().find_one(query, **kwargs)

    def find(self, query):
        assert query == {'disabled': {'$ne': True}}
        async def to_list(length):
            assert length is None
            return copy.deepcopy([row for row in self.rows.values() if not row['disabled']])
        return SimpleNamespace(to_list=to_list)


class ReadableSQLConnection(SQLConnection):
    @asynccontextmanager
    async def cursor(self, *args):
        yield self

    async def execute(self, query, *args):
        if query.startswith('SELECT * FROM credentials WHERE server_name = %s'):
            assert not self.pool.lock.locked()  # Real public selection is read-only.
            self.pool.queries.append(query)
            self.result = [dict(row) for row in self.pool.db.execute(query.replace('%s', '?'), args[0])]
            return
        await super().execute(query, *args)


class ReadableSQLPool(SQLPool):
    @asynccontextmanager
    async def acquire(self):
        yield ReadableSQLConnection(self)


@pytest.fixture(params=['mongo', 'mysql'])
def cached_store(request, monkeypatch):
    engine = request.param
    store = MongoDBManager() if engine == 'mongo' else MySQLManager()
    store._initialized = True
    store._redis_enabled = True
    store._redis = RedisPool()
    store._server_name = 'synthetic-node'
    if engine == 'mongo':
        collection = ReadableMongoCollection()
        store._get_collection_name = lambda mode: 'credentials'
        store._db = {'credentials': collection}
    else:
        store._get_table_name = lambda mode: 'credentials'
        store._pool = ReadableSQLPool('mysql', FIELDS)
    monkeypatch.setattr('src.storage.antigravity_quota.random.shuffle',
        lambda rows: rows.sort(key=lambda row: row['filename']))
    yield store
    if engine == 'mysql':
        store._pool.db.close()


async def test_new_receipt_upload_selectable_with_nonempty_stale_redis(cached_store):
    store = cached_store
    async def forbidden_cache(*args, **kwargs):
        raise AssertionError('Receipt imports must not await advisory cache work')
    store._redis_add_cred = forbidden_cache
    await store.import_antigravity_credential_with_receipt('zz-existing.json', {'marker': 'existing'})
    assert (await store.get_next_available_credential('antigravity'))[0] == 'zz-existing.json'
    receipt = await store.import_antigravity_credential_with_receipt(NAME, DATA,
        initial_state={'tier': 'ultra'})
    assert store._redis.members == {'zz-existing.json'}  # Deliberately stale.
    selected = await store.get_next_available_credential('antigravity')
    assert selected[0] == NAME
    assert selected[1]['access_token'] == DATA['access_token']
    assert selected[1]['_quota_generation'] == receipt.generation
    assert selected[1]['_quota_credential_version'] == receipt.credential_version == credential_version(DATA)
    assert store._redis.reads == 0


async def test_receipt_overwrite_preserves_disabled_policy_despite_stale_redis(cached_store):
    store = cached_store
    first = await store.import_antigravity_credential_with_receipt(NAME, DATA,
        initial_state={'disabled': True, 'tier': 'ultra'})
    before = (await store._quota_rows(NAME))[0]
    # A stale available pool cannot re-enable an existing disabled credential.
    store._redis.members.add(NAME)
    replacement = await store.import_antigravity_credential_with_receipt(NAME, {**DATA, 'marker': 2},
        initial_state={'disabled': False, 'tier': 'free'})
    after = (await store._quota_rows(NAME))[0]
    assert after['disabled'] == before['disabled'] and after['tier'] == 'ultra'
    assert replacement.generation != first.generation
    assert await store.get_next_available_credential('antigravity') is None
    assert store._redis.reads == 0


@pytest.mark.parametrize('abandon', ['timeout', 'cancel'])
async def test_receipt_late_settlement_ignores_redis_and_remains_selectable(cached_store, abandon):
    store = cached_store
    registry = AtomicRegistry()
    entered, release = asyncio.Event(), asyncio.Event()
    outcomes = []
    async def operation():
        entered.set()
        await release.wait()
        return await store.import_antigravity_credential_with_receipt(NAME, DATA)
    task = asyncio.create_task(registry.run(operation,
        deadline=time.monotonic() + .03, on_settled=outcomes.append))
    await entered.wait()
    if abandon == 'cancel':
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    else:
        with pytest.raises(SettlementPending):
            await task
    assert not outcomes
    pending = tuple(registry.tasks)
    release.set()
    await asyncio.wait_for(asyncio.gather(*pending), timeout=1)
    await asyncio.sleep(0)
    assert len(outcomes) == 1 and outcomes[0].status == 'succeeded'
    selected = await store.get_next_available_credential('antigravity')
    assert selected[0] == NAME and selected[1]['_quota_generation'] == outcomes[0].result.generation
    assert outcomes[0].result.credential_version == credential_version(DATA)
    assert store._redis.members == {'zz-existing.json'} and store._redis.reads == 0
    assert not registry.tasks
