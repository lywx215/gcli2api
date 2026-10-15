"""Safe metadata, capability truth and search for both legacy panel channels."""
import json
import sqlite3
from types import SimpleNamespace
from unittest.mock import AsyncMock

import aiosqlite
import pytest
from fastapi import FastAPI, HTTPException
from httpx import ASGITransport, AsyncClient

from src.panel import creds
from src.panel.credential_capabilities import GEMINICLI_SEARCH, credential_capabilities
from src.storage.sqlite_manager import SQLiteManager

HEALTH_FIELDS = ("health_status", "quarantine_reason", "probe_stage", "next_probe_at",
                 "last_health_check_at", "health_check_started_at", "health_state_version")


def row(name, email=None, **extra):
    return {"filename": name, "user_email": email, "disabled": False,
            "error_codes": [], "last_success": None, **extra}


def install(monkeypatch, *, engine="sqlite", rows=None, supports_search=True):
    result = {"items": rows or [], "total": len(rows or []),
              "stats": {"total": 41, "normal": 39, "disabled": 1, "permanent_disabled": 1}}
    backend = SimpleNamespace(get_credentials_summary=AsyncMock(return_value=result),
                              SUPPORTS_PANEL_CREDENTIAL_SEARCH=supports_search)
    adapter = SimpleNamespace(_backend=backend,
        get_backend_info=AsyncMock(return_value={"backend_type": engine}),
        get_credential=AsyncMock(side_effect=AssertionError("payload lookup forbidden")),
        get_credential_state=AsyncMock(side_effect=AssertionError("state lookup forbidden")),
        update_credential_state=AsyncMock(return_value=True))
    manager = SimpleNamespace(get_or_fetch_user_email=AsyncMock(side_effect=AssertionError("email lookup forbidden")),
        update_credential_state=AsyncMock(return_value=True),
        set_cred_disabled=AsyncMock(return_value=True))
    monkeypatch.setattr(creds, "get_storage_adapter", AsyncMock(return_value=adapter))
    monkeypatch.setattr(creds, "credential_manager", manager)
    return adapter, manager


def payload(response):
    assert response.status_code == 200
    return json.loads(response.body)


@pytest.mark.parametrize("mode", ["geminicli", "antigravity"])
async def test_both_channels_accept_limit_10_and_keep_legacy_envelope(monkeypatch, mode):
    adapter, manager = install(monkeypatch)
    data = payload(await creds.get_creds_status_common(0, 10, "all", mode))
    assert data["mode"] == mode and data["limit"] == 10
    assert {"items", "total", "offset", "limit", "has_more", "stats"} <= data.keys()
    assert f"{mode}.quota.summary" in data["panel_capabilities"]
    adapter.get_credential.assert_not_awaited()
    manager.get_or_fetch_user_email.assert_not_awaited()


@pytest.mark.parametrize("mode", ["geminicli", "antigravity"])
async def test_invalid_page_limit_is_still_rejected(monkeypatch, mode):
    adapter, _ = install(monkeypatch)
    with pytest.raises(HTTPException) as exc:
        await creds.get_creds_status_common(0, 9, "all", mode)
    assert exc.value.status_code == 400
    adapter._backend.get_credentials_summary.assert_not_awaited()


@pytest.mark.parametrize("engine", ["sqlite", "postgresql", "mongodb", "mysql"])
async def test_geminicli_search_matches_saved_email_and_filename_before_paging(monkeypatch, engine):
    rows = [row(f"match-{i:02}.json", f"user{i}@example.invalid") for i in range(13)]
    rows += [row("email-only.json", "MATCH@example.invalid"), row("other.json")]
    adapter, manager = install(monkeypatch, engine=engine, rows=rows)
    data = payload(await creds.get_creds_status_common(10, 10, "all", "geminicli", search="  MaTcH  "))
    assert [r["filename"] for r in data["items"]] == ["match-10.json", "match-11.json", "match-12.json", "email-only.json"]
    assert data["total"] == 14 and not data["has_more"] and data["stats"]["total"] == 41
    assert GEMINICLI_SEARCH in data["panel_capabilities"]
    request = adapter._backend.get_credentials_summary.await_args.kwargs
    assert request["offset"] == 0 and request["limit"] is None and request["mode"] == "geminicli"
    assert request["include_error_classifications"] is True
    adapter.get_credential.assert_not_awaited()
    adapter.get_credential_state.assert_not_awaited()
    manager.get_or_fetch_user_email.assert_not_awaited()


