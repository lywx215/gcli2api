import json

import pytest
from fastapi import HTTPException

import config
from src.management.auth import ManagementApiError, validate_management_token
from src.models import ConfigSaveRequest, ManagementTokenRequest
from src.panel import config_routes


class FakeConfigStorage:
    def __init__(self, values=None):
        self.values = dict(values or {})

    async def set_config(self, key, value):
        self.values[key] = value
        return True

    async def get_all_config(self):
        return dict(self.values)


@pytest.fixture(autouse=True)
def reset_security_config(monkeypatch):
    monkeypatch.delenv("NODE_MANAGEMENT_TOKEN", raising=False)
    monkeypatch.delenv("GCLI_EMBED_ALLOWED_ORIGINS", raising=False)
    monkeypatch.setattr(config, "_config_initialized", True)
    monkeypatch.setattr(config, "_config_cache", {})


def install_storage(monkeypatch, storage):
    async def get_storage():
        return storage

    async def reload_config():
        config._config_cache = dict(storage.values)
        config._config_initialized = True

    async def reconfigure():
        return None

    monkeypatch.setattr(config_routes, "get_storage_adapter", get_storage)
    monkeypatch.setattr(config, "reload_config", reload_config)
    monkeypatch.setattr("src.smart_429.smart_429_service.reconfigure", reconfigure)


@pytest.mark.asyncio
async def test_page_token_is_hashed_authenticates_and_never_echoes(monkeypatch):
    storage = FakeConfigStorage()
    install_storage(monkeypatch, storage)
    raw_token = "page-generated-management-token-1234567890"

    response = await config_routes.set_management_token(
        ManagementTokenRequest(token=raw_token), token="panel"
    )
    payload = json.loads(response.body)
    stored_hash = storage.values[config.NODE_MANAGEMENT_TOKEN_HASH_KEY]

    assert stored_hash.startswith("sha256:")
    assert raw_token not in stored_hash
    assert raw_token not in response.body.decode()
    assert stored_hash not in response.body.decode()
    assert payload["status"] == {
        "configured": True,
        "source": "storage",
        "locked": False,
    }

    await validate_management_token("Bearer", raw_token)
    with pytest.raises(ManagementApiError) as exc_info:
        await validate_management_token("Bearer", "wrong-token")
    assert exc_info.value.status_code == 401

    config_response = await config_routes.get_config(token="panel")
    config_body = config_response.body.decode()
    assert raw_token not in config_body
    assert stored_hash not in config_body
    assert config.NODE_MANAGEMENT_TOKEN_HASH_KEY not in config_body


@pytest.mark.asyncio
async def test_environment_token_locks_page_management(monkeypatch):
    storage = FakeConfigStorage()
    install_storage(monkeypatch, storage)
    monkeypatch.setenv("NODE_MANAGEMENT_TOKEN", "environment-management-token")

    await validate_management_token("Bearer", "environment-management-token")
    with pytest.raises(HTTPException) as exc_info:
        await config_routes.set_management_token(
            ManagementTokenRequest(token="replacement-management-token-123456789"),
            token="panel",
        )
    assert exc_info.value.status_code == 409

    response = await config_routes.get_config(token="panel")
    status = json.loads(response.body)["security"]["node_management_token"]
    assert status == {"configured": True, "source": "environment", "locked": True}


@pytest.mark.asyncio
async def test_clear_stored_token_disables_management_api(monkeypatch):
    storage = FakeConfigStorage(
        {config.NODE_MANAGEMENT_TOKEN_HASH_KEY: "sha256:" + "0" * 64}
    )
    install_storage(monkeypatch, storage)
    config._config_cache = dict(storage.values)

    response = await config_routes.clear_management_token(token="panel")
    assert json.loads(response.body)["status"]["configured"] is False
    assert storage.values[config.NODE_MANAGEMENT_TOKEN_HASH_KEY] is None
    with pytest.raises(ManagementApiError) as exc_info:
        await validate_management_token("Bearer", "any-token")
    assert exc_info.value.status_code == 503


@pytest.mark.asyncio
async def test_embed_policy_page_save_and_environment_lock(monkeypatch):
    storage = FakeConfigStorage()
    install_storage(monkeypatch, storage)

    response = await config_routes.save_config(
        ConfigSaveRequest(
            config={
                config.GCLI_EMBED_MODE_KEY: "exact",
                config.GCLI_EMBED_ORIGINS_KEY: ["https://manager.example.com"],
            }
        ),
        token="panel",
    )
    assert response.status_code == 200
    assert storage.values[config.GCLI_EMBED_MODE_KEY] == "exact"

    monkeypatch.setenv(
        "GCLI_EMBED_ALLOWED_ORIGINS", "https://environment.example.com"
    )
    get_response = await config_routes.get_config(token="panel")
    payload = json.loads(get_response.body)
    assert payload["config"][config.GCLI_EMBED_MODE_KEY] == "exact"
    assert payload["config"][config.GCLI_EMBED_ORIGINS_KEY] == [
        "https://environment.example.com"
    ]
    assert config.GCLI_EMBED_MODE_KEY in payload["env_locked"]
    assert config.GCLI_EMBED_ORIGINS_KEY in payload["env_locked"]
    assert payload["security"]["embed_policy"] == {
        "source": "environment",
        "locked": True,
        "valid": True,
    }


@pytest.mark.asyncio
async def test_generic_config_save_cannot_write_management_token_digest():
    with pytest.raises(HTTPException) as exc_info:
        await config_routes.save_config(
            ConfigSaveRequest(
                config={config.NODE_MANAGEMENT_TOKEN_HASH_KEY: "sha256:" + "0" * 64}
            ),
            token="panel",
        )
    assert exc_info.value.status_code == 400


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "payload",
    [
        {config.GCLI_EMBED_MODE_KEY: "unknown"},
        {config.GCLI_EMBED_MODE_KEY: "exact", config.GCLI_EMBED_ORIGINS_KEY: []},
        {
            config.GCLI_EMBED_MODE_KEY: "exact",
            config.GCLI_EMBED_ORIGINS_KEY: ["http://unsafe.example.com"],
        },
    ],
)
async def test_embed_policy_rejects_invalid_page_configuration(payload):
    with pytest.raises(HTTPException) as exc_info:
        await config_routes.save_config(ConfigSaveRequest(config=payload), token="panel")
    assert exc_info.value.status_code == 400
