"""Boundary tests use synthetic quota replies and temporary SQLite only."""
import json
import sqlite3
import time
from types import SimpleNamespace

import pytest

from scripts.migrate_antigravity_quota_sqlite import migrate
from src.diagnostics.antigravity import evidence, safe_error
from src.panel import creds as panel
from src.management.active_operations import PanelActiveOperations
from src.management.service import ManagementService
from src.models import CredFileBatchTestRequest
from src.smart_429 import classify_upstream_429
from test_antigravity_quota_policy import store, NAME, GEMINI, CLAUDE, week


@pytest.mark.parametrize("details", [None, 42, {}, [{"reason": ["private-sentinel"]}], [{"metadata": {"quotaResetTimeStamp": "private-sentinel"}}]])
def test_malformed_429_evidence_stays_unknown_without_body(details):
    body = json.dumps({"error": {"message": "private-sentinel", "details": details}})
    assert classify_upstream_429(json.loads(body), "antigravity").kind.value == "indeterminate"
    result = safe_error(429, body)
    assert "private-sentinel" not in result
    assert json.loads(result)["httpStatus"] == 429


def test_429_evidence_precedence_and_http_date():
    body = json.dumps({"error": {"details": [{"reason": "MODEL_CAPACITY_EXHAUSTED"}, {"reason": "QUOTA_EXHAUSTED"}, {"retryDelay": "2.5s"}]}})
    result = evidence(429, body, {"retry-after": "Sun, 27 Sep 2026 10:00:00 GMT"})
    assert result["classification"] == "quota_exhausted"
    assert result["retryDelaySeconds"] == 2.5 and result["retryAfterTimestamp"] > 0


def test_sqlite_migration_is_explicit_idempotent_and_preserves_credentials(tmp_path):
    path = tmp_path / "legacy.db"
    original = '{"access_token":"synthetic-only"}'
    with sqlite3.connect(path) as conn:
        conn.execute("CREATE TABLE antigravity_credentials (filename TEXT PRIMARY KEY, credential_data TEXT)")
        conn.execute("INSERT INTO antigravity_credentials VALUES (?,?)", (NAME, original))
    before = path.read_bytes()
    assert len(migrate(path)["missing_columns"]) == 2
    assert path.read_bytes() == before
    migrate(path, apply=True)
    with sqlite3.connect(path) as conn:
        row = conn.execute("SELECT credential_data,quota_group_states,quota_credential_generation FROM antigravity_credentials").fetchone()
    assert row[:2] == (original, "{}") and len(row[2]) == 32
    assert migrate(path, apply=True)["missing_columns"] == []
    with sqlite3.connect(path) as conn:
        assert conn.execute("SELECT quota_credential_generation FROM antigravity_credentials").fetchone()[0] == row[2]
    with pytest.raises(FileNotFoundError):
        migrate(tmp_path / "absent.db", apply=True)


async def test_disabled_update_cannot_touch_recreated_credential(store):
    old = await store.quota_snapshot(NAME)
    await store.delete_credential(NAME, "antigravity")
    await store.store_credential(NAME, {"access_token": "replacement"}, "antigravity")
    assert not await store.quota_disable(NAME, old["quota_credential_generation"])
    assert await store.quota_admit(NAME, GEMINI)
    new = await store.quota_snapshot(NAME)
    assert await store.quota_disable(NAME, new["quota_credential_generation"], new["_quota_credential_version"])
    assert await store.quota_admit(NAME, GEMINI) is None


async def test_sync_longer_explicit_reset_extends_only_its_group(store):
    from datetime import datetime, timezone
    now = time.time()
    await store.set_model_cooldown(NAME, GEMINI, now+100, "antigravity")
    await store.set_model_cooldown(NAME, CLAUDE, now+200, "antigravity")
    result = await store.quota_sync(NAME, {GEMINI: {"remaining": 0, "resetTimeRaw": datetime.fromtimestamp(now+1000, timezone.utc).isoformat()}}, {}, await store.quota_snapshot(NAME))
    assert result["quota_groups"]["gemini-shared"]["cooldownUntil"] == pytest.approx(now+1000)
    assert result["quota_groups"]["claude-gpt-shared"]["cooldownUntil"] == now+200


