"""Synthetic access observations; no production database or Google calls."""
import asyncio
import copy
import json
import time
from types import SimpleNamespace

import httpx
import pytest
from fastapi import Response

from src.antigravity_model_access import MODELS, PAUSE, RECHECK, QUERY_RETRY, access_model, eligible
from src.antigravity_access_runtime import ModelAccessService
from src.storage.sqlite_manager import SQLiteManager
from src.credential_manager import CredentialManager
from src.api import antigravity as api
from test_antigravity_quota_backends import backend
from test_antigravity_completion_policy import candidate, event

NAME = "access-synthetic.json"
LOW, MEDIUM, HIGH = MODELS


@pytest.fixture
async def access_store(tmp_path, monkeypatch):
    monkeypatch.setenv("CREDENTIALS_DIR", str(tmp_path))
    store = SQLiteManager()
    await store.initialize()
    await store.store_credential(NAME, {"access_token": "synthetic", "project_id": "synthetic"}, "antigravity")
    try:
        yield store
    finally:
        await store.close()


async def observe(store, models, now=None, name=NAME):
    snapshot = await store.model_access_snapshot(name)
    assert await store.model_access_observe(name, snapshot, models, now=now)
    return await store.model_access_snapshot(name)


@pytest.mark.parametrize("model,target", [(LOW, LOW), (HIGH, HIGH), ("claude-opus-5-5", MEDIUM),
    ("claude-opus-5-5-thinking", MEDIUM), ("假流式/ CLAUDE-OPUS-5-5-HIGH ", HIGH),
    ("流式抗截断/claude-opus-5-5-low", LOW), ("claude-sonnet-4-6", None), ("gemini-3.8-flash", None)])
def test_exact_access_alias(model, target):
    assert access_model(model) == target


async def test_virtual_clock_renew_recover_and_failed_query(access_store, monkeypatch):
    store = access_store
    t0 = 1000000
    clock = [t0]
    monkeypatch.setattr("src.storage.antigravity_model_access.time.time", lambda: clock[0])
    first = await observe(store, [LOW])
    assert eligible(first["access"], LOW, t0)
    entry = first["access"]["models"][HIGH]
    assert entry["blocked_until"] == t0 + PAUSE and entry["next_check_at"] == t0 + RECHECK
    clock[0] += RECHECK
    assert not eligible(first["access"], LOW, clock[0])
    renewed = await observe(store, [LOW])
    entry = renewed["access"]["models"][HIGH]
    assert entry["blocked_until"] == t0 + RECHECK + PAUSE
    clock[0] += 1
    assert await store.model_access_observe(NAME, renewed, reason="directory_timeout")
    failed = await store.model_access_snapshot(NAME)
    entry = failed["access"]["models"][HIGH]
    assert entry["state"] == "unavailable" and entry["blocked_until"] == t0 + RECHECK + PAUSE
    assert entry["next_check_at"] == clock[0] + QUERY_RETRY
    clock[0] += QUERY_RETRY
    recovered = await observe(store, MODELS)
    assert recovered["access"]["models"][HIGH]["blocked_until"] == 0
    assert await store.quota_admit(NAME, HIGH)
    clock[0] += 4 * PAUSE
    assert await store.quota_admit(NAME, HIGH) is None


async def test_unknown_negative_and_independent_quota_gate(access_store):
    store = access_store
    assert await store.quota_admit(NAME, HIGH) is None
    assert await store.quota_admit(NAME, "claude-sonnet-4-6")
    await observe(store, [LOW, MEDIUM])
    assert await store.quota_admit(NAME, LOW)
    assert await store.quota_admit(NAME, MEDIUM)
    assert await store.quota_admit(NAME, HIGH) is None
    await store.set_model_cooldown(NAME, "claude-opus-4-6-thinking", time.time() + 300, "antigravity")
    await observe(store, MODELS)
    assert await store.quota_admit(NAME, HIGH) is None
    assert await store.quota_admit(NAME, "gemini-3.8-flash-high")


