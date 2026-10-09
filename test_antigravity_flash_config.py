"""Flash transport configuration uses only synthetic in-memory storage."""

import json
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

import config
from src.models import ConfigSaveRequest
from src.panel import config_routes
from src.panel.utils import get_env_locked_keys


KEY = "antigravity_flash_non_stream_mode"
ENV = "ANTIGRAVITY_FLASH_NON_STREAM_MODE"
MODES = ("inherit", "native", "stream_collect")
INVALID = (None, True, False, 0, 1, 1.5, [], {}, "", "invalid", "NATIVE", " native ")


@pytest.fixture(autouse=True)
def isolated_config(monkeypatch):
    for name in (*config.ENV_MAPPINGS, "NODE_MANAGEMENT_TOKEN"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(config, "_config_initialized", True)
    monkeypatch.setattr(config, "_config_cache", {})


@pytest.fixture
def storage(monkeypatch):
    class MemoryStorage:
        def __init__(self):
            self.values = {}
            self.writes = []

        async def get_all_config(self):
            return dict(self.values)

        async def set_config(self, key, value):
            self.writes.append((key, value))
            self.values[key] = value
            return True

    adapter = MemoryStorage()

    async def reload():
        config._config_cache = dict(adapter.values)

    monkeypatch.setattr(config_routes, "get_storage_adapter", AsyncMock(return_value=adapter))
    monkeypatch.setattr("src.storage_adapter.get_storage_adapter", AsyncMock(return_value=adapter))
    monkeypatch.setattr(config, "reload_config", reload)
    monkeypatch.setattr("src.smart_429.smart_429_service.reconfigure", AsyncMock())
    return adapter


@pytest.mark.asyncio
async def test_default_inherits_without_changing_global_switch():
    assert await config.get_antigravity_flash_non_stream_mode() == "inherit"
    assert await config.get_antigravity_stream2nostream() is True
    assert config.ANTIGRAVITY_FLASH_NON_STREAM_MODES == frozenset(MODES)
    assert KEY not in get_env_locked_keys()


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", MODES)
async def test_storage_modes(mode):
    config._config_cache[KEY] = mode
    assert await config.get_antigravity_flash_non_stream_mode() == mode


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", MODES)
async def test_environment_takes_priority(monkeypatch, mode):
    config._config_cache[KEY] = "stream_collect" if mode == "native" else "native"
    monkeypatch.setenv(ENV, mode)
    assert await config.get_antigravity_flash_non_stream_mode() == mode
    assert KEY in get_env_locked_keys()


@pytest.mark.asyncio
@pytest.mark.parametrize("value", INVALID)
async def test_invalid_history_falls_back(value):
    config._config_cache[KEY] = value
    assert await config.get_antigravity_flash_non_stream_mode() == "inherit"


@pytest.mark.asyncio
@pytest.mark.parametrize("value", ("invalid", "NATIVE", " native "))
async def test_invalid_environment_does_not_use_storage(monkeypatch, value):
    config._config_cache[KEY] = "native"
    monkeypatch.setenv(ENV, value)
    assert await config.get_antigravity_flash_non_stream_mode() == "inherit"


@pytest.mark.asyncio
async def test_empty_environment_uses_storage_and_does_not_lock_save(storage, monkeypatch):
    monkeypatch.setenv(ENV, "")
    storage.values[KEY] = "stream_collect"
    config._config_cache = dict(storage.values)
    assert await config.get_antigravity_flash_non_stream_mode() == "stream_collect"
    before = json.loads((await config_routes.get_config(token="synthetic-panel")).body)
    assert before["config"][KEY] == "stream_collect"
    assert KEY not in before["env_locked"]

    response = await config_routes.save_config(
        ConfigSaveRequest(config={KEY: "native"}), token="synthetic-panel"
    )
    assert json.loads(response.body)["saved_config"] == {KEY: "native"}
    assert storage.writes == [(KEY, "native")]
    assert await config.get_antigravity_flash_non_stream_mode() == "native"
    after = json.loads((await config_routes.get_config(token="synthetic-panel")).body)
    assert after["config"][KEY] == "native"
    assert KEY not in after["env_locked"]


@pytest.mark.asyncio
@pytest.mark.parametrize("value", (*MODES, *INVALID))
async def test_get_normalizes_after_storage_merge_and_advertises_capability(storage, value):
    storage.values.update({KEY: value, "existing_custom_setting": "preserved"})
    config._config_cache = dict(storage.values)
    response = await config_routes.get_config(token="synthetic-panel")
    payload = json.loads(response.body)
    expected = value if isinstance(value, str) and value in MODES else "inherit"
    assert payload["config"][KEY] == expected
    assert payload["config"]["existing_custom_setting"] == "preserved"
    assert payload["capabilities"] == ["antigravity.flash.non_stream_transport"]
    assert config.ANTIGRAVITY_FLASH_NON_STREAM_CAPABILITY in payload["capabilities"]
    assert storage.writes == []


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", MODES)
async def test_save_valid_modes(storage, mode):
    response = await config_routes.save_config(
        ConfigSaveRequest(config={KEY: mode}), token="synthetic-panel"
    )
    assert json.loads(response.body)["saved_config"] == {KEY: mode}
    assert storage.writes == [(KEY, mode)]
    assert await config.get_antigravity_flash_non_stream_mode() == mode


@pytest.mark.asyncio
@pytest.mark.parametrize("value", INVALID)
async def test_invalid_save_rejects_entire_batch(storage, value):
    with pytest.raises(HTTPException) as caught:
        await config_routes.save_config(
            ConfigSaveRequest(config={"debug_mode": True, KEY: value}),
            token="synthetic-panel",
        )
    assert caught.value.status_code == 400
    assert storage.writes == []
    assert storage.values == {}


@pytest.mark.asyncio
@pytest.mark.parametrize("environment", ("native", "invalid"))
async def test_environment_lock_skips_save_and_get_reports_effective_value(storage, monkeypatch, environment):
    storage.values[KEY] = "stream_collect"
    config._config_cache = dict(storage.values)
    monkeypatch.setenv(ENV, environment)
    response = await config_routes.save_config(
        ConfigSaveRequest(config={KEY: "inherit", "debug_mode": True}),
        token="synthetic-panel",
    )
    assert json.loads(response.body)["saved_config"] == {"debug_mode": True}
    assert storage.writes == [("debug_mode", True)]
    assert storage.values[KEY] == "stream_collect"
    payload = json.loads((await config_routes.get_config(token="synthetic-panel")).body)
    assert payload["config"][KEY] == ("native" if environment == "native" else "inherit")
    assert KEY in payload["env_locked"]


@pytest.mark.asyncio
async def test_old_client_save_without_flash_field_is_compatible(storage):
    response = await config_routes.save_config(
        ConfigSaveRequest(config={"antigravity_stream2nostream": False}),
        token="synthetic-panel",
    )
    assert json.loads(response.body)["saved_config"] == {"antigravity_stream2nostream": False}
    assert KEY not in storage.values
    assert await config.get_antigravity_flash_non_stream_mode() == "inherit"
    assert await config.get_antigravity_stream2nostream() is False
