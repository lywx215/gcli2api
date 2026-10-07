"""Legacy list and batch boundaries for the optimized Antigravity path."""
import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from src.panel import creds
from src.models import CredFileBatchTestRequest
from src.storage.antigravity_panel import PanelListBusy, PanelListChanged
from src.antigravity_panel_budget import PanelBudgetConfigError

pytestmark = pytest.mark.asyncio


def summary():
    return {"items": [], "total": 0, "stats": {"total": 0},
            "model_access_summary": {"total": 0}, "quota_group_filter_supported": True}


async def install(monkeypatch, reader):
    backend = SimpleNamespace(SUPPORTS_QUOTA_GROUP_FILTER=True,
                              model_access_storage_ready=True,
                              get_antigravity_panel_summary=reader,
                              model_access_list_family_public=AsyncMock(side_effect=AssertionError("full family read")),
                              model_access_list_public=AsyncMock(side_effect=AssertionError("full native read")),
                              get_credentials_summary=AsyncMock(side_effect=AssertionError("legacy full read")))
    adapter = SimpleNamespace(_backend=backend, get_backend_info=AsyncMock(return_value={"backend_type": "synthetic"}))
    monkeypatch.setattr(creds, "get_storage_adapter", AsyncMock(return_value=adapter))
    return backend


async def test_optimized_route_has_no_full_read_and_preserves_filters(monkeypatch):
    reader = AsyncMock(return_value=summary())
    await install(monkeypatch, reader)
    response = await creds.get_creds_status_common(25, 25, "enabled", "antigravity",
        error_code_filter="403", cooldown_filter="all", tier_filter="pro", remark_filter="blue",
        model_access_filter="supported", model_access_family="claude-opus-4-6")
    assert response.status_code == 200
    reader.assert_awaited_once()
    assert reader.call_args.kwargs == dict(offset=25, limit=25, status_filter="enabled",
        error_code_filter="403", cooldown_filter=None, preview_filter=None, tier_filter="pro",
        remark_filter="blue", model_access_filter="supported", model_access_tier="any",
        model_access_family="claude-opus-4-6")
    assert "antigravity.model_access.family_filter" in json.loads(response.body)["panel_capabilities"]


@pytest.mark.parametrize("error,status,code", [
    (PanelListBusy(), 503, "credential_list_queue_full"),
    (PanelListChanged(), 503, "credential_list_changed"),
    (TimeoutError(), 504, "credential_list_timeout"),
    (PanelBudgetConfigError("private-value"), 503, "credential_list_budget_configuration"),
])
async def test_safe_list_failures_are_not_capability_downgrades(monkeypatch,error,status,code):
    await install(monkeypatch, AsyncMock(side_effect=error))
    response = await creds.get_creds_status_common(0, 25, "all", "antigravity")
    assert response.status_code == status
    data = json.loads(response.body)
    assert data["error_code"] == code and "stats" not in data and "capability" not in data
    assert b"private-value" not in response.body


async def test_entry_budget_includes_adapter_initialization(monkeypatch):
    from src import antigravity_panel_budget
    entered = asyncio.Event()
    async def slow():
        entered.set()
        await asyncio.sleep(1)
    monkeypatch.setattr(creds, "get_storage_adapter", slow)
    monkeypatch.setattr(antigravity_panel_budget, "panel_list_budget", lambda: .01)
    response = await creds.get_creds_status_common(0, 25, "all", "antigravity")
    assert entered.is_set() and response.status_code == 504


async def test_invalid_chain_never_initializes_storage(monkeypatch):
    monkeypatch.setenv("ANTIGRAVITY_PANEL_CHAIN_TIMEOUT_SECONDS", "10")
    init = AsyncMock(side_effect=AssertionError("must not read"))
    monkeypatch.setattr(creds, "get_storage_adapter", init)
    response = await creds.get_creds_status_common(0, 25, "all", "antigravity")
    assert response.status_code == 503
    init.assert_not_called()


async def test_batch_passes_disconnect_request_and_keeps_result_order(monkeypatch):
    from src.panel import antigravity_manual
    names = ["b.json", "a.json", "b.json"]
    rows = [{"filename": name, "success": False, "started": False,
             "error_code": "quota_timeout", "status_code": 504} for name in names]
    reader = AsyncMock(return_value=rows)
    monkeypatch.setattr(antigravity_manual, "batch_quota", reader)
    monkeypatch.setattr(creds, "get_storage_adapter", AsyncMock(side_effect=AssertionError("extra read")))
    connection = object()
    response = await creds.batch_refresh_cooldown(CredFileBatchTestRequest(filenames=names),
        mode="antigravity", _token="synthetic", http_request=connection)
    reader.assert_awaited_once_with(names, request=connection)
    data = json.loads(response.body)
    assert [row["filename"] for row in data["results"]] == names
    assert data["total_count"] == 3 and data["failure_count"] == 3
    assert data["model_access_summary"]["total"] == 0
