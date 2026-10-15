"""Panel capabilities and truthful mutations using synthetic, isolated adapters."""
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from src.panel import creds
from src.panel.credential_capabilities import CREDIT_MODE, PERMANENT_DISABLED, REMARK


@pytest.fixture
async def panel(monkeypatch):
    summary = {"items": [{"filename": "synthetic.json", "user_email": None,
        "disabled": True, "permanent_disabled": True, "error_codes": [], "last_success": None, "quota_groups": {}, "quota_state_invalid": False}],
        "total": 1, "stats": {"total": 41, "permanent_disabled": 7},
        "model_access_summary": {"total": 1}, "quota_group_filter_supported": True}
    backend = SimpleNamespace(get_antigravity_panel_summary=AsyncMock(return_value=summary),
        get_credentials_summary=AsyncMock(return_value=summary), SUPPORTS_QUOTA_GROUP_FILTER=True,
        model_access_storage_ready=True, model_access_list_family_public=AsyncMock(return_value={}))
    adapter = SimpleNamespace(_backend=backend,
        get_backend_info=AsyncMock(return_value={"backend_type": "sqlite"}),
        get_credential=AsyncMock(return_value={"kind": "synthetic"}),
        update_credential_state=AsyncMock(return_value=True))
    manager = SimpleNamespace(set_cred_disabled=AsyncMock(return_value=True),
        update_credential_state=AsyncMock(return_value=True), remove_credential=AsyncMock(return_value=True))
    clear = AsyncMock()
    monkeypatch.setattr(creds, "get_storage_adapter", AsyncMock(return_value=adapter))
    monkeypatch.setattr(creds, "credential_manager", manager)
    monkeypatch.setattr(creds, "clear_all_model_cooldowns_for_credential", clear)
    app = FastAPI()
    app.include_router(creds.router)
    app.dependency_overrides[creds.verify_panel_token] = lambda: "synthetic"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://synthetic.test") as client:
        yield SimpleNamespace(client=client, adapter=adapter, manager=manager, clear=clear)


def backend(panel, name):
    panel.adapter.get_backend_info.return_value = {"backend_type": name}


def no_mutations(panel):
    panel.adapter.update_credential_state.assert_not_awaited()
    panel.manager.update_credential_state.assert_not_awaited()
    panel.manager.set_cred_disabled.assert_not_awaited()
    panel.manager.remove_credential.assert_not_awaited()
    panel.clear.assert_not_awaited()


@pytest.mark.parametrize("engine,expected", [
    ("sqlite", {PERMANENT_DISABLED, REMARK, CREDIT_MODE}),
    ("postgresql", {PERMANENT_DISABLED, REMARK, CREDIT_MODE}),
    ("mongodb", {REMARK, CREDIT_MODE}), ("mysql", set()), ("unknown", set()),
])
async def test_list_matrix_projection_and_global_statistics(panel, engine, expected):
    backend(panel, engine)
    panel.adapter.get_credential.side_effect = AssertionError("list must not read full credentials")
    response = await panel.client.get("/creds/status", params={"mode": "antigravity", "limit": 25})
    assert response.status_code == 200
    data = response.json()
    assert set(data["panel_capabilities"]) & {PERMANENT_DISABLED, REMARK, CREDIT_MODE} == expected
    assert {"antigravity.credentials.search", "antigravity.cooldown.group_filter",
            "antigravity.model_access.family_filter"} <= set(data["panel_capabilities"])
    assert data["items"][0]["permanent_disabled"] is True
    assert data["stats"] == {"total": 41, "permanent_disabled": 7}
    assert data["total"] == 1
    panel.adapter.get_credential.assert_not_awaited()
    no_mutations(panel)


@pytest.mark.parametrize("engine,action,capability", [
    (engine, action, cap) for engine, actions in [
        ("mysql", [("permanent_disable", PERMANENT_DISABLED), ("enable_credit", CREDIT_MODE), ("disable_credit", CREDIT_MODE)]),
        ("unknown", [("permanent_disable", PERMANENT_DISABLED), ("enable_credit", CREDIT_MODE), ("disable_credit", CREDIT_MODE)]),
        ("mongodb", [("permanent_disable", PERMANENT_DISABLED)])]
    for action, cap in actions])
async def test_unsupported_single_and_batch_have_zero_side_effects(panel, engine, action, capability):
    backend(panel, engine)
    single = await panel.client.post("/creds/action?mode=antigravity", json={"filename": "synthetic.json", "action": action})
    assert single.status_code == 501
    assert single.json() == {"detail": "当前存储后端不支持该凭证能力",
                             "error_code": "capability_unavailable", "capability": capability}
    batch = await panel.client.post("/creds/batch-action?mode=antigravity",
        json={"filenames": ["synthetic.json", "other.json"], "action": action})
    assert batch.status_code == 200
    data = batch.json()
    assert set(data) == {"success_count", "total_count", "errors", "message"}
    assert data["success_count"] == 0 and data["total_count"] == 2
    assert len(data["errors"]) == 2 and all(capability in e for e in data["errors"])
    no_mutations(panel)


