"""Storage behavior tests; compiler mocks are explicitly separate from MR02."""

import asyncio
import copy
import json
import sqlite3
import subprocess
import sys
from types import SimpleNamespace

import pytest

from src.model_routing import store
from src.model_routing.types import (
    CHANNELS, CompiledChannel, CompileResult, ParsedRouteTable, RouteRow,
    RoutingConfigReadError, RoutingPolicySnapshot, ValidationIssue,
)
from src.storage_adapter import StorageAdapter
from src.storage.sqlite_manager import SQLiteManager


class MemoryAdapter:
    def __init__(self, value=store._MISSING):
        self.value = value
        self.reads = 0
        self.writes = []
        self.fail_read = False
        self.fail_write = False

    async def get_config_fresh(self, key, default=None):
        assert key == "model_routing"
        self.reads += 1
        if self.fail_read:
            raise RuntimeError("unsafe backend detail")
        return default if self.value is store._MISSING else copy.deepcopy(self.value)

    async def set_config(self, key, value):
        assert key == "model_routing"
        if self.fail_write:
            return False
        self.value = copy.deepcopy(value)
        self.writes.append(copy.deepcopy(value))
        await asyncio.sleep(0)
        return True


@pytest.fixture
def typed_compiler_mock(monkeypatch):
    """Mock dependency used ONLY to verify P storage/control flow."""
    policy = RoutingPolicySnapshot("mock-only", "mock-policy-v1")
    calls = []

    def parse(raw):
        if not isinstance(raw, dict) or not isinstance(raw.get("routes"), list):
            return ParsedRouteTable(issues=(ValidationIssue(None, None, None, "INVALID_STRUCTURE"),), global_error=True)
        rows = tuple(RouteRow(**row, row_index=index) for index, row in enumerate(raw["routes"]))
        return ParsedRouteTable(rows)

    def compile_channel(channel, parsed, candidate):
        calls.append((channel, candidate.digest))
        if parsed.global_error:
            return CompileResult(issues=parsed.issues, scope="global")
        issues = tuple(parsed.issues) + tuple(
            ValidationIssue(channel, row.row_index, "upstream_name", "UNSTABLE_TARGET_DISPATCH")
            for row in parsed.valid_rows if row.channel == channel and row.upstream_name == "mock-invalid"
        )
        if issues:
            return CompileResult(issues=issues)
        rows = tuple(row for row in parsed.valid_rows if row.channel == channel)
        return CompileResult(CompiledChannel(channel, "mock-config", candidate.digest, rows))

    def validate(parsed, candidate):
        return tuple(issue for channel in CHANNELS for issue in compile_channel(channel, parsed, candidate).issues)

    monkeypatch.setattr(store, "_policy", lambda: policy)
    monkeypatch.setattr(store, "_parse", parse)
    monkeypatch.setattr(store, "_compile", compile_channel)
    monkeypatch.setattr(store, "_validate", validate)
    store._compiled_cache.clear()
    return SimpleNamespace(policy=policy, parse=parse, calls=calls)


def _table(channel="geminicli", name="public-alpha", target="mock-target"):
    return {"routes": [{"channel": channel, "public_name": name, "upstream_name": target, "enabled": True}]}


def sqlite_config_only(path):
    # Independent temporary test schema, never manager.initialize().
    with sqlite3.connect(path) as connection:
        connection.execute("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT, updated_at REAL)")
    manager = SQLiteManager()
    manager._db_path = str(path)
    manager._initialized = True
    return manager


