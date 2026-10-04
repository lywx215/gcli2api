"""Independent, fail-closed readers for the single routing configuration key.

No adapter, application, cache, credential manager, or dotenv loader is imported.
Remote drivers are imported only after the environment selects that backend.
"""

from __future__ import annotations

import asyncio
from contextlib import contextmanager
from dataclasses import dataclass, field
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
from typing import Any, Mapping
from urllib.parse import parse_qs, urlsplit

from .types import RoutingConfigReadError, RoutingConfigSnapshot, thaw

ROUTING_KEY = "model_routing"
_TIMEOUT = 10
_WINDOWS = sys.platform == "win32"


@dataclass(frozen=True)
class BackendSelection:
    kind: str
    location: str = field(repr=False)
    scope: str = field(default="", repr=False)


@dataclass(frozen=True)
class ReadonlyReadResult:
    backend_identity_digest: str
    snapshot: RoutingConfigSnapshot = field(repr=False)


def config_digest(exists: bool, raw_value: Any) -> str:
    """Use the same presence-sensitive canonical representation as runtime."""
    encoded = json.dumps(
        {"exists": exists, "value": thaw(raw_value) if exists else None},
        sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def select_backend(environment: Mapping[str, str] | None = None) -> BackendSelection:
    """Mirror adapter selection, without initialization or a fallback attempt."""
    env = os.environ if environment is None else environment
    mysql_uri = env.get("MYSQL_URI", "")
    server = env.get("GCLI_SERVER_NAME", "")
    if mysql_uri and server:
        return BackendSelection("mysql", mysql_uri, server)
    if env.get("POSTGRESQL_URI", ""):
        return BackendSelection("postgresql", env["POSTGRESQL_URI"])
    if env.get("MONGODB_URI", ""):
        return BackendSelection("mongodb", env["MONGODB_URI"], env.get("MONGODB_DATABASE", "gcli2api"))
    path = Path(env.get("CREDENTIALS_DIR", "./creds")) / "credentials.db"
    return BackendSelection("sqlite", str(path.resolve()))


def _identity(selection: BackendSelection, scope: Any = None) -> str:
    # Passwords and URI options are never included, even inside a digest.
    if selection.kind == "sqlite":
        endpoint: Any = str(Path(selection.location).resolve())
    else:
        parsed = urlsplit(selection.location)
        if selection.kind == "mongodb":
            # Preserve all replica-set seeds while removing userinfo.
            options = parse_qs(parsed.query)
            endpoint = {
                "scheme": parsed.scheme, "hosts": parsed.netloc.rsplit("@", 1)[-1],
                "cluster_options": {key: options[key] for key in ("replicaSet", "authSource", "directConnection", "loadBalanced") if key in options},
            }
        else:
            endpoint = {
                "scheme": parsed.scheme.split("+", 1)[0], "host": parsed.hostname or ("127.0.0.1" if selection.kind == "mysql" else ""),
                "port": parsed.port or (3306 if selection.kind == "mysql" else 5432),
                "database": parsed.path.lstrip("/") or ("gcli2api" if selection.kind == "mysql" else ""),
                "user": parsed.username,
            }
    value = {"backend": selection.kind, "endpoint": endpoint, "scope": scope if scope is not None else selection.scope}
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")).hexdigest()


def _decode(raw: Any) -> Any:
    """Keep invalid stored JSON invalid, so the compiler reports a global issue."""
    if not isinstance(raw, (str, bytes, bytearray)):
        return raw
    if not isinstance(raw, str):
        raw = bytes(raw).decode("utf-8", errors="strict")

    def reject_constant(_value: str) -> None:
        raise ValueError

    def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError
            result[key] = value
        return result

    try:
        return json.loads(raw, parse_constant=reject_constant, object_pairs_hook=unique_object)
    except (ValueError, TypeError):
        return raw


def _result(selection: BackendSelection, rows: list[Any], *, native: bool = False, scope: Any = None) -> ReadonlyReadResult:
    if len(rows) > 1:
        raise RoutingConfigReadError()
    exists = bool(rows)
    raw = (rows[0] if native else _decode(rows[0][0])) if exists else None
    snapshot = RoutingConfigSnapshot(
        exists=exists, raw_table=raw if exists else {"routes": []},
        digest=config_digest(exists, raw),
    )
    return ReadonlyReadResult(_identity(selection, scope), snapshot)


class _WindowsExistingFiles:
    """Keep existing file names alive without obtaining any write/delete access.

    Omitting FILE_SHARE_DELETE prevents deletion/rename until every guard is
    closed, including SQLite's last-writer sidecar cleanup. OPEN_EXISTING never
    creates a missing file. HANDLE is pointer-sized, including on 64-bit Python.
    """

    def __init__(self) -> None:
        import ctypes
        from ctypes import wintypes

        self._kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self._create = self._kernel.CreateFileW
        self._create.argtypes = (
            wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
            wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
        )
        self._create.restype = wintypes.HANDLE
        self._close = self._kernel.CloseHandle
        self._close.argtypes = (wintypes.HANDLE,)
        self._close.restype = wintypes.BOOL
        self._invalid = ctypes.c_void_p(-1).value
        self._handles: list[Any] = []

    def acquire(self, path: Path, *, share_write: bool = True) -> None:
        handle = self._create(
            str(path), 0x80000000, 0x00000001 | (0x00000002 if share_write else 0), None,
            3, 0x00000080, None,
        )  # GENERIC_READ; SHARE_READ|WRITE; OPEN_EXISTING; NORMAL.
        if handle is None or handle == self._invalid:
            raise RoutingConfigReadError()
        self._handles.append(handle)

    def close(self) -> None:
        failed = False
        for handle in reversed(self._handles):
            if not self._close(handle):
                failed = True
        self._handles.clear()
        if failed:
            raise RoutingConfigReadError()


@contextmanager
def _sqlite_existing_files(path: Path):
    # A plain POSIX open cannot prevent unlink or a non-WAL -> WAL switch.
    # Do not connect on unproved platforms, even if the first header is non-WAL.
    if not _WINDOWS:
        raise RoutingConfigReadError()
    guards = _WindowsExistingFiles()
    try:
        strict_main = True
        try:
            # This blocks both replacement and a new writer changing a non-WAL
            # database to WAL after the header check.
            guards.acquire(path, share_write=False)
        except RoutingConfigReadError:
            strict_main = False
            guards.acquire(path, share_write=True)
        with path.open("rb") as source:
            header = source.read(100)
        if len(header) != 100 or header[:16] != b"SQLite format 3\x00":
            raise RoutingConfigReadError()
        if header[18:20] not in {b"\x01\x01", b"\x02\x02"}:
            # SQLite can interpret mixed read/write versions as WAL. Never
            # classify an unknown or mixed header as a pinned non-WAL file.
            raise RoutingConfigReadError()
        if header[18:20] == b"\x02\x02":
            guards.acquire(Path(str(path) + "-wal"))
            guards.acquire(Path(str(path) + "-shm"))
            # The main file may be writable on the WAL branch. Check again
            # only after all existing file names have been pinned.
            with path.open("rb") as source:
                if source.read(100)[18:20] != b"\x02\x02":
                    raise RoutingConfigReadError()
        elif not strict_main:
            # A read/write-shared pin cannot prove a non-WAL file stays non-WAL.
            raise RoutingConfigReadError()
        yield
    finally:
        guards.close()


def _read_sqlite(selection: BackendSelection) -> ReadonlyReadResult:
    path = Path(selection.location).resolve()
    # Do not use immutable: it would ignore committed changes still in the WAL.
    with _sqlite_existing_files(path):
        connection = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=_TIMEOUT)
        try:
            # Restrict even a corrupted/view-based schema to metadata and this
            # key's own table. No PRAGMA, DDL, or credential-table read.
            def authorize(action: int, name: str | None, _column: str | None, _db: str | None, _trigger: str | None) -> int:
                if action == sqlite3.SQLITE_SELECT:
                    return sqlite3.SQLITE_OK
                if action == sqlite3.SQLITE_READ and name in {"config", "sqlite_master", "sqlite_schema"}:
                    return sqlite3.SQLITE_OK
                return sqlite3.SQLITE_DENY

            connection.set_authorizer(authorize)
            metadata = connection.execute("SELECT type FROM sqlite_schema WHERE name = ?", ("config",)).fetchall()
            if metadata != [("table",)]:
                raise RoutingConfigReadError()
            rows = connection.execute("SELECT value FROM config WHERE key = ? LIMIT 2", (ROUTING_KEY,)).fetchall()
            return _result(selection, rows, scope={"table": "config", "key": ROUTING_KEY})
        finally:
            connection.close()


