"""Quota-summary contract tests use synthetic HTTP and isolated SQLite only."""
import asyncio
import json
import time
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from src.antigravity_directory_runtime import DirectoryBroker, work_class, work_deadline, work_progress
from src.panel import creds as panel
from src.panel import quota_summary as summary
from src.panel.quota_summary_normalize import normalize_summary
from src.storage.sqlite_manager import SQLiteManager

NAME = "synthetic-summary.json"
CREDENTIAL = {"access_token": "synthetic-access", "refresh_token": "synthetic-refresh",
              "client_id": "synthetic-client", "client_secret": "synthetic-secret",
              "project_id": "synthetic-project", "expiry": "2099-01-01T00:00:00Z"}
RESET = "2026-10-14T08:00:00Z"


def ag_payload():
    return {"groups": [{"groupId": "shared", "displayName": "Shared allowance",
                        "description": "Synthetic quota", "buckets": [
        {"bucketId": "five-hours", "displayName": "5 hours", "window": "5h",
         "remainingFraction": 0.0, "resetTime": RESET},
        {"bucketId": "week", "displayName": "Week", "window": "weekly",
         "remainingFraction": 0.75, "resetTime": RESET}]}]}


@pytest.fixture
async def store(tmp_path, monkeypatch):
    monkeypatch.setenv("CREDENTIALS_DIR", str(tmp_path))
    manager = SQLiteManager()
    await manager.initialize()
    for mode in ("antigravity", "geminicli"):
        await manager.store_credential(NAME, CREDENTIAL, mode)
    async def storage():
        return SimpleNamespace(_backend=manager, get_credential=manager.get_credential)
    async def endpoint():
        return "https://synthetic.invalid/configured"
    monkeypatch.setattr(panel, "get_storage_adapter", storage)
    monkeypatch.setattr(panel, "get_antigravity_api_url", endpoint)
    monkeypatch.setattr(panel, "get_code_assist_endpoint", endpoint)
    monkeypatch.setattr(summary, "directory_broker", DirectoryBroker(capacity=1))
    yield manager
    await manager.close()


async def install_post(monkeypatch, payload=None, status=200, action=None):
    calls = []
    async def post(**kwargs):
        calls.append(kwargs)
        if action:
            await action()
        return httpx.Response(status, json=payload if payload is not None else ag_payload())
    monkeypatch.setattr("src.httpx_client.post_async", post)
    return calls


@pytest.mark.parametrize("mode", ["antigravity", "geminicli"])
async def test_exact_configured_origin_payload_and_context(store, monkeypatch, mode):
    payload = ag_payload() if mode == "antigravity" else {"buckets": [
        {"modelId": "gemini-pro", "bucketId": "daily", "window": "daily",
         "remainingFraction": 0.4, "resetTime": RESET}]}
    classes = []
    async def action():
        classes.append((work_class.get(), work_deadline.get(), work_progress.get()["phase"]))
    calls = await install_post(monkeypatch, payload, action=action)
    result, status = await summary.fetch_summary(NAME, mode)
    assert status == 200 and result.status == "available"
    assert result.upstream_status == 200 and result.captured_at.endswith("Z")
    suffix = "retrieveUserQuotaSummary" if mode == "antigravity" else "retrieveUserQuota"
    assert calls[0]["url"] == f"https://synthetic.invalid/configured/v1internal:{suffix}"
    assert calls[0]["json"] == {"project": "synthetic-project"}
    assert calls[0]["follow_redirects"] is False
    assert calls[0]["timeout"] <= 30
    assert classes[0][0] == "interactive" and classes[0][1] > time.monotonic()
    assert classes[0][2] == "google"
    assert work_deadline.get() is None and work_progress.get() is None


@pytest.mark.parametrize("upstream", [200, 401, 403, 404, 405, 429, 500, 501])
async def test_summary_cannot_change_protection_cooldown_access_or_counts(store, monkeypatch, upstream):
    await store.set_model_cooldown(NAME, "gemini-pro-agent", time.time() + 3600, "antigravity")
    await store.update_credential_state(NAME, {"disabled": True, "permanent_disabled": True}, "antigravity")
    before = await store.manual_snapshot(NAME)
    async def forbidden(*args, **kwargs):
        raise AssertionError("summary must not perform quota/access/stat settlement")
    for name in ("manual_sync_quota", "manual_record_result", "quota_admit",
                 "model_access_observe", "model_access_observe_with_projection"):
        monkeypatch.setattr(store, name, forbidden)
    monkeypatch.setattr(panel, "fetch_quota_info", forbidden)
    calls = await install_post(monkeypatch, status=upstream)
    result, status = await summary.fetch_summary(NAME)
    assert status == 200 and result.upstream_status == upstream
    assert len(calls) == 1
    assert (await store.manual_snapshot(NAME))["raw"] == before["raw"]
    assert result.status == ("available" if upstream == 200 else
                             "unsupported" if upstream in (404, 405, 501) else "error")
    if upstream == 403:
        assert result.reason == "permission_denied"


