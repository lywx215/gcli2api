"""P's authenticated API tests, with dependency status made explicit."""

import copy

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import config
from src.model_routing import settings_routes, store
from src.model_routing.types import ValidationIssue
from src.models import ConfigSaveRequest
from src.panel import config_routes
from src.utils import verify_panel_token
from test_model_routing_storage import MemoryAdapter, _table, typed_compiler_mock


@pytest.fixture(autouse=True)
def isolated_config(monkeypatch):
    monkeypatch.setattr(config, "_config_initialized", True)
    monkeypatch.setattr(config, "_config_cache", {})
    monkeypatch.setenv("PANEL_PASSWORD", "mock-panel-password")
    monkeypatch.delenv("NODE_MANAGEMENT_TOKEN", raising=False)


def api_client(*, authenticated=True):
    app = FastAPI()
    app.include_router(settings_routes.router)
    if authenticated:
        app.dependency_overrides[verify_panel_token] = lambda: "mock-panel-password"
    return TestClient(app)


@pytest.mark.parametrize("method", ["get", "put"])
def test_authentication_failure_never_reads_or_discloses_targets(monkeypatch, method):
    def forbidden():
        raise AssertionError("Unauthenticated request must not read configuration")

    monkeypatch.setattr(store, "_get_adapter", forbidden)
    client = api_client(authenticated=False)
    response = getattr(client, method)("/config/model-routing", **({"json": _table()} if method == "put" else {}))
    assert response.status_code in (401, 403)
    assert "mock-target" not in response.text
    response = getattr(client, method)("/config/model-routing", headers={"Authorization": "Bearer wrong-password"}, **({"json": _table()} if method == "put" else {}))
    assert response.status_code == 401
    assert "mock-target" not in response.text


def test_mock_get_missing_and_successful_put_contract(monkeypatch, typed_compiler_mock):
    adapter = MemoryAdapter()
    monkeypatch.setattr(store, "_get_adapter", lambda: adapter)
    client = api_client()
    response = client.get("/config/model-routing")
    assert response.status_code == 200
    assert response.json() == {
        "routes": [], "supported_channels": ["geminicli", "antigravity"],
        "capabilities": ["model.routing.aliases", "model.identity.public"],
        "policy_digest": "mock-policy-v1", "validation": {
            "geminicli": {"valid": True, "issues": []},
            "antigravity": {"valid": True, "issues": []},
        },
    }
    response = client.put("/config/model-routing", json=_table())
    assert response.status_code == 200 and response.json()["routes"] == _table()["routes"]
    assert adapter.writes == [_table()]


def test_mock_invalid_global_get_is_safe_but_put_can_repair(monkeypatch, typed_compiler_mock):
    adapter = MemoryAdapter("unsafe-invalid-configuration")
    monkeypatch.setattr(store, "_get_adapter", lambda: adapter)
    client = api_client()
    response = client.get("/config/model-routing")
    assert response.status_code == 503 and "unsafe" not in response.text
    response = client.put("/config/model-routing", json=_table())
    assert response.status_code == 200 and adapter.value == _table()


def test_mock_channel_invalid_get_is_repairable_with_row_diagnostic(monkeypatch, typed_compiler_mock):
    adapter = MemoryAdapter(_table(target="mock-invalid"))
    monkeypatch.setattr(store, "_get_adapter", lambda: adapter)
    response = api_client().get("/config/model-routing")
    assert response.status_code == 200
    validation = response.json()["validation"]
    assert validation["antigravity"]["valid"] is True
    assert validation["geminicli"]["valid"] is False
    assert validation["geminicli"]["issues"][0]["row"] == 0


def test_mock_failed_validation_never_partially_saves(monkeypatch, typed_compiler_mock):
    original = _table()
    adapter = MemoryAdapter(original)
    monkeypatch.setattr(store, "_get_adapter", lambda: adapter)
    candidate = {"routes": original["routes"] + _table("antigravity", "public-beta", "mock-invalid")["routes"]}
    response = api_client().put("/config/model-routing", json=candidate)
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "MODEL_ROUTING_VALIDATION_FAILED"
    assert response.json()["error"]["issues"][0]["row"] == 1
    assert adapter.value == original and adapter.writes == []


def test_invalid_json_is_400_and_backend_failure_is_safe_503(monkeypatch, typed_compiler_mock):
    adapter = MemoryAdapter()
    monkeypatch.setattr(store, "_get_adapter", lambda: adapter)
    client = api_client()
    response = client.put("/config/model-routing", content="{broken", headers={"Content-Type": "application/json"})
    assert response.status_code == 400
    assert response.json()["error"]["issues"][0]["reason"] == "INVALID_STRUCTURE"
    adapter.fail_read = True
    response = client.get("/config/model-routing")
    assert response.status_code == 503 and "unsafe" not in response.text
    adapter.fail_write = True
    response = client.put("/config/model-routing", json=_table())
    assert response.status_code == 503 and "unsafe" not in response.text


