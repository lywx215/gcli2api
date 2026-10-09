"""Synthetic-only API/background tests: no real credentials or upstream calls."""
import asyncio
import io
import json
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI, UploadFile
from src import antigravity_email_enrichment as enrichment
from src.antigravity_directory_runtime import AtomicRegistry, AtomicSettlement, SettlementPending
from src.storage.antigravity_import import ImportReceipt
from src.storage.antigravity_quota import credential_version
from src.panel import creds, antigravity_import

pytestmark = pytest.mark.asyncio
DATA = {"access_token": "synthetic-access", "refresh_token": "synthetic-refresh", "expiry": "2099-01-01T00:00:00Z"}


class Store:
    model_access_storage_ready = True
    def __init__(self):
        self.data = dict(DATA)
        self.generation = "synthetic-generation"
        self.email = None
        self.writes = []
        self.gate = None
        self.entered = asyncio.Event()
        self.result = True

    async def import_antigravity_credential_with_receipt(self, filename, data, **kwargs):
        self.data = dict(data)
        self.email = None
        return self.receipt(filename)

    def receipt(self, filename="1621_test.json", supported=True):
        return ImportReceipt(filename, self.generation, credential_version(self.data), supported)

    async def quota_current_credential(self, filename, generation):
        if generation != self.generation:
            return None
        return {**self.data, "_quota_generation": generation, "_quota_credential_version": credential_version(self.data), "enable_credit": False}

    async def quota_refresh_credential(self, filename, generation, data, expected_version=None, state_updates=None):
        self.writes.append((data, state_updates))
        self.entered.set()
        if self.gate:
            await self.gate.wait()
        if isinstance(self.result, BaseException):
            raise self.result
        if self.result is False or generation != self.generation or expected_version != credential_version(self.data):
            return False
        if data is not None:
            self.data = data
        if state_updates:
            self.email = state_updates.get("user_email")
        return True


@pytest.fixture
def registry(monkeypatch):
    value = AtomicRegistry()
    monkeypatch.setattr(enrichment, "atomic_registry", value)
    return value


async def started(store=None, **kwargs):
    store = store or Store()
    fetch = AsyncMock(return_value="account@example.test")
    service = enrichment.EmailEnrichmentService(manager=store, fetch_email=fetch, **kwargs)
    await service.start(single_worker=True, backend=store)
    return service, store, fetch


async def complete(service, batch):
    for _ in range(200):
        result = service.snapshot(batch.job.job_id)
        if result["complete"]:
            return result
        await asyncio.sleep(.005)
    raise AssertionError("job did not finish")


async def stop(service):
    await service.close(deadline=time.monotonic()+.2)


async def test_new_receipt_email_is_fenced_and_safe(registry):
    service, store, fetch = await started()
    batch = service.batch()
    batch.add(store.receipt())
    batch.seal()
    result = await complete(service, batch)
    assert result["counts"]["success"] == 1
    assert result["items"] == [{"filename":"1621_test.json", "status":"success", "reason":None, "user_email":"account@example.test"}]
    assert store.email == "account@example.test"
    assert "synthetic-generation" not in json.dumps(result)
    assert "synthetic-access" not in json.dumps(result)
    fetch.assert_awaited_once()
    await stop(service)


@pytest.mark.parametrize("change", ["generation", "version"])
async def test_replaced_receipt_never_calls_google(registry, change):
    service, store, fetch = await started()
    receipt = store.receipt()
    if change == "generation":
        store.generation = "new-generation"
    else:
        store.data = {**store.data, "refresh_token":"different-synthetic"}
    batch = service.batch()
    batch.add(receipt)
    batch.seal()
    result = await complete(service, batch)
    assert result["counts"]["superseded"] == 1 and not store.writes
    fetch.assert_not_awaited()
    await stop(service)


@pytest.mark.parametrize("result,status", [(True,"success"), (False,"superseded"), (RuntimeError("synthetic-private"),"unknown")])
async def test_late_email_settlement_retains_slot_and_truth(registry, result, status):
    store = Store()
    store.gate, store.result = asyncio.Event(), result
    service, _, _ = await started(store, worker_count=1, execution_budget=.02)
    batch = service.batch()
    batch.add(store.receipt())
    batch.add(store.receipt("second.json"))
    batch.seal()
    await store.entered.wait()
    await asyncio.sleep(.04)
    assert service.snapshot(batch.job.job_id)["items"][0]["status"] == "settlement_pending"
    assert len(store.writes) == 1
    store.gate.set()
    final = await complete(service, batch)
    assert final["items"][0]["status"] == status
    assert "synthetic-private" not in json.dumps(final)
    await stop(service)