async def test_stale_404_does_not_overwrite_panel_recovery(access_store):
    store = access_store
    await observe(store, MODELS)
    admission = await store.quota_admit(NAME, HIGH)
    await observe(store, MODELS)
    assert not await store.model_access_observe(NAME, admission["model_access_snapshot"],
                                               model=HIGH, success=False, reason="generation_404")
    assert await store.quota_admit(NAME, HIGH)
    current = await store.quota_admit(NAME, HIGH)
    assert await store.model_access_observe(NAME, current["model_access_snapshot"],
                                            model=HIGH, success=False, reason="generation_404")
    assert await store.quota_admit(NAME, HIGH) is None
    assert await store.quota_admit(NAME, LOW)
    assert not (await store._quota_rows(NAME))[0]["disabled"]


async def test_stale_directory_fences_per_tier_and_replacement(access_store):
    store = access_store
    await observe(store, MODELS)
    before = await store.model_access_snapshot(NAME)
    admission = await store.quota_admit(NAME, HIGH)
    await store.model_access_observe(NAME, admission["model_access_snapshot"], model=HIGH, success=False)
    assert await store.model_access_observe(NAME, before, MODELS)
    assert await store.quota_admit(NAME, HIGH) is None
    await store.store_credential(NAME, {"access_token": "replacement", "project_id": "replacement"}, "antigravity")
    assert not await store.model_access_observe(NAME, before, MODELS)
    assert not await store.quota_admit(NAME, LOW)
    # A query of the replacement establishes new, fenced evidence.
    await observe(store, [LOW])
    assert await store.quota_admit(NAME, LOW)
    assert not await store.quota_admit(NAME, MEDIUM)


async def test_delete_recreate_and_restart_preserve_state(access_store):
    store = access_store
    first = await observe(store, [LOW])
    saved = copy.deepcopy(first["access"])
    await store.model_access_initialize()  # idempotent migration verification
    assert (await store.model_access_snapshot(NAME))["access"] == saved
    await store.delete_credential(NAME, "antigravity")
    await store.store_credential(NAME, {"access_token": "synthetic", "project_id": "synthetic"}, "antigravity")
    assert not await store.model_access_observe(NAME, first, MODELS)
    assert not await store.quota_admit(NAME, LOW)


async def test_persistent_leases_multi_worker_and_expiry(access_store, monkeypatch):
    store = access_store
    leases = await asyncio.gather(*(store.model_access_claim(NAME, force=True) for _ in range(4)))
    assert sum(item is not None for item in leases) == 1
    won = next(item for item in leases if item)
    assert await store.model_access_observe(NAME, won, [LOW])
    next_lease = await store.model_access_claim(NAME, force=True)
    assert next_lease
    assert not await store.model_access_observe(NAME, won, MODELS)
    await store.model_access_observe(NAME, next_lease, reason="directory_query_failed")
    assert not await store.model_access_due()
    now = time.time()
    monkeypatch.setattr("src.storage.antigravity_model_access.time.time", lambda: now + QUERY_RETRY + 1)
    assert NAME in await store.model_access_due()


async def test_backend_cas_access_tier_and_lease(backend):
    store, db = backend
    name = db.row["filename"]
    store.model_access_storage_ready = True
    first = await store.model_access_snapshot(name)
    assert await store.model_access_observe(name, first, [LOW, MEDIUM])
    assert await store.quota_admit(name, LOW)
    assert not await store.quota_admit(name, HIGH)
    leases = await asyncio.gather(*(store.model_access_claim(name, force=True) for _ in range(3)))
    assert sum(item is not None for item in leases) == 1
    assert db.row.get("model_access_state")


