"""Literal search, committed upload identity and settlement regression coverage."""
import asyncio
import copy
import time
from dataclasses import FrozenInstanceError

import pytest

from src.antigravity_directory_runtime import AtomicRegistry, SettlementPending
from src.storage.antigravity_import import ImportReceipt
from src.storage.antigravity_panel import matches_credential_search, normalize_credential_search
from src.storage.antigravity_quota import credential_version
from src.storage.mongodb_manager import MongoDBManager
from src.storage_adapter import StorageAdapter
from test_antigravity_import_atomic import (DATA, FIELDS, NAME, MongoCollection, SQLPool,
    sqlite_store, sql_store)
from test_antigravity_panel_index_backends import store as driver_store


@pytest.mark.parametrize('query,filename,email,expected', [
    ('1621', '1621_user.json', None, True),
    ('1621', '16210_user.json', '1621@example.test', False),
    ('001', '001_user.json', None, True),
    ('1', '001_user.json', None, False),
    ('USER', '001_user.json', None, True),
    ('ALPHA', 'unrelated.json', 'alpha@example.test', True),
    ('%_', 'unrelated.json', 'a%_b@example.test', True),
    ('[abc]', 'a.json', 'a@example.test', False),
    ('Ä', 'ä.json', None, False),
    ('１６２１', '１６２１_user.json', None, True),
    ('   ', 'arbitrary.json', None, True),
])
def test_search_exact_numeric_and_literal_ascii(query, filename, email, expected):
    assert matches_credential_search(filename, email, query) is expected


def test_search_trim_limit():
    assert normalize_credential_search('  001  ') == '001'
    assert len(normalize_credential_search('a'*255)) == 255
    with pytest.raises(ValueError): normalize_credential_search('a'*256)
    with pytest.raises(ValueError): normalize_credential_search(1)


async def test_driver_search_before_page_counts_and_cache(driver_store):
    store, db = driver_store
    db.rows[10].update(filename='1621_alpha.json', user_email='Alpha@example.test')
    db.rows[11].update(filename='16210_other.json', user_email='alpha@example.test')
    db.rows[12].update(filename='001_alpha.json', user_email='ALPHA@example.test', tier='free')
    result = await store.get_antigravity_panel_summary(search=' 1621 ', limit=1)
    assert [r['filename'] for r in result['items']] == ['1621_alpha.json']
    assert result['total'] == result['model_access_summary']['total'] == 1
    assert result['stats']['total'] == 47
    cache = store._panel_index
    result = await store.get_antigravity_panel_summary(search='aLpHa', offset=1, limit=1)
    assert store._panel_index is cache
    assert result['items'][0]['filename'] == '16210_other.json'
    assert result['total'] == result['model_access_summary']['total'] == 3
    assert result['stats']['total'] == 47
    result = await store.get_antigravity_panel_summary(search='alpha', tier_filter='free')
    assert result['total'] == 1
    assert result['items'][0]['filename'] == '001_alpha.json'
    projection = db.queries[0][1] if store.QUOTA_ENGINE == 'mongo' else db.queries[0][0]
    assert 'user_email' in projection and 'cycle_stats' not in projection


async def test_sqlite_email_cas_invalidates_cached_search(sqlite_store):
    store = sqlite_store
    receipt = await store.import_antigravity_credential_with_receipt('1621_alpha.json', DATA)
    assert (await store.get_antigravity_panel_summary(search='found@example.test'))['total'] == 0
    cached = store._panel_index
    assert await store.quota_refresh_credential(receipt.filename, receipt.generation, None,
        expected_version=receipt.credential_version, state_updates={'user_email':'Found@example.test'})
    assert store._panel_index is None and cached is not None
    result = await store.get_antigravity_panel_summary(search='found@')
    assert result['total'] == result['model_access_summary']['total'] == 1
    assert result['items'][0]['user_email'] == 'Found@example.test'
    assert (await store.get_antigravity_panel_summary(search='16210'))['total'] == 0


