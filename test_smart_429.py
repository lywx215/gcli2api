import asyncio
from copy import deepcopy

import pytest

import config
from src.smart_429 import (
    RiskCheckStatus,
    Upstream429Kind,
    classify_quota_result,
    classify_upstream_429,
    Smart429Service,
)
from src.storage.sqlite_manager import SQLiteManager


def _error(reason=None, *, message="Resource has been exhausted (e.g. check quota)."):
    details = []
    if reason:
        details.append({
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            "reason": reason,
            "metadata": {},
        })
    return {
        "error": {
            "code": 429,
            "message": message,
            "status": "RESOURCE_EXHAUSTED",
            "details": details,
        }
    }


def test_429_classification_is_mutually_exclusive():
    assert classify_upstream_429(_error("QUOTA_EXHAUSTED")).kind == Upstream429Kind.QUOTA_EXHAUSTED
    assert classify_upstream_429(_error("MODEL_CAPACITY_EXHAUSTED")).kind == Upstream429Kind.MODEL_CAPACITY_EXHAUSTED
    assert classify_upstream_429(_error("NO_CAPACITY_AVAILABLE")).kind == Upstream429Kind.MODEL_CAPACITY_EXHAUSTED
    assert classify_upstream_429(_error("RESOURCE_EXHAUSTED")).kind == Upstream429Kind.RISK_CHECK_REQUIRED
    assert classify_upstream_429(_error(), mode="antigravity").kind == Upstream429Kind.INDETERMINATE


def test_quota_risk_check_uses_exact_generic_error():
    result = {"success": False, "http_status": 429, "error_body": _error("RESOURCE_EXHAUSTED")}
    assert classify_quota_result(result) == RiskCheckStatus.RISK_CONTROLLED
    result["error_body"] = _error("MODEL_CAPACITY_EXHAUSTED")
    assert classify_quota_result(result) == RiskCheckStatus.INDETERMINATE
    result["error_body"] = _error("QUOTA_EXHAUSTED")
    assert classify_quota_result(result) == RiskCheckStatus.QUOTA_EXHAUSTED
    assert classify_quota_result({"success": True}) == RiskCheckStatus.NORMAL


def test_multi_worker_mode_fails_closed(monkeypatch):
    monkeypatch.setattr(config, "_smart_429_enabled_cache", True)
    monkeypatch.setattr(config, "_smart_429_runtime_blocked_reason", None)
    monkeypatch.setenv("WORKERS", "2")
    assert config.is_smart_429_protection_enabled() is False
    assert config.get_smart_429_config_sync()["blocked_reason"] == "multi_instance_unsupported"


@pytest.mark.asyncio
async def test_sqlite_health_migration_filter_and_exclusion(tmp_path, monkeypatch):
    monkeypatch.setenv("CREDENTIALS_DIR", str(tmp_path))
    monkeypatch.setenv("WORKERS", "1")
    monkeypatch.setattr(config, "_smart_429_enabled_cache", True)
    monkeypatch.setattr(config, "_smart_429_runtime_blocked_reason", None)
    manager = SQLiteManager()
    await manager.initialize()
    try:
        capable, reason = await manager.check_smart_429_capability()
        assert capable, reason
        for name in ("healthy.json", "quarantined.json"):
            await manager.store_credential(name, {"project_id": name, "token": "x"})
        await manager.update_credential_state(
            "quarantined.json",
            {"health_status": "risk_quarantined", "health_state_version": 1},
        )
        selected = await manager.get_next_available_credential(model_name="gemini-2.5-flash")
        assert selected and selected[0] == "healthy.json"
        assert await manager.get_next_available_credential(
            model_name="gemini-2.5-flash",
            excluded_credentials={"healthy.json"},
        ) is None
        state = await manager.get_credential_state("healthy.json")
        assert state["health_status"] == "healthy"
        assert state["health_state_version"] == 0
    finally:
        await manager.close()


class _FakeAdapter:
    def __init__(self):
        self.state = {
            "health_status": "checking",
            "health_state_version": 1,
            "probe_stage": 0,
        }
        self.credential = {"token": "token", "project_id": "project"}
        self.update_count = 0

    async def get_credential_state(self, filename, mode="geminicli"):
        return deepcopy(self.state)

    async def get_credential(self, filename, mode="geminicli"):
        return deepcopy(self.credential)

    async def update_credential_state(self, filename, updates, mode="geminicli"):
        self.update_count += 1
        self.state.update(updates)
        return True


@pytest.mark.asyncio
async def test_singleflight_merges_concurrent_quota_checks(monkeypatch):
    monkeypatch.setenv("WORKERS", "1")
    monkeypatch.setattr(config, "_smart_429_enabled_cache", True)
    monkeypatch.setattr(config, "_smart_429_runtime_blocked_reason", None)
    adapter = _FakeAdapter()

    async def get_adapter():
        return adapter

    calls = 0

    async def fetch_quota(access_token, project_id):
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.01)
        return {"success": True, "http_status": 200, "models": {}}

    monkeypatch.setattr("src.smart_429.get_storage_adapter", get_adapter)
    monkeypatch.setattr("src.api.geminicli.fetch_geminicli_quota_info", fetch_quota)
    service = Smart429Service()
    try:
        results = await asyncio.gather(*(
            service.verify_credential("one.json", adapter.credential)
            for _ in range(200)
        ))
        assert calls == 1
        assert adapter.update_count == 1
        assert all(result["status"] == "normal" for result in results)
    finally:
        await service.close()


@pytest.mark.asyncio
async def test_inflight_result_is_discarded_after_manual_state_change(monkeypatch):
    monkeypatch.setenv("WORKERS", "1")
    monkeypatch.setattr(config, "_smart_429_enabled_cache", True)
    monkeypatch.setattr(config, "_smart_429_runtime_blocked_reason", None)
    adapter = _FakeAdapter()
    started = asyncio.Event()
    release = asyncio.Event()

    async def get_adapter():
        return adapter

    async def fetch_quota(access_token, project_id):
        started.set()
        await release.wait()
        return {"success": True, "http_status": 200, "models": {}}

    monkeypatch.setattr("src.smart_429.get_storage_adapter", get_adapter)
    monkeypatch.setattr("src.api.geminicli.fetch_geminicli_quota_info", fetch_quota)
    service = Smart429Service()
    try:
        task = asyncio.create_task(service.verify_credential("one.json", adapter.credential))
        await started.wait()
        adapter.state["health_state_version"] += 1
        release.set()
        result = await task
        assert result["discarded"] is True
        assert adapter.update_count == 0
    finally:
        await service.close()