async def test_mixed_pool_cold_start_query_bounded_and_no_stats(access_store, monkeypatch):
    store = access_store
    await store.store_credential("access-other.json", {"access_token": "other", "project_id": "other"}, "antigravity")
    manager = CredentialManager()
    manager._storage_adapter = SimpleNamespace(_backend=store)
    manager._initialized = True
    async def no_refresh(data): return False
    manager._should_refresh_token = no_refresh
    calls = []
    async def directory(token, **kwargs):
        calls.append(token)
        return {"success": True, "models": {LOW: {}} if token == "synthetic" else {HIGH: {}}}
    monkeypatch.setattr(api, "fetch_quota_info", directory)
    service = ModelAccessService()
    selected = await service.select(manager, HIGH, set())
    assert selected[0] == "access-other.json"
    assert len(calls) == 2
    calls.clear()
    for _ in range(5):
        assert (await service.select(manager, HIGH, set()))[0] == "access-other.json"
    assert not calls
    assert await service.select(manager, MEDIUM, set()) is None
    assert all(row["call_count"] == 0 for row in await store._quota_rows())


@pytest.mark.parametrize("outcome", ["missing", "failed", "invalid"])
async def test_no_evidence_no_dispatch_and_backoff(access_store, monkeypatch, outcome):
    store = access_store
    manager = CredentialManager(); manager._initialized = True
    manager._storage_adapter = SimpleNamespace(_backend=store)
    async def no_refresh(data): return False
    manager._should_refresh_token = no_refresh
    async def directory(*args, **kwargs):
        if outcome == "invalid": raise ValueError("synthetic")
        return {"success": outcome == "missing", "models": {}}
    monkeypatch.setattr(api, "fetch_quota_info", directory)
    assert await ModelAccessService().select(manager, HIGH, set()) is None
    state = (await store.model_access_snapshot(NAME))["access"]["models"][HIGH]
    assert state["state"] == ("unavailable" if outcome == "missing" else "unknown")
    assert state["next_check_at"] > time.time()
    store.model_access_storage_ready = False
    assert await ModelAccessService().select(manager, HIGH, set()) is None


async def test_catalog_union_survives_random_account_and_failure(access_store, monkeypatch):
    store = access_store
    await observe(store, [LOW])
    await store.store_credential("union-other.json", {"access_token": "other", "project_id": "other"}, "antigravity")
    await observe(store, [HIGH], name="union-other.json")
    manager = CredentialManager(); manager._initialized = True
    manager._storage_adapter = SimpleNamespace(_backend=store)
    async def no_refresh(data): return False
    manager._should_refresh_token = no_refresh
    async def created(): return manager
    monkeypatch.setattr(api, "credential_manager", SimpleNamespace(_get_or_create=created))
    async def directory(token, **kwargs): return {"success": False}
    monkeypatch.setattr(api, "fetch_quota_info", directory)
    assert {x["id"] for x in await api.fetch_available_models()} == {LOW, HIGH}
    await store.quota_disable("union-other.json", (await store.quota_credential_fence("union-other.json"))["quota_credential_generation"],
        (await store.quota_credential_fence("union-other.json"))["_quota_credential_version"])
    assert {x["id"] for x in await api.fetch_available_models()} == {LOW}


