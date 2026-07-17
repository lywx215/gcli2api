"""Tests for Tier detection during Gemini CLI credential file upload."""

import json

from src.panel import creds as creds_panel
from src.subscription_tiers import (
    GeminiCliSubscriptionInfo,
    TIER_CODE_ASSIST_ENTERPRISE,
)


class FakeStorageAdapter:
    def __init__(self):
        self.store_calls = []
        self.state_calls = []
        self.state = {}

    async def store_credential(self, filename, data, mode="geminicli"):
        self.store_calls.append((filename, dict(data), mode))
        return True

    async def update_credential_state(self, filename, state, mode="geminicli"):
        self.state_calls.append((filename, dict(state), mode))
        return True
    async def get_credential_state(self, filename, mode="geminicli"):
        return dict(self.state)



class FakeCredentials:
    access_token = "access-token"
    refresh_token = None

    def is_expired(self):
        return False


class FakeCredentialsFactory:
    @staticmethod
    def from_dict(data):
        return FakeCredentials()


async def test_uploaded_credential_detects_and_persists_tier(monkeypatch):
    storage = FakeStorageAdapter()

    async def fake_get_storage_adapter():
        return storage

    async def fake_endpoint():
        return "https://example.test"

    async def fake_fetch(**kwargs):
        return GeminiCliSubscriptionInfo(
            project_id="detected-project",
            tier=TIER_CODE_ASSIST_ENTERPRISE,
            raw_tier_id="gcp-enterprise-tier",
            raw_tier_name="Gemini Code Assist Enterprise",
            detected_at=123456,
            status="detected",
        )

    monkeypatch.setattr(creds_panel, "get_storage_adapter", fake_get_storage_adapter)
    monkeypatch.setattr(creds_panel, "get_code_assist_endpoint", fake_endpoint)
    monkeypatch.setattr(creds_panel, "fetch_geminicli_subscription_info", fake_fetch)
    monkeypatch.setattr(creds_panel, "Credentials", FakeCredentialsFactory)

    credential_data = {"access_token": "access-token", "project_id": "old-project"}
    info = await creds_panel._detect_uploaded_geminicli_subscription(
        "uploaded.json", credential_data
    )

    assert info.tier == TIER_CODE_ASSIST_ENTERPRISE
    assert credential_data["project_id"] == "detected-project"
    assert storage.store_calls[0][2] == "geminicli"
    assert storage.state_calls == [
        (
            "uploaded.json",
            {
                "tier": TIER_CODE_ASSIST_ENTERPRISE,
                "tier_raw_id": "gcp-enterprise-tier",
                "tier_raw_name": "Gemini Code Assist Enterprise",
                "tier_detected_at": 123456,
            },
            "geminicli",
        )
    ]


async def test_uploaded_credential_unavailable_does_not_overwrite_state(monkeypatch):
    storage = FakeStorageAdapter()
    storage.state = {
        "tier": TIER_CODE_ASSIST_ENTERPRISE,
        "tier_raw_id": "gcp-enterprise-tier",
        "tier_raw_name": "Gemini Code Assist Enterprise",
        "tier_detected_at": 123456,
    }

    async def fake_get_storage_adapter():
        return storage

    async def fake_endpoint():
        return "https://example.test"

    async def fake_fetch(**kwargs):
        return GeminiCliSubscriptionInfo.unavailable("existing-project")

    monkeypatch.setattr(creds_panel, "get_storage_adapter", fake_get_storage_adapter)
    monkeypatch.setattr(creds_panel, "get_code_assist_endpoint", fake_endpoint)
    monkeypatch.setattr(creds_panel, "fetch_geminicli_subscription_info", fake_fetch)
    monkeypatch.setattr(creds_panel, "Credentials", FakeCredentialsFactory)

    info = await creds_panel._detect_uploaded_geminicli_subscription(
        "uploaded.json",
        {"access_token": "access-token", "project_id": "existing-project"},
    )

    assert info.status == "unavailable"
    assert info.tier == TIER_CODE_ASSIST_ENTERPRISE
    assert info.raw_tier_id == "gcp-enterprise-tier"
    assert info.raw_tier_name == "Gemini Code Assist Enterprise"
    assert info.detected_at == 123456
    assert storage.store_calls == []
    assert storage.state_calls == []


async def test_upload_response_contains_detected_tier(monkeypatch):
    async def fake_add_credential(filename, credential_data):
        return None

    async def fake_detect(filename, credential_data):
        return GeminiCliSubscriptionInfo(
            project_id="project-123",
            tier=TIER_CODE_ASSIST_ENTERPRISE,
            raw_tier_id="gcp-enterprise-tier",
            raw_tier_name="Gemini Code Assist Enterprise",
            detected_at=123456,
            status="detected",
        )

    class FakeUpload:
        filename = "uploaded.json"

        def __init__(self):
            self._read = False

        async def read(self, size=-1):
            if self._read:
                return b""
            self._read = True
            return b'{"access_token": "access-token"}'

    monkeypatch.setattr(
        creds_panel.credential_manager, "add_credential", fake_add_credential
    )
    monkeypatch.setattr(
        creds_panel, "_detect_uploaded_geminicli_subscription", fake_detect
    )

    response = await creds_panel.upload_credentials_common(
        [FakeUpload()], mode="geminicli"
    )
    payload = json.loads(response.body)

    assert payload["uploaded_count"] == 1
    assert payload["results"][0]["subscription_tier"] == TIER_CODE_ASSIST_ENTERPRISE
    assert payload["results"][0]["tier_detection_status"] == "detected"
