"""Refresh preservation uses synthetic credentials and temporary SQLite only."""
import copy
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from src import antigravity_email_enrichment as enrichment
from src.credential_manager import CredentialManager
from src.google_oauth_api import Credentials
from src.storage.antigravity_quota import credential_version
from src.storage.sqlite_manager import SQLiteManager
from test_antigravity_email_enrichment import registry, started, complete, stop


NAME = "synthetic-refresh-preservation.json"
ABSENT = "absent"


def uploaded(credit=ABSENT, alias=True):
    data = {"access_token": "synthetic-old", "refresh_token": "synthetic-refresh",
            "expiry": "2000-01-01T00:00:00Z", "project_id": "synthetic-project",
            "client_id": "synthetic-client", "client_secret": "synthetic-secret",
            "type": "authorized_user", "scopes": ["synthetic-scope"],
            "token_uri": "https://example.invalid/token",
            "custom_upload_metadata": {"nested": [0, False, "synthetic-value"]}}
    if credit != ABSENT:
        data["enable_credit"] = credit
    if alias:
        data["token"] = "synthetic-old"
    return data


@pytest.fixture
async def backend(tmp_path, monkeypatch):
    monkeypatch.setenv("CREDENTIALS_DIR", str(tmp_path))
    manager = SQLiteManager()
    await manager.initialize()
    try:
        yield manager
    finally:
        await manager.close()


@pytest.fixture
def refreshed(monkeypatch):
    async def refresh(self):
        self.access_token = "synthetic-new"
        self.refresh_token = "synthetic-rotated"
        self.expires_at = datetime(2099, 1, 1, tzinfo=timezone.utc)
    monkeypatch.setattr(Credentials, "refresh", refresh)


def assert_preserved(original, saved):
    changed = {"access_token", "refresh_token", "token", "expiry"}
    assert {k: v for k, v in saved.items() if k not in changed} == {
        k: v for k, v in original.items() if k not in changed}
    assert saved["access_token"] == "synthetic-new"
    assert saved["refresh_token"] == "synthetic-rotated"
    assert saved["expiry"].startswith("2099-01-01")
    if "token" in original:
        assert saved["token"] == saved["access_token"]
    else:
        assert "token" not in saved
    assert not any(k.startswith("_quota_") for k in saved)


@pytest.mark.parametrize("credit", [ABSENT, False, True])
async def test_auto_email_refresh_preserves_uploaded_fields(backend, registry, refreshed, credit):
    original = uploaded(credit)
    receipt = await backend.import_antigravity_credential_with_receipt(NAME, original)
    untouched = copy.deepcopy(original)
    service, _, _ = await started(backend)
    try:
        batch = service.batch()
        batch.add(receipt)
        batch.seal()
        final = await complete(service, batch)
        assert final["counts"].get("success") == 1
        saved = await backend.get_credential(NAME, "antigravity")
        assert_preserved(original, saved)
        assert (await backend.get_credential_state(NAME, "antigravity"))["user_email"] == "account@example.test"
        fence = await backend.quota_credential_fence(NAME)
        assert fence["quota_credential_generation"] == receipt.generation
        assert fence["_quota_credential_version"] == credential_version(saved)
        assert original == untouched
    finally:
        await stop(service)


@pytest.mark.parametrize("alias", [False, True])
async def test_manual_email_refresh_preserves_uploaded_fields(backend, refreshed, monkeypatch, alias):
    original = uploaded(True, alias=alias)
    await backend.import_antigravity_credential_with_receipt(NAME, original)
    manager = CredentialManager()
    manager._initialized = True
    manager._storage_adapter = SimpleNamespace(_backend=backend,
        get_credential=backend.get_credential, get_credential_state=backend.get_credential_state)
    monkeypatch.setattr("src.google_oauth_api.get_user_email", AsyncMock(return_value="account@example.test"))
    assert await manager.get_or_fetch_user_email(NAME, "antigravity") == "account@example.test"
    assert_preserved(original, await backend.get_credential(NAME, "antigravity"))
    assert (await backend.get_credential_state(NAME, "antigravity"))["user_email"] == "account@example.test"


@pytest.mark.parametrize("credit", [ABSENT, False, True])
async def test_raw_snapshot_does_not_overlay_runtime_credit(backend, credit):
    original = uploaded(credit)
    receipt = await backend.import_antigravity_credential_with_receipt(NAME, original)
    normal = await backend.quota_current_credential(NAME, receipt.generation)
    raw = await backend.quota_current_credential(NAME, receipt.generation, include_credit_state=False)
    assert normal["enable_credit"] is False  # legacy default control-state projection
    assert {k:v for k,v in raw.items() if not k.startswith("_quota_")} == original
    assert raw["_quota_credential_version"] == normal["_quota_credential_version"] == receipt.credential_version
    assert await backend.get_credential(NAME, "antigravity") == original


@pytest.mark.parametrize("change", ["generation", "version"])
async def test_auto_refresh_rejects_concurrent_replacement(backend, registry, monkeypatch, change):
    receipt = await backend.import_antigravity_credential_with_receipt(NAME, uploaded(True))
    replacement = {"access_token":"synthetic-replacement", "custom_upload_metadata":{"preserve":True}}
    async def refresh(self):
        if change == "generation":
            await backend.import_antigravity_credential_with_receipt(NAME, replacement)
        else:
            assert await backend.quota_refresh_credential(NAME, receipt.generation, replacement,
                                                         expected_version=receipt.credential_version)
        self.access_token = "synthetic-stale-refresh"
    monkeypatch.setattr(Credentials, "refresh", refresh)
    service, _, fetch = await started(backend)
    try:
        batch = service.batch()
        batch.add(receipt)
        batch.seal()
        final = await complete(service, batch)
        assert final["counts"].get("superseded") == 1
        fetch.assert_not_awaited()
        assert await backend.get_credential(NAME, "antigravity") == replacement
        assert not (await backend.get_credential_state(NAME, "antigravity")).get("user_email")
    finally:
        await stop(service)


async def test_failed_refresh_leaves_upload_unchanged(backend, registry, monkeypatch):
    original = uploaded(True)
    receipt = await backend.import_antigravity_credential_with_receipt(NAME, original)
    async def refresh(self):
        raise RuntimeError("synthetic-refresh-failed")
    monkeypatch.setattr(Credentials, "refresh", refresh)
    service, _, fetch = await started(backend)
    try:
        batch = service.batch()
        batch.add(receipt)
        batch.seal()
        assert (await complete(service, batch))["counts"].get("failed") == 1
        fetch.assert_not_awaited()
        assert await backend.get_credential(NAME, "antigravity") == original
    finally:
        await stop(service)
