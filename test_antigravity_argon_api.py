"""Synthetic shared-API Argon boundaries; no real credentials or network."""
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import Response

from src.api import antigravity as api
from src.antigravity_model_access import ARGON_MODELS, MODELS, eligible
from src.credential_manager import CredentialManager
from src.panel.credential_capabilities import supports_argon_model_access, ARGON_ACCESS
from test_antigravity_model_access import access_store, NAME, observe
from test_antigravity_completion_policy import candidate, event

LOW, MEDIUM, HIGH = ARGON_MODELS


def manager_for(store):
    manager = CredentialManager()
    manager._initialized = True
    manager._storage_adapter = SimpleNamespace(_backend=store)
    manager._should_refresh_token = AsyncMock(return_value=False)
    return manager


def configure(monkeypatch, store):
    monkeypatch.setattr(api, "credential_manager", manager_for(store))
    monkeypatch.setattr(api, "get_antigravity_api_url", AsyncMock(return_value="https://synthetic.invalid"))
    monkeypatch.setattr(api, "get_retry_config", AsyncMock(return_value={"max_retries": 2, "retry_interval": 0, "retry_enabled": False}))
    monkeypatch.setattr(api, "get_auto_ban_error_codes", AsyncMock(return_value=[404]))
    monkeypatch.setattr(api, "get_antigravity_stream2nostream", AsyncMock(return_value=False))
    monkeypatch.setattr(api, "is_smart_429_protection_enabled", lambda: False)
    monkeypatch.setattr(api, "record_api_call_error", AsyncMock())
    monkeypatch.setattr(api, "record_api_call_success", AsyncMock())


@pytest.mark.parametrize("stream", [False, True])
@pytest.mark.parametrize("final_race", [False, True])
async def test_no_eligible_or_final_gate_rejection_never_sends(access_store, monkeypatch, stream, final_race):
    configure(monkeypatch, access_store)
    await observe(access_store, {LOW: {}} if final_race else {"gemini-4-argon-disabled": {}})
    if final_race:
        monkeypatch.setattr(access_store, "quota_admit", AsyncMock(return_value=None))
    send = AsyncMock(side_effect=AssertionError("generation must not be sent"))
    monkeypatch.setattr(api, "post_async", send)
    async def deny(**kwargs):
        raise AssertionError("generation must not be sent")
        yield
    monkeypatch.setattr(api, "stream_post_async", deny)
    body = {"model": "gemini-4-argon", "request": {}}
    result = [x async for x in api.stream_request(body)] if stream else [await api.non_stream_request(body, record_logical=False)]
    assert len(result) == 1 and result[0].status_code == 503
    assert not send.called
    assert body["model"] == "gemini-4-argon"


@pytest.mark.parametrize("stream", [False, True])
async def test_shared_api_disabled_rejected_before_selection(monkeypatch, stream):
    manager = SimpleNamespace(get_valid_credential=AsyncMock(side_effect=AssertionError("must reject first")))
    monkeypatch.setattr(api, "credential_manager", manager)
    body = {"model": "gemini-4-argon-disabled", "request": {}}
    result = [x async for x in api.stream_request(body)] if stream else [await api.non_stream_request(body, record_logical=False)]
    assert len(result) == 1 and result[0].status_code == 404
    assert not manager.get_valid_credential.called