@pytest.mark.parametrize("search,expected", [("123", ["prefix123.json", "saved.json"]),
    ("%_", ["literal%_.json"]), ("[abc]", []), ("", ["prefix123.json", "saved.json", "literal%_.json"])])
async def test_geminicli_search_is_literal_including_digits(monkeypatch, search, expected):
    install(monkeypatch, rows=[row("prefix123.json"), row("saved.json", "123@example.invalid"), row("literal%_.json")])
    data = payload(await creds.get_creds_status_common(0, 10, "all", "geminicli", search=search))
    assert [r["filename"] for r in data["items"]] == expected


async def test_search_missing_safe_reader_returns_501_and_withdraws_capability(monkeypatch):
    adapter, manager = install(monkeypatch, supports_search=False)
    response = await creds.get_creds_status_common(0, 10, "all", "geminicli", search="saved")
    assert response.status_code == 501
    assert json.loads(response.body)["capability"] == GEMINICLI_SEARCH
    adapter._backend.get_credentials_summary.assert_not_awaited()
    data = payload(await creds.get_creds_status_common(0, 10, "all", "geminicli"))
    assert GEMINICLI_SEARCH not in data["panel_capabilities"]
    manager.get_or_fetch_user_email.assert_not_awaited()


@pytest.mark.parametrize("engine,expected", [
    ("sqlite", {"geminicli.credentials.permanent_disabled", "geminicli.credentials.remark"}),
    ("postgresql", {"geminicli.credentials.permanent_disabled", "geminicli.credentials.remark"}),
    ("mongodb", {"geminicli.credentials.remark"}), ("mysql", set()), ("unknown", set()),
])
async def test_geminicli_capabilities_follow_persisted_semantics(monkeypatch, engine, expected):
    install(monkeypatch, engine=engine)
    data = payload(await creds.get_creds_status_common(0, 10, "all", "geminicli"))
    actual = set(data["panel_capabilities"])
    assert set(credential_capabilities(engine, "geminicli")) == expected
    assert actual & {"geminicli.credentials.permanent_disabled", "geminicli.credentials.remark"} == expected
    assert not any(c.startswith("antigravity.") for c in actual)
    assert "geminicli.credentials.credit_mode" not in actual


async def test_geminicli_safe_status_fields_preserve_unknown_and_stored_diagnostics(monkeypatch):
    diagnostics = dict(health_status="quarantined", quarantine_reason="manual_review", probe_stage=2,
        next_probe_at=1234, last_health_check_at=1200, health_check_started_at=None, health_state_version=3,
        permanent_disabled=True, tier="standard", tier_raw_id="standard-tier", tier_raw_name="Standard", tier_detected_at=1100)
    install(monkeypatch, rows=[row("stored.json", **diagnostics), row("unknown.json", credential_data={"private": "synthetic"})])
    data = payload(await creds.get_creds_status_common(0, 10, "all", "geminicli"))
    stored, unknown = data["items"]
    for key, value in diagnostics.items():
        assert stored[key] == value
    assert all(unknown[field] is None for field in (*HEALTH_FIELDS, "permanent_disabled"))
    assert "credential_data" not in unknown and "private" not in json.dumps(data)


@pytest.mark.parametrize("engine,action,capability", [
    ("mongodb", "permanent_disable", "geminicli.credentials.permanent_disabled"),
    ("mysql", "permanent_disable", "geminicli.credentials.permanent_disabled"),
])
async def test_geminicli_unsupported_permanent_action_and_filter_do_not_mutate(monkeypatch, engine, action, capability):
    adapter, manager = install(monkeypatch, engine=engine)
    app = FastAPI(); app.include_router(creds.router)
    app.dependency_overrides[creds.verify_panel_token] = lambda: "synthetic"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://synthetic.test") as client:
        response = await client.post("/creds/action?mode=geminicli", json={"filename": "synthetic.json", "action": action})
    assert response.status_code == 501 and response.json()["capability"] == capability
    filtered = await creds.get_creds_status_common(0, 10, "permanent_disabled", "geminicli")
    assert filtered.status_code == 501
    adapter._backend.get_credentials_summary.assert_not_awaited()
    adapter.get_credential.assert_not_awaited()
    manager.update_credential_state.assert_not_awaited()