def test_diagnostic_message_never_echoes_proof_or_backend_text():
    issue = ValidationIssue("geminicli", 1, "upstream_name", "UNSTABLE_TARGET_DISPATCH", (0,), "unsafe-secret-target")
    response = settings_routes._invalid((issue,))
    assert b"unsafe-secret-target" not in response.body
    assert settings_routes.issue_json(issue)["related_rows"] == [0]


@pytest.mark.asyncio
@pytest.mark.parametrize("reserved", ["model_routing", "MODEL_ROUTING", "model_routing ", "módel_routing", "model_rout\u200bing"])
async def test_generic_save_rejects_entire_request_before_any_write(monkeypatch, reserved):
    def forbidden():
        raise AssertionError("Must reject before storage initialization")

    monkeypatch.setattr(config_routes, "get_storage_adapter", forbidden)
    with pytest.raises(HTTPException) as error:
        await config_routes.save_config(ConfigSaveRequest(config={reserved: _table(), "port": 3456}), token="mock-panel-password")
    assert error.value.status_code == 400


@pytest.mark.asyncio
async def test_generic_batch_rejects_database_collation_alias_before_first_write(monkeypatch):
    writes = []

    class GeneralStorage:
        def __init__(self):
            self._backend = self

        async def config_key_matches(self, key, reserved):
            return key == "database-equivalent-spelling" and reserved == "model_routing"

        async def set_config(self, key, value):
            writes.append((key, value))

    async def storage():
        return GeneralStorage()

    monkeypatch.setattr(config_routes, "get_storage_adapter", storage)
    with pytest.raises(HTTPException) as error:
        await config_routes.save_config(ConfigSaveRequest(config={"port": 3456, "database-equivalent-spelling": _table()}), token="mock-panel-password")
    assert error.value.status_code == 400 and writes == []


@pytest.mark.asyncio
async def test_generic_get_excludes_entire_routing_key(monkeypatch):
    class GeneralStorage:
        async def get_all_config(self):
            return {"model_routing": _table(), "MODEL_ROUTING": _table(), "módel_routing": _table(), "port": 8000}

    async def storage():
        return GeneralStorage()

    monkeypatch.setattr(config_routes, "get_storage_adapter", storage)
    response = await config_routes.get_config(token="mock-panel-password")
    assert b"model_routing" not in response.body and b"mock-target" not in response.body


@pytest.mark.asyncio
async def test_generic_other_save_preserves_existing_route_table(monkeypatch):
    values = {"model_routing": _table()}

    class GeneralStorage:
        async def set_config(self, key, value):
            values[key] = copy.deepcopy(value)
            return True

    async def storage():
        return GeneralStorage()

    async def reload_config():
        config._config_cache = copy.deepcopy(values)

    async def reconfigure():
        pass

    monkeypatch.setattr(config_routes, "get_storage_adapter", storage)
    monkeypatch.setattr(config, "reload_config", reload_config)
    monkeypatch.setattr("src.smart_429.smart_429_service.reconfigure", reconfigure)
    response = await config_routes.save_config(ConfigSaveRequest(config={"port": 3456}), token="mock-panel-password")
    assert response.status_code == 200 and values["model_routing"] == _table() and values["port"] == 3456


@pytest.mark.parametrize("candidate,reason", [
    ({"routes": [], "extra": True}, "UNKNOWN_FIELD"),
    ({"routes": [{"channel": "vertex", "public_name": "public-alpha", "upstream_name": "transparent-x", "enabled": True}]}, "UNSUPPORTED_CHANNEL"),
    ({"routes": [{"channel": "geminicli", "public_name": "public-alpha", "upstream_name": "transparent-x", "enabled": 1}]}, "INVALID_FIELD_TYPE"),
    ({"routes": [{"channel": "geminicli", "public_name": "public-alpha", "upstream_name": "transparent-x", "enabled": True, "extra": "bad"}]}, "UNKNOWN_FIELD"),
    ({"routes": [_table(target="transparent-x")["routes"][0]] * 2}, "DUPLICATE_PUBLIC_NAME"),
])
def test_real_compiler_api_strict_whole_table(monkeypatch, candidate, reason):
    """MR02 real compiler required; intentionally no mock/skip fallback."""
    adapter = MemoryAdapter({"routes": []})
    monkeypatch.setattr(store, "_get_adapter", lambda: adapter)
    store._compiled_cache.clear()
    response = api_client().put("/config/model-routing", json=candidate)
    assert response.status_code == 400, response.text
    assert reason in {issue["reason"] for issue in response.json()["error"]["issues"]}
    assert adapter.writes == []