async def test_late_token_success_is_not_email_success(registry, monkeypatch):
    from src.google_oauth_api import Credentials
    async def refresh(self):
        self.access_token = "synthetic-refreshed"
        return True
    monkeypatch.setattr(Credentials, "refresh_if_needed", refresh)
    store = Store()
    store.gate = asyncio.Event()
    service, _, fetch = await started(store, worker_count=1, execution_budget=.02)
    batch = service.batch()
    batch.add(store.receipt())
    batch.seal()
    await store.entered.wait()
    await asyncio.sleep(.04)
    assert service.snapshot(batch.job.job_id)["items"][0]["status"] == "settlement_pending"
    store.gate.set()
    result = await complete(service, batch)
    assert result["items"][0]["status"] == "failed"
    assert result["items"][0]["reason"] == "token_saved_email_not_fetched"
    fetch.assert_not_awaited()
    assert len(store.writes) == 1
    await stop(service)


async def test_token_refresh_normal_success_advances_email_version(registry, monkeypatch):
    from src.google_oauth_api import Credentials
    async def refresh(self):
        self.access_token = "synthetic-refreshed"
        return True
    monkeypatch.setattr(Credentials, "refresh_if_needed", refresh)
    service, store, _ = await started()
    batch = service.batch()
    batch.add(store.receipt())
    batch.seal()
    final = await complete(service, batch)
    assert final["counts"]["success"] == 1 and len(store.writes) == 2
    assert store.data["access_token"] == "synthetic-refreshed"
    assert not any(key.startswith("_quota_") for key in store.data)
    await stop(service)


async def test_google_timeout_and_missing_email_leave_saved_upload(registry):
    service, store, fetch = await started(execution_budget=.01)
    async def never(_):
        await asyncio.sleep(10)
    service.fetch_email = never
    batch = service.batch()
    batch.add(store.receipt())
    batch.seal()
    assert (await complete(service,batch))["items"][0]["reason"] == "execution_timeout"
    assert not store.writes and store.data == DATA
    await stop(service)


async def test_queue_expiry_runs_while_all_execution_slots_are_pending(registry):
    store = Store()
    store.gate = asyncio.Event()
    service, _, _ = await started(store, worker_count=1, execution_budget=.01, queue_ttl=.05)
    batch = service.batch()
    batch.add(store.receipt())
    await store.entered.wait()
    batch.add(store.receipt("queued.json"))
    batch.seal()
    await asyncio.sleep(1.05)  # independent housekeeping, not worker dequeue
    assert batch.job.items[1].reason == "queue_timeout" and batch.job.items[1].status == "failed"
    assert len(store.writes) == 1
    store.gate.set()
    await complete(service,batch)
    await stop(service)


async def test_capacity_disabled_backend_and_expiry_do_not_change_saved_data(registry):
    service = enrichment.EmailEnrichmentService(queue_limit=1, job_limit=1, item_limit=2, terminal_ttl=.01)
    service.enabled = True
    store = Store()
    batch = service.batch()
    batch.add(store.receipt())
    batch.add(store.receipt("full.json"))
    batch.add(store.receipt("unrecorded.json"))
    batch.seal()
    assert batch.public()["accepted"] == 1 and batch.public()["skipped"] == 2
    assert batch.job.items[1].reason == "queue_full" and batch.job.omitted == 1
    assert service.new_job() is None
    service.begin_close()
    batch.job.finished_at -= .1
    assert service.snapshot(batch.job.job_id) is None
    disabled = enrichment.EmailEnrichmentService()
    await disabled.start(single_worker=None, backend=store)
    assert disabled.enabled is False
    await disabled.start(single_worker=False, backend=store)
    assert disabled.enabled is False
    store.model_access_storage_ready = False
    await disabled.start(single_worker=True, backend=store)
    assert disabled.enabled is False


async def test_unsupported_receipt_is_skipped_without_lookup(registry):
    service, store, fetch = await started()
    batch = service.batch()
    batch.add(store.receipt(supported=False))
    batch.seal()
    assert (await complete(service,batch))["items"][0]["reason"] == "identity_fence_unavailable"
    assert batch.warnings
    fetch.assert_not_awaited()
    await stop(service)