async def _read_postgresql(selection: BackendSelection) -> ReadonlyReadResult:
    import asyncpg

    connection = await asyncpg.connect(
        selection.location, timeout=_TIMEOUT, command_timeout=_TIMEOUT,
        server_settings={"default_transaction_read_only": "on"},
    )
    try:
        async with connection.transaction(isolation="repeatable_read", readonly=True):
            if await connection.fetchval("SHOW transaction_read_only") != "on":
                raise RoutingConfigReadError()
            scope = await connection.fetchrow(
                "SELECT pg_catalog.current_database() AS database, pg_catalog.current_schema() AS schema, "
                "pg_catalog.current_setting('search_path') AS search_path, "
                "pg_catalog.pg_is_in_recovery() AS replica, pg_catalog.to_regclass('config')::text AS table_name, "
                "current_user AS authenticated_user, session_user AS session_user, "
                "(SELECT relkind FROM pg_catalog.pg_class WHERE oid = pg_catalog.to_regclass('config')) AS relation_kind, "
                "(SELECT n.nspname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace "
                "WHERE c.oid = pg_catalog.to_regclass('config')) AS relation_schema"
            )
            if not scope or scope["replica"] or not scope["table_name"] or not scope["relation_schema"] or scope["relation_kind"] not in {"r", "p"}:
                raise RoutingConfigReadError()
            rows = await connection.fetch("SELECT value FROM config WHERE key = $1 LIMIT 2", ROUTING_KEY)
            return _result(selection, rows, scope=dict(scope))
    finally:
        await connection.close()