@pytest.mark.parametrize("stream", [False, True])
@pytest.mark.parametrize("embedded", [False, True])
async def test_404_rotates_argon_family_without_account_or_opus_ban(access_store, monkeypatch, stream, embedded):
    store = access_store
    configure(monkeypatch, store)
    await store.store_credential("other-synthetic.json", {"access_token": "other", "project_id": "other"}, "antigravity")
    for name in (NAME, "other-synthetic.json"):
        await observe(store, {model: {} for model in (*MODELS, *ARGON_MODELS)}, name=name)
    calls = []
    error = {"error": {"code": 404, "message": "synthetic"}}
    async def post(**kwargs):
        calls.append(kwargs["headers"]["Authorization"])
        assert kwargs["json"]["model"] == LOW
        return httpx.Response(200 if embedded or len(calls) > 1 else 404, json=error if len(calls) == 1 else candidate())
    async def upstream(**kwargs):
        calls.append(kwargs["headers"]["Authorization"])
        assert kwargs["body"]["model"] == LOW
        if len(calls) == 1:
            yield event(error) if embedded else Response(json.dumps(error), status_code=404)
        else:
            yield event(candidate())
    monkeypatch.setattr(api, "post_async", post)
    monkeypatch.setattr(api, "stream_post_async", upstream)
    body = {"model": "gemini-4-argon", "request": {}}
    if stream:
        result = [x async for x in api.stream_request(body)]
        assert "synthetic answer" in "".join(x for x in result if isinstance(x, str))
    else:
        assert (await api.non_stream_request(body, record_logical=False)).status_code == 200
    assert len(calls) == len(set(calls)) == 2
    union = await store.model_access_union()
    assert set(ARGON_MODELS) <= union and set(MODELS) <= union
    rows = await store._quota_rows()
    assert all(not row["disabled"] for row in rows)
    snapshots = [(row["filename"], await store.model_access_snapshot(row["filename"])) for row in rows]
    failed = next(name for name, snapshot in snapshots if not eligible(snapshot["access"], LOW))
    assert await store.quota_admit(failed, MODELS[0])
    assert not await store.quota_admit(failed, HIGH)


@pytest.mark.parametrize("embedded", [False, True])
async def test_stream_404_after_body_does_not_replay(access_store, monkeypatch, embedded):
    configure(monkeypatch, access_store)
    await observe(access_store, {model: {} for model in ARGON_MODELS})
    calls = []
    error = {"error": {"code": 404, "message": "synthetic"}}
    async def upstream(**kwargs):
        calls.append(1)
        value = candidate()
        value["candidates"][0].pop("finishReason", None)
        yield event(value)
        yield event(error) if embedded else Response(json.dumps(error), status_code=404)
    monkeypatch.setattr(api, "stream_post_async", upstream)
    result = []
    try:
        async for item in api.stream_request({"model": LOW, "request": {}}):
            result.append(item)
    except api.ModelApiErrorException:
        pass
    assert calls == [1]
    assert "synthetic answer" in "".join(x for x in result if isinstance(x, str))


@pytest.mark.parametrize("ready", [False, True])
async def test_panel_argon_capability_is_storage_gated(access_store, monkeypatch, ready):
    from src.panel import creds
    store = access_store
    store.model_access_storage_ready = ready
    async def info(): return {"backend_type": "sqlite"}
    monkeypatch.setattr(creds, "get_storage_adapter", AsyncMock(return_value=SimpleNamespace(_backend=store, get_backend_info=info)))
    result = await creds.get_creds_status_common(0, 25, "all", "antigravity")
    assert (ARGON_ACCESS in json.loads(result.body)["panel_capabilities"]) is ready
    assert supports_argon_model_access(store) is ready
    assert not supports_argon_model_access(SimpleNamespace(model_access_storage_ready=True))


@pytest.mark.parametrize("high_metadata", [{}, None, "invalid"])
async def test_directory_preserves_enable_flags_without_quota_permission_inference(monkeypatch, high_metadata):
    from src.antigravity_directory_runtime import directory_broker
    payload = {"models": {LOW: {"disabled": True}, MEDIUM: {"enabled": False}, HIGH: high_metadata}}
    monkeypatch.setattr(api, "post_async", AsyncMock(return_value=httpx.Response(200, json=payload)))
    monkeypatch.setattr(api, "get_antigravity_api_url", AsyncMock(return_value="https://synthetic.invalid"))
    async def run(send, **kwargs): return await send(1)
    monkeypatch.setattr(directory_broker, "run", run)
    result = await api.fetch_quota_info("synthetic")
    assert result["models"][LOW]["disabled"] is True
    assert result["models"][MEDIUM]["enabled"] is False
    if isinstance(high_metadata, dict):
        assert "enabled" not in result["models"][HIGH]
    else:
        assert result["models"][HIGH]["enabled"] is None
    assert all(info["remaining"] is None for info in result["models"].values())