@pytest.mark.parametrize("entry", ["single", "batch", "management"])
async def test_manual_sync_recovers_while_management_keeps_week_policy(store, monkeypatch, entry):
    import src.google_oauth_api as oauth
    adapter = SimpleNamespace(_backend=store, get_credential=store.get_credential, get_credential_state=store.get_credential_state)
    async def storage(): return adapter
    monkeypatch.setattr(panel, "get_storage_adapter", storage)
    class Credentials:
        @classmethod
        def from_dict(cls, data):
            obj = cls(); obj.data = data; return obj
        async def refresh_if_needed(self): return False
        def to_dict(self): return self.data
    monkeypatch.setattr(panel, "Credentials", Credentials)
    monkeypatch.setattr(oauth, "Credentials", Credentials)
    async def quota(_, *, origin="legacy"):
        models, observation = week()
        return {"success": True, "models": models, "observation": observation,
                **({"upstream_status": 200, "response_source": "google"} if origin == "manual" else {})}
    monkeypatch.setattr(panel, "fetch_quota_info", quota)
    if entry == "single":
        response = await panel.get_credential_quota(NAME, token="synthetic", mode="antigravity")
        assert response.status_code == 200
    elif entry == "batch":
        response = await panel.batch_refresh_cooldown(CredFileBatchTestRequest(filenames=[NAME]), mode="antigravity", _token="synthetic")
        assert json.loads(response.body)["success_count"] == 1
    else:
        result = await PanelActiveOperations._sync_cooldown(filename=NAME, mode="antigravity", storage=adapter)
        assert result["success"] and "model_cooldowns" in result
    assert bool(await store.quota_admit(NAME, GEMINI)) == (entry != "management")
    assert await store.quota_admit(NAME, CLAUDE)
    assert (await store.quota_snapshot(NAME))["model_cooldowns"] == {}


def test_capability_is_additive_and_backend_gated():
    service = ManagementService.__new__(ManagementService)
    stub = SimpleNamespace(**{name: lambda: None for name in ("quota_admit", "quota_sync", "quota_release", "quota_snapshot")})
    assert "antigravity.quota.protection" in service._read_capabilities(stub, "sqlite")
    assert "antigravity.quota.protection" not in service._read_capabilities(object(), "unknown")


async def test_attempt_settlement_is_idempotent_even_for_concurrent_closers(store):
    import asyncio
    admission = await store.quota_admit(NAME, GEMINI)
    outcomes = await asyncio.gather(*(store.quota_record_result(NAME, admission, GEMINI, True) for _ in range(3)))
    assert outcomes.count(True) == 1
    state = await store.get_credential_state(NAME, "antigravity")
    assert state["success_count"] == 1


async def test_unknown_model_keeps_independent_group_and_manual_release(store):
    models, observation = week()
    unknown = "future-provider-model"
    await store.quota_sync(NAME, {unknown: models[GEMINI]}, observation, await store.quota_snapshot(NAME))
    assert await store.quota_admit(NAME, unknown) is None
    assert await store.quota_admit(NAME, GEMINI)
    await store.quota_release(NAME, unknown)
    assert await store.quota_admit(NAME, unknown)


async def test_protected_panel_test_never_dispatches_when_group_blocked(store, monkeypatch):
    import src.httpx_client as client
    models, observation = week()
    await store.quota_sync(NAME, models, observation, await store.quota_snapshot(NAME))
    adapter = SimpleNamespace(_backend=store, get_credential=store.get_credential)
    async def storage(): return adapter
    class Credentials:
        @classmethod
        def from_dict(cls, data): return cls()
        async def refresh_if_needed(self): return False
    async def forbidden(**kwargs): raise AssertionError("blocked group dispatched")
    monkeypatch.setattr(panel, "get_storage_adapter", storage)
    monkeypatch.setattr(panel, "Credentials", Credentials)
    monkeypatch.setattr(client, "post_async", forbidden)
    response = await panel.test_credential_common(NAME, mode="antigravity", model=GEMINI)
    assert response.status_code == 503


async def test_panel_release_keeps_auth_and_timed_cooldown(store, monkeypatch):
    import httpx
    from fastapi import FastAPI, HTTPException
    models, observation = week()
    await store.quota_sync(NAME, models, observation, await store.quota_snapshot(NAME))
    await store.set_model_cooldown(NAME, GEMINI, time.time()+100, "antigravity")
    adapter = SimpleNamespace(_backend=store, get_credential=store.get_credential)
    async def storage(): return adapter
    monkeypatch.setattr(panel, "get_storage_adapter", storage)
    async def deny(): raise HTTPException(401)
    async def allow(): return "synthetic"
    app = FastAPI(); app.include_router(panel.router)
    app.dependency_overrides[panel.verify_panel_token] = deny
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://example.invalid") as client:
        body = {"filename": NAME, "action": "release_quota_group", "group": "gemini-shared"}
        assert (await client.post("/creds/action?mode=antigravity", json=body)).status_code == 401
        assert (await store.quota_snapshot(NAME))["quota_group_states"]["gemini-shared"]["state"] == "blocked_unknown"
        app.dependency_overrides[panel.verify_panel_token] = allow
        response = await client.post("/creds/action?mode=antigravity", json=body)
        assert response.status_code == 200
        assert response.json()["quota_group_states"]["gemini-shared"]["state"] == "manual_override"
        assert await store.quota_admit(NAME, GEMINI) is None


@pytest.mark.parametrize("raw", ["prose 168h", "-1s", "1s invalid", "NaN", "Infinity", "", None])
def test_illegal_duration_does_not_create_quota_evidence(raw):
    result = evidence(429, json.dumps({"error": {"details": [{"metadata": {"quotaResetDelay": raw}, "retryDelay": raw}]}}))
    assert result["classification"] == "indeterminate"
    assert "quotaResetDelaySeconds" not in result and "retryDelaySeconds" not in result
