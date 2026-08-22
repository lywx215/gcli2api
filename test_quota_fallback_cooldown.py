import json
import time
from datetime import UTC, datetime

import pytest
from fastapi import HTTPException

import config
from src.api import utils as api_utils
from src.management.active_operations import PanelActiveOperations, _future_cooldown
from src.models import ConfigSaveRequest, CredFileBatchTestRequest
from src.panel import config_routes
from src.panel import creds as creds_panel


@pytest.fixture(autouse=True)
def reset_quota_fallback_config(monkeypatch):
    monkeypatch.delenv("QUOTA_FALLBACK_COOLDOWN_MINUTES", raising=False)
    monkeypatch.setattr(config, "_config_initialized", True)
    monkeypatch.setattr(config, "_config_cache", {})


@pytest.mark.asyncio
async def test_quota_fallback_config_default_storage_and_environment(monkeypatch):
    assert await config.get_quota_fallback_cooldown_minutes() == 30

    config._config_cache["quota_fallback_cooldown_minutes"] = 75
    assert await config.get_quota_fallback_cooldown_minutes() == 75

    monkeypatch.setenv("QUOTA_FALLBACK_COOLDOWN_MINUTES", "45")
    assert await config.get_quota_fallback_cooldown_minutes() == 45


@pytest.mark.asyncio
@pytest.mark.parametrize("value", [True, 0, 1441, 30.5, "invalid"])
async def test_quota_fallback_config_invalid_values_use_default(value):
    config._config_cache["quota_fallback_cooldown_minutes"] = value
    assert await config.get_quota_fallback_cooldown_minutes() == 30


class _FakeConfigStorage:
    def __init__(self, values=None):
        self.values = dict(values or {})

    async def set_config(self, key, value):
        self.values[key] = value
        return True

    async def get_all_config(self):
        return dict(self.values)


@pytest.mark.asyncio
@pytest.mark.parametrize("value", [1, 1440])
async def test_config_route_saves_boundaries_and_hot_reloads(monkeypatch, value):
    storage = _FakeConfigStorage()

    async def get_storage():
        return storage

    async def reload_config():
        config._config_cache = dict(storage.values)
        config._config_initialized = True

    async def reconfigure():
        return None

    monkeypatch.setattr(config_routes, "get_storage_adapter", get_storage)
    monkeypatch.setattr(config, "reload_config", reload_config)
    monkeypatch.setattr(
        "src.smart_429.smart_429_service.reconfigure", reconfigure
    )

    response = await config_routes.save_config(
        ConfigSaveRequest(config={"quota_fallback_cooldown_minutes": value}),
        token="test",
    )

    assert response.status_code == 200
    assert storage.values["quota_fallback_cooldown_minutes"] == value
    assert await config.get_quota_fallback_cooldown_minutes() == value


@pytest.mark.asyncio
@pytest.mark.parametrize("value", [True, False, 0, 1441, 30.5, "30"])
async def test_config_route_rejects_invalid_values(value):
    with pytest.raises(HTTPException) as exc_info:
        await config_routes.save_config(
            ConfigSaveRequest(config={"quota_fallback_cooldown_minutes": value}),
            token="test",
        )
    assert exc_info.value.status_code == 400


@pytest.mark.asyncio
async def test_config_get_returns_effective_env_value_and_lock(monkeypatch):
    storage = _FakeConfigStorage({"quota_fallback_cooldown_minutes": 90})

    async def get_storage():
        return storage

    monkeypatch.setattr(config_routes, "get_storage_adapter", get_storage)
    monkeypatch.setenv("QUOTA_FALLBACK_COOLDOWN_MINUTES", "45")

    response = await config_routes.get_config(token="test")
    payload = json.loads(response.body)

    assert payload["config"]["quota_fallback_cooldown_minutes"] == 45
    assert "quota_fallback_cooldown_minutes" in payload["env_locked"]


@pytest.mark.asyncio
async def test_config_get_normalizes_invalid_stored_value(monkeypatch):
    storage = _FakeConfigStorage({"quota_fallback_cooldown_minutes": 0})
    config._config_cache["quota_fallback_cooldown_minutes"] = 0

    async def get_storage():
        return storage

    monkeypatch.setattr(config_routes, "get_storage_adapter", get_storage)

    response = await config_routes.get_config(token="test")
    payload = json.loads(response.body)

    assert payload["config"]["quota_fallback_cooldown_minutes"] == 30


def _quota_error(*, reason="QUOTA_EXHAUSTED", metadata=None):
    return {
        "error": {
            "code": 429,
            "status": "RESOURCE_EXHAUSTED",
            "details": [
                {
                    "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                    "reason": reason,
                    "metadata": metadata or {},
                }
            ],
        }
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["geminicli", "antigravity"])
async def test_runtime_quota_error_uses_configured_fallback(monkeypatch, mode):
    async def fallback_minutes():
        return 30

    monkeypatch.setattr(api_utils, "get_quota_fallback_cooldown_minutes", fallback_minutes)
    before = time.time()

    cooldown_until = await api_utils.parse_and_log_cooldown(
        json.dumps(_quota_error()),
        mode=mode,
    )

    assert cooldown_until is not None
    assert before + 30 * 60 - 1 <= cooldown_until <= time.time() + 30 * 60 + 1