@pytest.mark.parametrize("engine", ["mysql"])
async def test_geminicli_unsupported_remark_has_no_payload_read_or_mutation(monkeypatch, engine):
    adapter, _ = install(monkeypatch, engine=engine)
    response = await creds.update_cred_remark("synthetic.json", {"remark": "blue"}, "synthetic", "geminicli")
    assert response.status_code == 501 and json.loads(response.body)["capability"] == "geminicli.credentials.remark"
    filtered = await creds.get_creds_status_common(0, 10, "all", "geminicli", remark_filter="blue")
    assert filtered.status_code == 501
    adapter.get_credential.assert_not_awaited()
    adapter.update_credential_state.assert_not_awaited()


@pytest.mark.parametrize("fast_path", ["1", "0"])
async def test_real_sqlite_safe_metadata_nulls_search_and_global_statistics(tmp_path, monkeypatch, fast_path):
    monkeypatch.setenv("CREDENTIALS_DIR", str(tmp_path))
    monkeypatch.setenv("CREDENTIAL_SUMMARY_BOUNDED_FAST_PATH", fast_path)
    store = SQLiteManager(); await store.initialize()
    try:
        for name in ("saved.json", "filename-match.json", "unrelated.json"):
            assert await store.store_credential(name, {"kind": "synthetic"}, mode="geminicli")
        assert await store.update_credential_state("saved.json", {"user_email": "MATCH@example.invalid", "remark": "blue", "permanent_disabled": True, "disabled": True}, "geminicli")
        db = sqlite3.connect(store._db_path)
        db.execute("UPDATE credentials SET health_status=NULL, probe_stage=NULL, health_state_version=NULL WHERE filename=?", ("saved.json",))
        db.commit(); db.close()
        queries = []
        execute = aiosqlite.Connection.execute
        def tracked(self, sql, parameters=None):
            queries.append(sql)
            return execute(self, sql, parameters)
        monkeypatch.setattr(aiosqlite.Connection, "execute", tracked)
        adapter = SimpleNamespace(_backend=store, get_backend_info=AsyncMock(return_value={"backend_type": "sqlite"}),
            get_credential=AsyncMock(side_effect=AssertionError("payload lookup forbidden")))
        monkeypatch.setattr(creds, "get_storage_adapter", AsyncMock(return_value=adapter))
        summary = payload(await creds.get_creds_status_common(0, 10, "all", "geminicli"))
        saved = next(item for item in summary["items"] if item["filename"] == "saved.json")
        assert saved["health_status"] is None and saved["probe_stage"] is None and saved["health_state_version"] is None
        searched = payload(await creds.get_creds_status_common(0, 10, "all", "geminicli", search="match"))
        assert searched["total"] == 2 and searched["stats"]["total"] == 3
        assert searched["stats"]["permanent_disabled"] == 1
        filtered = payload(await creds.get_creds_status_common(0, 10, "permanent_disabled", "geminicli", search="match", remark_filter="blue"))
        assert filtered["total"] == 1 and filtered["items"][0]["permanent_disabled"] is True
        assert all("credential_data" not in query.lower() for query in queries)
        adapter.get_credential.assert_not_awaited()
    finally:
        await store.close()


@pytest.mark.parametrize("query", ["x" * 256, 1])
async def test_geminicli_invalid_search_is_rejected_before_storage(monkeypatch, query):
    adapter, _ = install(monkeypatch)
    with pytest.raises(HTTPException) as exc:
        await creds.get_creds_status_common(0, 10, "all", "geminicli", search=query)
    assert exc.value.status_code == 400
    adapter._backend.get_credentials_summary.assert_not_awaited()


