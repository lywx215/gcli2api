import json

import pytest

from src.storage.mongodb_manager import MongoDBManager
from src.storage.mysql_manager import MySQLManager
from src.storage.psql_manager import PSQLManager


def _tos_payload():
    return json.dumps(
        {"error": {"details": [{"reason": "TOS_VIOLATION"}]}}
    )


def _antigravity_summary_dict():
    return {
        "filename": "tos.json",
        "disabled": True,
        "error_codes": "[403]",
        "last_success": None,
        "user_email": None,
        "rotation_order": 1,
        "model_cooldowns": "{}",
        "tier": "pro",
        "enable_credit": False,
        "success_count": 0,
        "failure_count": 1,
        "permanent_disabled": False,
        "cycle_stats": "{}",
        "last_cycle_stats": "{}",
        "remark": "",
    }


class _Acquire:
    def __init__(self, connection):
        self.connection = connection

    async def __aenter__(self):
        return self.connection

    async def __aexit__(self, exc_type, exc, tb):
        return False


class _PSQLConnection:
    def __init__(self):
        self.calls = []

    async def fetch(self, query, *params):
        self.calls.append((query, params))
        if "COUNT(*) AS cnt" in query:
            return [{"disabled": True, "permanent_disabled": False, "cnt": 1}]
        if "SELECT model_cooldowns FROM" in query:
            return [{"model_cooldowns": "{}"}]
        if "filename = ANY" in query:
            assert params == (["tos.json"],)
            return [
                {
                    "filename": "tos.json",
                    "error_messages": json.dumps({"403": _tos_payload()}),
                }
            ]
        return [_antigravity_summary_dict()]


class _PSQLPool:
    def __init__(self, connection):
        self.connection = connection

    def acquire(self):
        return _Acquire(self.connection)


@pytest.mark.asyncio
async def test_psql_uses_lightweight_summary_then_bulk_error_query():
    connection = _PSQLConnection()
    manager = PSQLManager()
    manager._initialized = True
    manager._pool = _PSQLPool(connection)

    result = await manager.get_credentials_summary(
        mode="antigravity",
        error_code_filter="403_tos_violation",
        include_error_classifications=True,
    )

    assert result["total"] == 1
    assert result["items"][0]["error_classifications"] == {"403": "tos_violation"}
    main_query = next(query for query, _ in connection.calls if "ORDER BY" in query)
    assert "error_messages" not in main_query
    assert any("filename = ANY" in query for query, _ in connection.calls)


@pytest.mark.asyncio
async def test_psql_default_summary_never_loads_error_messages():
    connection = _PSQLConnection()
    manager = PSQLManager()
    manager._initialized = True
    manager._pool = _PSQLPool(connection)

    result = await manager.get_credentials_summary(mode="antigravity")

    assert result["total"] == 1
    assert "error_classifications" not in result["items"][0]
    assert len(connection.calls) == 2
    assert all("error_messages" not in query for query, _ in connection.calls)


class _MySQLCursor:
    def __init__(self):
        self.calls = []
        self.last_query = ""

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def execute(self, query, params=()):
        self.last_query = query
        self.calls.append((query, params))

    async def fetchall(self):
        if "COUNT(*)" in self.last_query:
            return [(1, 1)]
        if "SELECT model_cooldowns FROM" in self.last_query:
            return [("{}",)]
        if "filename IN" in self.last_query:
            return [("tos.json", json.dumps({"403": _tos_payload()}))]
        return [
            (
                "tos.json",
                1,
                "[403]",
                None,
                None,
                1,
                "{}",
                "pro",
                "",
            )
        ]


class _MySQLConnection:
    def __init__(self, cursor):
        self._cursor = cursor

    def cursor(self):
        return self._cursor


class _MySQLPool:
    def __init__(self, connection):
        self.connection = connection

    def acquire(self):
        return _Acquire(self.connection)


@pytest.mark.asyncio
async def test_mysql_uses_lightweight_summary_and_server_scoped_bulk_query():
    cursor = _MySQLCursor()
    manager = MySQLManager()
    manager._initialized = True
    manager._pool = _MySQLPool(_MySQLConnection(cursor))
    manager._server_name = "node-a"

    result = await manager.get_credentials_summary(
        mode="antigravity",
        error_code_filter="403_tos_violation",
        include_error_classifications=True,
    )

    assert result["total"] == 1
    assert result["items"][0]["error_classifications"] == {"403": "tos_violation"}
    main_query = next(query for query, _ in cursor.calls if "ORDER BY" in query)
    assert "error_messages" not in main_query
    bulk_query, bulk_params = next(
        (query, params) for query, params in cursor.calls if "filename IN" in query
    )
    assert "server_name = %s" in bulk_query
    assert bulk_params == ("node-a", "tos.json")


class _MongoList:
    async def to_list(self, length):
        return [{"_id": True, "count": 1}]


class _MongoCursor:
    def __init__(self, docs):
        self.docs = docs
        self.index = 0

    def sort(self, *args):
        return self

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self.index >= len(self.docs):
            raise StopAsyncIteration
        doc = self.docs[self.index]
        self.index += 1
        return doc


class _MongoCollection:
    def __init__(self):
        self.find_calls = []

    def aggregate(self, pipeline):
        return _MongoList()

    def find(self, query, projection=None):
        self.find_calls.append((query, projection))
        if projection and "error_messages" in projection:
            return _MongoCursor(
                [
                    {
                        "filename": "tos.json",
                        "error_messages": {"403": _tos_payload()},
                    }
                ]
            )
        return _MongoCursor(
            [
                {
                    "filename": "tos.json",
                    "disabled": True,
                    "error_codes": [403],
                    "rotation_order": 1,
                    "model_cooldowns": {},
                    "tier": "pro",
                }
            ]
        )


@pytest.mark.asyncio
async def test_mongodb_prefilters_classified_403_with_indexable_query():
    collection = _MongoCollection()
    manager = MongoDBManager()
    manager._initialized = True
    manager._db = {"antigravity_credentials": collection}

    result = await manager.get_credentials_summary(
        mode="antigravity",
        error_code_filter="403_tos_violation",
        include_error_classifications=True,
    )

    assert result["total"] == 1
    assert result["items"][0]["error_classifications"] == {"403": "tos_violation"}
    initial_query, initial_projection = collection.find_calls[0]
    assert initial_query["error_codes"] == {"$in": [403, "403"]}
    assert "error_messages" not in initial_projection
    bulk_query, bulk_projection = collection.find_calls[1]
    assert bulk_query == {"filename": {"$in": ["tos.json"]}}
    assert bulk_projection["error_messages"] == 1