async def test_cancelled_http_import_enqueues_its_late_receipt(registry, monkeypatch):
    store = Store()
    service, _, fetch = await started(store)
    monkeypatch.setattr(enrichment,"email_enrichment_service",service)
    gate, entered = asyncio.Event(), asyncio.Event()
    async def save(filename, data, **kwargs):
        entered.set()
        await gate.wait()
        return store.receipt(filename)
    manager = SimpleNamespace(add_antigravity_credential_with_receipt=save)
    batch = service.batch()
    async def upload():
        try:
            await enrichment.import_with_email_receipt(manager,"late.json",DATA,email_batch=batch)
        finally:
            batch.seal()
    request = asyncio.create_task(upload())
    await entered.wait()
    request.cancel()
    with pytest.raises(asyncio.CancelledError):
        await request
    assert batch.job.sealed and not batch.job.complete and batch.job.imports_pending == 1
    gate.set()
    result = await complete(service,batch)
    assert result["items"][0]["filename"] == "late.json" and batch.accepted == 1
    fetch.assert_awaited_once()
    await stop(service)


async def test_shutdown_deadline_reports_unknown_and_no_rollback(registry, monkeypatch):
    store = Store()
    store.gate = asyncio.Event()
    service, _, _ = await started(store, execution_budget=.01)
    batch = service.batch()
    batch.add(store.receipt())
    batch.seal()
    await store.entered.wait()
    await service.close(deadline=time.monotonic()+.01)
    snapshot = service.snapshot(batch.job.job_id)
    item = snapshot["items"][0]
    assert item["status"] == "unknown" and item["reason"] == "shutdown_commit_unconfirmed"
    annotations = service.annotations([item["filename"]])
    assert annotations[item["filename"]] == {
        "email_enrichment_status":"unknown", "email_enrichment_reason":"shutdown_commit_unconfirmed"}
    # The panel list forwards the same enum rather than translated/free-form text.
    store.get_antigravity_panel_summary = AsyncMock(return_value={
        "items":[{"filename":item["filename"], "user_email":None, "disabled":False,
                  "error_codes":[], "last_success":None}], "total":1,
        "stats":{"total":1}, "model_access_summary":{"total":1}})
    adapter = SimpleNamespace(_backend=store,
        get_backend_info=AsyncMock(return_value={"backend_type":"synthetic"}))
    monkeypatch.setattr(creds,"get_storage_adapter",AsyncMock(return_value=adapter))
    monkeypatch.setattr(creds,"email_enrichment_service",service)
    response = await creds.get_creds_status_common(0,25,"all","antigravity")
    listed = json.loads(response.body)
    assert listed["items"][0]["email_enrichment_reason"] == "shutdown_commit_unconfirmed"
    public = json.dumps({"snapshot":snapshot,"annotations":annotations,"list":listed})
    assert item["reason"].isascii() and "rollback" not in public
    for secret in ("synthetic-access","synthetic-refresh","synthetic-generation"):
        assert secret not in public
    assert not service.enabled
    store.gate.set()
    await asyncio.wait(service.workers,timeout=.2)
    late = service.snapshot(batch.job.job_id)["items"][0]
    assert late["status"] == "success" and late["reason"] is None
    assert service.annotate(item["filename"])["email_enrichment_reason"] is None


async def test_cancel_race_without_owner_map_still_waits_for_exact_operation(monkeypatch, registry):
    class DelayedRegistry:
        def __init__(self):
            self.callback = None
        async def run(self, operation, **kwargs):
            coro = operation()
            coro.close()  # deterministic fake commit: factory already scheduled
            self.callback = kwargs["on_settled"]
            raise asyncio.CancelledError
    delayed = DelayedRegistry()
    monkeypatch.setattr(enrichment,"atomic_registry",delayed)
    service = enrichment.EmailEnrichmentService()
    store = Store()
    item = enrichment.EmailItem("race.json", store.receipt())
    task = asyncio.create_task(service._write(item,store,"email_write",None,item.receipt.credential_version,time.monotonic()+1))
    await asyncio.sleep(0)
    assert item.status == "settlement_pending" and not task.done()
    delayed.callback(AtomicSettlement("succeeded",True))
    assert await task is False and item.status == "success"