@pytest.mark.parametrize("mode", ["antigravity", "geminicli"])
async def test_missing_project_is_local_and_does_not_refresh_or_configure(store, monkeypatch, mode):
    await store.store_credential(NAME, {**CREDENTIAL, "project_id": None, "expiry": None}, mode)
    async def forbidden(*args, **kwargs):
        raise AssertionError("no Google or project setup call is needed")
    monkeypatch.setattr("src.httpx_client.post_async", forbidden)
    monkeypatch.setattr(panel.Credentials, "refresh_if_needed", forbidden)
    monkeypatch.setattr(panel, "fetch_project_id_and_tier", forbidden)
    result, status = await summary.fetch_summary(NAME, mode)
    assert status == 200 and result.status == "unknown" and result.reason == "missing_project"
    assert result.upstream_status is None and result.captured_at is None


@pytest.mark.parametrize("mode", ["antigravity", "geminicli"])
async def test_missing_credential_and_bad_filename_do_not_dispatch(store, monkeypatch, mode):
    calls = await install_post(monkeypatch)
    result, status = await summary.fetch_summary("missing.json", mode)
    assert status == 404 and result.reason == "credential_not_found"
    result, status = await summary.fetch_summary("../synthetic-summary.json", mode)
    assert status == 400 and result.reason == "invalid_filename"
    assert calls == []


def test_ag_camel_and_snake_case_fields_and_whitelist():
    payload = {"quota_groups": [{"group_id": "g", "display_name": "Group",
        "description": "Known field", "refresh_token": "FORBIDDEN_SENTINEL", "quota_buckets": [
            {"bucket_id": "b", "display_name": "Bucket", "quota_window": "FIVE_HOURS",
             "remaining_fraction": 0.5, "reset_at": "2026-10-14T16:00:00+08:00",
             "upstream_response": {"client_secret": "FORBIDDEN_SENTINEL"}}]}],
        "access_token": "FORBIDDEN_SENTINEL"}
    result = normalize_summary(payload, "antigravity")
    parsed = result.groups[0].buckets[0]
    assert result.status == "available" and parsed.window == "5h"
    assert parsed.raw_window == "FIVE_HOURS" and parsed.reset_at == RESET
    assert "FORBIDDEN_SENTINEL" not in result.model_dump_json()
    assert set(result.model_dump()) == {"status", "source", "captured_at", "upstream_status", "reason", "groups"}


@pytest.mark.parametrize("remaining", [None, True, "NaN", "Infinity", "101%", "-1%", -0.1, 1.1, float("nan"), float("inf")])
def test_invalid_remaining_is_unknown_never_zero(remaining):
    data = ag_payload()
    data["groups"][0]["buckets"][0]["remainingFraction"] = remaining
    result = normalize_summary(data, "antigravity")
    assert result.status == "partial"
    assert result.groups[0].buckets[0].remaining_fraction is None
    assert "NaN" not in result.model_dump_json() and "Infinity" not in result.model_dump_json()


def test_geminicli_preserves_all_buckets_and_never_guesses_window_from_labels_or_reset():
    payload = {"buckets": [
        {"modelId": "gemini-pro", "tokenType": "input", "displayName": "5 hours",
         "remainingFraction": 0.9, "resetTime": RESET},
        {"modelId": "gemini-pro", "tokenType": "output", "displayName": "Weekly",
         "remainingFraction": 0.1, "resetTime": RESET},
        {"modelId": "gemini-pro", "tokenType": "daily", "window": "daily",
         "remainingFraction": 0.0, "resetTime": RESET}]}
    result = normalize_summary(payload, "geminicli")
    buckets = result.groups[0].buckets
    assert len(result.groups) == 1 and len(buckets) == 3
    assert [b.window for b in buckets] == ["unknown", "unknown", "daily"]
    assert [b.remaining_fraction for b in buckets] == [0.9, 0.1, 0]
    assert len({b.bucket_id for b in buckets}) == 3
    assert result.status == "partial"


