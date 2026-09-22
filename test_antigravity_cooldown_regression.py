"""Regression coverage for Antigravity model tests and cooldown decisions."""

import json
import time

from src import httpx_client
from src.api.utils import (
    parse_and_log_cooldown,
    parse_antigravity_quota_reset_timestamp,
)
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

    def __init__(self, reply="测试成功"):
        self._payload = {
            "response": {
                "candidates": [
                    {"content": {"parts": [{"text": reply}]}}
                ]
            }
        }
        self.text = json.dumps(self._payload, ensure_ascii=False)
        self.content = self.text.encode("utf-8")

    def json(self):
        return self._payload


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
    assert captured_request["json"]["request"]["contents"][0]["parts"][0][
        "text"
    ].endswith("测试成功")
    assert captured_request["json"]["request"]["generationConfig"] == {
        "maxOutputTokens": 256
    }


async def test_antigravity_specific_model_rejects_deprecation_text(monkeypatch):
    storage = _FakeStorageAdapter()

    async def fake_get_storage_adapter():
        return storage

    async def fake_get_antigravity_api_url():
        return "https://antigravity.test"

    async def fake_post_async(**kwargs):
        return _FakeResponse(
            "Gemini 3.5 Flash is no longer available. "
            "Please switch to Gemini 3.7 Flash in the latest version of Antigravity."
        )

    monkeypatch.setattr(creds_panel, "get_storage_adapter", fake_get_storage_adapter)
    monkeypatch.setattr(
        creds_panel, "get_antigravity_api_url", fake_get_antigravity_api_url
    )
    monkeypatch.setattr(creds_panel, "Credentials", _FakeCredentialsFactory)
    monkeypatch.setattr(httpx_client, "post_async", fake_post_async)

    response = await creds_panel.test_credential_common(
        "credential.json",
        mode="antigravity",
        model="gemini-3.5-flash-low",
    )
    payload = json.loads(response.body)

    assert response.status_code == 424
    assert payload["success"] is False
    assert payload["verified_reply"] is False
    assert "no longer available" in payload["model_reply"]
    assert storage._backend.success_calls == []


async def test_antigravity_model_test_uses_current_service_route(monkeypatch):
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
        model="gemini-3.1-pro-high",
    )

    assert response.status_code == 200
    assert captured_request["json"]["model"] == "gemini-pro-agent"


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
    assert before + 30 * 60 - 1 <= cooldown_until <= time.time() + 30 * 60 + 1


def test_antigravity_parser_checks_all_error_info_and_retry_info(monkeypatch):
    payload = {
        "error": {
            "details": [
                {
                    "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                    "metadata": {"quotaResetTimeStamp": "invalid"},
                },
                {
                    "@type": "type.googleapis.com/google.rpc.RetryInfo",
                    "retryDelay": "2.5s",
                },
            ]
        }
    }
    monkeypatch.setattr(time, "time", lambda: 1_000.0)

    assert parse_antigravity_quota_reset_timestamp(payload) == 1_002.5


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