@pytest.mark.parametrize("bucket_id,window,reset,confirmed", [
    ("gemini-argon-wtu-weekly", "weekly", "2030-01-08T00:00:00Z", True),
    ("gemini-argon-wtu-weekly", "weekly", "2030-01-08T00:01:00Z", False),
    ("gemini-argon-wtu-weekly-extra", "weekly", "2030-01-08T00:00:00Z", False),
    ("gemini-argon-wtu-weekly", "5h", "2030-01-08T00:00:00Z", False),
])
async def test_weekly_confirmation_exact_bucket_window_and_reset(monkeypatch, bucket_id, window, reset, confirmed):
    from src.antigravity_directory_runtime import directory_broker
    payload = {"groups": [{"buckets": [{"bucketId": bucket_id, "window": window, "resetTime": reset}]}]}
    post = AsyncMock(return_value=httpx.Response(200, json=payload))
    monkeypatch.setattr(api, "post_async", post)
    async def run(send, **kwargs): return await send(1)
    monkeypatch.setattr(directory_broker, "run", run)
    models = {LOW: {"rolling168h": True, "resetTimeRaw": "2030-01-08T00:00:00Z"},
              "gemini-3.8-flash": {"rolling168h": True, "resetTimeRaw": "2030-01-08T00:00:00Z"}}
    await api._confirm_argon_weekly_window(models, {}, "https://synthetic.invalid", deadline=None, timeout=1, scheduling_class=None)
    assert (models[LOW].get("quotaBucketId") == "gemini-argon-wtu-weekly") is confirmed
    assert "quotaBucketId" not in models["gemini-3.8-flash"]
    assert post.call_args.kwargs["follow_redirects"] is False


async def test_failed_week_confirmation_keeps_original_protection(monkeypatch):
    from src.antigravity_directory_runtime import directory_broker
    monkeypatch.setattr(directory_broker, "run", AsyncMock(side_effect=TimeoutError))
    models = {LOW: {"rolling168h": True, "resetTimeRaw": "2030-01-08T00:00:00Z"}}
    await api._confirm_argon_weekly_window(models, {}, "https://synthetic.invalid", deadline=None, timeout=1, scheduling_class=None)
    assert models[LOW] == {"rolling168h": True, "resetTimeRaw": "2030-01-08T00:00:00Z"}


async def test_optional_summary_timeout_preserves_directory_evidence(monkeypatch):
    import asyncio
    import time
    from datetime import datetime, timezone
    from email.utils import format_datetime
    from src.antigravity_directory_runtime import directory_broker
    clock = time.time()
    reset = datetime.fromtimestamp(clock + 604800, timezone.utc).isoformat()
    calls = []
    async def post(**kwargs):
        calls.append(kwargs["url"])
        if len(calls) == 1:
            return httpx.Response(200, json={"models": {LOW: {"quotaInfo": {"remainingFraction": 1, "resetTime": reset}}}},
                                  headers={"date": format_datetime(datetime.fromtimestamp(clock, timezone.utc))})
        await asyncio.sleep(10)
        raise AssertionError("query must time out")
    async def run(send, **kwargs): return await send(1)
    monkeypatch.setattr(directory_broker, "run", run)
    monkeypatch.setattr(api, "post_async", post)
    monkeypatch.setattr(api, "get_antigravity_api_url", AsyncMock(return_value="https://synthetic.invalid"))
    result = await api.fetch_quota_info("synthetic", deadline=time.monotonic() + 0.6)
    assert len(calls) == 2 and result["success"]
    assert result["models"][LOW]["rolling168h"] is True
    assert "quotaBucketId" not in result["models"][LOW]
