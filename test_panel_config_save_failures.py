"""Configuration write failures use only in-memory storage and fake services."""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import HTTPException

import config
from src.models import ConfigSaveRequest
from src.panel import config_routes
from src.smart_429 import smart_429_service


SECRET = "synthetic-only-panel-password"


@pytest.fixture
def isolated(monkeypatch):
    values = {}
    calls = []
    events = []
    storage = SimpleNamespace(_backend=None)

    async def write(key, value):
        calls.append(key)
        values[key] = value
        return True

    async def reload():
        events.append("reload")
        config._config_cache = dict(values)

    async def reconfigure():
        events.append("reconfigure")

    async def restart():
        events.append("restart")

    storage.set_config = write
    logger = Mock()
    monkeypatch.setattr(config, "_config_initialized", True)
    monkeypatch.setattr(config, "_config_cache", {})
    monkeypatch.setattr(config, "reload_config", reload)
    monkeypatch.setattr(config_routes, "get_storage_adapter", AsyncMock(return_value=storage))
    monkeypatch.setattr(config_routes, "get_env_locked_keys", lambda: set())
    monkeypatch.setattr(config_routes, "log", logger)
    monkeypatch.setattr(smart_429_service, "reconfigure", reconfigure)
    monkeypatch.setattr(smart_429_service, "status", lambda: {"enabled": False})
    monkeypatch.setattr(config_routes.keepalive_service, "restart", restart)
    return SimpleNamespace(storage=storage, values=values, calls=calls, events=events, log=logger)


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", [False, RuntimeError(SECRET)])
@pytest.mark.parametrize("fail_at", [0, 1])
async def test_stop_on_first_failed_write_and_refresh_observed_state(isolated, failure, fail_at):
    original = isolated.storage.set_config

    async def write(key, value):
        # Simulate an ambiguous write that persisted before reporting failure.
        await original(key, value)
        if len(isolated.calls) - 1 == fail_at:
            if isinstance(failure, Exception):
                raise failure
            return failure
        return True

    isolated.storage.set_config = write
    payload = {"keepalive_url": "https://synthetic.example.invalid", "password": SECRET, "port": 4567}
    with pytest.raises(HTTPException) as exc:
        await config_routes.save_config(ConfigSaveRequest(config=payload), token="synthetic")
    assert exc.value.status_code == 500
    assert "部分配置可能已保存" in exc.value.detail
    assert isolated.calls == list(payload)[:fail_at + 1]
    assert "port" not in isolated.values
    assert config._config_cache == isolated.values
    assert isolated.events == ["reload", "reconfigure", "restart"]
    assert SECRET not in str(isolated.log.mock_calls)
    assert SECRET not in exc.value.detail


@pytest.mark.asyncio
async def test_refresh_failure_does_not_skip_other_services(isolated, monkeypatch):
    isolated.storage.set_config = AsyncMock(return_value=False)
    monkeypatch.setattr(config, "reload_config", AsyncMock(side_effect=RuntimeError(SECRET)))
    with pytest.raises(HTTPException) as exc:
        await config_routes.save_config(
            ConfigSaveRequest(config={"keepalive_interval": 60, "password": SECRET}), token="synthetic"
        )
    assert exc.value.status_code == 500
    assert isolated.storage.set_config.await_count == 1
    assert isolated.events == ["reconfigure", "restart"]
    assert SECRET not in str(isolated.log.mock_calls)


@pytest.mark.asyncio
async def test_success_keeps_legacy_saved_password_values_without_logging(isolated):
    payload = {key: SECRET for key in ("password", "api_password", "panel_password")}
    response = await config_routes.save_config(ConfigSaveRequest(config=payload), token="synthetic")
    assert json.loads(response.body)["saved_config"] == payload
    assert isolated.values == payload
    assert isolated.events == ["reload", "reconfigure"]
    assert SECRET not in str(isolated.log.mock_calls)


@pytest.mark.asyncio
async def test_locked_values_are_not_written_or_echoed(isolated, monkeypatch):
    monkeypatch.setattr(config_routes, "get_env_locked_keys", lambda: {"panel_password"})
    response = await config_routes.save_config(
        ConfigSaveRequest(config={"panel_password": SECRET, "port": 4567}), token="synthetic"
    )
    assert isolated.calls == ["port"]
    assert json.loads(response.body)["saved_config"] == {"port": 4567}
    assert SECRET not in str(isolated.log.mock_calls)