async def test_postgresql_summary_preserves_unknown_health_without_payload_projection():
    from src.storage.psql_manager import PSQLManager
    from test_error_classification_backends import _PSQLConnection, _PSQLPool, _antigravity_summary_dict
    class Connection(_PSQLConnection):
        async def fetch(self, query, *params):
            if "ORDER BY" in query:
                self.calls.append((query, params))
                return [{**_antigravity_summary_dict(), "tier": "unknown", "preview": True,
                    "tier_raw_id": None, "tier_raw_name": None, "tier_detected_at": None,
                    **{field: None for field in HEALTH_FIELDS}}]
            return await super().fetch(query, *params)
    connection = Connection(); store = PSQLManager()
    store._initialized = True; store._pool = _PSQLPool(connection)
    result = await store.get_credentials_summary(mode="geminicli")
    assert result["total"] == 1
    assert all(result["items"][0][field] is None for field in HEALTH_FIELDS)
    assert store.SUPPORTS_PANEL_CREDENTIAL_SEARCH is True
    assert all("credential_data" not in sql.lower() for sql, _ in connection.calls)


async def test_mysql_summary_preserves_unknown_health_without_payload_projection():
    from src.storage.mysql_manager import MySQLManager
    from test_error_classification_backends import _MySQLCursor, _MySQLConnection, _MySQLPool
    class Cursor(_MySQLCursor):
        async def fetchall(self):
            if "ORDER BY" in self.last_query:
                return [("synthetic.json", 1, "[]", None, None, 1, "{}", 1, "unknown",
                         None, None, None, None, None, None, None, None, None, None, "")]
            return await super().fetchall()
    cursor = Cursor(); store = MySQLManager()
    store._initialized = True; store._pool = _MySQLPool(_MySQLConnection(cursor))
    result = await store.get_credentials_summary(mode="geminicli")
    assert result["total"] == 1
    assert all(result["items"][0][field] is None for field in HEALTH_FIELDS)
    assert store.SUPPORTS_PANEL_CREDENTIAL_SEARCH is True
    assert all("credential_data" not in sql.lower() for sql, _ in cursor.calls)


async def test_mongodb_summary_preserves_missing_health_without_payload_projection():
    from src.storage.mongodb_manager import MongoDBManager
    from test_error_classification_backends import _MongoCollection
    collection = _MongoCollection(); store = MongoDBManager()
    store._initialized = True; store._db = {"credentials": collection}
    result = await store.get_credentials_summary(mode="geminicli")
    assert result["total"] == 1
    assert all(result["items"][0][field] is None for field in HEALTH_FIELDS)
    assert store.SUPPORTS_PANEL_CREDENTIAL_SEARCH is True
    assert all("credential_data" not in projection for _, projection in collection.find_calls)


async def test_unknown_geminicli_legacy_remark_and_credit_keep_original_request_semantics(monkeypatch):
    adapter, _ = install(monkeypatch, engine="unknown", supports_search=False)
    adapter.get_credential.side_effect = None
    adapter.get_credential.return_value = {"kind": "synthetic"}
    response = await creds.update_cred_remark("synthetic.json", {"remark": "blue"}, "synthetic", "geminicli")
    assert response.status_code == 200
    adapter.update_credential_state.assert_awaited_once_with("synthetic.json", {"remark": "blue"}, mode="geminicli")
    from src.panel.credential_capabilities import CREDIT_MODE, unavailable_capability
    for engine in ("unknown", "sqlite", "mongodb", "mysql"):
        adapter.get_backend_info.return_value = {"backend_type": engine}
        assert await unavailable_capability(adapter, "geminicli", CREDIT_MODE) is None


@pytest.mark.parametrize("engine", ["mysql", "mongodb"])
async def test_geminicli_known_unsupported_permanent_batch_reports_each_failure_without_mutation(monkeypatch, engine):
    adapter, manager = install(monkeypatch, engine=engine)
    app = FastAPI(); app.include_router(creds.router)
    app.dependency_overrides[creds.verify_panel_token] = lambda: "synthetic"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://synthetic.test") as client:
        response = await client.post("/creds/batch-action?mode=geminicli",
            json={"filenames": ["one.json", "two.json"], "action": "permanent_disable"})
    assert response.status_code == 200
    data = response.json()
    assert data["success_count"] == 0 and data["total_count"] == 2
    assert len(data["errors"]) == 2
    assert all("geminicli.credentials.permanent_disabled" in error for error in data["errors"])
    adapter.get_credential.assert_not_awaited()
    manager.update_credential_state.assert_not_awaited()
