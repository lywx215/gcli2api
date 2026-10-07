"""Legacy/shared quota helper: local scheduling errors are not access evidence."""
import copy
import time
from types import SimpleNamespace

import pytest

from src.antigravity_model_access import FAMILIES, MODELS, QUERY_RETRY
from src.panel import creds as panel
from test_antigravity_model_access import access_store, observe, NAME


@pytest.mark.parametrize("error_code", ["quota_queue_full", "quota_timeout", "quota_shutdown", None])
async def test_legacy_quota_only_google_failure_sets_access_backoff(access_store, monkeypatch, error_code):
    store = access_store
    clock = time.time()
    monkeypatch.setattr("src.storage.antigravity_model_access.time.time", lambda: clock)
    await observe(store, MODELS, now=clock - 1)
    before = copy.deepcopy((await store.model_access_snapshot(NAME))["access"])
    epoch = getattr(store, "_panel_epoch", 0)
    observations = []
    real_observe = store.model_access_observe

    async def observe_result(*args, **kwargs):
        observations.append(kwargs)
        return await real_observe(*args, **kwargs)

    class Credentials:
        @classmethod
        def from_dict(cls, data):
            value = cls()
            value.data = data
            return value
        async def refresh_if_needed(self):
            return False
        def to_dict(self):
            return self.data

    async def adapter():
        return SimpleNamespace(_backend=store, get_credential=store.get_credential)

    upstream = {"success": False, "upstream_status": None if error_code else 403,
                "error": "Quota query could not complete." if error_code else "Permission denied.",
                "models": {}}
    if error_code:
        upstream.update(error_code=error_code, phase="http_queue")

    async def fetch(*args, **kwargs):
        return copy.deepcopy(upstream)

    monkeypatch.setattr(panel, "Credentials", Credentials)
    monkeypatch.setattr(panel, "get_storage_adapter", adapter)
    monkeypatch.setattr(panel, "fetch_quota_info", fetch)
    monkeypatch.setattr(store, "model_access_observe", observe_result)
    # This default helper path is shared by legacy panel and existing Management callers.
    result = await panel._fetch_quota_for_credential(NAME, "antigravity")
    after = (await store.model_access_snapshot(NAME))["access"]
    assert result["success"] is False
    assert result["upstream_status"] == upstream["upstream_status"]
    if error_code:
        assert result["error_code"] == error_code
        assert observations == []
        assert after == before
        assert getattr(store, "_panel_epoch", 0) == epoch
    else:
        assert len(observations) == 1
        assert observations[0]["reason"] == "directory_query_failed"
        for family in FAMILIES:
            assert after["families"][family]["reason"] == "directory_query_failed"
            assert after["families"][family]["next_check_at"] == clock + QUERY_RETRY
