import asyncio
import json
import time
from contextlib import asynccontextmanager

import aiosqlite
import pytest
from src.storage._stats_common import prepare_antigravity_cooldown
from src.storage.sqlite_manager import SQLiteManager
from src.storage.psql_manager import PSQLManager

HIGH = 'gemini-3.1-pro-high'
LOW = 'gemini-3.1-pro-low'
FLASH = 'gemini-3.7-flash-medium'


@pytest.fixture
async def db(tmp_path, monkeypatch):
    monkeypatch.setenv('CREDENTIALS_DIR', str(tmp_path))
    manager = SQLiteManager()
    await manager.initialize()
    assert await manager.store_credential('synthetic.json', {}, mode='antigravity')
    async with aiosqlite.connect(manager._db_path) as conn:
        await conn.execute('UPDATE antigravity_credentials SET cycle_stats = ?',
                           (json.dumps({'pro':7, 'flash':3, 'other':2, 'total':12}),))
        await conn.commit()
    try:
        yield manager
    finally:
        await manager.close()


async def snapshot(db):
    async with aiosqlite.connect(db._db_path) as conn:
        async with conn.execute('SELECT model_cooldowns,cycle_stats,last_cycle_stats FROM antigravity_credentials') as cursor:
            return [json.loads(value or '{}') for value in await cursor.fetchone()]


@pytest.mark.parametrize('concurrent', [False, True])
async def test_high_low_close_seven_once(db, concurrent):
    deadline = time.time()+100
    async def set_cd(model):
        return await db.set_model_cooldown('synthetic.json', model, deadline, mode='antigravity')
    if concurrent:
        assert all(await asyncio.gather(set_cd(HIGH), set_cd(LOW)))
    else:
        assert await set_cd(HIGH)
        assert await set_cd(LOW)
    cooldowns, current, last = await snapshot(db)
    assert last['total'] == last['pro'] == 7
    assert current['pro'] == 0 and current['flash'] == 3 and current['other'] == 2
    assert set(cooldowns) == {HIGH, LOW}
    assert await db.set_model_cooldown('synthetic.json', LOW, deadline+100, mode='antigravity')
    assert (await snapshot(db))[2] == last


async def test_flash_closes_separately_and_clearing_starts_new_cycle(db):
    deadline = time.time()+100
    assert await db.set_model_cooldown('synthetic.json', HIGH, deadline, mode='antigravity')
    assert await db.set_model_cooldown('synthetic.json', FLASH, deadline+100, mode='antigravity')
    cooldowns, current, last = await snapshot(db)
    assert last['flash'] == 3 and last['pro'] == 0
    assert current['other'] == 2 and current['total'] == 2
    assert cooldowns[HIGH] == cooldowns[FLASH]
    assert await db.set_model_cooldown('synthetic.json', LOW, deadline+300, mode='antigravity')
    assert (await snapshot(db))[2] == last
    assert await db.set_model_cooldown('synthetic.json', LOW, None, mode='antigravity')
    assert (await snapshot(db))[0] == {}
    assert await db.set_model_cooldown('synthetic.json', HIGH, deadline, mode='antigravity')
    assert (await snapshot(db))[2]['cooldown_family'] == 'pro'


async def test_expired_deadline_does_not_close(db):
    assert await db.set_model_cooldown('synthetic.json', HIGH, time.time()-1, mode='antigravity')
    _, current, last = await snapshot(db)
    assert current['total'] == 12 and last == {}


def test_expiry_new_round_and_legacy_keys():
    cooldowns, close = prepare_antigravity_cooldown({HIGH:90, FLASH:95}, LOW, 200, now=100)
    assert close and cooldowns == {LOW:200}
    cooldowns, close = prepare_antigravity_cooldown(cooldowns, FLASH, 300, now=100)
    assert close and cooldowns[LOW] == 300
    cooldowns, close = prepare_antigravity_cooldown(cooldowns, HIGH, 400, now=250)
    assert not close
    for key in ('gemini-shared', HIGH):
        _, close = prepare_antigravity_cooldown({key:200}, LOW, 300, now=100)
        assert not close
    # Unknown models remain independent; no broad all-Gemini grouping.
    _, close = prepare_antigravity_cooldown({HIGH:200}, 'gemini-3.8-flash', 300, now=100)
    assert close
    _, close = prepare_antigravity_cooldown({'claude-sonnet-4-6':200}, 'gpt-oss-120b', 300, now=100)
    assert not close


async def test_postgres_uses_transaction_and_row_lock():
    class Connection:
        locked = False
        row = {'model_cooldowns':'{}', 'cycle_stats':json.dumps({'pro':7}), 'last_cycle_stats':'{}'}
        @asynccontextmanager
        async def transaction(self):
            self.locked = True
            try:
                yield
            finally:
                self.locked = False
        async def fetchrow(self, query, filename):
            assert self.locked and 'FOR UPDATE' in query
            return dict(self.row)
        async def execute(self, query, *args):
            assert self.locked
            self.row['model_cooldowns'] = args[0]
            if len(args) == 4:
                self.row['cycle_stats'], self.row['last_cycle_stats'] = args[1:3]
    conn = Connection()
    class Pool:
        @asynccontextmanager
        async def acquire(self):
            yield conn
    manager = PSQLManager.__new__(PSQLManager)
    manager._pool = Pool()
    manager._ensure_initialized = lambda: None
    manager._get_table_name = lambda _: 'antigravity_credentials'
    deadline = time.time()+100
    for model in (HIGH, LOW):
        assert await manager.set_model_cooldown('synthetic.json', model, deadline, mode='antigravity')
    assert json.loads(conn.row['last_cycle_stats'])['total'] == 7