@pytest.mark.parametrize("payload,status,reason", [
    ({"groups": []}, "unknown", "empty_quota_summary"),
    ({"models": {}}, "unknown", "unrecognized_quota_summary"),
    ({"error": {"message": "FORBIDDEN_SENTINEL"}}, "error", "invalid_upstream_response"),
    ([], "error", "invalid_upstream_response"),
])
def test_empty_and_unrecognized_upstream_are_explicit(payload, status, reason):
    result = normalize_summary(payload, "antigravity")
    assert result.status == status and result.reason == reason
    assert "FORBIDDEN_SENTINEL" not in result.model_dump_json()


async def test_invalid_upstream_json_is_sanitized(store, monkeypatch):
    async def post(**kwargs):
        return httpx.Response(200, content=b"FORBIDDEN_SENTINEL")
    monkeypatch.setattr("src.httpx_client.post_async", post)
    result, status = await summary.fetch_summary(NAME)
    assert status == 200 and result.status == "error" and result.upstream_status == 200
    assert result.reason == "invalid_upstream_response"
    assert "FORBIDDEN_SENTINEL" not in result.model_dump_json()


@pytest.mark.parametrize("mode", ["antigravity", "geminicli"])
async def test_concurrent_credential_replacement_discards_returned_quota(store, monkeypatch, mode):
    async def replace():
        await store.store_credential(NAME, {**CREDENTIAL, "project_id": "another-project"}, mode)
    await install_post(monkeypatch, action=replace)
    result, status = await summary.fetch_summary(NAME, mode)
    assert status == 409 and result.reason == "credential_changed" and result.groups == []


async def test_geminicli_refresh_is_request_only_and_identity_checked(store, monkeypatch):
    await store.store_credential(NAME, {**CREDENTIAL, "expiry": None}, "geminicli")
    before = await store.get_credential(NAME, "geminicli")
    async def refresh(credentials):
        credentials.access_token = "synthetic-refreshed"
    monkeypatch.setattr(panel.Credentials, "refresh", refresh)
    payload = {"buckets": [{"modelId": "gemini-pro", "window": "daily",
                            "remainingFraction": 0.5, "resetTime": RESET}]}
    calls = await install_post(monkeypatch, payload)
    async def forbidden(*args, **kwargs):
        raise AssertionError("GeminiCLI refresh must not store credentials or use AG snapshot")
    monkeypatch.setattr(store, "manual_snapshot", forbidden)
    monkeypatch.setattr(store, "store_credential", forbidden)
    result, status = await summary.fetch_summary(NAME, "geminicli")
    assert status == 200 and result.status == "available"
    assert calls[0]["headers"]["Authorization"] == "Bearer synthetic-refreshed"
    assert await store.get_credential(NAME, "geminicli") == before


async def test_geminicli_replacement_during_refresh_never_dispatches(store, monkeypatch):
    await store.store_credential(NAME, {**CREDENTIAL, "expiry": None}, "geminicli")
    async def refresh(credentials):
        await store.store_credential(NAME, {**CREDENTIAL, "refresh_token": "replacement-account"}, "geminicli")
        credentials.access_token = "synthetic-refreshed"
    monkeypatch.setattr(panel.Credentials, "refresh", refresh)
    calls = await install_post(monkeypatch)
    result, status = await summary.fetch_summary(NAME, "geminicli")
    assert status == 409 and result.reason == "credential_changed" and calls == []


async def test_antigravity_necessary_refresh_uses_cas_without_losing_metadata(store, monkeypatch):
    await store.store_credential(NAME, {**CREDENTIAL, "expiry": None, "import_marker": "keep"}, "antigravity")
    async def refresh(credentials):
        credentials.access_token = "synthetic-refreshed"
    monkeypatch.setattr(panel.Credentials, "refresh", refresh)
    calls = await install_post(monkeypatch)
    result, status = await summary.fetch_summary(NAME)
    assert status == 200 and result.status == "available"
    saved = await store.get_credential(NAME, "antigravity")
    assert saved["access_token"] == "synthetic-refreshed" and saved["import_marker"] == "keep"
    assert calls[0]["headers"]["Authorization"] == "Bearer synthetic-refreshed"


@pytest.mark.parametrize("mode", ["antigravity", "geminicli"])
async def test_oauth_failure_is_not_panel_401(store, monkeypatch, mode):
    await store.store_credential(NAME, {**CREDENTIAL, "expiry": None}, mode)
    async def endpoint():
        return "https://synthetic.invalid"
    async def oauth(*args, **kwargs):
        return httpx.Response(401, json={"error": "FORBIDDEN_SENTINEL"},
                              request=httpx.Request("POST", "https://synthetic.invalid/token"))
    monkeypatch.setattr("src.google_oauth_api.get_oauth_proxy_url", endpoint)
    monkeypatch.setattr("src.google_oauth_api.post_async", oauth)
    calls = await install_post(monkeypatch)
    result, status = await summary.fetch_summary(NAME, mode)
    assert status == 200 and result.upstream_status == 401 and result.reason == "oauth_refresh_failed"
    assert result.groups == [] and calls == []
    assert "FORBIDDEN_SENTINEL" not in result.model_dump_json()