async def test_progress_requires_auth_and_pages_safe_items(registry,monkeypatch):
    service, store, _ = await started()
    batch=service.batch()
    batch.add(store.receipt())
    batch.seal()
    await complete(service,batch)
    monkeypatch.setattr(creds,"email_enrichment_service",service)
    app=FastAPI()
    app.include_router(creds.router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url="http://test") as client:
        assert (await client.get(f"/creds/email-enrichment/{batch.job.job_id}")).status_code == 401
        app.dependency_overrides[creds.verify_panel_token]=lambda:"synthetic-panel-token"
        result=await client.get(f"/creds/email-enrichment/{batch.job.job_id}",params={"offset":0,"limit":1})
        assert result.status_code==200 and len(result.json()["items"])==1
        assert "credential_version" not in result.text and "generation" not in result.text
        assert (await client.get("/creds/email-enrichment/missing")).status_code==404
        assert (await client.get(f"/creds/email-enrichment/{batch.job.job_id}?limit=201")).status_code==400
    await stop(service)


async def test_files_zip_and_oauth_immediately_share_receipt_queue(registry,monkeypatch):
    import zipfile
    from src import auth
    service, store, _ = await started()
    monkeypatch.setattr(enrichment,"email_enrichment_service",service)
    monkeypatch.setattr(antigravity_import,"email_enrichment_service",service)
    manager=SimpleNamespace(add_antigravity_credential_with_receipt=store.import_antigravity_credential_with_receipt)
    archive=io.BytesIO()
    with zipfile.ZipFile(archive,"w") as z:
        z.writestr("1621_inside.json",json.dumps(DATA))
    files=[UploadFile(filename="1621_file.json",file=io.BytesIO(json.dumps(DATA).encode())),
           UploadFile(filename="archive.zip",file=io.BytesIO(archive.getvalue()))]
    response=await antigravity_import.upload_antigravity_files(files,manager)
    body=json.loads(response.body)
    assert body["uploaded_count"]==2 and body["email_enrichment"]["accepted"]==2
    assert service.snapshot(body["email_enrichment"]["job_id"])["sealed"]
    monkeypatch.setattr(auth,"get_storage_adapter",AsyncMock(return_value=store))
    from src.google_oauth_api import Credentials
    public={}
    filename=await auth.save_credentials(Credentials.from_dict(DATA),"synthetic-project",mode="antigravity",email_result=public)
    assert isinstance(filename,str) and public["email_enrichment"]["accepted"]==1
    assert service.snapshot(public["email_enrichment"]["job_id"])["sealed"]
    await stop(service)

async def test_enabled_single_and_batch_rt_routes_report_only_saved_enqueues(registry,monkeypatch):
    from src.models import RefreshTokenAddRequest, RefreshTokenBatchAddRequest
    from src.credential_manager import CredentialStorageError
    service, store, fetch = await started()
    monkeypatch.setattr(enrichment,"email_enrichment_service",service)
    monkeypatch.setattr(creds,"email_enrichment_service",service)
    async def save(filename,data,**kwargs):
        if filename == "batch-2.json":
            raise CredentialStorageError()
        return await store.import_antigravity_credential_with_receipt(filename,data,**kwargs)
    manager=SimpleNamespace(add_antigravity_credential_with_receipt=save)
    monkeypatch.setattr(creds,"credential_manager",manager)
    monkeypatch.setattr(creds,"_exchange_refresh_token_to_credential",AsyncMock(return_value=dict(DATA)))
    monkeypatch.setattr(creds,"fetch_project_id_and_tier",AsyncMock(return_value=("synthetic-project","pro")))
    monkeypatch.setattr(creds,"get_antigravity_api_url",AsyncMock(return_value="https://example.test"))
    one=await creds.upload_credentials_by_refresh_token(RefreshTokenAddRequest(
        mode="antigravity",refresh_token="synthetic-secret",project_id="synthetic-project",custom_filename="1621_single"),token="synthetic-panel")
    data=json.loads(one.body)
    assert one.status_code==200 and data["email_enrichment"]["accepted"]==1
    assert data["warnings"]==[]
    assert service.snapshot(data["email_enrichment"]["job_id"])["sealed"]
    batch=await creds.upload_credentials_by_refresh_token_batch(RefreshTokenBatchAddRequest(
        mode="antigravity",refresh_tokens=["synthetic-secret-1","synthetic-secret-2"],filename_prefix="batch"),token="synthetic-panel")
    data=json.loads(batch.body)
    assert data["success_count"]==1 and data["failure_count"]==1
    assert data["email_enrichment"]["accepted"]==1 and data["email_enrichment"]["skipped"]==0
    assert service.snapshot(data["email_enrichment"]["job_id"])["sealed"]
    assert "synthetic-secret" not in batch.body.decode()
    await stop(service)

