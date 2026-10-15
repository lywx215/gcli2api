"""Safe panel configuration reads use only synthetic in-memory settings."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException
from httpx import ASGITransport, AsyncClient

import config
from src.panel import config_routes


PASSWORD_KEYS = ("api_password", "panel_password", "password")
SYNTHETIC_PASSWORDS = {key: f"synthetic-only-{key}" for key in PASSWORD_KEYS}
SYNTHETIC_DIGEST = "sha256:" + "0" * 64


@pytest.fixture
def isolated(monkeypatch):
    for name in (*config.ENV_MAPPINGS, "NODE_MANAGEMENT_TOKEN", "GCLI_EMBED_ALLOWED_ORIGINS"):
        monkeypatch.delenv(name, raising=False)
    values = {
        **SYNTHETIC_PASSWORDS,
        config.NODE_MANAGEMENT_TOKEN_HASH_KEY: SYNTHETIC_DIGEST,
        "model_routing": {"synthetic": "private"},
        "existing_custom_setting": "preserved",
        "quota_fallback_cooldown_minutes": "invalid-history",
    }
    storage = SimpleNamespace(
        _backend=None,
        get_all_config=AsyncMock(side_effect=lambda: dict(values)),
    )
    monkeypatch.setattr(config, "_config_initialized", True)
    monkeypatch.setattr(config, "_config_cache", dict(values))
    monkeypatch.setattr(config_routes, "get_storage_adapter", AsyncMock(return_value=storage))
    app = FastAPI()
    app.include_router(config_routes.router)
    app.dependency_overrides[config_routes.verify_panel_token] = lambda: "synthetic-panel"
    return SimpleNamespace(app=app, values=values, storage=storage)


async def read_config(isolated, path):
    async with AsyncClient(
        transport=ASGITransport(app=isolated.app), base_url="http://synthetic.test"
    ) as client:
        return await client.get(path)


@pytest.mark.parametrize("query", ["", "?include_secrets=true"])
async def test_default_and_explicit_secret_reads_keep_legacy_envelope(isolated, query):
    response = await read_config(isolated, "/config/get" + query)
    assert response.status_code == 200
    payload = response.json()
    assert set(payload) == {"config", "capabilities", "env_locked", "security"}
    assert {key: payload["config"][key] for key in PASSWORD_KEYS} == SYNTHETIC_PASSWORDS
    assert payload["config"]["existing_custom_setting"] == "preserved"
    assert response.headers["cache-control"] == "no-store"
    assert SYNTHETIC_DIGEST not in response.text
    assert config.NODE_MANAGEMENT_TOKEN_HASH_KEY not in payload["config"]
    assert "model_routing" not in payload["config"]


async def test_safe_read_removes_passwords_and_preserves_other_effective_config(isolated):
    legacy = await read_config(isolated, "/config/get")
    response = await read_config(isolated, "/config/get?include_secrets=false")
    assert response.status_code == 200
    payload = response.json()
    expected = legacy.json()
    expected["config"] = {
        key: value for key, value in expected["config"].items() if key not in PASSWORD_KEYS
    }
    expected["secret_fields"] = {key: {"configured": True} for key in PASSWORD_KEYS}
    assert payload == expected
    assert response.headers["cache-control"] == "no-store"
    for value in (*SYNTHETIC_PASSWORDS.values(), SYNTHETIC_DIGEST):
        assert value not in response.text
    assert payload["config"]["quota_fallback_cooldown_minutes"] == (
        config.QUOTA_FALLBACK_COOLDOWN_DEFAULT_MINUTES
    )
    assert payload["capabilities"] == [
        config.ANTIGRAVITY_FLASH_NON_STREAM_CAPABILITY,
        config.ANTIGRAVITY_NATIVE_TIMEOUT_CAPABILITY,
    ]
    assert payload["security"]["node_management_token"] == {
        "configured": True, "source": "storage", "locked": False
    }


async def test_safe_read_retains_environment_locks_and_security_metadata(isolated, monkeypatch):
    monkeypatch.setenv("API_PASSWORD", "synthetic-only-environment-api-password")
    monkeypatch.setenv("NODE_MANAGEMENT_TOKEN", "synthetic-only-environment-management-token")
    monkeypatch.setenv("GCLI_EMBED_ALLOWED_ORIGINS", "https://manager.example.invalid")
    response = await read_config(isolated, "/config/get?include_secrets=false")
    payload = response.json()
    assert set(PASSWORD_KEYS).isdisjoint(payload["config"])
    assert payload["secret_fields"] == {key: {"configured": True} for key in PASSWORD_KEYS}
    assert {
        "api_password", config.GCLI_EMBED_MODE_KEY, config.GCLI_EMBED_ORIGINS_KEY
    } <= set(payload["env_locked"])
    assert payload["config"][config.GCLI_EMBED_MODE_KEY] == "exact"
    assert payload["config"][config.GCLI_EMBED_ORIGINS_KEY] == [
        "https://manager.example.invalid"
    ]
    assert payload["security"] == {
        "node_management_token": {
            "configured": True, "source": "environment", "locked": True
        },
        "embed_policy": {"source": "environment", "locked": True, "valid": True},
    }
    assert "synthetic-only-environment-api-password" not in response.text
    assert "synthetic-only-environment-management-token" not in response.text
    assert SYNTHETIC_DIGEST not in response.text


async def test_safe_status_uses_final_merged_values_without_mutating_storage(isolated):
    isolated.values.update({"api_password": "", "panel_password": "", "password": ""})
    isolated.values["api_password"] = "synthetic-only-stored-api-password"
    before = dict(isolated.values)
    response = await read_config(isolated, "/config/get?include_secrets=false")
    assert response.json()["secret_fields"] == {
        "api_password": {"configured": True},
        "panel_password": {"configured": False},
        "password": {"configured": False},
    }
    assert isolated.values == before
    for value in SYNTHETIC_PASSWORDS.values():
        assert value not in response.text
    assert "synthetic-only-stored-api-password" not in response.text


@pytest.mark.parametrize("query", ["", "?include_secrets=true", "?include_secrets=false"])
async def test_both_read_modes_still_require_panel_authentication(isolated, query):
    def reject_auth():
        raise HTTPException(status_code=401, detail="Synthetic authentication rejection")

    isolated.app.dependency_overrides[config_routes.verify_panel_token] = reject_auth
    response = await read_config(isolated, "/config/get" + query)
    assert response.status_code == 401
    isolated.storage.get_all_config.assert_not_awaited()