async def _read_mysql(selection: BackendSelection) -> ReadonlyReadResult:
    import aiomysql

    parsed = urlsplit(selection.location)
    if parsed.scheme not in {"mysql", "mysql+aiomysql", "mysql+pymysql"}:
        raise RoutingConfigReadError()
    params = parse_qs(parsed.query)
    # Match the existing manager's URI interpretation; never initialize a pool.
    connection = await aiomysql.connect(
        host=parsed.hostname or "127.0.0.1", port=parsed.port or 3306,
        user=parsed.username or "root", password=parsed.password or "",
        db=parsed.path.lstrip("/") or "gcli2api",
        charset=params.get("charset", ["utf8mb4"])[0],
        autocommit=True, connect_timeout=_TIMEOUT,
        init_command="SET SESSION TRANSACTION READ ONLY",
    )
    try:
        async with connection.cursor() as cursor:
            await cursor.execute("SHOW SESSION VARIABLES WHERE Variable_name IN ('transaction_read_only', 'tx_read_only')")
            variables = await cursor.fetchall()
            if not variables or any(str(item[1]).upper() not in {"ON", "1"} for item in variables):
                raise RoutingConfigReadError()
            await cursor.execute("START TRANSACTION READ ONLY")
            await cursor.execute("SELECT DATABASE(), CURRENT_USER(), USER()")
            database = await cursor.fetchone()
            if not database or not database[0]:
                raise RoutingConfigReadError()
            await cursor.execute("SELECT TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s", ("gcli_config",))
            metadata = await cursor.fetchall()
            if list(metadata) != [("BASE TABLE",)]:
                raise RoutingConfigReadError()
            await cursor.execute("SELECT value FROM gcli_config WHERE server_name = %s AND `key` = %s LIMIT 2", (selection.scope, ROUTING_KEY))
            rows = await cursor.fetchall()
            return _result(selection, list(rows), scope={"database": database[0], "authenticated_user": database[1], "session_user": database[2], "server_name": selection.scope, "table": "gcli_config", "key": ROUTING_KEY})
    finally:
        try:
            await connection.rollback()
        finally:
            connection.close()