async def test_cancelled_late_import_retention_starts_only_after_work_is_terminal(registry, monkeypatch):
    clock = [100.0]
    monkeypatch.setattr(enrichment, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    service = enrichment.EmailEnrichmentService()
    service.enabled = True  # keep the receipt queued without running network work
    monkeypatch.setattr(enrichment, "email_enrichment_service", service)
    store = Store()
    gate, entered = asyncio.Event(), asyncio.Event()
    async def save(filename, data, **kwargs):
        entered.set()
        await gate.wait()
        return store.receipt(filename)
    batch = service.batch()
    async def upload():
        try:
            await enrichment.import_with_email_receipt(
                SimpleNamespace(add_antigravity_credential_with_receipt=save),
                "late-retained.json", DATA, email_batch=batch)
        finally:
            batch.seal()
    waiter = asyncio.create_task(upload())
    await entered.wait()
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter
    assert batch.job.sealed and batch.job.imports_pending == 1
    gate.set()
    for _ in range(10):
        await asyncio.sleep(0)
        if batch.accepted:
            break
    assert batch.accepted == 1 and batch.job.imports_pending == 0
    assert batch.job.items[0].status == "queued" and batch.job.finished_at is None
    item = batch.job.items[0]
    item.queued_at = clock[0]
    # Also repair a stale timestamp rather than trusting it to expire active work.
    batch.job.finished_at = clock[0]
    clock[0] += service.terminal_ttl + 1
    state = service.snapshot(batch.job.job_id)
    assert state is not None and not state["complete"] and item.status == "queued"
    assert batch.job.finished_at is None
    service.queue.popleft()
    item.status = "running"
    batch.job.finished_at = 100.0
    clock[0] += service.terminal_ttl + 1
    state = service.snapshot(batch.job.job_id)
    assert state is not None and not state["complete"] and item.status == "running"
    assert batch.job.finished_at is None
    item.status = "success"
    service.finish_job(batch.job)
    finished = clock[0]
    assert batch.job.finished_at == finished
    clock[0] += service.terminal_ttl - 1
    assert service.snapshot(batch.job.job_id) is not None
    clock[0] += 2
    assert service.snapshot(batch.job.job_id) is None


async def test_import_notification_failure_balances_pending_counter(registry, monkeypatch):
    service = enrichment.EmailEnrichmentService()
    service.enabled = True
    batch = service.batch()
    def broken_add(receipt):
        raise RuntimeError("synthetic enqueue failure")
    monkeypatch.setattr(batch, "add", broken_add)
    store = Store()
    await enrichment.import_with_email_receipt(store, "notification.json", DATA, email_batch=batch)
    assert batch.job.imports_pending == 0
    batch.seal()
    assert batch.job.complete


async def test_annotations_traverse_records_once_for_a_large_page_and_keep_newest(monkeypatch):
    clock = [100.0]
    monkeypatch.setattr(enrichment, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    service = enrichment.EmailEnrichmentService()
    service.enabled = True
    visits = [0]
    class CountedItems(list):
        def __reversed__(self):
            for item in super().__reversed__():
                visits[0] += 1
                yield item
    old = service.new_job()
    # Include 1,000 names with no match so traversal must visit all 5,000 records.
    receipt = Store().receipt()
    old.items = CountedItems(enrichment.EmailItem(f"record-{i}.json", receipt, status="success")
                             for i in range(4999))
    old.sealed = True
    newest = service.new_job()
    newest.items = CountedItems([enrichment.EmailItem("record-0.json", receipt,
                               status="failed", reason="email_unavailable")])
    newest.sealed = True
    page = [f"missing-{i}.json" for i in range(1000)] + ["record-0.json"]
    result = service.annotations(page)
    assert visits[0] == 5000
    assert result == {"record-0.json": {"email_enrichment_status":"failed",
                                      "email_enrichment_reason":"email_unavailable"}}
    assert "generation" not in json.dumps(result) and "synthetic-access" not in json.dumps(result)
    assert service.annotate("record-0.json") == result["record-0.json"]
    # Expiry can fall back to an older live record; all stale records disappear.
    clock[0] = 200.0
    old.finished_at = clock[0]
    newest.finished_at = clock[0] - service.terminal_ttl
    assert service.annotations(["record-0.json"])["record-0.json"]["email_enrichment_status"] == "success"
    clock[0] += service.terminal_ttl
    assert service.annotations(["record-0.json"]) == {}

@pytest.mark.parametrize("kind", ["json", "zip", "empty_rt", "invalid_rt", "batch_invalid_rt"])
async def test_more_than_job_limit_failed_uploads_do_not_reserve_email_jobs(registry, monkeypatch, kind):
    from fastapi import HTTPException
    from src.models import RefreshTokenAddRequest, RefreshTokenBatchAddRequest
    service = enrichment.EmailEnrichmentService()
    service.enabled = True
    monkeypatch.setattr(enrichment, "email_enrichment_service", service)
    monkeypatch.setattr(antigravity_import, "email_enrichment_service", service)
    monkeypatch.setattr(creds, "email_enrichment_service", service)
    never_store = AsyncMock(side_effect=AssertionError("failed validation/exchange must not save"))
    manager = SimpleNamespace(add_antigravity_credential_with_receipt=never_store)
    monkeypatch.setattr(creds, "credential_manager", manager)
    exchange = AsyncMock(side_effect=RuntimeError("synthetic exchange rejection"))
    monkeypatch.setattr(creds, "_exchange_refresh_token_to_credential", exchange)
    for _ in range(service.job_limit + 2):
        if kind in ("json", "zip"):
            filename, data = ("invalid.json", b"{") if kind == "json" else ("invalid.zip", b"not a ZIP")
            result = await antigravity_import.upload_antigravity_files(
                [UploadFile(filename=filename, file=io.BytesIO(data))], manager)
            assert result.status_code == 400
            public = json.loads(result.body)["email_enrichment"]
            assert public["job_id"] is None and public["status_url"] is None
        elif kind == "empty_rt":
            with pytest.raises(HTTPException) as exc:
                await creds.upload_credentials_by_refresh_token(
                    RefreshTokenAddRequest(mode="antigravity", refresh_token=" "), token="synthetic-panel")
            assert exc.value.status_code == 400
        elif kind == "invalid_rt":
            result = await creds.upload_credentials_by_refresh_token(
                RefreshTokenAddRequest(mode="antigravity", refresh_token="synthetic-rejected"), token="synthetic-panel")
            assert result.status_code == 400
        else:
            result = await creds.upload_credentials_by_refresh_token_batch(
                RefreshTokenBatchAddRequest(mode="antigravity", refresh_tokens=["synthetic-rejected"]), token="synthetic-panel")
            public = json.loads(result.body)
            assert public["success_count"] == 0
            assert public["email_enrichment"]["job_id"] is None
            assert public["email_enrichment"]["status_url"] is None
        assert service.jobs == {} and not service.queue
    never_store.assert_not_awaited()
    if kind == "empty_rt":
        exchange.assert_not_awaited()
    # A valid upload still gets the full job capacity immediately afterward.
    store = Store()
    result = await antigravity_import.upload_antigravity_files(
        [UploadFile(filename="valid.json", file=io.BytesIO(json.dumps(DATA).encode()))],
        SimpleNamespace(add_antigravity_credential_with_receipt=store.import_antigravity_credential_with_receipt))
    public = json.loads(result.body)["email_enrichment"]
    assert result.status_code == 200 and public["accepted"] == 1
    assert public["job_id"] is not None and service.snapshot(public["job_id"]) is not None
    service.begin_close()


async def test_empty_discarded_batch_cannot_reappear_or_leave_unpollable_queue(registry):
    service = enrichment.EmailEnrichmentService()
    service.enabled = True
    batch = service.batch()
    job_id = batch.job.job_id
    assert batch.public()["job_id"] is None  # response is built before request finally seals
    batch.seal()
    assert job_id not in service.jobs and batch.job.finished_at is None
    batch.add(Store().receipt("discarded.json"))
    assert batch.public() == {"job_id":None, "accepted":0, "skipped":1, "status_url":None}
    batch.seal()
    service.purge()
    assert service.snapshot(job_id) is None and not service.queue and service.jobs == {}


async def test_omitted_only_job_retains_counts_and_public_reference(registry):
    service = enrichment.EmailEnrichmentService(item_limit=0)
    service.enabled = True
    batch = service.batch()
    batch.add(Store().receipt("omitted.json"))
    assert batch.job.items == [] and batch.job.omitted == 1
    assert batch.public()["job_id"] == batch.job.job_id
    batch.seal()
    result = service.snapshot(batch.job.job_id)
    assert result["complete"] and result["total"] == 0 and result["counts"]["skipped"] == 1
    assert batch.public()["skipped"] == 1 and result["items"] == []


async def test_close_can_remove_multiple_sealed_empty_jobs_without_iteration_error(registry):
    service = enrichment.EmailEnrichmentService()
    service.enabled = True
    jobs = [service.new_job(), service.new_job()]
    for job in jobs:
        job.sealed = True  # simulate seal discovered by the close pass
    await service.close(deadline=time.monotonic()+.01)
    assert service.jobs == {}

async def test_clean_lifecycle_restart_restores_four_workers_and_processes_new_upload(registry):
    service, store, fetch = await started()
    first = service.batch()
    first.add(store.receipt("first-cycle.json"))
    first.seal()
    assert (await complete(service, first))["counts"]["success"] == 1
    old_workers, old_housekeeper = tuple(service.workers), service.housekeeper
    await stop(service)
    assert all(task.done() for task in old_workers) and old_housekeeper.done()
    assert not service.supports(store)
    await service.start(single_worker=True, backend=store)
    assert service.supports(store) and not service.closing
    assert len(service.workers) == 4 and all(not task.done() for task in service.workers)
    assert not set(service.workers).intersection(old_workers)
    assert service.housekeeper is not old_housekeeper and not service.housekeeper.done()
    new_workers, new_housekeeper = tuple(service.workers), service.housekeeper
    # Repeated startup of a live lifecycle preserves the same fixed task set.
    await service.start(single_worker=True, backend=store)
    assert tuple(service.workers) == new_workers and service.housekeeper is new_housekeeper
    second = service.batch()
    second.add(store.receipt("second-cycle.json"))
    second.seal()
    assert (await complete(service, second))["counts"]["success"] == 1
    assert fetch.await_count == 2 and len(store.writes) == 2
    assert first.job.items[0].status == "success"  # history was not scanned/retried
    await stop(service)


async def test_restart_defers_until_old_cas_workers_settle_without_extra_slots(registry):
    store = Store()
    store.gate = asyncio.Event()
    service, _, fetch = await started(store)
    first = service.batch()
    first.add(store.receipt("pending-cycle.json"))
    first.seal()
    await store.entered.wait()
    old_workers, old_housekeeper = tuple(service.workers), service.housekeeper
    closing = asyncio.create_task(service.close(deadline=time.monotonic()+.03))
    await asyncio.sleep(0)
    assert not service.enabled and service.closing
    await service.start(single_worker=True, backend=store)
    assert tuple(service.workers) == old_workers and service.housekeeper is old_housekeeper
    assert not service.enabled
    await closing
    assert first.job.items[0].status == "unknown"
    assert any(not task.done() for task in old_workers) and len(registry.tasks) == 1
    for _ in range(3):
        await service.start(single_worker=True, backend=store)
        assert tuple(service.workers) == old_workers and service.housekeeper is old_housekeeper
        assert not service.supports(store) and service.closing
    rejected = service.batch()
    rejected.add(store.receipt("while-stopping.json"))
    rejected.seal()
    assert rejected.job is None and rejected.accepted == 0 and not service.queue
    assert fetch.await_count == 1 and len(store.writes) == 1
    store.gate.set()
    await asyncio.wait(old_workers, timeout=.3)
    assert all(task.done() for task in old_workers) and old_housekeeper.done()
    assert first.job.items[0].status == "success"  # exact original CAS confirmation
    await service.start(single_worker=True, backend=store)
    assert service.supports(store) and len(service.workers) == 4
    assert not set(service.workers).intersection(old_workers)
    assert service.housekeeper is not old_housekeeper
    second = service.batch()
    second.add(store.receipt("after-settlement.json"))
    second.seal()
    assert (await complete(service, second))["counts"]["success"] == 1
    assert fetch.await_count == 2 and len(store.writes) == 2
    await stop(service)