async def test_receipt_sqlite_exact_identity_and_overwrite_email(sqlite_store):
    store = sqlite_store
    first = await store.import_antigravity_credential_with_receipt(NAME, DATA)
    assert isinstance(first, ImportReceipt) and first.email_fence_supported
    with pytest.raises(FrozenInstanceError): first.filename = 'changed.json'
    assert await store.quota_refresh_credential(NAME, first.generation, None,
        expected_version=first.credential_version, state_updates={'user_email':'previous@example.test'})
    await store.update_credential_state(NAME, {'disabled':True, 'remark':'keep'}, 'antigravity')
    replacement = {**DATA, 'marker': 'new'}
    second = await store.import_antigravity_credential_with_receipt(NAME, replacement,
        initial_state={'disabled':False, 'user_email':'unsafe-initial@example.test'})
    row = (await store._quota_rows(NAME))[0]
    assert row['quota_credential_generation'] == second.generation != first.generation
    assert second.credential_version == credential_version(replacement)
    assert row['user_email'] is None and row['disabled'] and row['remark'] == 'keep'
    assert not await store.quota_refresh_credential(NAME, first.generation, None,
        expected_version=first.credential_version, state_updates={'user_email':'stale@example.test'})


@pytest.mark.parametrize('protection', [set(), {'quota_credential_generation'}, FIELDS])
async def test_receipt_sql_drivers_actual_columns_and_email_clear(sql_store, protection):
    store, engine = sql_store
    pool = SQLPool(engine, protection); store._pool = pool
    try:
        first = await store.import_antigravity_credential_with_receipt(NAME, DATA)
        pool.db.execute("UPDATE credentials SET user_email='previous@example.test', remark='keep'")
        pool.db.commit()
        second = await store.import_antigravity_credential_with_receipt(NAME, {**DATA, 'marker':2})
        row = pool.row()
        assert row['user_email'] is None and row['remark'] == 'keep'
        assert second.email_fence_supported == ('quota_credential_generation' in protection)
        assert second.generation == row.get('quota_credential_generation')
        assert first.credential_version == credential_version(DATA)
        assert second.credential_version == credential_version({**DATA, 'marker':2})
    finally:
        pool.db.close()


async def test_mongo_receipt_and_nonoverlapping_email_defaults():
    store = MongoDBManager(); store._initialized=True; store._redis_enabled=False
    collection=MongoCollection(); store._get_collection_name=lambda mode:'credentials'
    store._db={'credentials':collection}
    first = await store.import_antigravity_credential_with_receipt(NAME, DATA,
        initial_state={'user_email':'untrusted@example.test'})
    assert collection.rows[NAME]['user_email'] is None
    collection.rows[NAME].update(user_email='old@example.test', remark='keep')
    second = await store.import_antigravity_credential_with_receipt(NAME, DATA)
    assert second.email_fence_supported and collection.rows[NAME]['user_email'] is None
    assert second.generation == collection.rows[NAME]['quota_credential_generation'] != first.generation
    assert collection.rows[NAME]['remark'] == 'keep'


async def test_receipt_adapter_legacy_backend_does_not_read_later_identity():
    class Legacy:
        async def import_antigravity_credential(self, *args, **kwargs): return True
        async def get_credential(self, *args, **kwargs): raise AssertionError('must not read back')
    adapter = StorageAdapter(); adapter._initialized=True; adapter._backend=Legacy()
    receipt = await adapter.import_antigravity_credential_with_receipt(NAME, DATA)
    assert not receipt.email_fence_supported and receipt.generation is None
    assert await adapter.import_antigravity_credential(NAME, DATA) is True


@pytest.mark.parametrize('value', [True, False, 0, None])
async def test_atomic_settled_preserves_result_including_false(value):
    registry = AtomicRegistry(); seen=[]
    result = await registry.run(lambda: asyncio.sleep(0, result=value), on_settled=seen.append)
    assert result is value and len(seen) == 1
    assert seen[0].status == 'succeeded' and seen[0].result is value


async def test_atomic_settled_exception_and_notification_failure_preserve_semantics():
    registry = AtomicRegistry(); seen=[]
    async def fail(): raise ValueError('synthetic operation failure')
    with pytest.raises(ValueError, match='synthetic operation failure'):
        await registry.run(fail, on_settled=seen.append)
    assert len(seen) == 1 and seen[0].status == 'failed'
    assert isinstance(seen[0].exception, ValueError)
    def bad_callback(outcome): raise RuntimeError('synthetic callback failure')
    assert await registry.run(lambda: asyncio.sleep(0, result=7), on_settled=bad_callback) == 7


