import json

import pytest

from src.panel import creds


class _SummaryBackend:
    def __init__(self):
        self.requested_limit = None
        self.include_error_classifications = None

    async def get_credentials_summary(self, **kwargs):
        self.requested_limit = kwargs["limit"]
        self.include_error_classifications = kwargs["include_error_classifications"]
        return {
            "items": [],
            "total": 0,
            "stats": {"total": 0, "normal": 0, "disabled": 0},
        }


class _StorageAdapter:
    def __init__(self):
        self._backend = _SummaryBackend()

    async def get_backend_info(self):
        return {"backend_type": "test"}


@pytest.mark.asyncio
async def test_credential_status_accepts_page_size_25(monkeypatch):
    storage = _StorageAdapter()

    async def get_storage_adapter():
        return storage

    monkeypatch.setattr(creds, "get_storage_adapter", get_storage_adapter)

    response = await creds.get_creds_status_common(
        offset=0,
        limit=25,
        status_filter="all",
    )
    payload = json.loads(response.body)

    assert response.status_code == 200
    assert payload["limit"] == 25
    assert storage._backend.requested_limit == 25
    assert storage._backend.include_error_classifications is True
