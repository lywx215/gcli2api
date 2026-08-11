from __future__ import annotations

import pytest
from fastapi import HTTPException
from fastapi.responses import JSONResponse

from src.management.active_operations import (
    ActiveOperationFailure,
    PanelActiveOperations,
)


class FakeStorage:
    def __init__(self) -> None:
        self._backend = self
        self.material = {
            "one.json": {
                "access_token": "fixture-access-before",
                "refresh_token": "fixture-refresh",
            }
        }
        self.states = {
            "one.json": {
                "preview": False,
                "model_cooldowns": {
                    "clear-model": 4_102_444_800,
                    "keep-model": 4_102_444_800,
                },
            }
        }

    async def get_credential(self, filename, mode="geminicli"):
        value = self.material.get(filename)
        return dict(value) if value is not None else None

    async def get_credential_state(self, filename, mode="geminicli"):
        value = self.states.get(filename)
        if value is None:
            return {}
        return {
            **value,
            "model_cooldowns": dict(value.get("model_cooldowns", {})),
        }

    async def update_credential_state(self, filename, updates, mode="geminicli"):
        self.states[filename].update(updates)
        return True

    async def set_model_cooldown(
        self, filename, model_name, cooldown_until, mode="geminicli"
    ):
        cooldowns = self.states[filename].setdefault("model_cooldowns", {})
        if cooldown_until is None:
            cooldowns.pop(model_name, None)
        else:
            cooldowns[model_name] = cooldown_until
        return True


@pytest.mark.asyncio
async def test_panel_active_adapter_normalizes_all_existing_operation_shapes(
    monkeypatch,
) -> None:
    import src.panel.creds as panel_creds

    storage = FakeStorage()
    operations = PanelActiveOperations()

    async def quota(filename, mode):
        return {
            "success": True,
            "models": {
                "fixture-model": {
                    "remaining": 0.5,
                    "resetTimeRaw": "2026-08-13T00:00:00Z",
                }
            },
        }

    async def preview(filename, token, mode):
        storage.material[filename]["access_token"] = "fixture-access-after"
        await storage.update_credential_state(filename, {"preview": True}, mode=mode)
        return JSONResponse(
            content={
                "success": True,
                "preview": True,
                "setting_id": "must-be-filtered-by-service",
            }
        )

    async def tested(filename, mode, model):
        return JSONResponse(
            status_code=429,
            content={"success": True, "status_code": 429, "filename": filename},
        )

    async def risk(filename, token):
        return JSONResponse(
            content={"filename": filename, "health": {"status": "normal"}}
        )

    monkeypatch.setattr(panel_creds, "_fetch_quota_for_credential", quota)
    monkeypatch.setattr(panel_creds, "configure_preview_channel", preview)
    monkeypatch.setattr(panel_creds, "test_credential_common", tested)
    monkeypatch.setattr(panel_creds, "immediately_recheck_risk_control", risk)

    quota_result = await operations.execute(
        action="quota",
        mode="geminicli",
        filename="one.json",
        parameters={},
        storage=storage,
    )
    preview_result = await operations.execute(
        action="enable_preview",
        mode="geminicli",
        filename="one.json",
        parameters={},
        storage=storage,
    )
    test_result = await operations.execute(
        action="test",
        mode="geminicli",
        filename="one.json",
        parameters={"model_name": "fixture-model"},
        storage=storage,
    )
    risk_result = await operations.execute(
        action="risk_check",
        mode="geminicli",
        filename="one.json",
        parameters={},
        storage=storage,
    )

    assert quota_result["payload"]["success"] is True
    assert preview_result["payload"]["preview"] is True
    assert preview_result["token_refreshed"] is True
    assert preview_result["state_changed"] is True
    assert test_result["payload"]["_status_code"] == 429
    assert risk_result["payload"]["health"]["status"] == "normal"


@pytest.mark.asyncio
async def test_panel_active_adapter_synchronizes_cooldowns_with_stubbed_quota(
    monkeypatch,
) -> None:
    import src.panel.creds as panel_creds

    async def quota(filename, mode):
        return {
            "success": True,
            "models": {
                "clear-model": {"remaining": 0.4},
                "keep-model": {"remaining": 0},
                "add-model": {
                    "remaining": 0,
                    "resetTimeRaw": "2099-01-01T00:00:00Z",
                },
                "unknown-model": {"remaining": None},
            },
        }

    monkeypatch.setattr(panel_creds, "_fetch_quota_for_credential", quota)
    storage = FakeStorage()
    result = await PanelActiveOperations().execute(
        action="sync_cooldown",
        mode="geminicli",
        filename="one.json",
        parameters={},
        storage=storage,
    )

    cooldowns = result["payload"]["model_cooldowns"]
    assert "clear-model" not in cooldowns
    assert cooldowns["keep-model"] == 4_102_444_800
    assert cooldowns["add-model"] == pytest.approx(4_070_908_800)
    assert result["cooldown_changed"] is True


@pytest.mark.asyncio
async def test_panel_active_adapter_returns_sanitized_failures(monkeypatch) -> None:
    import src.panel.creds as panel_creds

    storage = FakeStorage()

    async def stopped(filename, token):
        raise HTTPException(status_code=409, detail="must-not-survive")

    monkeypatch.setattr(panel_creds, "immediately_recheck_risk_control", stopped)
    with pytest.raises(ActiveOperationFailure) as known:
        await PanelActiveOperations().execute(
            action="risk_check",
            mode="geminicli",
            filename="one.json",
            parameters={},
            storage=storage,
        )
    assert known.value.status_code == 409
    assert known.value.code == "CONFLICT"
    assert "must-not-survive" not in str(known.value)

    async def broken(filename, mode):
        raise RuntimeError("Bearer must-not-survive")

    monkeypatch.setattr(panel_creds, "_fetch_quota_for_credential", broken)
    with pytest.raises(ActiveOperationFailure) as unknown:
        await PanelActiveOperations().execute(
            action="quota",
            mode="geminicli",
            filename="one.json",
            parameters={},
            storage=storage,
        )
    assert unknown.value.status_code == 502
    assert unknown.value.code == "UPSTREAM_ERROR"
    assert "must-not-survive" not in str(unknown.value)


def test_panel_active_adapter_risk_capability_tracks_runtime_state(monkeypatch) -> None:
    import config

    monkeypatch.setattr(config, "is_smart_429_protection_enabled", lambda: False)
    assert PanelActiveOperations.supports("risk_check") is False
    monkeypatch.setattr(config, "is_smart_429_protection_enabled", lambda: True)
    assert PanelActiveOperations.supports("risk_check") is True
    assert PanelActiveOperations.supports("quota") is True
    assert PanelActiveOperations.supports("disable_preview") is False