async def test_atomic_late_settlement_delivered_once_after_timeout_and_cancel():
    for cancel in (False, True):
        registry = AtomicRegistry(); gate=asyncio.Event(); entered=asyncio.Event(); seen=[]
        async def write(): entered.set(); await gate.wait(); return False
        task = asyncio.create_task(registry.run(write, deadline=time.monotonic()+.04,
            on_settled=seen.append))
        await entered.wait()
        if cancel:
            task.cancel()
            with pytest.raises(asyncio.CancelledError): await task
        else:
            with pytest.raises(SettlementPending): await task
        assert not seen and len(registry.tasks) == 1
        gate.set()
        for _ in range(5): await asyncio.sleep(0)
        assert len(seen) == 1 and seen[0].status == 'succeeded' and seen[0].result is False
        assert not registry.tasks


async def test_atomic_operation_cancel_and_completion_cancel_race():
    registry = AtomicRegistry(); seen=[]
    async def cancel_self(): raise asyncio.CancelledError()
    with pytest.raises(asyncio.CancelledError): await registry.run(cancel_self, on_settled=seen.append)
    assert len(seen) == 1 and seen[0].status == 'cancelled'
    gate=asyncio.Event(); seen=[]
    task=asyncio.create_task(registry.run(lambda: gate.wait(), on_settled=seen.append))
    for _ in range(3): await asyncio.sleep(0)
    gate.set(); task.cancel()
    with pytest.raises(asyncio.CancelledError): await task
    for _ in range(5): await asyncio.sleep(0)
    assert len(seen) == 1 and seen[0].status == 'succeeded' and seen[0].result is True


async def test_receipt_mongo_fast_path_has_no_advisory_await_or_readback():
    store = MongoDBManager(); store._initialized=True; store._redis_enabled=False
    collection = MongoCollection(); store._get_collection_name=lambda mode:'credentials'
    store._db={'credentials':collection}
    calls=[]
    async def cache(*args, **kwargs): calls.append(1); raise AssertionError('receipt must return immediately')
    store._redis_add_cred=cache
    first = await store.import_antigravity_credential_with_receipt(NAME, DATA)
    assert calls == []
    identity = first.generation
    await store.import_antigravity_credential_with_receipt(NAME, {**DATA, 'marker':2})
    assert first.generation == identity != collection.rows[NAME]['quota_credential_generation']
    assert first.credential_version == credential_version(DATA)


async def test_fenced_credential_read_independent_of_corrupt_quota_admission_stays_closed(sqlite_store):
    store = sqlite_store
    receipt = await store.import_antigravity_credential_with_receipt(NAME, DATA)
    import aiosqlite
    async with aiosqlite.connect(store._db_path) as conn:
        await conn.execute('UPDATE antigravity_credentials SET quota_group_states=?, model_cooldowns=? WHERE filename=?',
            ('broken-quota', 'broken-cooldown', NAME))
        await conn.commit()
    current = await store.quota_current_credential(NAME, receipt.generation)
    assert current['access_token'] == DATA['access_token']
    assert current['_quota_credential_version'] == receipt.credential_version
    assert await store.quota_current_credential(NAME, 'wrong-generation') is None
    assert await store.quota_refresh_credential(NAME, receipt.generation, None,
        expected_version=receipt.credential_version, state_updates={'user_email':'found@example.test'})
    from src.antigravity_quota import InvalidQuotaState
    with pytest.raises(InvalidQuotaState): await store.quota_admit(NAME, 'gemini-3-flash')
    raw = (await store._quota_rows(NAME))[0]
    assert raw['quota_group_states'] == 'broken-quota' and raw['model_cooldowns'] == 'broken-cooldown'

async def test_late_atomic_email_commit_invalidates_search_without_waiter(sqlite_store):
    store = sqlite_store
    receipt = await store.import_antigravity_credential_with_receipt(NAME, DATA)
    assert (await store.get_antigravity_panel_summary(search='late@example.test'))['total'] == 0
    cached = store._panel_index
    gate = asyncio.Event()
    registry = AtomicRegistry()
    seen = []

    async def write():
        await gate.wait()
        return await store.quota_refresh_credential(NAME, receipt.generation, None,
            expected_version=receipt.credential_version,
            state_updates={'user_email': 'Late@example.test'})

    with pytest.raises(SettlementPending):
        await registry.run(write, deadline=time.monotonic() + .02,
            phase='email_write', on_settled=seen.append)
    assert store._panel_index is cached and not seen
    pending = tuple(registry.tasks)
    gate.set()
    await asyncio.wait_for(asyncio.gather(*pending), timeout=1)
    assert seen[0].status == 'succeeded' and seen[0].result is True
    assert store._panel_index is None
    result = await store.get_antigravity_panel_summary(search='late@example.test')
    assert result['total'] == 1 and result['items'][0]['user_email'] == 'Late@example.test'