@pytest.mark.asyncio
async def test_sqlite_authoritative_key_observes_other_process_commit(tmp_path):
    path = tmp_path / "isolated.db"
    manager = sqlite_config_only(path)
    manager._config_cache = {"model_routing": {"routes": []}, "other": "cached"}
    command = [sys.executable, "-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('INSERT INTO config VALUES (?, ?, 0)', ('model_routing', sys.argv[2])); c.commit(); c.close()", str(path), json.dumps(_table())]
    result = subprocess.run(command, capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr
    assert await manager.get_config("model_routing") == {"routes": []}
    assert await manager.get_config_fresh("model_routing") == _table()
    assert await manager.get_all_config() == manager._config_cache
    sentinel = object()
    assert await manager.get_config_fresh("missing", sentinel) is sentinel


@pytest.mark.asyncio
async def test_sqlite_fresh_failure_and_invalid_json_are_not_missing(tmp_path):
    manager = sqlite_config_only(tmp_path / "isolated.db")
    with sqlite3.connect(manager._db_path) as connection:
        connection.execute("INSERT INTO config VALUES ('model_routing', '{broken', 0)")
    with pytest.raises(json.JSONDecodeError):
        await manager.get_config_fresh("model_routing", object())
    with sqlite3.connect(manager._db_path) as connection:
        connection.execute("DROP TABLE config")
    with pytest.raises(sqlite3.OperationalError):
        await manager.get_config_fresh("model_routing", object())


@pytest.mark.asyncio
async def test_adapter_fresh_does_not_call_cached_getter():
    adapter = StorageAdapter()
    adapter._initialized = True
    adapter._backend = MemoryAdapter(_table())
    assert await adapter.get_config_fresh("model_routing") == _table()


@pytest.mark.asyncio
async def test_read_missing_explicit_null_and_failure_distinct(monkeypatch, typed_compiler_mock):
    adapter = MemoryAdapter()
    monkeypatch.setattr(store, "_get_adapter", lambda: adapter)
    missing = await store.read_routing_config_fresh()
    assert missing.exists is False and all(result.valid for result in missing.channels.values())
    assert all(result.compiled.config_digest == missing.digest for result in missing.channels.values())
    adapter.value = None
    null = await store.read_routing_config_fresh()
    assert null.exists is True and null.digest != missing.digest
    assert all(result.scope == "global" and not result.valid for result in null.channels.values())
    adapter.fail_read = True
    with pytest.raises(RoutingConfigReadError) as error:
        await store.read_routing_config_fresh()
    assert "unsafe" not in str(error.value)


@pytest.mark.asyncio
async def test_cache_binds_channel_full_config_and_policy(monkeypatch, typed_compiler_mock):
    adapter = MemoryAdapter(_table())
    monkeypatch.setattr(store, "_get_adapter", lambda: adapter)
    first = await store.read_routing_config_fresh()
    assert len(typed_compiler_mock.calls) == 2
    again = await store.read_routing_config_fresh()
    assert again == first and adapter.reads == 2 and len(typed_compiler_mock.calls) == 2
    adapter.value = _table(name="public-beta")
    changed = await store.read_routing_config_fresh()
    assert changed.digest != first.digest and len(typed_compiler_mock.calls) == 4
    policy2 = RoutingPolicySnapshot("mock-only", "mock-policy-v2")
    await store.load_channel_routes("geminicli", policy2)
    assert len(typed_compiler_mock.calls) == 6
    assert changed.raw_table["routes"][0]["public_name"] == "public-beta"
    with pytest.raises(TypeError):
        changed.raw_table["routes"][0]["public_name"] = "mutated"


@pytest.mark.asyncio
async def test_mock_channel_failure_does_not_break_other_channel(monkeypatch, typed_compiler_mock):
    adapter = MemoryAdapter(_table(target="mock-invalid"))
    monkeypatch.setattr(store, "_get_adapter", lambda: adapter)
    snapshot = await store.read_routing_config_fresh()
    assert not snapshot.channels["geminicli"].valid
    assert snapshot.channels["antigravity"].valid
    assert adapter.writes == []


@pytest.mark.asyncio
async def test_invalid_candidate_never_partially_saves_and_repair_reads_no_old_value(monkeypatch, typed_compiler_mock):
    adapter = MemoryAdapter(None)
    monkeypatch.setattr(store, "_get_adapter", lambda: adapter)
    invalid = typed_compiler_mock.parse(_table(target="mock-invalid"))
    with pytest.raises(store.RoutingConfigValidationError):
        await store.save_routing_config(invalid, typed_compiler_mock.policy)
    assert adapter.writes == [] and adapter.reads == 0
    repaired = await store.save_routing_config(typed_compiler_mock.parse(_table()), typed_compiler_mock.policy)
    assert repaired.exists and adapter.value == _table() and adapter.reads == 1


@pytest.mark.asyncio
async def test_all_local_writes_commit_whole_tables_last_writer_wins(monkeypatch, typed_compiler_mock):
    adapter = MemoryAdapter()
    monkeypatch.setattr(store, "_get_adapter", lambda: adapter)
    tables = [_table(name=f"public-{index}") for index in range(12)]
    results = await asyncio.gather(*(store.save_routing_config(typed_compiler_mock.parse(table), typed_compiler_mock.policy) for table in tables))
    assert len(adapter.writes) == 12 and adapter.value == tables[-1]
    assert [result.raw_table["routes"][0]["public_name"] for result in results] == [f"public-{index}" for index in range(12)]


@pytest.mark.asyncio
async def test_write_false_is_safe_and_does_not_read(monkeypatch, typed_compiler_mock):
    adapter = MemoryAdapter()
    adapter.fail_write = True
    monkeypatch.setattr(store, "_get_adapter", lambda: adapter)
    with pytest.raises(store.RoutingConfigWriteError):
        await store.save_routing_config(typed_compiler_mock.parse(_table()), typed_compiler_mock.policy)
    assert adapter.reads == 0


@pytest.mark.asyncio
async def test_read_and_save_cancellation_propagates(monkeypatch, typed_compiler_mock):
    class CancelRead(MemoryAdapter):
        async def get_config_fresh(self, *args):
            raise asyncio.CancelledError

    monkeypatch.setattr(store, "_get_adapter", lambda: CancelRead())
    with pytest.raises(asyncio.CancelledError):
        await store.read_routing_config_fresh()

    class CancelWrite(MemoryAdapter):
        async def set_config(self, *args):
            raise asyncio.CancelledError

    monkeypatch.setattr(store, "_get_adapter", lambda: CancelWrite())
    with pytest.raises(asyncio.CancelledError):
        await store.save_routing_config(typed_compiler_mock.parse(_table()), typed_compiler_mock.policy)


@pytest.mark.asyncio
async def test_cancelled_dispatched_commit_settles_before_next_accepted_write(monkeypatch, typed_compiler_mock):
    entered = asyncio.Event()
    release = asyncio.Event()

    class DelayedAdapter(MemoryAdapter):
        async def set_config(self, key, table):
            if table["routes"][0]["public_name"] == "public-first":
                entered.set()
                await release.wait()
            self.value = copy.deepcopy(table)
            self.writes.append(copy.deepcopy(table))
            return True

    adapter = DelayedAdapter()
    monkeypatch.setattr(store, "_get_adapter", lambda: adapter)
    # Each isolated ASGI/test event loop gets its own test lock; production
    # uses one lock on its application loop.
    monkeypatch.setattr(store, "_save_lock", asyncio.Lock())
    first = asyncio.create_task(store.save_routing_config(typed_compiler_mock.parse(_table(name="public-first")), typed_compiler_mock.policy))
    await entered.wait()
    first.cancel()
    await asyncio.sleep(0)
    second = asyncio.create_task(store.save_routing_config(typed_compiler_mock.parse(_table(name="public-second")), typed_compiler_mock.policy))
    await asyncio.sleep(0)
    assert adapter.writes == [] and not first.done() and not second.done()
    first.cancel()  # A second cancellation also cannot abandon the commit.
    await asyncio.sleep(0)
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await first
    saved = await second
    assert adapter.value == _table(name="public-second")
    assert saved.raw_table["routes"][0]["public_name"] == "public-second"
    assert [value["routes"][0]["public_name"] for value in adapter.writes] == ["public-first", "public-second"]


@pytest.mark.asyncio
async def test_partial_parser_failure_cannot_save_its_valid_rows(monkeypatch, typed_compiler_mock):
    adapter = MemoryAdapter()
    monkeypatch.setattr(store, "_get_adapter", lambda: adapter)
    parsed = ParsedRouteTable(
        typed_compiler_mock.parse(_table()).valid_rows,
        (ValidationIssue("antigravity", 1, "enabled", "INVALID_FIELD_TYPE"),),
    )
    # Defense in depth even when a mock validator forgets parser issues.
    monkeypatch.setattr(store, "_validate", lambda *args: ())
    with pytest.raises(store.RoutingConfigValidationError):
        await store.save_routing_config(parsed, typed_compiler_mock.policy)
    assert adapter.writes == [] and adapter.reads == 0


@pytest.mark.asyncio
async def test_cache_is_bounded_and_always_reads_authority(monkeypatch, typed_compiler_mock):
    adapter = MemoryAdapter()
    monkeypatch.setattr(store, "_get_adapter", lambda: adapter)
    monkeypatch.setattr(store, "_CACHE_LIMIT", 4)
    for index in range(5):
        adapter.value = _table(name=f"public-{index}")
        await store.read_routing_config_fresh()
    assert len(store._compiled_cache) == 4 and adapter.reads == 5


def test_cold_adapter_is_never_initialized(monkeypatch):
    import src.storage_adapter as adapters

    monkeypatch.setattr(adapters, "_storage_adapter", None)
    with pytest.raises(RoutingConfigReadError):
        store._get_adapter()
    assert adapters._storage_adapter is None


class Context:
    def __init__(self, value):
        self.value = value

    async def __aenter__(self):
        return self.value

    async def __aexit__(self, *args):
        pass


@pytest.mark.asyncio
async def test_postgres_mock_uses_single_authoritative_key_no_cache():
    from src.storage.psql_manager import PSQLManager

    queries = []

    async def fetchrow(query, *params):
        queries.append((query, params))
        return {"value": json.dumps(_table())}

    manager = PSQLManager()
    manager._initialized = True
    manager._config_cache = {"model_routing": "stale"}
    manager._pool = SimpleNamespace(acquire=lambda: Context(SimpleNamespace(fetchrow=fetchrow)))
    assert await manager.get_config_fresh("model_routing") == _table()
    assert queries == [("SELECT value FROM config WHERE key = $1", ("model_routing",))]
    assert await manager.get_config("model_routing") == "stale"


@pytest.mark.asyncio
async def test_mysql_mock_scopes_key_and_ends_read_transaction_on_error():
    from src.storage.mysql_manager import MySQLManager

    queries = []
    rollbacks = []

    async def execute(query, params):
        queries.append((query, params))

    async def fetchone():
        return (json.dumps(_table()),)

    async def rollback():
        rollbacks.append(True)

    cursor = SimpleNamespace(execute=execute, fetchone=fetchone)
    connection = SimpleNamespace(cursor=lambda: Context(cursor), rollback=rollback)
    manager = MySQLManager()
    manager._initialized = True
    manager._server_name = "mock-node"
    manager._config_cache = {"model_routing": "stale"}
    manager._pool = SimpleNamespace(acquire=lambda: Context(connection))
    assert await manager.get_config_fresh("model_routing") == _table()
    assert queries[0][1] == ("mock-node", "model_routing") and len(rollbacks) == 2
    assert await manager.get_config("model_routing") == "stale"

    async def fail(*args):
        raise RuntimeError("mock query failed")

    cursor.execute = fail
    with pytest.raises(RuntimeError):
        await manager.get_config_fresh("model_routing")
    assert len(rollbacks) == 4


@pytest.mark.asyncio
@pytest.mark.parametrize("metadata,comparison,valid", [
    (("utf8mb4", "utf8mb4_unicode_ci", 255), (1,), True),
    (("utf8mb4", "utf8mb4_bin", 255), (0,), True),
    (None, None, False),
    (("utf8mb4", "invalid';--", 255), None, False),
])
async def test_mysql_mock_reserved_alias_uses_actual_validated_collation(metadata, comparison, valid):
    from src.storage.mysql_manager import MySQLManager

    queries = []

    async def execute(query, params):
        queries.append((query, params))

    async def fetchone():
        return metadata if len(queries) == 1 else comparison

    async def rollback():
        pass

    cursor = SimpleNamespace(execute=execute, fetchone=fetchone)
    connection = SimpleNamespace(cursor=lambda: Context(cursor), rollback=rollback)
    manager = MySQLManager()
    manager._initialized = True
    manager._pool = SimpleNamespace(acquire=lambda: Context(connection))
    if valid:
        assert await manager.config_key_matches("database-equivalent-spelling", "model_routing") is bool(comparison[0])
        assert queries[1][1] == ("database-equivalent-spelling", "model_routing")
        assert metadata[1] in queries[1][0]
    else:
        with pytest.raises(RuntimeError):
            await manager.config_key_matches("database-equivalent-spelling", "model_routing")
        assert len(queries) == 1


@pytest.mark.asyncio
async def test_mysql_mock_overlong_key_rejected_before_collation_cast():
    from src.storage.mysql_manager import MySQLManager

    queries = []

    async def execute(query, params):
        queries.append((query, params))

    async def fetchone():
        return ("utf8mb4", "utf8mb4_unicode_ci", 255)

    async def rollback():
        pass

    cursor = SimpleNamespace(execute=execute, fetchone=fetchone)
    connection = SimpleNamespace(cursor=lambda: Context(cursor), rollback=rollback)
    manager = MySQLManager()
    manager._initialized = True
    manager._pool = SimpleNamespace(acquire=lambda: Context(connection))
    key = "model_routing" + " " * 243 + "x"
    assert len(key) > 255
    assert await manager.config_key_matches(key, "model_routing") is True
    assert len(queries) == 1


@pytest.mark.asyncio
async def test_mongodb_mock_bypasses_redis_and_reads_primary():
    from pymongo.read_preferences import ReadPreference
    from src.storage.mongodb_manager import MongoDBManager

    queries = []

    def find(query, projection):
        queries.append((query, projection))
        class Cursor:
            def limit(self, count):
                assert count == 2
                return self

            async def to_list(self, *, length):
                assert length == 2
                return [{"value": _table()}]
        return Cursor()

    def collection(name, *, read_preference):
        assert name == "config" and read_preference == ReadPreference.PRIMARY
        return SimpleNamespace(find=find)

    manager = MongoDBManager()
    manager._initialized = True
    manager._redis_enabled = True
    manager._db = SimpleNamespace(get_collection=collection)
    assert await manager.get_config_fresh("model_routing") == _table()
    assert queries == [({"key": "model_routing"}, {"_id": 0, "value": 1})]


@pytest.mark.asyncio
@pytest.mark.parametrize("indexes,allowed", [
    ({"_id_": {"key": [("_id", 1)], "unique": True}}, False),
    ({"key": {"key": [("key", 1)], "unique": True}}, True),
    ({"key": {"key": [("key", -1)], "unique": True}}, True),
    ({"key": {"key": [("key", 1)], "unique": True, "partialFilterExpression": {"other": True}}}, False),
    ({"key": {"key": [("key", 1)], "unique": True, "sparse": True}}, False),
    ({"key": {"key": [("key", 1)], "unique": True, "collation": {"locale": "en"}}}, False),
    ({"key": {"key": [("key", 1), ("other", 1)], "unique": True}}, False),
])
async def test_mongodb_mock_routing_write_requires_existing_unique_key(indexes, allowed):
    from src.storage.mongodb_manager import MongoDBManager

    writes = []

    async def information():
        return indexes

    async def update_one(*args, **kwargs):
        writes.append((args, kwargs))

    collection = SimpleNamespace(index_information=information, update_one=update_one)
    manager = MongoDBManager()
    manager._initialized = True
    manager._db = {"config": collection}
    assert await manager.set_config("model_routing", _table()) is allowed
    assert bool(writes) is allowed
    assert await manager.set_config("other", True) is True
    assert writes[-1][0][0] == {"key": "other"}


@pytest.mark.asyncio
async def test_real_compiler_storage_and_sqlite(monkeypatch, tmp_path):
    """Run only after R's real modules are delivered; no mock substitution."""
    from src.model_routing.compiler import parse_route_table
    from src.model_routing.policy import build_policy_snapshot

    manager = sqlite_config_only(tmp_path / "real-compiler.db")
    monkeypatch.setattr(store, "_get_adapter", lambda: manager)
    store._compiled_cache.clear()
    policy = build_policy_snapshot()
    table = _table(target="transparent-target-x")
    saved = await store.save_routing_config(parse_route_table(table), policy)
    assert saved.exists and saved.channels["geminicli"].valid and saved.channels["antigravity"].valid
    assert await manager.get_config_fresh("model_routing") == table
    assert (await store.load_channel_routes("geminicli", policy)).valid
