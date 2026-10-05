"""Caller integration with temporary SQLite and mocked upstream only."""
from types import SimpleNamespace
from unittest.mock import AsyncMock
import json
import pytest
from fastapi import FastAPI
import httpx
from src.api import antigravity as api
from src import auth
from src.panel import creds
from src.antigravity_access_runtime import ModelAccessService
from src.antigravity_model_access import check_due, MODELS
from test_antigravity_model_access import access_store, NAME


def catalog_manager(monkeypatch, store, candidates):
    manager = SimpleNamespace(_storage_adapter=SimpleNamespace(_backend=store),
        get_valid_credential=AsyncMock(side_effect=candidates))
    monkeypatch.setattr(api, "credential_manager", SimpleNamespace(_get_or_create=AsyncMock(return_value=manager)))
    return manager

async def selected(store):
    snap = await store.model_access_snapshot(NAME)
    data = await store.quota_current_credential(NAME, snap["generation"])
    return NAME, {**data, "_quota_generation": snap["generation"], "_quota_credential_version": snap["version"], "enable_credit": True}

@pytest.mark.parametrize("outcome", ["success", "removal", "failure", "save_failure"])
async def test_catalog_observes_persisted_fence_not_runtime_metadata(access_store, monkeypatch, outcome):
    store = access_store
    snap = await store.model_access_snapshot(NAME)
    await store.model_access_observe(NAME, snap, [MODELS[0]])
    candidate = await selected(store)
    catalog_manager(monkeypatch, store, [candidate])
    models = ["claude-sonnet-4-6"] + ([MODELS[1]] if outcome == "success" else [])
    fetch = AsyncMock(return_value={"success": outcome != "failure", "models": models})
    monkeypatch.setattr(api, "fetch_quota_info", fetch)
    if outcome == "save_failure":
        monkeypatch.setattr(store, "model_access_observe", AsyncMock(side_effect=RuntimeError("synthetic")))
    result = {item["id"] for item in await api.fetch_available_models()}
    fetch.assert_awaited_once_with("synthetic")
    if outcome != "failure":
        assert "claude-sonnet-4-6" in result
    if outcome in ("success", "removal"):
        assert MODELS[0] not in result
        assert (MODELS[1] in result) == (outcome == "success")
    else:
        assert MODELS[0] in result

@pytest.mark.parametrize("fresh", [True, False])
async def test_catalog_reselects_once_never_pairs_stale_token_with_new_snapshot(access_store, monkeypatch, fresh):
    store = access_store
    old = await selected(store)
    await store.import_antigravity_credential(NAME, {"access_token": "replacement"})
    new = await selected(store)
    manager = catalog_manager(monkeypatch, store, [old, new if fresh else old])
    fetch = AsyncMock(return_value={"success": True, "models": ["claude-sonnet-4-6"]})
    monkeypatch.setattr(api, "fetch_quota_info", fetch)
    await api.fetch_available_models()
    assert manager.get_valid_credential.await_count == 2
    if fresh:
        fetch.assert_awaited_once_with("replacement")
    else:
        fetch.assert_not_awaited()

async def test_catalog_not_ready_preserves_non_opus_without_access_io(monkeypatch):
    forbidden = AsyncMock(side_effect=AssertionError("access store unavailable"))
    store = SimpleNamespace(model_access_storage_ready=False, model_access_snapshot=forbidden,
        model_access_observe=forbidden, model_access_union=forbidden)
    catalog_manager(monkeypatch, store, [(NAME, {"access_token": "synthetic"})])
    monkeypatch.setattr(api, "fetch_quota_info", AsyncMock(return_value={"success": True,
        "models": ["claude-sonnet-4-6", MODELS[0]]}))
    assert {m["id"] for m in await api.fetch_available_models()} == {"claude-sonnet-4-6"}
    forbidden.assert_not_awaited()

@pytest.mark.parametrize("replacement", [False, True])
async def test_refresh_none_observes_original_claim_with_retry_and_cas(access_store, monkeypatch, replacement):
    store = access_store
    now = [1000000]
    monkeypatch.setattr("src.storage.antigravity_model_access.time.time", lambda: now[0])
    async def refresh(*args, **kwargs):
        if replacement:
            await store.import_antigravity_credential(NAME, {"access_token": "replacement"})
        return None
    manager = SimpleNamespace(_storage_adapter=SimpleNamespace(_backend=store),
        _should_refresh_token=AsyncMock(return_value=True), _refresh_token=refresh)
    upstream = AsyncMock(side_effect=AssertionError("no upstream after failed refresh"))
    monkeypatch.setattr(api, "fetch_quota_info", upstream)
    assert await ModelAccessService().check(manager, NAME) is False
    snap = await store.model_access_snapshot(NAME)
    if replacement:
        assert check_due(snap["access"], now=now[0])
    else:
        assert not check_due(snap["access"], now=now[0]+120)
        assert not check_due(snap["access"], now=now[0]+899)
        assert check_due(snap["access"], now=now[0]+900)
    upstream.assert_not_awaited()

