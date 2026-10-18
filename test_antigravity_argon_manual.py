"""Argon manual probes use synthetic directory evidence and temporary SQLite."""
import asyncio
import json
import time
from unittest.mock import AsyncMock

import httpx
import pytest

from src.antigravity_model_access import ARGON_MODELS, MODELS, VALID_FOR, eligible
from src.antigravity_access_runtime import model_access_service
from src.api import antigravity as api
from src.credential_manager import CredentialManager
from src.panel import antigravity_manual as manual, creds as panel
from test_antigravity_manual import panel_store, reply
from test_antigravity_quota_policy import store, NAME

LOW, MEDIUM, HIGH = ARGON_MODELS


async def grant(store, models=ARGON_MODELS, now=None):
    await store.model_access_observe(NAME, await store.model_access_snapshot(NAME),
        {model: {} for model in (*MODELS, *models)}, now=now)


@pytest.fixture
async def probe(panel_store, monkeypatch):
    # The shared legacy fixture observes Opus only; make Argon truly unknown.
    access = (await panel_store.model_access_snapshot(NAME))["access"]
    access.pop("argon", None)
    await panel_store._quota_atomic(NAME, lambda row: row.update(model_access_state=access))
    directory = AsyncMock(return_value={"success": False})
    send = AsyncMock(return_value=httpx.Response(200, json=reply()))
    monkeypatch.setattr(api, "fetch_quota_info", directory)
    monkeypatch.setattr("src.httpx_client.post_async", send)
    monkeypatch.setattr(panel, "get_antigravity_api_url", AsyncMock(return_value="https://synthetic.invalid"))
    monkeypatch.setattr(CredentialManager, "_should_refresh_token", AsyncMock(return_value=False))
    return panel_store, directory, send


@pytest.mark.parametrize("origin", ["manual", "legacy"])
@pytest.mark.parametrize("model", ["gemini-4-argon-disabled", "假流式/gemini-4-argon-disabled"])
async def test_disabled_rejected_before_any_snapshot(monkeypatch, origin, model):
    forbidden = AsyncMock(side_effect=AssertionError("must reject before credential or HTTP access"))
    monkeypatch.setattr(manual, "prepare", forbidden)
    monkeypatch.setattr(panel, "get_storage_adapter", forbidden)
    monkeypatch.setattr("src.httpx_client.post_async", forbidden)
    result = await panel.test_credential_common(NAME, "antigravity", model, origin=origin)
    assert result.status_code == 404 and not forbidden.called


@pytest.mark.parametrize("kind", ["unknown", "negative", "disabled", "cooling"])
async def test_unconfirmed_disabled_or_cooling_argon_never_generates(probe, kind):
    store, directory, send = probe
    if kind == "negative":
        await grant(store, [])
    elif kind in ("disabled", "cooling"):
        await grant(store)
        if kind == "disabled":
            await store.update_credential_state(NAME, {"disabled": True}, "antigravity")
        else:
            await store.set_model_cooldown(NAME, HIGH, time.time()+300, "antigravity")
    result = await manual.test(NAME, LOW)
    assert result.status_code == 503 and not send.called
    assert json.loads(result.body)["response_source"] == "local"
    assert directory.call_count == int(kind == "unknown")


@pytest.mark.parametrize("model", [LOW, MEDIUM, HIGH, "gemini-4-argon"])
async def test_fresh_exact_permission_dispatches_only_native_route(probe, model):
    store, directory, send = probe
    await grant(store)
    result = await manual.test(NAME, model)
    assert result.status_code == 200 and json.loads(result.body)["success"]
    assert not directory.called
    assert send.await_args.kwargs["json"]["model"] == (LOW if model == "gemini-4-argon" else model)


async def test_bare_low_never_substitutes_permitted_high(probe):
    store, directory, send = probe
    await grant(store, [HIGH])
    result = await manual.test(NAME, "gemini-4-argon")
    assert result.status_code == 503 and not send.called and not directory.called


async def test_stale_permission_rechecks_selected_account_with_bounded_deadline(probe, monkeypatch):
    store, directory, send = probe
    await grant(store, now=time.time()-VALID_FOR-1)
    directory.return_value = {"success": True, "models": {LOW: {}}}
    original = model_access_service.check
    checks = []
    async def tracked(manager, filename, data, **kwargs):
        checks.append((filename, kwargs))
        return await original(manager, filename, data, **kwargs)
    monkeypatch.setattr(model_access_service, "check", tracked)
    result = await manual.test(NAME, "gemini-4-argon")
    assert result.status_code == 200 and send.call_count == directory.call_count == 1
    assert checks[0][0] == NAME and checks[0][1]["model"] == LOW
    assert checks[0][1]["scheduling_class"] == "interactive"
    assert 0 < directory.await_args.kwargs["deadline"] - time.monotonic() <= 10


async def test_unknown_directory_success_404_revokes_current_argon_evidence_only(probe):
    store, directory, send = probe
    directory.return_value = {"success": True, "models": {model: {} for model in (*MODELS, LOW)}}
    send.return_value = httpx.Response(404, json={"error": {"code": 404}})
    result = await manual.test(NAME, LOW)
    assert result.status_code == 404
    snapshot = await store.model_access_snapshot(NAME)
    assert not eligible(snapshot["access"], LOW)
    assert snapshot["access"]["argon"]["families"]["gemini-4-argon"]["reason"] == "generation_404"
    assert eligible(snapshot["access"], MODELS[0])


@pytest.mark.parametrize("race", ["identity", "revoke", "reject"])
async def test_final_admission_races_never_send(probe, monkeypatch, race):
    store, directory, send = probe
    await grant(store)
    original = store.quota_admit
    async def raced(*args):
        if race == "identity":
            await store._quota_atomic(NAME, lambda row: row.update(credential_data={"project_id": "replacement"}))
        elif race == "revoke":
            await grant(store, [])
        else:
            return None
        return await original(*args)
    monkeypatch.setattr(store, "quota_admit", raced)
    result = await manual.test(NAME, LOW)
    assert result.status_code == 503 and not send.called


async def test_identity_replaced_during_directory_check_never_sends(probe):
    store, directory, send = probe
    async def replaced(*args, **kwargs):
        await store._quota_atomic(NAME, lambda row: row.update(credential_data={"project_id": "replacement"}))
        return {"success": True, "models": {LOW: {}}}
    directory.side_effect = replaced
    result = await manual.test(NAME, LOW)
    assert result.status_code == 503 and not send.called


async def test_directory_timeout_stays_within_panel_budget_and_never_sends(probe, monkeypatch):
    store, directory, send = probe
    monkeypatch.setattr(manual, "panel_work_budget", lambda: .2)
    async def slow(*args, **kwargs):
        await asyncio.sleep(10)
    directory.side_effect = slow
    started = time.monotonic()
    result = await manual.test(NAME, LOW)
    assert time.monotonic()-started < 2
    assert result.status_code == 503 and not send.called


async def test_generation_uses_remaining_panel_budget(probe, monkeypatch):
    store, directory, send = probe
    await grant(store)
    monkeypatch.setattr(manual, "panel_work_budget", lambda: .2)
    async def slow(**kwargs):
        await asyncio.sleep(10)
    send.side_effect = slow
    started = time.monotonic()
    result = await manual.test(NAME, LOW)
    assert time.monotonic()-started < 2 and send.call_count == 1
    body = json.loads(result.body)
    assert result.status_code == 502 and body["phase"] == "generation"
