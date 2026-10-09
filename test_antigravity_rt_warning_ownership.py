"""RT warning ownership regressions; synthetic receipts, no provider calls."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI

from src import antigravity_email_enrichment as enrichment
from src.antigravity_directory_runtime import AtomicRegistry
from src.credential_manager import CredentialStorageError
from src.panel import creds
from src.storage.antigravity_import import ImportReceipt

pytestmark = pytest.mark.asyncio
DATA = {"access_token": "synthetic-access", "refresh_token": "synthetic-refresh"}


@pytest.fixture
def rt_context(monkeypatch):
    monkeypatch.setattr(enrichment, "atomic_registry", AtomicRegistry())
    service = enrichment.EmailEnrichmentService(
        fetch_email=AsyncMock(side_effect=AssertionError("no provider requests")))
    # Exercise actual receipt admission without starting background network work.
    service.enabled = True
    monkeypatch.setattr(creds, "email_enrichment_service", service)
    monkeypatch.setattr(creds, "_exchange_refresh_token_to_credential",
                        AsyncMock(return_value=dict(DATA)))
    monkeypatch.setattr(creds, "fetch_project_id_and_tier",
                        AsyncMock(return_value=("synthetic-project", "pro")))
    monkeypatch.setattr(creds, "get_antigravity_api_url",
                        AsyncMock(return_value="https://example.test"))
    app = FastAPI()
    app.include_router(creds.router)
    app.dependency_overrides[creds.verify_panel_token] = lambda: "synthetic-panel"
    return service, app


def receipt(filename, supported=True):
    return ImportReceipt(filename, "synthetic-generation", "synthetic-version", supported)


async def post(app, path, data):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                base_url="http://test") as client:
        response = await client.post(path, json={"mode": "antigravity", **data})
    assert response.status_code == 200
    body = response.json()
    for secret in ("synthetic-access", "synthetic-refresh", "synthetic-generation",
                   "synthetic-version"):
        assert secret not in response.text
    return body


@pytest.mark.parametrize("skip_reason", ["identity_fence_unavailable", "queue_full"])
async def test_concurrent_rt_batch_does_not_copy_prior_skip_warning(
    rt_context, monkeypatch, skip_reason
):
    service, app = rt_context
    entered = set()
    both_started, skipped = asyncio.Event(), asyncio.Event()
    saved = []
    if skip_reason == "queue_full":
        service.queue_limit = 0
    enqueue = service.enqueue

    def ordered_enqueue(job, item_receipt):
        admitted = enqueue(job, item_receipt)
        if item_receipt.filename == "batch-1.json":
            assert not admitted
            service.queue_limit = 1000
            skipped.set()
        return admitted

    monkeypatch.setattr(service, "enqueue", ordered_enqueue)

    async def save(filename, data, **kwargs):
        entered.add(filename)
        if len(entered) == 2:
            both_started.set()
        await asyncio.wait_for(both_started.wait(), timeout=2)
        if filename == "batch-2.json":
            await asyncio.wait_for(skipped.wait(), timeout=2)
        saved.append(filename)
        return receipt(filename, supported=(filename != "batch-1.json"
                       or skip_reason != "identity_fence_unavailable"))

    monkeypatch.setattr(creds, "credential_manager", SimpleNamespace(
        add_antigravity_credential_with_receipt=save))
    body = await post(app, "/creds/upload-by-refresh-token-batch", {
        "refresh_tokens": ["synthetic-refresh-1", "synthetic-refresh-2"],
        "filename_prefix": "batch"})
    assert saved == ["batch-1.json", "batch-2.json"]
    assert body["success_count"] == 2 and body["failure_count"] == 0
    assert body["warnings"] == [enrichment.WARNING]
    assert body["email_enrichment"]["accepted"] == 1
    assert body["email_enrichment"]["skipped"] == 1
    # Email warnings belong to the shared batch; no row inherits another row's warning.
    assert [item["warnings"] for item in body["results"]] == [[], []]
    snapshot = service.snapshot(body["email_enrichment"]["job_id"])
    assert snapshot["sealed"]
    assert snapshot["counts"] == {"skipped": 1, "queued": 1}
    assert [(item["filename"], item["reason"]) for item in snapshot["items"]] == [
        ("batch-1.json", skip_reason), ("batch-2.json", None)]
    service.fetch_email.assert_not_awaited()


@pytest.mark.parametrize("direct", [False, True])
async def test_single_rt_skip_still_reports_its_own_warning(rt_context, monkeypatch, direct):
    service, app = rt_context
    save = AsyncMock(return_value=receipt("single.json", supported=False))
    monkeypatch.setattr(creds, "credential_manager", SimpleNamespace(
        add_antigravity_credential_with_receipt=save))
    if direct:
        body = await creds._add_credential_by_refresh_token(
            "synthetic-refresh", None, None, "synthetic-project", "single", "antigravity")
    else:
        body = await post(app, "/creds/upload-by-refresh-token", {
            "refresh_token": "synthetic-refresh", "project_id": "synthetic-project",
            "custom_filename": "single"})
        assert body["email_enrichment"]["accepted"] == 0
        assert body["email_enrichment"]["skipped"] == 1
    assert body["success"] and body["warnings"] == [enrichment.WARNING]
    save.assert_awaited_once()
    service.fetch_email.assert_not_awaited()


@pytest.mark.parametrize("fail_last", [False, True])
async def test_rt_batch_accepted_receipts_and_saved_counts(rt_context, monkeypatch, fail_last):
    service, app = rt_context
    saved = []

    async def save(filename, data, **kwargs):
        if fail_last and filename == "batch-2.json":
            raise CredentialStorageError()
        saved.append(filename)
        return receipt(filename)

    monkeypatch.setattr(creds, "credential_manager", SimpleNamespace(
        add_antigravity_credential_with_receipt=save))
    body = await post(app, "/creds/upload-by-refresh-token-batch", {
        "refresh_tokens": ["synthetic-refresh-1", "synthetic-refresh-2"],
        "filename_prefix": "batch"})
    assert body["success_count"] == len(saved) == 2 - int(fail_last)
    assert body["failure_count"] == int(fail_last)
    assert body["email_enrichment"]["accepted"] == len(saved)
    assert body["email_enrichment"]["skipped"] == 0
    assert body["warnings"] == []
    assert all(item["warnings"] == [] for item in body["results"])
    assert service.snapshot(body["email_enrichment"]["job_id"])["sealed"]
    service.fetch_email.assert_not_awaited()