@pytest.mark.parametrize("stream,embedded", [(False, False), (True, False), (False, True), (True, True)])
async def test_generation_404_rotates_without_auto_ban(access_store, monkeypatch, stream, embedded):
    store = access_store
    await observe(store, MODELS)
    await store.store_credential("retry-other.json", {"access_token": "other", "project_id": "other"}, "antigravity")
    await observe(store, MODELS, name="retry-other.json")
    manager = CredentialManager(); manager._initialized = True
    manager._storage_adapter = SimpleNamespace(_backend=store)
    async def no_refresh(data): return False
    manager._should_refresh_token = no_refresh
    monkeypatch.setattr(api, "credential_manager", manager)
    async def endpoint(): return "https://synthetic.invalid"
    async def retry(): return {"max_retries": 2, "retry_interval": 0, "retry_enabled": False}
    async def bans(): return [404]
    async def wrap(request, model, project, credit): return {"request": request, "project": project, "model": model}, "synthetic"
    async def no_collect(): return False
    calls, failures, successes = [], [], []
    async def failure(*args, **kwargs): failures.append((args, kwargs))
    async def success(*args, **kwargs): successes.append(kwargs)
    monkeypatch.setattr(api, "record_api_call_error", failure)
    monkeypatch.setattr(api, "record_api_call_success", success)
    monkeypatch.setattr(api, "get_antigravity_api_url", endpoint)
    monkeypatch.setattr(api, "get_retry_config", retry)
    monkeypatch.setattr(api, "get_auto_ban_error_codes", bans)
    monkeypatch.setattr(api, "wrap_cli_request", wrap)
    monkeypatch.setattr(api, "get_antigravity_stream2nostream", no_collect)
    monkeypatch.setattr(api, "is_smart_429_protection_enabled", lambda: False)
    error = {"error": {"code": 404, "message": "synthetic"}}
    async def post(**kwargs):
        calls.append(kwargs["headers"]["Authorization"])
        return httpx.Response(200 if embedded or len(calls) > 1 else 404, json=error if len(calls) == 1 else candidate())
    async def upstream(**kwargs):
        calls.append(kwargs["headers"]["Authorization"])
        if len(calls) == 1:
            yield event(error) if embedded else Response(json.dumps(error), status_code=404)
        else:
            yield event(candidate())
    monkeypatch.setattr(api, "post_async", post)
    monkeypatch.setattr(api, "stream_post_async", upstream)
    if stream:
        result = [x async for x in api.stream_request({"model": HIGH, "request": {}})]
        assert "synthetic answer" in ''.join(x for x in result if isinstance(x, str))
    else:
        result = await api.non_stream_request({"model": HIGH, "request": {}}, record_logical=False)
        assert result.status_code == 200
    assert len(calls) == 2 and len(set(calls)) == 2
    assert len(failures) == len(successes) == 1
    assert failures[0][0][2] == 404
    assert all(not row["disabled"] for row in await store._quota_rows())
    assert len(await store.model_access_union()) == 3

async def test_restart_and_idempotent_additive_sql_migration(access_store):
    import aiosqlite
    store = access_store
    await observe(store, [LOW])
    reopened = SQLiteManager()
    await reopened.initialize()
    try:
        assert await reopened.quota_admit(NAME, LOW)
        assert not await reopened.quota_admit(NAME, HIGH)
        async with aiosqlite.connect(store._db_path) as conn:
            columns = [row[1] for row in await (await conn.execute("PRAGMA table_info(antigravity_credentials)")).fetchall()]
        assert columns.count("model_access_state") == 1
        assert (await reopened.model_access_snapshot(NAME))["access"] == (await store.model_access_snapshot(NAME))["access"]
    finally:
        await reopened.close()


async def test_credential_content_change_fences_query_but_token_refresh_preserves_pause(access_store):
    store = access_store
    first = await observe(store, [LOW])
    assert await store.quota_refresh_credential(NAME, first["generation"],
        {"access_token": "refreshed", "project_id": "synthetic"}, expected_version=first["version"])
    assert not await store.model_access_observe(NAME, first, MODELS)
    assert (await store.model_access_snapshot(NAME))["access"]["models"][HIGH]["state"] == "unavailable"
    assert await store.quota_admit(NAME, LOW)
    assert not await store.quota_admit(NAME, HIGH)


async def test_capability_requires_verified_storage(access_store):
    from src.management.service import ManagementService
    service = ManagementService(active_operations=SimpleNamespace())
    assert "antigravity.model_access.protection" not in service._read_capabilities(SimpleNamespace(), "sqlite")
    assert "antigravity.model_access.protection" not in service._read_capabilities(SimpleNamespace(model_access_storage_ready=True), "sqlite")
    assert "antigravity.model_access.protection" in service._read_capabilities(access_store, "sqlite")