@pytest.mark.parametrize("engine", ["mysql", "unknown"])
async def test_unsupported_remark_write_and_filter(panel, engine):
    backend(panel, engine)
    response = await panel.client.post("/creds/remark/synthetic.json?mode=antigravity", json={"remark": "blue"})
    assert response.status_code == 501 and response.json()["capability"] == REMARK
    for remark in ("blue", ""):
        response = await panel.client.get("/creds/status", params={"mode": "antigravity", "remark_filter": remark})
        assert response.status_code == 501 and response.json()["capability"] == REMARK
    panel.adapter._backend.get_antigravity_panel_summary.assert_not_awaited()
    no_mutations(panel)
    response = await panel.client.get("/creds/status", params={"mode": "antigravity", "remark_filter": "__all__"})
    assert response.status_code == 200


@pytest.mark.parametrize("engine", ["mysql", "mongodb", "unknown"])
async def test_unsupported_permanent_filter_does_not_query(panel, engine):
    backend(panel, engine)
    response = await panel.client.get("/creds/status", params={"mode": "antigravity", "status_filter": "permanent_disabled"})
    assert response.status_code == 501 and response.json()["capability"] == PERMANENT_DISABLED
    panel.adapter._backend.get_antigravity_panel_summary.assert_not_awaited()
    no_mutations(panel)


@pytest.mark.parametrize("engine", ["sqlite", "postgresql", "mongodb"])
async def test_supported_remark_write_and_filter(panel, engine):
    backend(panel, engine)
    response = await panel.client.post("/creds/remark/synthetic.json?mode=antigravity", json={"remark": "blue"})
    assert response.status_code == 200 and response.json()["remark"] == "blue"
    panel.adapter.update_credential_state.assert_awaited_once_with("synthetic.json", {"remark": "blue"}, mode="antigravity")
    response = await panel.client.get("/creds/status", params={"mode": "antigravity", "remark_filter": "blue"})
    assert response.status_code == 200
    assert panel.adapter._backend.get_antigravity_panel_summary.await_args.kwargs["remark_filter"] == "blue"


@pytest.mark.parametrize("engine", ["sqlite", "postgresql", "mongodb"])
@pytest.mark.parametrize("action", ["enable_credit", "disable_credit"])
@pytest.mark.parametrize("outcome", [True, False, "exception"])
async def test_credit_side_effect_only_after_success(panel, engine, action, outcome):
    backend(panel, engine)
    update = panel.adapter.update_credential_state
    update.side_effect = RuntimeError("synthetic failure") if outcome == "exception" else None
    update.return_value = outcome
    response = await panel.client.post("/creds/action?mode=antigravity", json={"filename": "synthetic.json", "action": action})
    assert response.status_code == (200 if outcome is True else 500)
    assert panel.clear.await_count == (1 if outcome is True else 0)


@pytest.mark.parametrize("action", ["enable", "disable", "permanent_disable", "enable_credit", "disable_credit", "delete"])
@pytest.mark.parametrize("outcomes", [[True], [False], [RuntimeError("synthetic failure")], [True, False, RuntimeError("synthetic failure"), True]])
async def test_batch_true_false_exception_and_partial_response_shape(panel, action, outcomes):
    update = (panel.manager.set_cred_disabled if action in ("enable", "disable") else
              panel.manager.update_credential_state if action == "permanent_disable" else
              panel.manager.remove_credential if action == "delete" else panel.adapter.update_credential_state)
    update.side_effect = outcomes
    names = [f"synthetic-{i}.json" for i in range(len(outcomes))]
    response = await panel.client.post("/creds/batch-action?mode=antigravity", json={"filenames": names, "action": action})
    assert response.status_code == 200
    data = response.json()
    successes = sum(result is True for result in outcomes)
    assert set(data) == {"success_count", "total_count", "errors", "message"}
    assert data["success_count"] == successes and data["total_count"] == len(names)
    assert len(data["errors"]) == len(names) - successes
    assert update.await_count == len(names)
    assert panel.clear.await_count == (successes if "credit" in action else 0)