def test_explicit_reset_timestamp_and_delay_take_precedence(monkeypatch):
    reset_at = "2030-01-02T03:04:05Z"
    parsed = api_utils.parse_quota_reset_timestamp(
        _quota_error(metadata={"quotaResetTimeStamp": reset_at}),
        fallback_cooldown_seconds=30 * 60,
    )
    assert parsed == datetime.fromisoformat(reset_at).astimezone(UTC).timestamp()

    monkeypatch.setattr(time, "time", lambda: 1_000.0)
    parsed = api_utils.parse_quota_reset_timestamp(
        _quota_error(metadata={"quotaResetDelay": "5m"}),
        fallback_cooldown_seconds=30 * 60,
    )
    assert parsed == 1_300.0


class _FakeCooldownStorage:
    def __init__(self, cooldowns=None):
        self.state = {"model_cooldowns": dict(cooldowns or {})}
        self._backend = _FakeCooldownBackend(self)

    async def get_credential_state(self, filename, mode="geminicli"):
        return {"model_cooldowns": dict(self.state["model_cooldowns"])}


class _FakeCooldownBackend:
    def __init__(self, storage):
        self.storage = storage
        self.calls = []

    async def set_model_cooldown(
        self, filename, model_name, cooldown_until, mode="geminicli"
    ):
        self.calls.append((filename, model_name, cooldown_until, mode))
        if cooldown_until is None:
            self.storage.state["model_cooldowns"].pop(model_name, None)
        else:
            self.storage.state["model_cooldowns"][model_name] = cooldown_until
        return True


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["geminicli", "antigravity"])
async def test_panel_quota_sync_uses_shared_fallback(monkeypatch, mode):
    storage = _FakeCooldownStorage()

    async def fallback_minutes():
        return 30

    monkeypatch.setattr(creds_panel, "get_quota_fallback_cooldown_minutes", fallback_minutes)
    before = time.time()
    result = await creds_panel.sync_model_cooldowns_from_quota(
        storage,
        "credential.json",
        mode,
        {"model-a": {"remaining": 0, "resetTimeRaw": ""}},
    )

    assert result == {"cleared": [], "added": ["model-a"]}
    cooldown_until = storage._backend.calls[0][2]
    assert before + 30 * 60 - 1 <= cooldown_until <= time.time() + 30 * 60 + 1


@pytest.mark.asyncio
async def test_panel_quota_sync_does_not_extend_active_cooldown(monkeypatch):
    existing = time.time() + 600
    storage = _FakeCooldownStorage({"model-a": existing})

    async def fallback_minutes():
        return 30

    monkeypatch.setattr(creds_panel, "get_quota_fallback_cooldown_minutes", fallback_minutes)
    result = await creds_panel.sync_model_cooldowns_from_quota(
        storage,
        "credential.json",
        "geminicli",
        {"model-a": {"remaining": 0}},
    )

    assert result == {"cleared": [], "added": []}
    assert storage._backend.calls == []
    assert storage.state["model_cooldowns"]["model-a"] == existing


@pytest.mark.asyncio
async def test_panel_quota_sync_clears_cooldown_when_quota_recovers(monkeypatch):
    storage = _FakeCooldownStorage({"model-a": time.time() + 600})

    async def fallback_minutes():
        return 30

    monkeypatch.setattr(creds_panel, "get_quota_fallback_cooldown_minutes", fallback_minutes)
    result = await creds_panel.sync_model_cooldowns_from_quota(
        storage,
        "credential.json",
        "geminicli",
        {"model-a": {"remaining": 0.5}},
    )

    assert result == {"cleared": ["model-a"], "added": []}
    assert "model-a" not in storage.state["model_cooldowns"]


@pytest.mark.asyncio
async def test_panel_batch_sync_uses_shared_fallback(monkeypatch):
    storage = _FakeCooldownStorage()

    async def get_storage():
        return storage

    async def quota(*args, **kwargs):
        return {
            "success": True,
            "models": {"model-a": {"remaining": 0, "resetTimeRaw": ""}},
        }

    async def fallback_minutes():
        return 30

    monkeypatch.setattr(creds_panel, "get_storage_adapter", get_storage)
    monkeypatch.setattr(creds_panel, "_fetch_quota_for_credential", quota)
    monkeypatch.setattr(creds_panel, "get_quota_fallback_cooldown_minutes", fallback_minutes)
    before = time.time()

    response = await creds_panel.batch_refresh_cooldown(
        CredFileBatchTestRequest(filenames=["credential.json"]),
        mode="geminicli",
        _token="test",
    )
    payload = json.loads(response.body)

    assert payload["success_count"] == 1
    assert payload["added_total"] == 1
    cooldown_until = storage.state["model_cooldowns"]["model-a"]
    assert before + 30 * 60 - 1 <= cooldown_until <= time.time() + 30 * 60 + 1


def test_management_future_cooldown_uses_passed_fallback():
    assert _future_cooldown("", 1_000.0, 30 * 60) == 2_800.0


@pytest.mark.asyncio
async def test_management_sync_uses_shared_config(monkeypatch):
    storage = _FakeCooldownStorage()

    async def quota(*args, **kwargs):
        return {
            "success": True,
            "models": {"model-a": {"remaining": 0, "resetTimeRaw": ""}},
        }

    async def fallback_minutes():
        return 30

    monkeypatch.setattr(creds_panel, "_fetch_quota_for_credential", quota)
    monkeypatch.setattr(config, "get_quota_fallback_cooldown_minutes", fallback_minutes)
    before = time.time()

    result = await PanelActiveOperations._sync_cooldown(
        filename="credential.json",
        mode="geminicli",
        storage=storage,
    )

    assert result["success"] is True
    cooldown_until = storage.state["model_cooldowns"]["model-a"]
    assert before + 30 * 60 - 1 <= cooldown_until <= time.time() + 30 * 60 + 1