async def test_disabled_accounts_never_receive_background_query(access_store, monkeypatch):
    store = access_store
    fence = await store.quota_credential_fence(NAME)
    await store.quota_disable(NAME, fence["quota_credential_generation"], fence["_quota_credential_version"])
    assert not await store.model_access_due()
    assert not await store.model_access_claim(NAME, force=True)
    manager = CredentialManager(); manager._initialized = True
    manager._storage_adapter = SimpleNamespace(_backend=store)
    async def deny(*args, **kwargs): raise AssertionError("disabled credential queried")
    monkeypatch.setattr(api, "fetch_quota_info", deny)
    await ModelAccessService().scan(manager)


@pytest.mark.parametrize("origin", ["legacy", "manual"])
@pytest.mark.parametrize("embedded", [False, True])
async def test_manual_404_and_success_restore_only_target(access_store, monkeypatch, origin, embedded):
    from test_antigravity_manual import reply
    from src.panel import creds as panel
    store = access_store
    await observe(store, MODELS)
    async def storage(): return SimpleNamespace(_backend=store, get_credential=store.get_credential)
    class Credentials:
        @classmethod
        def from_dict(cls, data): return cls()
        async def refresh_if_needed(self): return False
    async def endpoint(): return "https://synthetic.invalid"
    async def auto_ban(status): return True
    async def logical(*args): pass
    monkeypatch.setattr(panel, "get_storage_adapter", storage)
    monkeypatch.setattr(panel, "Credentials", Credentials)
    monkeypatch.setattr(panel, "get_antigravity_api_url", endpoint)
    monkeypatch.setattr(panel, "check_should_auto_ban", auto_ban)
    monkeypatch.setattr(panel, "record_logical_request", logical)
    replies = [httpx.Response(200 if embedded else 404, json={"error": {"code": 404, "message": "synthetic"}}),
               httpx.Response(200, json=reply())]
    calls = []
    async def post(**kwargs):
        calls.append(kwargs["json"]["model"])
        return replies.pop(0)
    monkeypatch.setattr("src.httpx_client.post_async", post)
    failed = await panel.test_credential_common(NAME, "antigravity", HIGH, origin=origin)
    assert failed.status_code == 404
    assert not await store.quota_admit(NAME, HIGH)
    assert await store.quota_admit(NAME, LOW)
    assert not (await store._quota_rows(NAME))[0]["disabled"]
    succeeded = await panel.test_credential_common(NAME, "antigravity", HIGH, origin=origin)
    assert succeeded.status_code == 200
    assert await store.quota_admit(NAME, HIGH)
    assert calls == [HIGH, HIGH]


async def test_manual_quota_reuses_response_and_keeps_quota_on_access_restore(access_store, monkeypatch):
    from src.panel import creds as panel
    from src.panel.antigravity_manual import quota
    store = access_store
    await observe(store, [])
    await store.set_model_cooldown(NAME, HIGH, time.time() + 300, "antigravity")
    async def storage(): return SimpleNamespace(_backend=store)
    class Credentials:
        @classmethod
        def from_dict(cls, data): return cls()
        async def refresh_if_needed(self): return False
    calls = []
    async def directory(*args, **kwargs):
        calls.append(1)
        return {"success": True, "models": {HIGH: {"remaining": None}}, "observation": {}, "upstream_status": 200}
    monkeypatch.setattr(panel, "get_storage_adapter", storage)
    monkeypatch.setattr(panel, "Credentials", Credentials)
    monkeypatch.setattr(panel, "fetch_quota_info", directory)
    result = await quota(NAME, sync=True)
    assert calls == [1]
    assert result["model_access_state"][HIGH]["state"] == "supported"
    assert result["model_access_state"][LOW]["state"] == "unavailable"
    assert not await store.quota_admit(NAME, HIGH)  # Independent quota remains blocked.


# Exercise the real protocol routers and their pre-header stream priming.
from test_antigravity_opus_retirement import protected_app

