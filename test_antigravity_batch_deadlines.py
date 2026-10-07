"""Actual phase and no-admission fences for bounded legacy batch windows."""
import asyncio
import time

import pytest
from src import antigravity_batch_runtime as runtime
from src.panel import antigravity_manual as manual

pytestmark = pytest.mark.asyncio


async def test_request_budget_never_creates_jobs_for_future_windows(monkeypatch):
    pool = runtime.BatchQuotaPool()
    submitted = []
    original = pool.submit
    def submit(names, request_id, deadline):
        submitted.append(list(names))
        return original(names, request_id, deadline)
    pool.submit = submit
    async def quota(name, **kwargs):
        kwargs["_on_started"]()
        kwargs["_progress"]["phase"] = "oauth"
        await asyncio.Event().wait()
    monkeypatch.setattr(runtime, "batch_pool", pool)
    monkeypatch.setattr(runtime, "panel_work_budget", lambda n: .03)
    monkeypatch.setattr(manual, "quota", quota)
    names = [f"synthetic{i}.json" for i in range(23)]
    result = await runtime.batch_quota(names)
    assert submitted == [names[:10]]
    assert [row["filename"] for row in result] == names
    assert all(row["phase"] == "request_budget" and row["started"] is False
               and row["status_code"] == 504 and row["error_code"] == "quota_timeout"
               for row in result[10:])
    pool.begin_close()
    await pool.wait_closed(time.monotonic() + 1)


@pytest.mark.parametrize("phase", ["oauth", "http_queue", "google", "credential_cas", "quota_sync"])
async def test_window_timeout_preserves_actual_started_phase(monkeypatch, phase):
    pool = runtime.BatchQuotaPool()
    async def quota(name, **kwargs):
        kwargs["_on_started"]()
        kwargs["_progress"]["phase"] = phase
        await asyncio.Event().wait()
    monkeypatch.setattr(runtime, "batch_pool", pool)
    monkeypatch.setattr(runtime, "panel_work_budget", lambda n: .03)
    monkeypatch.setattr(manual, "quota", quota)
    rows = await runtime.batch_quota(["synthetic.json"])
    assert rows[0]["started"] is True and rows[0]["phase"] == phase
    assert rows[0]["status_code"] == 504 and rows[0]["error_code"] == "quota_timeout"
    pool.begin_close()
    await pool.wait_closed(time.monotonic() + 1)


async def test_cancel_keeps_confirmed_google_failure_and_pending_write(monkeypatch):
    from src import antigravity_directory_runtime as directory
    registry = directory.AtomicRegistry()
    pool = runtime.BatchQuotaPool()
    gate = asyncio.Event()
    entered = asyncio.Event()
    async def quota(name, **kwargs):
        kwargs["_on_started"]()
        kwargs["_progress"]["phase"] = "model_access"
        kwargs["_on_result"]({"filename": name, "success": False, "status_code": 403,
                               "upstream_status": 403, "error": "Permission denied."})
        async def save():
            entered.set()
            await gate.wait()
        await registry.run(save, deadline=kwargs["deadline"], phase="model_access")
    monkeypatch.setattr(directory, "atomic_registry", registry)
    monkeypatch.setattr(manual, "quota", quota)
    job = pool.submit(["synthetic.json"], object(), time.monotonic() + 1)[0]
    await entered.wait()
    pool.cancel(job, "quota_timeout")
    result = job.future.result()
    assert result["success"] is False and result["status_code"] == 403
    assert result["phase"] == "model_access" and result["started"] is True
    assert result["state_update"]["model_access"]["status"] == "pending"
    gate.set()
    pool.begin_close()
    await pool.wait_closed(time.monotonic() + 1)
    await asyncio.sleep(0)
