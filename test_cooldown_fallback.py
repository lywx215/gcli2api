"""Regression tests for channel-specific quota cooldown fallbacks."""

import json
import time
from datetime import datetime, timedelta, timezone

import pytest

from src.api import utils as api_utils
from src.models import CredFileBatchTestRequest
from src.panel import creds as creds_panel


def _resource_exhausted(reason=None, metadata=None):
    details = []
    if reason:
        details.append(
            {
                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                "reason": reason,
                "metadata": metadata or {},
            }
        )
    return {
        "error": {
            "code": 429,
            "status": "RESOURCE_EXHAUSTED",
            "details": details,
        }
    }


@pytest.mark.asyncio
async def test_geminicli_explicit_quota_without_reset_uses_30_minute_fallback():
    before = time.time()
    result = await api_utils.parse_and_log_cooldown(
        json.dumps(_resource_exhausted("QUOTA_EXHAUSTED")),
        mode="geminicli",
    )

    assert result is not None
    assert before + 1800 - 1 <= result <= time.time() + 1800 + 1


@pytest.mark.asyncio
async def test_geminicli_generic_resource_exhausted_uses_fallback_when_smart_off(
    monkeypatch,
):
    monkeypatch.setattr(api_utils, "is_smart_429_protection_enabled", lambda: False)
    before = time.time()
    result = await api_utils.parse_and_log_cooldown(
        json.dumps(_resource_exhausted()),
        mode="geminicli",
    )

    assert result is not None
    assert before + 1800 - 1 <= result <= time.time() + 1800 + 1


def test_google_reset_delay_is_not_replaced_by_channel_fallback():
    before = time.time()
    result = api_utils.parse_quota_reset_timestamp(
        _resource_exhausted(
            "QUOTA_EXHAUSTED",
            {"quotaResetDelay": "1m30s"},
        ),
        mode="geminicli",
    )

    assert result is not None
    assert before + 89 <= result <= time.time() + 91


def test_google_reset_timestamp_over_30_minutes_is_not_truncated():
    reset_at = datetime.now(timezone.utc) + timedelta(hours=2)
    result = api_utils.parse_quota_reset_timestamp(
        _resource_exhausted(
            "QUOTA_EXHAUSTED",
            {"quotaResetTimeStamp": reset_at.isoformat().replace("+00:00", "Z")},
        ),
        mode="geminicli",
    )

    assert result == pytest.approx(reset_at.timestamp(), abs=0.001)


def test_capacity_exhaustion_still_has_no_persistent_cooldown():
    result = api_utils.parse_quota_reset_timestamp(
        _resource_exhausted("MODEL_CAPACITY_EXHAUSTED"),
        mode="geminicli",
    )

    assert result is None


def test_generic_resource_exhausted_still_has_no_cooldown_when_smart_on(
    monkeypatch,
):
    monkeypatch.setattr(api_utils, "is_smart_429_protection_enabled", lambda: True)

    assert api_utils.parse_quota_reset_timestamp(
        _resource_exhausted(), mode="geminicli"
    ) is None


class _FakeBackend:
    def __init__(self):
        self.cooldown_calls = []

    async def set_model_cooldown(self, filename, model_name, cooldown_until, mode):
        self.cooldown_calls.append((filename, model_name, cooldown_until, mode))
        return True


class _FakeStorage:
    def __init__(self, state=None):
        self._backend = _FakeBackend()
        self.state = state or {}

    async def get_credential_state(self, filename, mode="geminicli"):
        return self.state


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("mode", "fallback_seconds"),
    [("geminicli", 1800), ("antigravity", 4 * 3600)],
)
async def test_single_quota_sync_uses_channel_fallback(mode, fallback_seconds):
    storage = _FakeStorage()
    before = time.time()

    result = await creds_panel.sync_model_cooldowns_from_quota(
        storage,
        "credential.json",
        mode,
        {"gemini-test": {"remaining": 0}},
    )

    assert result == {"cleared": [], "added": ["gemini-test"]}
    cooldown_until = storage._backend.cooldown_calls[0][2]
    assert before + fallback_seconds - 1 <= cooldown_until <= (
        time.time() + fallback_seconds + 1
    )


@pytest.mark.asyncio
async def test_single_quota_sync_keeps_explicit_reset_and_active_cooldown():
    active_until = time.time() + 600
    storage = _FakeStorage(
        {"model_cooldowns": {"active-model": active_until}}
    )
    reset_at = datetime.now(timezone.utc) + timedelta(hours=2)

    result = await creds_panel.sync_model_cooldowns_from_quota(
        storage,
        "credential.json",
        "geminicli",
        {
            "active-model": {"remaining": 0},
            "reset-model": {
                "remaining": 0,
                "resetTimeRaw": reset_at.isoformat().replace("+00:00", "Z"),
            },
        },
    )

    assert result == {"cleared": [], "added": ["reset-model"]}
    assert storage._backend.cooldown_calls == [
        (
            "credential.json",
            "reset-model",
            pytest.approx(reset_at.timestamp(), abs=0.001),
            "geminicli",
        )
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("mode", "fallback_seconds"),
    [("geminicli", 1800), ("antigravity", 4 * 3600)],
)
async def test_batch_quota_sync_uses_channel_fallback(
    monkeypatch, mode, fallback_seconds
):
    storage = _FakeStorage()

    async def fake_get_storage_adapter():
        return storage

    async def fake_fetch_quota(filename, mode):
        return {
            "success": True,
            "models": {"gemini-test": {"remaining": 0}},
        }

    monkeypatch.setattr(creds_panel, "get_storage_adapter", fake_get_storage_adapter)
    monkeypatch.setattr(
        creds_panel, "_fetch_quota_for_credential", fake_fetch_quota
    )
    before = time.time()

    response = await creds_panel.batch_refresh_cooldown(
        CredFileBatchTestRequest(filenames=["credential.json"]),
        mode=mode,
        _token="test-token",
    )

    payload = json.loads(response.body)
    assert payload["success_count"] == 1
    assert payload["added_total"] == 1
    cooldown_until = storage._backend.cooldown_calls[0][2]
    assert before + fallback_seconds - 1 <= cooldown_until <= (
        time.time() + fallback_seconds + 1
    )