_MONGO_READ_ACTIONS = frozenset({
    "find", "changeStream", "listCollections", "listIndexes", "listDatabases",
    "collStats", "dbStats", "dbHash", "indexStats", "planCacheRead", "killCursors",
})


def _mongo_readonly_identity(status: Any, database: str) -> None:
    info = status.get("authInfo", {}) if isinstance(status, dict) else {}
    users = info.get("authenticatedUsers")
    privileges = info.get("authenticatedUserPrivileges")
    if not isinstance(users, list) or not users or not isinstance(privileges, list) or not privileges:
        raise RoutingConfigReadError()
    can_find = False
    for privilege in privileges:
        if not isinstance(privilege, dict):
            raise RoutingConfigReadError()
        actions, resource = privilege.get("actions"), privilege.get("resource")
        if not isinstance(actions, list) or not actions or not isinstance(resource, dict):
            raise RoutingConfigReadError()
        if any(action not in _MONGO_READ_ACTIONS for action in actions):
            raise RoutingConfigReadError()
        if "find" in actions and resource.get("db") in {database, ""} and resource.get("collection") in {"config", ""}:
            can_find = True
    if not can_find:
        raise RoutingConfigReadError()


async def _read_mongodb(selection: BackendSelection) -> ReadonlyReadResult:
    from motor.motor_asyncio import AsyncIOMotorClient
    from pymongo.read_concern import ReadConcern
    from pymongo.read_preferences import Primary

    client = AsyncIOMotorClient(
        selection.location, connect=False, retryWrites=False, retryReads=False,
        readPreference="primary", serverSelectionTimeoutMS=_TIMEOUT * 1000,
        connectTimeoutMS=_TIMEOUT * 1000, socketTimeoutMS=_TIMEOUT * 1000,
    )
    try:
        status = await client.admin.command({"connectionStatus": 1, "showPrivileges": True})
        _mongo_readonly_identity(status, selection.scope)
        database = client.get_database(selection.scope, read_preference=Primary(), read_concern=ReadConcern("local"))
        collections = await database.command({"listCollections": 1, "filter": {"name": "config"}, "nameOnly": True})
        batch = collections.get("cursor", {}).get("firstBatch", [])
        if len(batch) != 1 or batch[0].get("type") != "collection":
            raise RoutingConfigReadError()
        docs = await database["config"].find({"key": ROUTING_KEY}, {"_id": 0, "value": 1}).limit(2).to_list(length=2)
        if any("value" not in doc for doc in docs):
            raise RoutingConfigReadError()
        return _result(selection, [doc["value"] for doc in docs], native=True, scope={"database": selection.scope, "collection": "config", "key": ROUTING_KEY, "authenticated_users": status["authInfo"]["authenticatedUsers"]})
    finally:
        client.close()


async def read_routing_config_readonly(environment: Mapping[str, str] | None = None) -> ReadonlyReadResult:
    """Read the selected backend once; backend errors contain no source text."""
    try:
        selection = select_backend(environment)
        if selection.kind == "sqlite":
            return _read_sqlite(selection)
        reader = {"postgresql": _read_postgresql, "mysql": _read_mysql, "mongodb": _read_mongodb}[selection.kind]
        return await asyncio.wait_for(reader(selection), timeout=_TIMEOUT * 4)
    except asyncio.CancelledError:
        raise
    except Exception:
        raise RoutingConfigReadError() from None