@pytest.mark.parametrize("protocol,stream", [(p, s) for p in ("openai", "claude", "gemini") for s in (False, True)])
@pytest.mark.parametrize("feature", ["", "假流式/", "抗截断/", "流式抗截断/"])
async def test_no_qualified_credential_is_json_503_all_protocols(protected_app, monkeypatch, protocol, stream, feature):
    from src.router.antigravity import openai, anthropic, gemini
    from urllib.parse import quote
    class Manager:
        async def get_valid_credential(self, **kwargs): return None
    async def no_collect(): return False
    async def thoughts(): return False
    async def deny(*args, **kwargs): raise AssertionError("no permission dispatched generation")
    monkeypatch.setattr(api, "credential_manager", Manager())
    monkeypatch.setattr(api, "get_antigravity_stream2nostream", no_collect)
    monkeypatch.setattr(api, "post_async", deny)
    monkeypatch.setattr(api, "stream_post_async", deny)
    monkeypatch.setattr("config.get_return_thoughts_to_frontend", thoughts)
    async def logical(*args): pass
    for route in (openai, anthropic, gemini):
        monkeypatch.setattr(route, "record_logical_request", logical)
    model = feature + HIGH
    if protocol == "openai":
        url, body = "/antigravity/v1/chat/completions", {"model": model, "messages": [{"role": "user", "content": "hi"}], "stream": stream}
    elif protocol == "claude":
        url, body = "/antigravity/v1/messages", {"model": model, "messages": [{"role": "user", "content": "hi"}], "max_tokens": 8, "stream": stream}
    else:
        method = "streamGenerateContent" if stream else "generateContent"
        url = f"/antigravity/v1beta/models/{quote(model, safe='')}:{method}"
        body = {"contents": [{"role": "user", "parts": [{"text": "hi"}]}]}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=protected_app), base_url="http://synthetic") as client:
        response = await client.post(url, json=body)
    assert response.status_code == 503
    assert response.headers["content-type"].startswith("application/json")
    assert response.json()["error"]["message"] == "The service is temporarily unavailable. Please try again later."

async def test_directory_timeout_bound_and_durable_retry(access_store, monkeypatch):
    import src.antigravity_access_runtime as runtime
    store = access_store
    manager = CredentialManager(); manager._initialized = True
    manager._storage_adapter = SimpleNamespace(_backend=store)
    async def no_refresh(data): return False
    manager._should_refresh_token = no_refresh
    async def stalled(*args, **kwargs): await asyncio.Event().wait()
    monkeypatch.setattr(api, "fetch_quota_info", stalled)
    monkeypatch.setattr(runtime, "QUERY_TIMEOUT", .02)
    started = time.monotonic()
    assert not await ModelAccessService().select(manager, HIGH, set())
    assert time.monotonic() - started < 1
    state = (await store.model_access_snapshot(NAME))["access"]
    assert state["models"][HIGH]["state"] == "unknown"
    assert state["models"][HIGH]["next_check_at"] > time.time() + 800
    assert "lease" not in state


async def test_confirmation_budget_exhaustion_still_allows_verified_pool(access_store):
    from src.antigravity_limits import current_budget
    store = access_store
    await observe(store, MODELS)
    manager = CredentialManager(); manager._initialized = True
    manager._storage_adapter = SimpleNamespace(_backend=store)
    async def no_refresh(data): return False
    manager._should_refresh_token = no_refresh
    token = current_budget.set(SimpleNamespace(model_access_remaining=0))
    try:
        assert (await ModelAccessService().select(manager, HIGH, set()))[0] == NAME
    finally:
        current_budget.reset(token)


