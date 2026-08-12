"""Regression coverage for Antigravity model tests and cooldown decisions."""

import json
import time

from src import httpx_client
from src.api.utils import parse_and_log_cooldown
from src.panel import creds as creds_panel


class _FakeBackend:
    def __init__(self):
        self.success_calls = []
        self.cooldown_calls = []

    async def record_success(self, filename, *, model_name, mode):
        self.success_calls.append((filename, model_name, mode))

    async def set_model_cooldown(self, filename, model_name, cooldown_until, mode):
        self.cooldown_calls.append((filename, model_name, cooldown_until, mode))
        return True


class _FakeStorageAdapter:
    def __init__(self):
        self._backend = _FakeBackend()
        self.state = {}

    async def get_credential(self, filename, mode="geminicli"):
        return {
            "access_token": "test-access-token",
            "project_id": "test-project",
        }

    async def get_credential_state(self, filename, mode="geminicli"):
        return self.state


class _FakeCredentials:
    async def refresh_if_needed(self):
        return False


class _FakeCredentialsFactory:
    @staticmethod
    def from_dict(data):
        return _FakeCredentials()


class _FakeResponse:
    status_code = 200


async def test_antigravity_specific_model_uses_current_header_signature(monkeypatch):
    storage = _FakeStorageAdapter()
    captured_request = {}

    async def fake_get_storage_adapter():
        return storage

    async def fake_get_antigravity_api_url():
        return "https://antigravity.test"

    async def fake_post_async(**kwargs):
        captured_request.update(kwargs)
        return _FakeResponse()

    monkeypatch.setattr(creds_panel, "get_storage_adapter", fake_get_storage_adapter)
    monkeypatch.setattr(
        creds_panel, "get_antigravity_api_url", fake_get_antigravity_api_url
    )
    monkeypatch.setattr(creds_panel, "Credentials", _FakeCredentialsFactory)
    monkeypatch.setattr(httpx_client, "post_async", fake_post_async)

    response = await creds_panel.test_credential_common(
        "credential.json",
        mode="antigravity",
        model="gemini-3.6-flash-high",
    )
    payload = json.loads(response.body)

    assert response.status_code == 200
    assert payload["success"] is True
    assert captured_request["json"]["model"] == "gemini-3.6-flash-high"
    assert captured_request["headers"]["Authorization"] == (
        "Bearer test-access-token"
    )
    assert storage._backend.success_calls == [
        ("credential.json", "gemini-3.6-flash-high", "antigravity")
    ]


async def test_antigravity_generic_429_does_not_create_persistent_cooldown():
    error_text = json.dumps(
        {
            "error": {
                "code": 429,
                "message": "Resource has been exhausted (e.g. check quota).",
                "status": "RESOURCE_EXHAUSTED",
                "details": [],
            }
        }
    )

    assert await parse_and_log_cooldown(error_text, mode="antigravity") is None


async def test_antigravity_explicit_quota_429_keeps_persistent_cooldown():
    error_text = json.dumps(
        {
            "error": {
                "code": 429,
                "status": "RESOURCE_EXHAUSTED",
                "details": [
                    {
                        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                        "reason": "QUOTA_EXHAUSTED",
                        "metadata": {},
                    }
                ],
            }
        }
    )
    before = time.time()

    cooldown_until = await parse_and_log_cooldown(
        error_text, mode="antigravity"
    )

    assert cooldown_until is not None
    assert before + 4 * 3600 - 1 <= cooldown_until <= time.time() + 4 * 3600 + 1


async def test_positive_live_quota_clears_existing_model_cooldown():
    storage = _FakeStorageAdapter()
    storage.state = {
        "model_cooldowns": {
            "gemini-3.6-flash-tiered": time.time() + 4 * 3600,
        }
    }

    result = await creds_panel.sync_model_cooldowns_from_quota(
        storage,
        "credential.json",
        "antigravity",
        {"gemini-3.6-flash-tiered": {"remaining": 1.0}},
    )

    assert result == {"cleared": ["gemini-3.6-flash-tiered"], "added": []}
    assert storage._backend.cooldown_calls == [
        ("credential.json", "gemini-3.6-flash-tiered", None, "antigravity")
    ]