def test_real_compiler_get_isolates_attributable_field_failure_and_repairs(monkeypatch):
    adapter = MemoryAdapter({"routes": [
        {"channel": "geminicli", "public_name": "public-alpha", "upstream_name": "transparent-x", "enabled": "true"},
        {"channel": "antigravity", "public_name": "public-beta", "upstream_name": "transparent-y", "enabled": True},
    ]})
    monkeypatch.setattr(store, "_get_adapter", lambda: adapter)
    store._compiled_cache.clear()
    client = api_client()
    result = client.get("/config/model-routing")
    assert result.status_code == 200, result.text
    assert result.json()["validation"]["geminicli"]["valid"] is False
    assert result.json()["validation"]["antigravity"]["valid"] is True
    assert result.json()["routes"][0]["enabled"] == "true"
    repaired = copy.deepcopy(adapter.value)
    repaired["routes"][0]["enabled"] = True
    result = client.put("/config/model-routing", json=repaired)
    assert result.status_code == 200, result.text
    assert all(status["valid"] for status in result.json()["validation"].values())


@pytest.mark.parametrize("stored", [None, "broken secret target", {"routes": [{"channel": "vertex", "public_name": "secret-target"}]}])
def test_real_compiler_global_get_does_not_echo_and_can_replace(monkeypatch, stored):
    adapter = MemoryAdapter(stored)
    monkeypatch.setattr(store, "_get_adapter", lambda: adapter)
    store._compiled_cache.clear()
    client = api_client()
    result = client.get("/config/model-routing")
    assert result.status_code == 503 and "secret" not in result.text, result.text
    result = client.put("/config/model-routing", json={"routes": []})
    assert result.status_code == 200, result.text
    assert adapter.value == {"routes": []}


def test_real_compiler_authenticated_api_roundtrip_with_real_sqlite(monkeypatch, tmp_path):
    import json
    import sqlite3
    from test_model_routing_storage import sqlite_config_only

    manager = sqlite_config_only(tmp_path / "api-compiler-sqlite.db")
    monkeypatch.setattr(store, "_get_adapter", lambda: manager)
    store._compiled_cache.clear()
    client = api_client()
    assert client.get("/config/model-routing").json()["routes"] == []
    table = _table(target="transparent-api-target")
    response = client.put("/config/model-routing", json=table)
    assert response.status_code == 200, response.text
    with sqlite3.connect(manager._db_path) as connection:
        stored = connection.execute("SELECT value FROM config WHERE key='model_routing'").fetchone()[0]
        assert json.loads(stored) == table
        connection.execute("UPDATE config SET value=? WHERE key='model_routing'", (json.dumps("secret-invalid-table"),))
    response = client.get("/config/model-routing")
    assert response.status_code == 503 and "secret" not in response.text
    response = client.put("/config/model-routing", json={"routes": []})
    assert response.status_code == 200, response.text
    assert client.get("/config/model-routing").json()["routes"] == []


def test_real_sqlite_committed_put_readback_failure_returns503_but_reload_confirms(monkeypatch, tmp_path):
    import json
    import sqlite3
    from test_model_routing_storage import sqlite_config_only

    manager = sqlite_config_only(tmp_path / "api-committed-readback-failure.db")
    monkeypatch.setattr(store, "_get_adapter", lambda: manager)
    store._compiled_cache.clear()
    client = api_client()
    fresh = manager.get_config_fresh

    async def unavailable(*args, **kwargs):
        raise RuntimeError("private-readback-error-sentinel")

    monkeypatch.setattr(manager, "get_config_fresh", unavailable)
    table = _table(target="transparent-committed-target")
    response = client.put("/config/model-routing", json=table)
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "MODEL_ROUTING_UNAVAILABLE"
    assert "private-readback-error-sentinel" not in response.text
    with sqlite3.connect(manager._db_path) as connection:
        stored = connection.execute("SELECT value FROM config WHERE key='model_routing'").fetchone()[0]
        assert json.loads(stored) == table  # The real write already committed.
    monkeypatch.setattr(manager, "get_config_fresh", fresh)
    reloaded = client.get("/config/model-routing")
    assert reloaded.status_code == 200 and reloaded.json()["routes"] == table["routes"]