async def test_unknown_geminicli_legacy_requests_remain_compatible_with_additive_capabilities(panel):
    backend(panel, "unknown")
    response = await panel.client.get("/creds/status", params={"mode": "geminicli", "status_filter": "permanent_disabled", "remark_filter": "blue"})
    assert response.status_code == 200
    data = response.json()
    assert {"items", "total", "offset", "limit", "has_more", "stats"} <= data.keys()
    assert data["mode"] == "geminicli"
    assert data["items"][0]["filename"] == "synthetic.json"
    assert data["items"][0]["disabled"] is True
    assert data["items"][0]["permanent_disabled"] is True
    assert "geminicli.quota.summary" in data["panel_capabilities"]
    assert "geminicli.credentials.permanent_disabled" not in data["panel_capabilities"]
    assert "geminicli.credentials.remark" not in data["panel_capabilities"]
    response = await panel.client.post("/creds/action", json={"filename": "synthetic.json", "action": "permanent_disable"})
    assert response.status_code == 200
    panel.manager.update_credential_state.assert_awaited_once_with(
        "synthetic.json", {"disabled": True, "permanent_disabled": True}, mode="geminicli")


@pytest.mark.parametrize("engine", ["sqlite", "postgresql"])
async def test_supported_permanent_filter_preserves_independent_status_and_global_stats(tmp_path, monkeypatch, engine):
    if engine == "sqlite":
        from src.storage.sqlite_manager import SQLiteManager
        monkeypatch.setenv("CREDENTIALS_DIR", str(tmp_path))
        store = SQLiteManager()
        await store.initialize()
        for name, state in [("normal.json", {}), ("disabled.json", {"disabled": True}),
                            ("permanent.json", {"disabled": True, "permanent_disabled": True})]:
            await store.store_credential(name, {"kind": "synthetic"}, "antigravity")
            assert await store.update_credential_state(name, state, "antigravity")
    else:
        from src.storage.psql_manager import PSQLManager
        from test_antigravity_panel_index_backends import SQL
        store = PSQLManager.__new__(PSQLManager)
        store._initialized = True
        store.model_access_storage_ready = True
        store._pool = SQL()
        store._pool.rows = store._pool.rows[:3]
        store._pool.rows[1]["disabled"] = True
        store._pool.rows[2].update(disabled=True, permanent_disabled=True)
    adapter = SimpleNamespace(_backend=store, get_backend_info=AsyncMock(return_value={"backend_type": engine}))
    monkeypatch.setattr(creds, "get_storage_adapter", AsyncMock(return_value=adapter))
    try:
        for status in ("enabled", "disabled", "permanent_disabled"):
            response = await creds.get_creds_status_common(0, 25, status, "antigravity")
            assert response.status_code == 200
            data = json.loads(response.body)
            assert data["total"] == 1 and len(data["items"]) == 1
            assert data["items"][0]["permanent_disabled"] == (status == "permanent_disabled")
            assert data["stats"]["total"] == 3 and data["stats"]["permanent_disabled"] == 1
            assert PERMANENT_DISABLED in data["panel_capabilities"]
    finally:
        if engine == "sqlite":
            await store.close()


@pytest.mark.parametrize("engine", ["sqlite", "postgresql"])
@pytest.mark.parametrize("outcome", [True, False, "exception"])
async def test_supported_permanent_single_write_result(panel, engine, outcome):
    backend(panel, engine)
    update = panel.manager.update_credential_state
    update.side_effect = RuntimeError("synthetic failure") if outcome == "exception" else None
    update.return_value = outcome
    response = await panel.client.post("/creds/action?mode=antigravity", json={"filename": "synthetic.json", "action": "permanent_disable"})
    assert response.status_code == (200 if outcome is True else 500)
    update.assert_awaited_once_with("synthetic.json", {"disabled": True, "permanent_disabled": True}, mode="antigravity")
    panel.clear.assert_not_awaited()


@pytest.mark.parametrize("outcome", [False, "exception"])
async def test_remark_write_failure_is_not_success(panel, outcome):
    update = panel.adapter.update_credential_state
    update.side_effect = RuntimeError("synthetic failure") if outcome == "exception" else None
    update.return_value = outcome
    response = await panel.client.post("/creds/remark/synthetic.json?mode=antigravity", json={"remark": "blue"})
    assert response.status_code == 500
    panel.clear.assert_not_awaited()


async def test_backend_change_withdraws_capabilities_and_rechecks_writes(panel):
    first = await panel.client.get("/creds/status?mode=antigravity")
    assert CREDIT_MODE in first.json()["panel_capabilities"]
    backend(panel, "mysql")
    second = await panel.client.get("/creds/status?mode=antigravity")
    assert not {PERMANENT_DISABLED, REMARK, CREDIT_MODE} & set(second.json()["panel_capabilities"])
    response = await panel.client.post("/creds/action?mode=antigravity", json={"filename": "synthetic.json", "action": "enable_credit"})
    assert response.status_code == 501 and response.json()["capability"] == CREDIT_MODE
    no_mutations(panel)