async def test_panel_missing_and_invalid_token_are_401(store, monkeypatch):
    async def password():
        return "synthetic-panel"
    monkeypatch.setattr("src.utils.get_panel_password", password)
    app = FastAPI()
    app.include_router(summary.router)
    calls = await install_post(monkeypatch, status=401)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        for headers in ({}, {"Authorization": "Bearer wrong"}):
            response = await client.get(f"/creds/quota-summary/{NAME}", headers=headers)
            assert response.status_code == 401
        assert calls == []
        response = await client.get(f"/creds/quota-summary/{NAME}", headers={"Authorization": "Bearer synthetic-panel"})
    assert response.status_code == 200 and response.json()["upstream_status"] == 401


async def test_deadline_and_queue_failures_reset_request_context(store, monkeypatch):
    before = (await store.manual_snapshot(NAME))["raw"]
    monkeypatch.setattr(summary, "panel_work_budget", lambda: 0.02)
    async def post(**kwargs):
        await asyncio.sleep(1)
    monkeypatch.setattr("src.httpx_client.post_async", post)
    result, status = await summary.fetch_summary(NAME)
    assert status == 504 and result.reason == "quota_timeout"
    assert work_deadline.get() is None and work_progress.get() is None
    assert (await store.manual_snapshot(NAME))["raw"] == before


async def test_transport_failure_is_sanitized_and_does_not_fallback(store, monkeypatch):
    calls = []
    async def post(**kwargs):
        calls.append(kwargs["url"])
        raise httpx.ConnectError("FORBIDDEN_SENTINEL")
    monkeypatch.setattr("src.httpx_client.post_async", post)
    result, status = await summary.fetch_summary(NAME)
    assert status == 200 and result.status == "error" and result.reason == "transport_error"
    assert len(calls) == 1 and result.upstream_status is None and result.groups == []
    assert "FORBIDDEN_SENTINEL" not in result.model_dump_json()


@pytest.mark.parametrize("remaining,expected", [("0.5", 0.5), ("75%", 0.75), ("0%", 0.0), ("100%", 1.0)])
def test_official_fraction_strings_are_finite_and_not_clamped(remaining, expected):
    payload = ag_payload()
    payload["groups"][0]["buckets"][0]["remainingFraction"] = remaining
    result = normalize_summary(payload, "antigravity")
    assert result.status == "available" and result.groups[0].buckets[0].remaining_fraction == expected


@pytest.mark.parametrize("mode,field,value,expected", [
    ("antigravity", "window", "five-hour", "5h"),
    ("antigravity", "window", "five_hour", "5h"),
    ("antigravity", "window", "18000", "unknown"),
    ("antigravity", "durationSeconds", 18000, "unknown"),
    ("antigravity", "duration", 604800, "unknown"),
    ("antigravity", "period", "weekly", "unknown"),
    ("geminicli", "duration", 18000, "unknown"),
    ("geminicli", "period", 604800, "unknown"),
    ("geminicli", "durationSeconds", 18000, "5h"),
    ("geminicli", "windowDurationSeconds", "604800", "weekly"),
    ("geminicli", "window_duration_seconds", 86400, "daily"),
    ("geminicli", "windowDurationSeconds", True, "unknown"),
])
def test_windows_require_explicit_names_or_geminicli_seconds(mode, field, value, expected):
    item = {"bucketId": "b", "modelId": "gemini-pro", field: value,
            "remainingFraction": 0.5, "resetTime": RESET}
    payload = {"groups": [{"groupId": "g", "buckets": [item]}]} if mode == "antigravity" else {"buckets": [item]}
    assert normalize_summary(payload, mode).groups[0].buckets[0].window == expected


@pytest.mark.parametrize("fields,expected", [
    ({"displayName": "Display", "description": "Description", "window": "weekly"}, "Display"),
    ({"description": "Description", "window": "weekly"}, "Description"),
    ({"window": "weekly"}, "weekly"),
    ({}, "identifier"),
])
def test_bucket_label_uses_reference_precedence(fields, expected):
    item = {"bucketId": "identifier", **fields}
    payload = {"groups": [{"groupId": "g", "buckets": [item]}]}
    assert normalize_summary(payload, "antigravity").groups[0].buckets[0].display_name == expected
