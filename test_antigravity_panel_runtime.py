"""Synthetic admission, timing and cancellation tests; no external IO."""
import asyncio
import math
import time
from types import SimpleNamespace

import pytest

from src.antigravity_panel_budget import (
    PanelBudgetConfigError, panel_list_budget, panel_work_budget, shutdown_budgets,
)
from src.antigravity_directory_runtime import DirectoryBroker, AtomicRegistry, QuotaWorkError, SettlementPending
from src.antigravity_batch_runtime import BatchQuotaPool


@pytest.fixture(autouse=True)
def budgets(monkeypatch):
    for key in ("ANTIGRAVITY_PANEL_CHAIN_TIMEOUT_SECONDS", "ANTIGRAVITY_LEGACY_BATCH_WORK_TIMEOUT_SECONDS", "ANTIGRAVITY_SHUTDOWN_GRACE_SECONDS"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("ANTIGRAVITY_PANEL_TIMING_SAMPLE_RATE", "0")


@pytest.mark.parametrize("value", ["", "0", "-1", "nan", "inf", "Infinity", "garbage"])
def test_invalid_chain_rejected_without_work(monkeypatch, value):
    monkeypatch.setenv("ANTIGRAVITY_PANEL_CHAIN_TIMEOUT_SECONDS", value)
    with pytest.raises(PanelBudgetConfigError): panel_list_budget()
    with pytest.raises(PanelBudgetConfigError): panel_work_budget()


def test_budget_domains_and_legacy_nominal(monkeypatch):
    assert panel_list_budget() == 15
    assert panel_work_budget() == 50
    assert panel_work_budget(21) == 150
    assert shutdown_budgets().shutdown() == 5
    monkeypatch.setenv("ANTIGRAVITY_SHUTDOWN_GRACE_SECONDS", "invalid")
    assert panel_list_budget() == 15
    assert panel_work_budget(21) == 150
    monkeypatch.setenv("ANTIGRAVITY_LEGACY_BATCH_WORK_TIMEOUT_SECONDS", "75")
    assert panel_work_budget(21) == 75
    assert panel_work_budget(10) == 50
    monkeypatch.setenv("ANTIGRAVITY_PANEL_CHAIN_TIMEOUT_SECONDS", "20")
    assert panel_list_budget() == panel_work_budget(21) == 10
    monkeypatch.setenv("ANTIGRAVITY_PANEL_CHAIN_TIMEOUT_SECONDS", "10")
    with pytest.raises(PanelBudgetConfigError): panel_list_budget()
    monkeypatch.setenv("ANTIGRAVITY_PANEL_CHAIN_TIMEOUT_SECONDS", "unbounded")
    assert panel_list_budget() == 15
    assert panel_work_budget(21) == 75


@pytest.mark.parametrize("value,expected", [("1", 0), ("5", 0), ("10", 5), ("100", 30), ("unbounded", 30)])
def test_shutdown_uses_only_s(monkeypatch, value, expected):
    monkeypatch.setenv("ANTIGRAVITY_PANEL_CHAIN_TIMEOUT_SECONDS", "invalid")
    monkeypatch.setenv("ANTIGRAVITY_LEGACY_BATCH_WORK_TIMEOUT_SECONDS", "invalid")
    monkeypatch.setenv("ANTIGRAVITY_SHUTDOWN_GRACE_SECONDS", value)
    assert shutdown_budgets().shutdown() == expected


async def _turns(n=5):
    for _ in range(n):
        await asyncio.sleep(0)


async def test_http_total_five_background_one_and_foreground_uses_idle_slots():
    broker = DirectoryBroker()
    gate = asyncio.Event()
    active = peak = bg_active = bg_peak = 0
    async def send(timeout, background=False):
        nonlocal active, peak, bg_active, bg_peak
        active += 1; peak = max(peak, active)
        bg_active += background; bg_peak = max(bg_peak, bg_active)
        try: await gate.wait()
        finally:
            active -= 1; bg_active -= background
    tasks = [asyncio.create_task(broker.run(lambda t: send(t, True), kind="background")) for _ in range(3)]
    tasks += [asyncio.create_task(broker.run(send, kind="interactive")) for _ in range(8)]
    await _turns()
    assert active == peak == 5 and bg_peak == 1
    gate.set(); await asyncio.gather(*tasks)
    assert not broker.active and not broker.queued
    gate.clear(); peak = 0
    tasks = [asyncio.create_task(broker.run(send, kind="interactive")) for _ in range(5)]
    await _turns()
    assert peak == 5
    gate.set(); await asyncio.gather(*tasks)


async def test_http_round_robin_fifo_and_background_not_starved():
    broker = DirectoryBroker(capacity=1)
    gate = asyncio.Event()
    first = asyncio.create_task(broker.run(lambda t: gate.wait(), kind="interactive"))
    await _turns()
    order = []
    async def send(timeout, kind, i): order.append((kind, i))
    tasks = []
    for kind in ("interactive", "business", "batch", "background"):
        for i in range(15):
            tasks.append(asyncio.create_task(broker.run(lambda t, k=kind, j=i: send(t,k,j), kind=kind)))
    await _turns(); gate.set(); await asyncio.gather(first, *tasks)
    assert next(i for i,v in enumerate(order) if v[0] == "background") < 11
    for kind in ("interactive", "business", "batch", "background"):
        assert [i for k,i in order if k == kind] == list(range(15))


async def test_http_queue_bound_timeout_and_cancel_do_not_leak_slots():
    broker = DirectoryBroker(capacity=1, queue_limit=1)
    gate = asyncio.Event()
    first = asyncio.create_task(broker.run(lambda t: gate.wait()))
    await _turns()
    queued = asyncio.create_task(broker.run(lambda t: gate.wait(), deadline=time.monotonic()+.03))
    await _turns()
    with pytest.raises(QuotaWorkError, match="quota_queue_full"):
        await broker.run(lambda t: gate.wait())
    with pytest.raises(QuotaWorkError) as error: await queued
    assert error.value.phase == "http_queue"
    assert broker.queued == 0
    first.cancel()
    with pytest.raises(asyncio.CancelledError): await first
    # The cancelled transport retains admission through actual close. A new
    # bounded request proves its completion callback returns the permit.
    assert await broker.run(lambda t: asyncio.sleep(0, result=42), deadline=time.monotonic()+1) == 42
    assert not broker.active


async def test_atomic_timeout_keeps_one_write_and_reserves_before_start():
    registry = AtomicRegistry(limit=1)
    gate = asyncio.Event(); calls = []
    async def write():
        calls.append("started")
        await gate.wait()
        calls.append("committed")
        return 7
    with pytest.raises(SettlementPending):
        await registry.run(write, deadline=time.monotonic()+.03, phase="quota_sync")
    assert len(registry.tasks) == 1
    with pytest.raises(QuotaWorkError) as error:
        await registry.run(write, deadline=time.monotonic()+.02)
    assert not isinstance(error.value, SettlementPending)
    assert calls == ["started"]
    gate.set(); await _turns()
    assert calls == ["started", "committed"] and not registry.tasks


async def test_atomic_cancel_does_not_cancel_write_and_cleanup_cannot_overflow():
    registry = AtomicRegistry(limit=1)
    gate = asyncio.Event()
    operation = asyncio.create_task(registry.run(lambda: gate.wait()))
    await _turns()
    assert registry.pending_phase(operation) == "settlement"
    operation.cancel()
    with pytest.raises(asyncio.CancelledError): await operation
    assert len(registry.tasks) == 1
    assert registry.cleanup(lambda: asyncio.sleep(0)) is False
    registry.begin_close(time.monotonic())
    assert await registry.drain() == 1
    gate.set(); await _turns()
    assert not registry.tasks


async def test_batch_process_workers_request_rotation_and_queue_limit(monkeypatch):
    from src.panel import antigravity_manual as manual
    pool = BatchQuotaPool(workers=5, queue_limit=20)
    gate = asyncio.Event(); order = []; active = peak = 0
    async def quota(filename, **kwargs):
        nonlocal active, peak
        active += 1; peak=max(peak,active); order.append(filename)
        try: await gate.wait()
        finally: active -= 1
        return {"filename":filename,"success":True}
    monkeypatch.setattr(manual, "quota", quota)
    deadline = time.monotonic()+1
    a = pool.submit([f"a{i}" for i in range(10)], "a", deadline)
    b = pool.submit([f"b{i}" for i in range(10)], "b", deadline)
    rejected = pool.submit(["overflow"], "c", deadline)
    assert rejected[0].future.result()["error_code"] == "quota_queue_full"
    await _turns()
    assert peak == 5 and order[:4] == ["a0", "b0", "a1", "b1"]
    gate.set(); await asyncio.gather(*(j.future for j in a+b))
    pool.begin_close(); await pool.wait_closed(time.monotonic()+1)
    assert not pool.active and not pool.queued


async def test_expired_batch_job_never_prepares(monkeypatch):
    pool = BatchQuotaPool()
    jobs = pool.submit(["synthetic.json"], object(), time.monotonic()-1)
    result=jobs[0].future.result()
    assert result["error_code"] == "quota_timeout" and result["started"] is False
    assert not pool.workers


async def test_manual_pending_access_does_not_start_quota_sync(monkeypatch):
    from src.panel import antigravity_manual as manual, creds
    registry = AtomicRegistry(); gate=asyncio.Event(); synced=[]
    class Backend:
        model_access_storage_ready=True
        async def model_access_observe_with_projection(self,*args,**kwargs):
            await gate.wait()
            return {"applied":True,"public":{},"families":{}}
        async def manual_sync_quota(self,*args,**kwargs): synced.append(1)
    async def prepare(*args,**kwargs): return SimpleNamespace(_backend=Backend()),{}, {"access_token":"synthetic"}
    async def fetch(*args,**kwargs): return {"success":True,"upstream_status":200,"models":{}}
    monkeypatch.setattr(manual,"prepare",prepare)
    monkeypatch.setattr(creds,"fetch_quota_info",fetch)
    monkeypatch.setattr(manual,"atomic_registry",registry)
    result=await manual.quota("synthetic.json",sync=True,deadline=time.monotonic()+.03)
    assert result["state_update"]["model_access"]["status"] == "pending"
    assert result["success"] is True and result["status_code"] == 200
    assert result["models"] == {}
    assert not synced and len(registry.tasks)==1
    gate.set(); await _turns()
    assert not synced and not registry.tasks


async def test_batch_cancel_before_prepare_is_not_started(monkeypatch):
    from src.panel import antigravity_manual as manual
    pool = BatchQuotaPool()
    called = []
    async def quota(name, **kwargs):
        called.append(name)
        kwargs["_on_started"]()
        await asyncio.Event().wait()
    monkeypatch.setattr(manual, "quota", quota)
    job = pool.submit(["synthetic.json"], object(), time.monotonic()+1)[0]
    await asyncio.sleep(0)  # Worker owns the job, child prepare has not run.
    assert job.task is not None and not job.started
    pool.cancel(job)
    assert job.future.result()["started"] is False
    pool.begin_close(); await pool.wait_closed(time.monotonic()+1)
    assert not called


async def test_shutdown_race_keeps_success_and_pending_phase(monkeypatch):
    from src.panel import antigravity_manual as manual, creds
    import src.antigravity_directory_runtime as runtime
    registry = AtomicRegistry(); pool = BatchQuotaPool(); gate=asyncio.Event(); entered=asyncio.Event()
    class Backend:
        model_access_storage_ready=True
        async def model_access_observe_with_projection(self,*args,**kwargs):
            entered.set(); await gate.wait()
            return {"applied":True,"public":{},"families":{}}
    async def prepare(*args,**kwargs): return SimpleNamespace(_backend=Backend()),{}, {"access_token":"synthetic"}
    async def fetch(*args,**kwargs): return {"success":True,"upstream_status":200,"models":{"synthetic":{}}}
    monkeypatch.setattr(manual,"prepare",prepare)
    monkeypatch.setattr(creds,"fetch_quota_info",fetch)
    monkeypatch.setattr(manual,"atomic_registry",registry)
    monkeypatch.setattr(runtime,"atomic_registry",registry)
    job=pool.submit(["synthetic.json"],object(),time.monotonic()+1)[0]
    await entered.wait()
    pool.begin_close()
    result=job.future.result()
    assert result["success"] is True and result["status_code"] == 200 and result["started"] is True
    assert result["state_update"]["model_access"]["status"] == "pending"
    assert result["models"] == {"synthetic":{}}
    gate.set(); await pool.wait_closed(time.monotonic()+1); await _turns()
    assert not registry.tasks


async def test_legacy_request_budget_does_not_restart_between_windows(monkeypatch):
    from src.panel import antigravity_manual as manual
    import src.antigravity_batch_runtime as runtime
    pool = BatchQuotaPool(); calls=[]
    async def quota(name,**kwargs):
        calls.append(name); kwargs["_on_started"]()
        await asyncio.Event().wait()
    monkeypatch.setattr(manual,"quota",quota)
    monkeypatch.setattr(runtime,"batch_pool",pool)
    monkeypatch.setattr(runtime,"panel_work_budget",lambda count: .04)
    results=await runtime.batch_quota([f"synthetic{i}.json" for i in range(25)])
    assert len(results)==25 and len(calls)==5
    assert all(r["error_code"]=="quota_timeout" for r in results)
    assert all(r["status_code"]==504 for r in results)
    assert sum(r["started"] for r in results)==5
    pool.begin_close(); await pool.wait_closed(time.monotonic()+1)


async def test_client_disconnect_removes_unstarted_batch(monkeypatch):
    from src.panel import antigravity_manual as manual
    import src.antigravity_batch_runtime as runtime
    pool=BatchQuotaPool(); calls=[]
    async def quota(name,**kwargs): calls.append(name)
    async def disconnected(): return True
    monkeypatch.setattr(manual,"quota",quota)
    monkeypatch.setattr(runtime,"batch_pool",pool)
    result=await runtime.batch_quota([f"synthetic{i}.json" for i in range(15)],
                                   request=SimpleNamespace(is_disconnected=disconnected))
    assert len(result)==15 and all(r["error_code"]=="quota_cancelled" for r in result)
    assert not calls and not pool.queued
    pool.begin_close(); await pool.wait_closed(time.monotonic()+1)


async def test_slow_http_cancel_cleanup_keeps_slot_without_hanging_waiter():
    broker=DirectoryBroker(capacity=1)
    cleanup=asyncio.Event(); cancellation=asyncio.Event()
    async def transport(timeout):
        try: await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancellation.set(); await cleanup.wait()
    start=time.monotonic()
    with pytest.raises(QuotaWorkError):
        await broker.run(transport, timeout=.02)
    assert time.monotonic()-start < .3
    await cancellation.wait()
    assert len(broker.active)==1
    blocked=asyncio.create_task(broker.run(lambda t: asyncio.sleep(0,result=42),deadline=time.monotonic()+1))
    await _turns(); assert broker.queued==1
    cleanup.set()
    assert await blocked==42
    await _turns(); assert not broker.active


@pytest.mark.parametrize("count", [23, 100])
async def test_large_legacy_batches_keep_ten_item_windows(monkeypatch, count):
    from src.panel import antigravity_manual as manual
    import src.antigravity_batch_runtime as runtime
    pool=BatchQuotaPool(); sizes=[]; seen=[]; original=pool.submit
    def submit(names,request_id,deadline):
        sizes.append(len(names)); return original(names,request_id,deadline)
    async def quota(name,**kwargs):
        kwargs["_on_started"](); seen.append(name)
        return {"filename":name,"success":True}
    monkeypatch.setattr(pool,"submit",submit)
    monkeypatch.setattr(manual,"quota",quota)
    monkeypatch.setattr(runtime,"batch_pool",pool)
    names=[f"synthetic{i}.json" for i in range(count)]
    results=await runtime.batch_quota(names)
    assert sizes == [10]*(count//10)+([count%10] if count%10 else [])
    assert [r["filename"] for r in results]==names and sorted(seen)==sorted(names)
    assert not pool.queued and not pool.active
    pool.begin_close(); await pool.wait_closed(time.monotonic()+1)


async def test_default_http_queue_is_bounded_at_two_hundred():
    broker=DirectoryBroker(); gate=asyncio.Event()
    tasks=[asyncio.create_task(broker.run(lambda t: gate.wait())) for _ in range(205)]
    await _turns()
    assert len(broker.active)==5 and broker.queued==200
    with pytest.raises(QuotaWorkError,match="quota_queue_full"):
        await broker.run(lambda t: gate.wait())
    gate.set(); await asyncio.gather(*tasks)
    assert not broker.active and not broker.queued
    assert AtomicRegistry().limit==200 and BatchQuotaPool().queue_limit==200


async def test_shutdown_budget_starts_at_signal_not_drain(monkeypatch):
    import src.antigravity_directory_runtime as runtime
    import src.antigravity_batch_runtime as batch
    registry=AtomicRegistry(); gate=asyncio.Event()
    monkeypatch.setattr(runtime,"atomic_registry",registry)
    monkeypatch.setattr(runtime,"directory_broker",DirectoryBroker())
    monkeypatch.setattr(batch,"batch_pool",BatchQuotaPool())
    monkeypatch.setenv("ANTIGRAVITY_SHUTDOWN_GRACE_SECONDS","5.03")
    operation=asyncio.create_task(registry.run(lambda: gate.wait()))
    await _turns()
    start=time.monotonic(); deadline=runtime.begin_directory_shutdown()
    await asyncio.sleep(.02)
    assert await runtime.wait_directory_shutdown(deadline)==1
    assert time.monotonic()-start < .1
    assert registry.tasks and registry.closing
    with pytest.raises(QuotaWorkError,match="quota_shutdown"):
        await registry.run(lambda: asyncio.sleep(0))
    gate.set(); await operation; await _turns()
    assert not registry.tasks


async def test_catalog_cas_timeout_preserves_fetched_models(monkeypatch):
    from unittest.mock import AsyncMock
    from src.api import antigravity as api
    import src.antigravity_directory_runtime as runtime
    registry=AtomicRegistry(); gate=asyncio.Event()
    async def observe(*args,**kwargs): await gate.wait(); return True
    store=SimpleNamespace(model_access_storage_ready=True,
        model_access_snapshot=AsyncMock(return_value={"generation":"g","version":"v"}),
        model_access_observe=observe,model_access_union=AsyncMock(return_value=set()))
    manager=SimpleNamespace(_storage_adapter=SimpleNamespace(_backend=store),
        get_valid_credential=AsyncMock(return_value=("synthetic.json",{"access_token":"synthetic",
            "_quota_generation":"g","_quota_credential_version":"v"})))
    monkeypatch.setattr(api,"credential_manager",SimpleNamespace(_get_or_create=AsyncMock(return_value=manager)))
    monkeypatch.setattr(api,"fetch_quota_info",AsyncMock(return_value={"success":True,"models":{"claude-sonnet-4-6":{}}}))
    monkeypatch.setattr(runtime,"atomic_registry",registry)
    token=runtime.work_deadline.set(time.monotonic()+.03)
    try: result=await api.fetch_available_models()
    finally: runtime.work_deadline.reset(token)
    assert [r["id"] for r in result]==["claude-sonnet-4-6"]
    assert len(registry.tasks)==1
    gate.set(); await _turns()
    assert not registry.tasks


async def test_lease_cleanup_waits_for_unconfirmed_atomic_operation():
    registry=AtomicRegistry(); gate=asyncio.Event(); order=[]
    async def write(): await gate.wait(); order.append("commit")
    async def clear(): order.append("lease_clear")
    async def caller():
        try: await registry.run(write,deadline=time.monotonic()+.02)
        except SettlementPending:
            registry.cleanup_after(asyncio.current_task(),clear)
    await caller()
    assert order==[] and len(registry.tasks)==1
    gate.set(); await _turns(10)
    assert order==["commit","lease_clear"] and not registry.tasks


async def test_background_pending_refresh_does_not_start_result_cas(monkeypatch):
    import src.antigravity_access_runtime as runtime
    registry=AtomicRegistry(); gate=asyncio.Event(); writes=[]; cleared=[]
    class Backend:
        async def model_access_claim(self,*args,**kwargs):
            return {"generation":"g","version":"v","lease_id":"lease","access":{}}
        async def quota_current_credential(self,*args): return {"access_token":"synthetic"}
        async def model_access_observe(self,*args,**kwargs): writes.append(1)
        async def model_access_clear_lease(self,*args): cleared.append(1)
    async def refresh(*args,atomic,deadline,**kwargs):
        await atomic(lambda:gate.wait(),deadline=deadline,phase="credential_cas")
    async def needed(data): return True
    manager=SimpleNamespace(_storage_adapter=SimpleNamespace(_backend=Backend()),
                            _should_refresh_token=needed,_refresh_token=refresh)
    monkeypatch.setattr(runtime,"atomic_registry",registry)
    monkeypatch.setattr(runtime,"QUERY_TIMEOUT",.08)
    assert await runtime.ModelAccessService().check(manager,"synthetic.json") is False
    assert not writes and not cleared and len(registry.tasks)==1
    gate.set(); await _turns(10)
    assert cleared==[1] and not writes and not registry.tasks