async def test_oauth_same_second_replace_preserves_disabled_and_tier(access_store, monkeypatch):
    store = access_store
    adapter = SimpleNamespace(import_antigravity_credential=store.import_antigravity_credential,
        update_credential_state=AsyncMock(side_effect=AssertionError("no post-write state")))
    monkeypatch.setattr(auth, "get_storage_adapter", AsyncMock(return_value=adapter))
    monkeypatch.setattr(auth, "_prepare_credentials_data", lambda *a: {"access_token": "synthetic"})
    monkeypatch.setattr(auth.time, "time", lambda: 1000000)
    name = await auth.save_credentials(None, "synthetic", "antigravity", "pro")
    state = await store.get_credential_state(name, "antigravity")
    assert state["tier"] == "pro" and not state["disabled"]
    await store.update_credential_state(name, {"disabled": True, "tier": "ultra"}, "antigravity")
    assert await auth.save_credentials(None, "synthetic", "antigravity", "free") == name
    state = await store.get_credential_state(name, "antigravity")
    assert state["tier"] == "ultra" and state["disabled"]
    adapter.update_credential_state.assert_not_awaited()

@pytest.mark.parametrize("branch,cap,detail", [
    ("family", "antigravity.model_access.family_filter", "当前存储后端不支持 Opus 版本权限筛选"),
    ("static", "antigravity.cooldown.group_filter", "当前存储后端不支持共享额度筛选"),
    ("runtime", "antigravity.cooldown.group_filter", "当前存储后端未能提供共享额度状态")])
async def test_501_actual_http_body_keeps_detail_and_exact_capability(monkeypatch, branch, cap, detail):
    backend = SimpleNamespace(SUPPORTS_QUOTA_GROUP_FILTER=branch == "runtime",
        get_credentials_summary=AsyncMock(return_value={"items": [], "total": 0}))
    adapter = SimpleNamespace(_backend=backend, get_backend_info=AsyncMock(return_value={"backend_type": "synthetic"}))
    monkeypatch.setattr(creds, "get_storage_adapter", AsyncMock(return_value=adapter))
    app = FastAPI()
    @app.get("/test")
    async def route():
        kwargs = {"model_access_filter": "supported"} if branch == "family" else {"cooldown_filter": "any_restricted"}
        return await creds.get_creds_status_common(0, 25, "all", "antigravity", **kwargs)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/test")
    assert response.status_code == 501
    assert response.json() == {"detail": detail, "error_code": "capability_unavailable", "capability": cap}

@pytest.mark.parametrize("existing", [False, True])
async def test_refresh_token_custom_name_uses_atomic_insert_only_tier(access_store, monkeypatch, existing):
    from src.credential_manager import CredentialManager
    store = access_store
    name = "custom.json"
    if existing:
        await store.import_antigravity_credential(name, {"access_token": "old"}, initial_state={"disabled": True, "tier": "ultra"})
    manager = CredentialManager()
    manager._initialized = True
    adapter = SimpleNamespace(import_antigravity_credential=store.import_antigravity_credential,
        update_credential_state=AsyncMock(side_effect=AssertionError("no post-import tier write")))
    manager._storage_adapter = adapter
    monkeypatch.setattr(creds, "credential_manager", manager)
    monkeypatch.setattr(creds, "_exchange_refresh_token_to_credential", AsyncMock(return_value={"access_token": "synthetic", "refresh_token": "synthetic"}))
    monkeypatch.setattr(creds, "fetch_project_id_and_tier", AsyncMock(return_value=("project", "pro")))
    monkeypatch.setattr(creds, "get_antigravity_api_url", AsyncMock(return_value="https://example.test"))
    result = await creds._add_credential_by_refresh_token("synthetic", None, None, None, "custom", "antigravity")
    assert result["success"] and result["warnings"] == []
    state = await store.get_credential_state(name, "antigravity")
    assert state["tier"] == ("ultra" if existing else "pro")
    assert state["disabled"] == existing
    adapter.update_credential_state.assert_not_awaited()

async def test_catalog_missing_selector_identity_fails_closed(access_store, monkeypatch):
    manager = catalog_manager(monkeypatch, access_store, [(NAME, {"access_token": "synthetic"})]*2)
    fetch = AsyncMock(side_effect=AssertionError("unfenced request"))
    monkeypatch.setattr(api, "fetch_quota_info", fetch)
    assert await api.fetch_available_models() == []
    assert manager.get_valid_credential.await_count == 2
    fetch.assert_not_awaited()

async def test_disappearing_claim_credential_does_not_poison_replacement(access_store, monkeypatch):
    store = access_store
    async def current(*args):
        await store.import_antigravity_credential(NAME, {"access_token": "replacement"})
        return None
    monkeypatch.setattr(store, "quota_current_credential", current)
    manager = SimpleNamespace(_storage_adapter=SimpleNamespace(_backend=store))
    assert await ModelAccessService().check(manager, NAME) is False
    snap = await store.model_access_snapshot(NAME)
    assert check_due(snap["access"])
