"""Regression tests for Antigravity credential model testing."""

import copy
import json
import time

from src import httpx_client
from src.api import antigravity as antigravity_api
from src.api.utils import parse_and_log_cooldown
from src.panel import creds as creds_panel
from src.utils import (
    ANTIGRAVITY_CLI_VERSION,
    ANTIGRAVITY_USER_AGENT,
    BASE_MODELS,
    GEMINICLI_MODEL_ALIASES,
)


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


def test_antigravity_headers_allow_only_safe_forwarded_values():
    headers = antigravity_api.build_antigravity_headers(
        "real-access-token",
        {
            "Authorization": "Bearer attacker-token",
            "User-Agent": "attacker-agent",
            "Content-Type": "text/plain",
            "Connection": "close",
            "Host": "attacker.invalid",
            "Cookie": "session=secret",
            "Proxy-Authorization": "Basic secret",
            "Accept-Language": "zh-CN",
            "Traceparent": "00-trace-parent",
            "X-B3-TraceId": "b3-trace",
            "X-Request-ID": "client-request-id",
        },
    )

    assert headers["Authorization"] == "Bearer real-access-token"
    assert headers["User-Agent"] == ANTIGRAVITY_USER_AGENT
    assert headers["Content-Type"] == "application/json"
    assert headers["Accept"] == "*/*"
    assert "Connection" not in headers
    assert "Host" not in headers
    assert "Cookie" not in headers
    assert "Proxy-Authorization" not in headers
    assert headers["Accept-Language"] == "zh-CN"
    assert headers["Traceparent"] == "00-trace-parent"
    assert headers["X-B3-TraceId"] == "b3-trace"
    assert headers["X-Request-ID"] == "client-request-id"


async def test_wrap_cli_request_deep_copies_and_preserves_explicit_mode(monkeypatch):
    state = antigravity_api.AntigravitySessionState(
        conversation_id="conversation",
        trajectory_id="trajectory",
        session_id="-123",
        step_index=7,
        created_at=1.0,
        last_used_at=1.0,
    )

    async def fake_get_session_state(request_payload, model=""):
        return state

    monkeypatch.setattr(
        antigravity_api, "_get_session_state", fake_get_session_state
    )
    request = {
        "contents": [
            {"role": "user", "parts": [{"text": "hello"}]},
        ],
        "toolConfig": {
            "functionCallingConfig": {
                "mode": "ANY",
                "allowedFunctionNames": ["lookup"],
            }
        },
        "safetySettings": [{"category": "example"}],
    }
    original = copy.deepcopy(request)

    payload, request_id = await antigravity_api.wrap_cli_request(
        request, "gemini-3.5-flash-low", "project-id"
    )

    assert request == original
    assert payload["request"] is not request
    assert payload["request"]["contents"] is not request["contents"]
    assert "safetySettings" not in payload["request"]
    assert payload["request"]["sessionId"] == "-123"
    assert payload["request"]["labels"]["last_step_index"] == "7"
    assert payload["request"]["toolConfig"]["functionCallingConfig"] == {
        "mode": "ANY",
        "allowedFunctionNames": ["lookup"],
    }
    assert request_id.startswith("agent/conversation/")
    assert request_id.endswith("/trajectory/7")


async def test_wrap_cli_request_defaults_mode_and_keeps_session_progress(monkeypatch):
    monkeypatch.setattr(antigravity_api, "_redis_checked", True)
    monkeypatch.setattr(antigravity_api, "_redis_client", None)
    monkeypatch.setattr(antigravity_api, "_session_states", {})
    request = {
        "contents": [
            {"role": "user", "parts": [{"text": "same conversation"}]},
        ]
    }

    first, _ = await antigravity_api.wrap_cli_request(
        request, "gemini-3.5-flash-low", "project-id"
    )
    second, _ = await antigravity_api.wrap_cli_request(
        request, "gemini-3.5-flash-low", "project-id"
    )

    assert "sessionId" not in request
    assert first["request"]["sessionId"] == second["request"]["sessionId"]
    assert first["request"]["labels"]["trajectory_id"] == (
        second["request"]["labels"]["trajectory_id"]
    )
    assert first["request"]["labels"]["last_step_index"] == "1"
    assert second["request"]["labels"]["last_step_index"] == "2"
    assert first["request"]["toolConfig"]["functionCallingConfig"]["mode"] == (
        "VALIDATED"
    )


def test_synced_antigravity_version_and_gemini35_models_are_preserved():
    assert ANTIGRAVITY_CLI_VERSION == "1.1.9"
    assert ANTIGRAVITY_USER_AGENT.startswith("antigravity/cli/1.1.9 ")
    assert "gemini-3.5-flash" in BASE_MODELS
    assert "gemini-3.5-flash-preview" in BASE_MODELS
    assert GEMINICLI_MODEL_ALIASES["gemini-3.5-flash-preview"] == (
        "gemini-3-flash"
    )


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
    assert captured_request["url"] == (
        "https://antigravity.test/v1internal:generateContent"
    )
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
