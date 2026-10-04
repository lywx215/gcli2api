"""MR06: isolated SQLite, explicit remote/compiler mocks, real compiler gate.

The mock cases prove boundaries and reporting only. They are not MR02 compiler
acceptance or PostgreSQL/MySQL/MongoDB service integration evidence.
"""

import asyncio
import hashlib
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
from types import SimpleNamespace

import pytest
import pytest_asyncio

from src.model_routing import preflight, readonly
from src.model_routing.types import (
    CHANNELS, CompileResult, CompiledChannel, ParsedRouteTable, RoutingConfigReadError,
    RoutingPolicySnapshot, ValidationIssue, thaw,
)

POLICY_DIGEST = "a" * 64


@pytest_asyncio.fixture(autouse=True)
async def isolated_environment(monkeypatch, tmp_path):
    for key in ("MYSQL_URI", "POSTGRESQL_URI", "MONGODB_URI", "MONGODB_DATABASE", "GCLI_SERVER_NAME", "REDIS_URL", "STORAGE_STRICT"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("CREDENTIALS_DIR", str(tmp_path))
    for key in ("CODE_ASSIST_ENDPOINT", "ANTIGRAVITY_API_URL", "KEEPALIVE_URL", "OAUTHLIB_INSECURE_TRANSPORT"):
        monkeypatch.delenv(key, raising=False)

    def forbidden_network(*_args, **_kwargs):
        raise AssertionError("Real network is forbidden in MR06 unit tests.")

    monkeypatch.setattr(socket.socket, "connect", forbidden_network)
    monkeypatch.setattr(socket.socket, "connect_ex", forbidden_network)
    monkeypatch.setattr(socket, "create_connection", forbidden_network)
    yield


def create_sqlite(tmp_path, raw=None, *, exists=True, wal=True):
    path = tmp_path / "credentials.db"
    writer = sqlite3.connect(path)
    if wal:
        assert writer.execute("PRAGMA journal_mode=WAL").fetchone()[0] == "wal"
    writer.execute("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT)")
    writer.execute("CREATE TABLE credentials (credential_data TEXT)")
    writer.execute("INSERT INTO credentials VALUES ('synthetic-credential-sentinel')")
    if exists:
        writer.execute("INSERT INTO config VALUES (?, ?)", ("model_routing", raw if isinstance(raw, str) else json.dumps(raw)))
    writer.commit()
    return path, writer


def candidate_mock(monkeypatch, *, raw_seen=None, bad_channel=None, global_error=False, unsafe_message=False):
    """Explicit dependency mock; does not implement/claim routing proofs."""
    def parse(value):
        if raw_seen is not None:
            raw_seen.append(value)
        return ParsedRouteTable(global_error=global_error)

    def compile_channel(channel, _parsed, _policy):
        if global_error or channel == bad_channel:
            issue = ValidationIssue(
                None if global_error else channel, 2, "upstream_name", "UNSTABLE_TARGET_DISPATCH",
                (1, 3), "secret-target-and-uri" if unsafe_message else "safe",
            )
            return CompileResult(issues=(issue,), scope="global" if global_error else "channel")
        return CompileResult(CompiledChannel(channel, "b" * 64, POLICY_DIGEST))

    modules = (SimpleNamespace(parse_route_table=parse, compile_channel=compile_channel),
               SimpleNamespace(build_policy_snapshot=lambda: RoutingPolicySnapshot("unit-mock", POLICY_DIGEST)))
    monkeypatch.setattr(preflight, "_candidate_modules", lambda: modules)
    return modules


def test_selection_matches_actual_adapter_precedence_and_scope(tmp_path):
    env = {"MYSQL_URI": "mysql://unit@localhost/unit", "GCLI_SERVER_NAME": "node-a", "POSTGRESQL_URI": "postgresql://unit@localhost/unit", "MONGODB_URI": "mongodb://localhost/ignored", "MONGODB_DATABASE": "unit-db", "CREDENTIALS_DIR": str(tmp_path)}
    assert readonly.select_backend(env).kind == "mysql"
    assert readonly.select_backend(env).scope == "node-a"
    del env["GCLI_SERVER_NAME"]
    assert readonly.select_backend(env).kind == "postgresql"
    del env["POSTGRESQL_URI"]
    assert readonly.select_backend(env).kind == "mongodb"
    assert readonly.select_backend(env).scope == "unit-db"
    del env["MONGODB_URI"]
    assert readonly.select_backend(env).location == str((tmp_path / "credentials.db").resolve())
    assert "unit@" not in repr(readonly.select_backend({"MYSQL_URI": "mysql://unit@localhost/unit", "GCLI_SERVER_NAME": "node-a"}))


def test_config_digest_canonical_and_presence_sensitive():
    raw = {"routes": [], "unused": {"z": False, "a": 0}}
    canonical = json.dumps({"exists": True, "value": raw}, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    assert readonly.config_digest(True, raw) == hashlib.sha256(canonical.encode()).hexdigest()
    assert readonly.config_digest(False, None) != readonly.config_digest(True, None)
    with pytest.raises(ValueError):
        readonly.config_digest(True, {"value": float("nan")})


@pytest.mark.asyncio
async def test_real_sqlite_reads_latest_wal_without_init_writes_or_credential_reads(monkeypatch, tmp_path):
    path, writer = create_sqlite(tmp_path, {"routes": []}, wal=True)
    fresh = {"routes": [{"channel": "antigravity", "public_name": "public-unit", "upstream_name": "opaque-unit", "enabled": True}]}
    writer.execute("UPDATE config SET value = ? WHERE key = ?", (json.dumps(fresh), "model_routing"))
    writer.commit()
    before_db, before_wal = path.read_bytes(), Path(str(path) + "-wal").read_bytes()
    original_connect = sqlite3.connect
    statements, uris = [], []

    def connect(location, **kwargs):
        uris.append((location, kwargs))
        connection = original_connect(location, **kwargs)
        connection.set_trace_callback(statements.append)
        return connection

    monkeypatch.setattr(readonly.sqlite3, "connect", connect)
    try:
        result = await readonly.read_routing_config_readonly()
        assert thaw(result.snapshot.raw_table) == fresh
        assert result.snapshot.exists is True
        assert path.read_bytes() == before_db
        assert Path(str(path) + "-wal").read_bytes() == before_wal
        assert len(uris) == 1 and uris[0][1]["uri"] is True
        assert "mode=ro" in uris[0][0] and "immutable" not in uris[0][0]
        assert len(statements) == 2
        assert all(sql.lstrip().startswith("SELECT") for sql in statements)
        assert all("credentials" not in sql for sql in statements)
    finally:
        writer.close()


@pytest.mark.asyncio
async def test_sqlite_committed_snapshot_excludes_inflight_then_binds_new_commit(tmp_path):
    path, writer = create_sqlite(tmp_path, {"routes": []}, wal=True)
    try:
        first = await readonly.read_routing_config_readonly()
        writer.execute("UPDATE config SET value = ? WHERE key = ?", ('{"routes":[{"pending":true}]}', "model_routing"))
        inflight = await readonly.read_routing_config_readonly()
        assert inflight.snapshot.digest == first.snapshot.digest
        writer.commit()
        committed = await readonly.read_routing_config_readonly()
        assert committed.snapshot.digest != first.snapshot.digest
        assert committed.backend_identity_digest == first.backend_identity_digest
        assert path.exists()
    finally:
        writer.close()


@pytest.mark.asyncio
async def test_old_writer_after_preflight_invalidates_config_binding(monkeypatch, tmp_path):
    path, writer = create_sqlite(tmp_path, {"routes": []}, wal=True)
    candidate_mock(monkeypatch)
    old_writer = sqlite3.connect(path)
    try:
        checked, code = await preflight.run_preflight()
        assert code == 0
        old_writer.execute("UPDATE config SET value = ? WHERE key = ?", ('{"routes":[{"old_writer":true}]}', "model_routing"))
        old_writer.commit()
        current = await readonly.read_routing_config_readonly()
        assert current.snapshot.digest != checked["config_digest"]
        assert current.backend_identity_digest == checked["backend_identity_digest"]
    finally:
        old_writer.close()
        writer.close()


@pytest.mark.asyncio
async def test_missing_key_is_empty_but_stored_null_is_not_empty(monkeypatch, tmp_path):
    path, writer = create_sqlite(tmp_path, exists=False)
    seen = []
    candidate_mock(monkeypatch, raw_seen=seen)
    try:
        missing = await readonly.read_routing_config_readonly()
        report, code = await preflight.run_preflight()
        assert code == 0 and seen == [{"routes": []}]
        assert missing.snapshot.exists is False
        writer.execute("INSERT INTO config VALUES ('model_routing', 'null')")
        writer.commit()
        stored = await readonly.read_routing_config_readonly()
        assert stored.snapshot.exists is True and stored.snapshot.raw_table is None
        assert stored.snapshot.digest != report["config_digest"]
    finally:
        writer.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("raw", ['not-json', '{"routes":[],"routes":[1]}', '{"routes":[NaN]}'])
async def test_bad_stored_json_never_becomes_missing_or_empty(tmp_path, raw):
    _path, writer = create_sqlite(tmp_path, raw)
    try:
        result = await readonly.read_routing_config_readonly()
        assert result.snapshot.exists is True
        assert result.snapshot.raw_table == raw
    finally:
        writer.close()


@pytest.mark.asyncio
async def test_missing_file_and_table_fail_without_creation_or_fallback(tmp_path):
    report, code = await preflight.run_preflight()
    assert code == 3 and report["config_digest"] is None
    path = tmp_path / "credentials.db"
    assert not path.exists()
    connection = sqlite3.connect(path)
    connection.execute("CREATE TABLE unrelated (value TEXT)")
    connection.commit()
    connection.close()
    original = path.read_bytes()
    with pytest.raises(RoutingConfigReadError):
        await readonly.read_routing_config_readonly()
    assert path.read_bytes() == original


@pytest.mark.asyncio
async def test_sqlite_view_cannot_read_credentials(tmp_path):
    path = tmp_path / "credentials.db"
    connection = sqlite3.connect(path)
    connection.execute("CREATE TABLE credentials (key TEXT, value TEXT)")
    connection.execute("CREATE VIEW config AS SELECT key, value FROM credentials")
    connection.commit()
    connection.close()
    with pytest.raises(RoutingConfigReadError):
        await readonly.read_routing_config_readonly()


@pytest.mark.asyncio
async def test_wal_without_existing_sidecars_refuses_creation(tmp_path):
    path, writer = create_sqlite(tmp_path, {"routes": []}, wal=True)
    writer.close()  # Last writer removes checkpointed sidecars.
    assert not Path(str(path) + "-wal").exists()
    with pytest.raises(RoutingConfigReadError):
        await readonly.read_routing_config_readonly()
    assert not Path(str(path) + "-wal").exists()
    assert not Path(str(path) + "-shm").exists()


@pytest.mark.asyncio
async def test_windows_wal_last_writer_close_cannot_recreate_sidecars(monkeypatch, tmp_path):
    """Real Windows race: close the last writer inside the connect boundary."""
    path, writer = create_sqlite(tmp_path, {"routes": []}, wal=True)
    fresh = {"routes": [{"channel": "antigravity", "public_name": "public-race-unit", "upstream_name": "opaque-race-unit", "enabled": True}]}
    writer.execute("UPDATE config SET value = ? WHERE key = ?", (json.dumps(fresh), "model_routing"))
    writer.commit()
    # Fixture checkpoint isolates the preflight's byte invariance from the
    # legitimate checkpoint that closing a writer may otherwise perform.
    writer.execute("PRAGMA wal_checkpoint(PASSIVE)").fetchall()
    wal, shm = Path(str(path) + "-wal"), Path(str(path) + "-shm")
    identities = {item: item.stat().st_ino for item in (path, wal, shm)}
    before_db, before_wal = path.read_bytes(), wal.read_bytes()
    original_connect = sqlite3.connect
    entered = []

    def raced_connect(location, **kwargs):
        entered.append(True)
        writer.close()
        assert all(item.exists() and item.stat().st_ino == identity for item, identity in identities.items())
        return original_connect(location, **kwargs)

    monkeypatch.setattr(readonly.sqlite3, "connect", raced_connect)
    try:
        if not readonly._WINDOWS:
            with pytest.raises(RoutingConfigReadError):
                await readonly.read_routing_config_readonly()
            assert not entered  # Honest failure on platforms without a guard.
            return
        result = await readonly.read_routing_config_readonly()
        assert thaw(result.snapshot.raw_table) == fresh
        assert entered == [True]
        assert all(item.exists() and item.stat().st_ino == identity for item, identity in identities.items())
        assert path.read_bytes() == before_db
        assert wal.read_bytes() == before_wal
    finally:
        writer.close()


@pytest.mark.asyncio
async def test_windows_nonwal_guard_prevents_switch_to_wal_before_connect(monkeypatch, tmp_path):
    path, writer = create_sqlite(tmp_path, {"routes": []}, wal=False)
    writer.close()
    original_connect = sqlite3.connect
    original = path.read_bytes()
    attempts = []

    def raced_connect(location, **kwargs):
        attempts.append(True)
        # SQLite may fall back internally to a read-only connection after the
        # OS refuses its read/write handle; it still cannot switch journal mode.
        raced_writer = original_connect(path)
        try:
            with pytest.raises(sqlite3.OperationalError):
                raced_writer.execute("PRAGMA journal_mode=WAL").fetchone()
        finally:
            raced_writer.close()
        return original_connect(location, **kwargs)

    monkeypatch.setattr(readonly.sqlite3, "connect", raced_connect)
    if not readonly._WINDOWS:
        with pytest.raises(RoutingConfigReadError):
            await readonly.read_routing_config_readonly()
        assert not attempts
    else:
        result = await readonly.read_routing_config_readonly()
        assert thaw(result.snapshot.raw_table) == {"routes": []}
        assert attempts == [True]
    assert path.read_bytes() == original
    assert not Path(str(path) + "-wal").exists()
    assert not Path(str(path) + "-shm").exists()


@pytest.mark.asyncio
@pytest.mark.parametrize("versions", [b"\x01\x02", b"\x02\x01", b"\x00\x00", b"\x03\x03"])
async def test_mixed_or_unknown_sqlite_versions_fail_before_connect(monkeypatch, tmp_path, versions):
    path, writer = create_sqlite(tmp_path, {"routes": []}, wal=False)
    writer.close()
    damaged = bytearray(path.read_bytes())
    damaged[18:20] = versions
    path.write_bytes(damaged)
    original = path.read_bytes()
    monkeypatch.setattr(readonly.sqlite3, "connect", lambda *_args, **_kwargs: pytest.fail("Invalid journal versions must fail before connect."))
    report, code = await preflight.run_preflight()
    assert code == 3
    assert path.read_bytes() == original
    assert not Path(str(path) + "-wal").exists()
    assert not Path(str(path) + "-shm").exists()


@pytest.mark.asyncio
async def test_nonwal_active_writer_cannot_receive_unproved_readwrite_pin(monkeypatch, tmp_path):
    path, writer = create_sqlite(tmp_path, {"routes": []}, wal=False)
    original = path.read_bytes()
    monkeypatch.setattr(readonly.sqlite3, "connect", lambda *_args, **_kwargs: pytest.fail("No SQLite connect without a proven guard."))
    try:
        report, code = await preflight.run_preflight()
        assert code == 3
        assert path.read_bytes() == original
        assert not Path(str(path) + "-wal").exists()
        assert not Path(str(path) + "-shm").exists()
    finally:
        writer.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("wal", [False, True])
async def test_unproved_platform_refuses_all_sqlite_before_connection(monkeypatch, tmp_path, wal):
    path, writer = create_sqlite(tmp_path, {"routes": []}, wal=wal)
    original = path.read_bytes()
    monkeypatch.setattr(readonly, "_WINDOWS", False)
    monkeypatch.setattr(readonly.sqlite3, "connect", lambda *_args, **_kwargs: pytest.fail("Unproved platform must never connect."))
    try:
        report, code = await preflight.run_preflight()
        assert code == 3
        assert path.read_bytes() == original
    finally:
        writer.close()


def test_windows_guards_block_delete_rename_replace_and_use_pointer_sized_handles(tmp_path):
    path, writer = create_sqlite(tmp_path, {"routes": []}, wal=True)
    if not readonly._WINDOWS:
        with pytest.raises(RoutingConfigReadError):
            with readonly._sqlite_existing_files(path):
                pytest.fail("No guard support on this platform.")
        writer.close()
        return
    import ctypes
    from ctypes import wintypes

    guard = readonly._WindowsExistingFiles()
    assert guard._create.restype is wintypes.HANDLE
    assert ctypes.sizeof(wintypes.HANDLE) == ctypes.sizeof(ctypes.c_void_p)
    assert guard._close.argtypes == (wintypes.HANDLE,)
    assert guard._close.restype is wintypes.BOOL
    try:
        with readonly._sqlite_existing_files(path):
            for number, item in enumerate((path, Path(str(path) + "-wal"), Path(str(path) + "-shm"))):
                identity = item.stat().st_ino
                with pytest.raises(PermissionError):
                    item.unlink()
                with pytest.raises(PermissionError):
                    item.rename(tmp_path / f"renamed-{number}")
                replacement = tmp_path / f"replacement-{number}"
                replacement.write_bytes(b"synthetic replacement")
                with pytest.raises(PermissionError):
                    os.replace(replacement, item)
                assert item.stat().st_ino == identity
    finally:
        guard.close()
        writer.close()


@pytest.mark.asyncio
async def test_partial_sidecar_guard_failure_closes_all_acquired_handles(monkeypatch, tmp_path):
    path, writer = create_sqlite(tmp_path, {"routes": []}, wal=True)
    if not readonly._WINDOWS:
        with pytest.raises(RoutingConfigReadError):
            await readonly.read_routing_config_readonly()
        writer.close()
        return
    original_acquire = readonly._WindowsExistingFiles.acquire

    def missing_shm(self, item, **kwargs):
        if str(item).endswith("-shm"):
            raise RoutingConfigReadError()
        return original_acquire(self, item, **kwargs)

    monkeypatch.setattr(readonly._WindowsExistingFiles, "acquire", missing_shm)
    monkeypatch.setattr(readonly.sqlite3, "connect", lambda *_args, **_kwargs: pytest.fail("No connect before every guard is held."))
    try:
        with pytest.raises(RoutingConfigReadError):
            await readonly.read_routing_config_readonly()
    finally:
        writer.close()
    assert not Path(str(path) + "-wal").exists()
    assert not Path(str(path) + "-shm").exists()


@pytest.mark.asyncio
@pytest.mark.parametrize("global_error,bad_channel", [(False, "geminicli"), (False, "antigravity"), (True, None)])
async def test_mock_candidate_failures_are_scoped_and_sanitized(monkeypatch, tmp_path, global_error, bad_channel):
    path, writer = create_sqlite(tmp_path, {"routes": []})
    candidate_mock(monkeypatch, global_error=global_error, bad_channel=bad_channel, unsafe_message=True)
    original = path.read_bytes()
    try:
        report, code = await preflight.run_preflight()
        assert code == 2
        for channel in CHANNELS:
            assert report["validation"][channel]["valid"] is (not global_error and channel != bad_channel)
        output = json.dumps(report)
        assert "secret-target-and-uri" not in output
        assert POLICY_DIGEST == report["policy_digest"]
        assert path.read_bytes() == original
    finally:
        writer.close()


@pytest.mark.asyncio
async def test_mock_policy_upgrade_changes_bound_digest_and_rejects_old_table(monkeypatch, tmp_path):
    _path, writer = create_sqlite(tmp_path, {"routes": []})
    candidate_mock(monkeypatch)
    try:
        before, code = await preflight.run_preflight()
        assert code == 0
        modules = candidate_mock(monkeypatch, bad_channel="antigravity")
        modules[1].build_policy_snapshot = lambda: RoutingPolicySnapshot("unit-mock-new", "c" * 64)
        after, code = await preflight.run_preflight()
        assert code == 2
        assert before["config_digest"] == after["config_digest"]
        assert before["backend_identity_digest"] == after["backend_identity_digest"]
        assert before["policy_digest"] != after["policy_digest"]
    finally:
        writer.close()


@pytest.mark.asyncio
async def test_missing_candidate_is_unverified_failure_not_pass(monkeypatch, tmp_path):
    _path, writer = create_sqlite(tmp_path, {"routes": []})
    def unavailable():
        raise ImportError("untrusted compiler path")
    monkeypatch.setattr(preflight, "_candidate_modules", unavailable)
    try:
        report, code = await preflight.run_preflight()
        assert code == 2 and report["policy_digest"] is None
        assert "untrusted" not in json.dumps(report)
        assert report["validation"]["geminicli"]["issues"][0]["reason"] == "CANDIDATE_COMPILER_UNAVAILABLE"
    finally:
        writer.close()


def test_cli_rejects_uri_arguments_without_echo_or_backend_read(monkeypatch, capsys):
    monkeypatch.setattr(preflight, "run_preflight", lambda: pytest.fail("Arguments must be rejected before a DB read."))
    assert preflight.main(["--uri", "synthetic-secret-uri"]) == 2
    output = capsys.readouterr()
    assert "synthetic-secret-uri" not in output.out + output.err
    assert json.loads(output.out)["validation"]["geminicli"]["valid"] is False


def test_cli_fresh_process_imports_no_app_adapter_or_config_and_outputs_only_safe_json(tmp_path):
    script = """
import importlib.abc, sys
class Forbidden(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname == 'web' or fullname == 'config' or fullname.startswith(('src.storage', 'src.credential', 'src.api', 'src.model_routing.store')):
            raise AssertionError('Forbidden application import')
sys.meta_path.insert(0, Forbidden())
from src.model_routing.preflight import main
raise SystemExit(main([]))
"""
    process = subprocess.run([sys.executable, "-c", script], cwd=Path(__file__).parent, env=os.environ.copy(), capture_output=True, text=True, timeout=20)
    assert process.returncode == 3
    report = json.loads(process.stdout)
    assert report["config_digest"] is None
    assert "Traceback" not in process.stderr
    assert not (tmp_path / "credentials.db").exists()


def test_cli_mock_candidate_success_only_safe_json(tmp_path):
    _path, writer = create_sqlite(tmp_path, {"routes": [{"upstream_name": "synthetic-private-target"}]})
    script = """
from types import SimpleNamespace
from src.model_routing import preflight
from src.model_routing.types import ParsedRouteTable, CompileResult, CompiledChannel, RoutingPolicySnapshot
digest = 'a' * 64
compiler = SimpleNamespace(parse_route_table=lambda raw: ParsedRouteTable(), compile_channel=lambda channel, parsed, policy: CompileResult(CompiledChannel(channel, 'b' * 64, digest)))
policy = SimpleNamespace(build_policy_snapshot=lambda: RoutingPolicySnapshot('unit-mock', digest))
preflight._candidate_modules = lambda: (compiler, policy)
raise SystemExit(preflight.main([]))
"""
    try:
        process = subprocess.run([sys.executable, "-c", script], cwd=Path(__file__).parent, env=os.environ.copy(), capture_output=True, text=True, timeout=20)
        assert process.returncode == 0
        report = json.loads(process.stdout)
        assert all(report["validation"][channel]["valid"] for channel in CHANNELS)
        assert "synthetic-private-target" not in process.stdout + process.stderr
        assert set(report) == {"backend_identity_digest", "config_digest", "policy_digest", "validation"}
        assert process.stderr == ""
    finally:
        writer.close()


def test_backend_identity_binds_scope_and_cluster_options_but_not_passwords():
    first = readonly.BackendSelection("mysql", "mysql://reader:password-a@localhost/unit", "node-a")
    rotated = readonly.BackendSelection("mysql", "mysql://reader:password-b@localhost/unit", "node-a")
    other_scope = readonly.BackendSelection("mysql", first.location, "node-b")
    assert readonly._identity(first) == readonly._identity(rotated)
    assert readonly._identity(first) != readonly._identity(other_scope)
    mongo_a = readonly.BackendSelection("mongodb", "mongodb://localhost/?replicaSet=cluster-a&authSource=auth-a", "unit")
    mongo_b = readonly.BackendSelection("mongodb", "mongodb://localhost/?replicaSet=cluster-b&authSource=auth-a", "unit")
    assert readonly._identity(mongo_a) != readonly._identity(mongo_b)


def install_pg_mock(monkeypatch, *, readonly_on=True, relation_kind="r", replica=False):
    trace = []
    class Transaction:
        async def __aenter__(self):
            trace.append("enter-readonly")
        async def __aexit__(self, *_args):
            trace.append("exit-readonly")
    class Connection:
        def transaction(self, **kwargs):
            assert kwargs == {"isolation": "repeatable_read", "readonly": True}
            return Transaction()
        async def fetchval(self, query):
            trace.append(query)
            return "on" if readonly_on else "off"
        async def fetchrow(self, query):
            trace.append(query)
            return {"database": "unit", "schema": "public", "search_path": "public", "replica": replica, "table_name": "config", "relation_kind": relation_kind, "relation_schema": "public", "authenticated_user": "reader", "session_user": "reader"}
        async def fetch(self, query, key):
            trace.append((query, key))
            return [(json.dumps({"routes": []}),)]
        async def close(self):
            trace.append("close")
    async def connect(_dsn, **kwargs):
        assert kwargs["server_settings"] == {"default_transaction_read_only": "on"}
        trace.append("connect")
        return Connection()
    monkeypatch.setitem(sys.modules, "asyncpg", SimpleNamespace(connect=connect, create_pool=lambda *_a, **_k: pytest.fail("No pool")))
    return trace


@pytest.mark.asyncio
async def test_mock_pg_readonly_transaction_and_scoped_single_key(monkeypatch):
    trace = install_pg_mock(monkeypatch)
    result = await readonly.read_routing_config_readonly({"POSTGRESQL_URI": "postgresql://reader:synthetic-password@localhost/unit"})
    assert thaw(result.snapshot.raw_table) == {"routes": []}
    assert trace[-2:] == ["exit-readonly", "close"]
    assert ("SELECT value FROM config WHERE key = $1 LIMIT 2", "model_routing") in trace


@pytest.mark.asyncio
@pytest.mark.parametrize("kwargs", [{"readonly_on": False}, {"relation_kind": "v"}, {"replica": True}])
async def test_mock_pg_permission_view_or_replica_refused(monkeypatch, kwargs):
    trace = install_pg_mock(monkeypatch, **kwargs)
    with pytest.raises(RoutingConfigReadError):
        await readonly.read_routing_config_readonly({"POSTGRESQL_URI": "postgresql://reader@localhost/unit"})
    assert not any(isinstance(item, tuple) and item[0].startswith("SELECT value") for item in trace)
    assert trace[-1] == "close"


def install_mysql_mock(monkeypatch, *, readonly_on=True, table_type="BASE TABLE"):
    trace = []
    class Cursor:
        def __init__(self):
            self.query = ""
        async def __aenter__(self):
            return self
        async def __aexit__(self, *_args):
            trace.append("cursor-close")
        async def execute(self, query, params=None):
            self.query = query
            trace.append((query, params))
        async def fetchall(self):
            if self.query.startswith("SHOW"):
                return [("transaction_read_only", "ON" if readonly_on else "OFF")]
            if self.query.startswith("SELECT TABLE_TYPE"):
                return [(table_type,)]
            return [(json.dumps({"routes": []}),)]
        async def fetchone(self):
            return ("unit", "reader@localhost", "reader@localhost")
    class Connection:
        def cursor(self):
            return Cursor()
        async def rollback(self):
            trace.append("rollback")
        def close(self):
            trace.append("close")
    async def connect(**kwargs):
        assert kwargs["autocommit"] is True
        assert kwargs["init_command"] == "SET SESSION TRANSACTION READ ONLY"
        trace.append("connect")
        return Connection()
    monkeypatch.setitem(sys.modules, "aiomysql", SimpleNamespace(connect=connect, create_pool=lambda *_a, **_k: pytest.fail("No pool")))
    return trace


@pytest.mark.asyncio
async def test_mock_mysql_readonly_new_session_no_pool_and_server_scope(monkeypatch):
    trace = install_mysql_mock(monkeypatch)
    result = await readonly.read_routing_config_readonly({"MYSQL_URI": "mysql://reader:synthetic-password@localhost/unit", "GCLI_SERVER_NAME": "node-unit"})
    assert thaw(result.snapshot.raw_table) == {"routes": []}
    assert ("START TRANSACTION READ ONLY", None) in trace
    assert ("SELECT value FROM gcli_config WHERE server_name = %s AND `key` = %s LIMIT 2", ("node-unit", "model_routing")) in trace
    assert trace[-2:] == ["rollback", "close"]
    assert not any(isinstance(item, tuple) and item[0].startswith(("INSERT", "UPDATE", "DELETE", "CREATE", "ALTER", "COMMIT")) for item in trace)


@pytest.mark.asyncio
@pytest.mark.parametrize("kwargs", [{"readonly_on": False}, {"table_type": "VIEW"}])
async def test_mock_mysql_permission_or_view_refused(monkeypatch, kwargs):
    trace = install_mysql_mock(monkeypatch, **kwargs)
    with pytest.raises(RoutingConfigReadError):
        await readonly.read_routing_config_readonly({"MYSQL_URI": "mysql://reader@localhost/unit", "GCLI_SERVER_NAME": "node-unit"})
    assert not any(isinstance(item, tuple) and item[0].startswith("SELECT value") for item in trace)
    assert trace[-2:] == ["rollback", "close"]


def install_mongo_mock(monkeypatch, *, actions=None, collection_type="collection", docs=None, unauthenticated=False):
    trace = []
    actions = ["find", "listCollections", "listIndexes"] if actions is None else actions
    docs = [{"value": {"routes": []}}] if docs is None else docs
    class Cursor:
        def limit(self, length):
            assert length == 2
            return self
        async def to_list(self, length):
            assert length == 2
            return docs
    class Collection:
        def find(self, query, projection):
            trace.append((query, projection))
            assert query == {"key": "model_routing"}
            assert projection == {"_id": 0, "value": 1}
            return Cursor()
    class Database:
        def __getitem__(self, name):
            assert name == "config"
            return Collection()
        async def command(self, command):
            trace.append(command)
            if "connectionStatus" in command:
                return {"authInfo": {"authenticatedUsers": [] if unauthenticated else [{"user": "reader", "db": "unit"}], "authenticatedUserPrivileges": [{"resource": {"db": "unit", "collection": ""}, "actions": actions}]}}
            assert command == {"listCollections": 1, "filter": {"name": "config"}, "nameOnly": True}
            batch = [] if collection_type is None else [{"name": "config", "type": collection_type}]
            return {"cursor": {"firstBatch": batch}}
    class Client:
        def __init__(self, _uri, **kwargs):
            assert kwargs["retryWrites"] is False and kwargs["retryReads"] is False
            assert kwargs["readPreference"] == "primary"
            self.admin = Database()
        def get_database(self, name, **kwargs):
            assert name == "unit"
            assert kwargs["read_concern"].level == "local"
            return Database()
        def close(self):
            trace.append("close")
    monkeypatch.setitem(sys.modules, "motor.motor_asyncio", SimpleNamespace(AsyncIOMotorClient=Client))
    return trace


@pytest.mark.asyncio
async def test_mock_mongo_effective_privileges_and_database_override(monkeypatch):
    trace = install_mongo_mock(monkeypatch)
    result = await readonly.read_routing_config_readonly({"MONGODB_URI": "mongodb://reader:synthetic-password@localhost/ignored", "MONGODB_DATABASE": "unit"})
    assert thaw(result.snapshot.raw_table) == {"routes": []}
    assert trace[0] == {"connectionStatus": 1, "showPrivileges": True}
    assert trace[-1] == "close"


@pytest.mark.asyncio
@pytest.mark.parametrize("kwargs", [{"actions": ["find", "insert"]}, {"actions": ["find", "anyAction"]}, {"unauthenticated": True}, {"collection_type": None}, {"collection_type": "view"}, {"docs": [{"value": None}, {"value": None}]}])
async def test_mock_mongo_unproven_permissions_missing_collection_and_duplicate_key_refused(monkeypatch, kwargs):
    trace = install_mongo_mock(monkeypatch, **kwargs)
    with pytest.raises(RoutingConfigReadError):
        await readonly.read_routing_config_readonly({"MONGODB_URI": "mongodb://reader@localhost/unit", "MONGODB_DATABASE": "unit"})
    assert trace[-1] == "close"


@pytest.mark.asyncio
async def test_remote_failure_sanitized_no_fallback_even_when_storage_strict_off(monkeypatch, tmp_path):
    _path, writer = create_sqlite(tmp_path, {"routes": []})
    async def fail_connect(*_args, **_kwargs):
        raise RuntimeError("synthetic-secret-uri-and-password")
    monkeypatch.setitem(sys.modules, "asyncpg", SimpleNamespace(connect=fail_connect))
    env = {"POSTGRESQL_URI": "postgresql://reader:synthetic-secret-uri-and-password@localhost/unit", "STORAGE_STRICT": "0", "CREDENTIALS_DIR": str(tmp_path)}
    try:
        with pytest.raises(RoutingConfigReadError) as caught:
            await readonly.read_routing_config_readonly(env)
        assert "synthetic-secret" not in str(caught.value)
        assert caught.value.__cause__ is None
        report, code = await preflight.run_preflight(env)
        assert code == 3 and "synthetic-secret" not in json.dumps(report)
    finally:
        writer.close()


def test_runbook_requires_freeze_drain_fresh_all_writers_and_manual_gate():
    document = (Path(__file__).parent / "docs/model-routing/UPGRADE.md").read_text(encoding="utf-8")
    for marker in ("backend_identity_digest", "config_digest", "policy_digest", "已受理", "提交", "全部可写实例", "旧写入口", "冻结", "fresh", "/storage-engine/switch"):
        assert marker in document


def test_safe_issue_rejects_dynamic_reason_field_message_and_invalid_indexes():
    issue = ValidationIssue("antigravity", True, "secret-target", "secret-uri", (False, -1, 4), "secret-password")
    result = preflight._safe_issue(issue)
    assert result == {"channel": "antigravity", "row": None, "field": None, "reason": "AMBIGUOUS_COMPATIBILITY", "related_rows": [4], "message": "Invalid model routing configuration."}


@pytest.mark.asyncio
@pytest.mark.parametrize("case", ["transparent_target", "unknown_channel", "bad_json"])
async def test_real_compiler_preflight_sqlite_and_runtime_digest(tmp_path, case):
    """Real MR02/MR04 dependency gate: no compiler/policy mock and no skip.

    These cases deliberately fail while candidate modules are unavailable.
    Execute them after the root integrates the accepted real R dependencies.
    """
    from src.model_routing import compiler, policy
    from src.model_routing.store import config_digest as runtime_config_digest

    raw = {"routes": [{
        "channel": "antigravity", "public_name": "public-preflight-unit",
        "upstream_name": "unit-opaque-target", "enabled": True,
    }]}
    if case == "unknown_channel":
        raw["routes"][0]["channel"] = "unknown-unit-channel"
    elif case == "bad_json":
        raw = "{invalid-unit-json"

    path = tmp_path / "credentials.db"
    connection = sqlite3.connect(path)
    connection.execute("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT)")
    connection.execute("INSERT INTO config VALUES (?, ?)", ("model_routing", raw if isinstance(raw, str) else json.dumps(raw)))
    connection.commit()
    connection.close()  # Non-WAL strong pin requires no existing write handle.
    original = path.read_bytes()
    try:
        actual_compiler, actual_policy = preflight._candidate_modules()
        assert actual_compiler is compiler and actual_policy is policy
        report, code = await preflight.run_preflight()
        assert report["config_digest"] == runtime_config_digest(True, raw)
        assert report["policy_digest"] == policy.build_policy_snapshot().digest
        assert path.read_bytes() == original
        if case == "transparent_target":
            assert code == 0
            assert all(report["validation"][channel]["valid"] for channel in CHANNELS)
        else:
            assert code == 2
            expected_reason = "UNSUPPORTED_CHANNEL" if case == "unknown_channel" else "INVALID_STRUCTURE"
            for channel in CHANNELS:
                assert report["validation"][channel]["valid"] is False
                assert expected_reason in {issue["reason"] for issue in report["validation"][channel]["issues"]}
        assert "unit-opaque-target" not in json.dumps(report)
        assert "unknown-unit-channel" not in json.dumps(report)
    finally:
        connection.close()
