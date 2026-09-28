"""Driver doubles exercise the actual SQL locking / Mongo CAS implementation.

SQLite persistence is exercised separately against real temporary databases.
These tests deliberately do not connect to configured remote databases.
"""
import asyncio
import copy
import json
import re
import time
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest

from src.storage.mongodb_manager import MongoDBManager
from src.storage.mysql_manager import MySQLManager
from src.storage.psql_manager import PSQLManager
from test_antigravity_quota_policy import GEMINI, CLAUDE, NAME, week


class Database:
    def __init__(self):
        self.lock = asyncio.Lock()
        self.row = dict(_id="original-document", filename=NAME, disabled=False,
                        quota_group_states={}, quota_credential_generation=None,
                        model_cooldowns={}, credential_data={}, success_count=0,
                        failure_count=0, call_count=0, error_codes=[], error_messages={})
        self.cas_conflicts = 0
        self.queries = []

    async def find_one(self, query):
        result = copy.deepcopy(self.row)
        await asyncio.sleep(0)
        return result

    def find(self, query):
        class Cursor:
            async def to_list(inner, length=None):
                return [] if self.row.get("disabled") else [copy.deepcopy(self.row)]
        return Cursor()

    async def update_one(self, query, update):
        async with self.lock:
            for key, expected in query.items():
                if isinstance(expected, dict) and "$exists" in expected:
                    match = (key in self.row) == expected["$exists"]
                else:
                    match = self.row.get(key) == expected
                if not match:
                    self.cas_conflicts += 1
                    return SimpleNamespace(matched_count=0)
            self.row.update(copy.deepcopy(update["$set"]))
            return SimpleNamespace(matched_count=1)

    @asynccontextmanager
    async def acquire(self):
        yield Connection(self)


class Connection:
    def __init__(self, db):
        self.db = db
        self.backup = None
        self.fetched = None

    async def begin(self):
        await self.db.lock.acquire()
        self.backup = copy.deepcopy(self.db.row)

    async def commit(self):
        self.db.lock.release()

    async def rollback(self):
        self.db.row = self.backup
        self.db.lock.release()

    @asynccontextmanager
    async def transaction(self):
        await self.begin()
        try:
            yield
            await self.commit()
        except BaseException:
            await self.rollback()
            raise

    @asynccontextmanager
    async def cursor(self, *_):
        yield self

    async def fetchrow(self, query, *_):
        assert self.db.lock.locked() and "FOR UPDATE" in query
        self.db.queries.append(query)
        await asyncio.sleep(0)
        return copy.deepcopy(self.db.row)

    async def fetchone(self):
        return self.fetched

    async def fetchall(self):
        return [copy.deepcopy(self.db.row)]

    async def fetch(self, query, *params):
        assert "FOR UPDATE" not in query
        # The production PostgreSQL disabled column is INTEGER, not BOOLEAN.
        assert "COALESCE(disabled, FALSE)" not in query
        self.db.queries.append(query)
        return [copy.deepcopy(self.db.row)]

    async def execute(self, query, *params):
        assert self.db.lock.locked() or query.startswith("SELECT") and "FOR UPDATE" not in query
        self.db.queries.append(query)
        if query.startswith("SELECT"):
            assert "server_name = %s" in query
            self.fetched = copy.deepcopy(self.db.row)
        elif query.startswith("UPDATE"):
            args = params[0] if len(params) == 1 and isinstance(params[0], tuple) else params
            names = re.findall(r"(\w+) = (?:\$\d+|%s)", query.split(" WHERE ")[0])
            self.db.row.update(zip(names, args))


@pytest.fixture(params=["postgres", "mysql", "mongo"])
def backend(request):
    engine = request.param
    cls = {"postgres": PSQLManager, "mysql": MySQLManager, "mongo": MongoDBManager}[engine]
    manager = cls.__new__(cls)
    db = Database()
    manager._initialized = True
    manager._pool = db
    manager._server_name = "isolated"
    manager._db = {"antigravity_credentials": db}
    manager._redis_enabled = False
    manager._ensure_initialized = lambda: None
    async def names(mode): return [NAME]
    manager.list_credentials = names
    return manager, db


async def test_concurrent_groups_release_old_request_and_override_429(backend):
    manager, db = backend
    original = await manager.quota_admit(NAME, GEMINI)
    models, observation = week()
    snapshot = await manager.quota_snapshot(NAME)
    await manager.quota_sync(NAME, models, observation, snapshot)
    assert await manager.quota_admit(NAME, GEMINI) is None
    assert await manager.quota_admit(NAME, CLAUDE)
    await manager.quota_release(NAME, "gemini-shared")
    await manager.quota_business_result(NAME, original, 429)
    admission = await manager.quota_admit(NAME, GEMINI)
    assert admission
    await asyncio.gather(manager.set_model_cooldown(NAME, CLAUDE, time.time()+3600, "antigravity"),
                         manager.quota_business_result(NAME, admission, 429))
    assert await manager.quota_admit(NAME, GEMINI) is None
    assert await manager.quota_admit(NAME, CLAUDE) is None
    state = await manager.quota_snapshot(NAME)
    assert len(state["model_cooldowns"]) == 1
    assert state["quota_group_states"]["gemini-shared"]["reason"] == "override_failed_429"
    if manager.QUOTA_ENGINE == "mongo":
        assert db.cas_conflicts > 0


async def test_recreated_credential_and_bad_document_fail_closed(backend):
    manager, db = backend
    ticket = await manager.quota_admit(NAME, GEMINI)
    db.row["quota_credential_generation"] = "replacement"
    assert not await manager.quota_record_result(NAME, ticket, GEMINI, True)
    assert not await manager.quota_refresh_credential(NAME, ticket["generation"], {})
    db.row["quota_group_states"] = "corrupt"
    assert await manager.get_next_available_credential(mode="antigravity", model_name=GEMINI) is None


async def test_atomic_success_retains_cooldown_and_model_counts(backend):
    manager, db = backend
    admission = await manager.quota_admit(NAME, GEMINI)
    await manager.set_model_cooldown(NAME, GEMINI, time.time()+100, "antigravity")
    await manager.quota_record_result(NAME, admission, GEMINI, True)
    assert await manager.quota_admit(NAME, GEMINI) is None
    assert db.row["success_count"] == 1
    assert db.row["call_count"] == 1


@pytest.mark.parametrize("mode", ["geminicli", "antigravity"])
async def test_mode_dispatch_keeps_geminicli_legacy(backend, mode):
    manager, _ = backend
    calls = []
    async def legacy(*args, **kwargs):
        calls.append((args, kwargs))
        return True
    manager._set_model_cooldown_legacy = legacy
    assert await manager.set_model_cooldown(NAME, GEMINI, time.time()+100, mode)
    assert bool(calls) == (mode == "geminicli")