async def test_global_directory_concurrency_never_exceeds_two(access_store, monkeypatch):
    store = access_store
    for i in range(4):
        await store.store_credential(f"concurrent-{i}.json", {"access_token": f"synthetic-{i}", "project_id": "synthetic"}, "antigravity")
    manager = CredentialManager(); manager._initialized = True
    manager._storage_adapter = SimpleNamespace(_backend=store)
    async def no_refresh(data): return False
    manager._should_refresh_token = no_refresh
    active, maximum = 0, 0
    first_pair_started = asyncio.Event()
    async def directory(*args, **kwargs):
        nonlocal active, maximum
        active += 1
        maximum = max(maximum, active)
        if active == 2:
            first_pair_started.set()
        # Require actual overlap without assuming SQLite preparation finishes
        # within 10ms. A serial implementation fails at this bounded barrier.
        await asyncio.wait_for(first_pair_started.wait(), timeout=5)
        await asyncio.sleep(.01)
        active -= 1
        return {"success": True, "models": dict.fromkeys(MODELS, {})}
    monkeypatch.setattr(api, "fetch_quota_info", directory)
    service = ModelAccessService()
    await asyncio.gather(*(service.check(manager, row["filename"], force=True) for row in await store._quota_rows()))
    assert maximum == 2
    for row in await store._quota_rows():
        assert (await store.model_access_snapshot(row["filename"]))["access"]["models"][HIGH]["state"] == "supported"
    assert await store.model_access_union() == set(MODELS)

async def test_scheduler_keeps_scanning_while_two_checks_are_busy(monkeypatch):
    import src.antigravity_access_runtime as runtime
    service = ModelAccessService()
    scanned = asyncio.Event()
    scans, checks = [], []
    async def due():
        scans.append(1)
        if len(scans) >= 3:
            scanned.set()
        return ["scheduled-1.json", "scheduled-2.json", "scheduled-3.json"]
    manager = SimpleNamespace(_storage_adapter=SimpleNamespace(_backend=SimpleNamespace(model_access_due=due)))
    async def created(): return manager
    async def stalled(manager, name):
        checks.append(name)
        await asyncio.Event().wait()
    monkeypatch.setattr("src.credential_manager.credential_manager", SimpleNamespace(_get_or_create=created))
    monkeypatch.setattr(runtime, "SCAN_INTERVAL", .01)
    service.check = stalled
    await service.start()
    try:
        await asyncio.wait_for(scanned.wait(), 1)
        assert len(checks) == 2 and len(set(checks)) == 2
    finally:
        await service.close()
    assert not service._workers and service._task is None


async def test_404_after_content_never_replays(monkeypatch):
    observed, calls = [], []
    class Manager:
        async def get_valid_credential(self, **kwargs):
            return NAME, {"access_token": "synthetic", "project_id": "synthetic"}
        async def quota_admit(self, *args): return {"generation": "synthetic", "purpose": "business"}
        async def model_access_generation_result(self, name, admission, model, status): observed.append((model, status))
    async def endpoint(): return "https://synthetic.invalid"
    async def retry(): return {"max_retries": 3, "retry_interval": 0, "retry_enabled": True}
    async def bans(): return [404]
    async def wrap(request, *args): return {"request": request}, "synthetic"
    async def settle(*args, **kwargs): pass
    async def upstream(**kwargs):
        calls.append(1)
        yield event(candidate(finish=None))
        yield event({"error": {"code": 404, "message": "synthetic"}})
    monkeypatch.setattr(api, "credential_manager", Manager())
    monkeypatch.setattr(api, "get_antigravity_api_url", endpoint)
    monkeypatch.setattr(api, "get_retry_config", retry)
    monkeypatch.setattr(api, "get_auto_ban_error_codes", bans)
    monkeypatch.setattr(api, "wrap_cli_request", wrap)
    monkeypatch.setattr(api, "record_api_call_error", settle)
    monkeypatch.setattr(api, "stream_post_async", upstream)
    from src.router.model_api_errors import ModelApiErrorException
    seen = []
    with pytest.raises(ModelApiErrorException):
        async for item in api.stream_request({"model": HIGH, "request": {}}):
            seen.append(item)
    assert len(calls) == 1 and len(seen) == 1
    assert observed == [(HIGH, 404)]
