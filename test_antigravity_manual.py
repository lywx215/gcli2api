"""Manual probes use synthetic Google responses and isolated storage only."""
import asyncio
import json
import time
from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException

from src.panel import creds as panel
from src.panel import antigravity_manual as manual
from test_antigravity_quota_policy import store, NAME, GEMINI, CLAUDE, block, week
from test_antigravity_quota_backends import backend


@pytest.fixture
def panel_store(store, monkeypatch):
    async def storage():
        return SimpleNamespace(_backend=store)
    class Credentials:
        @classmethod
        def from_dict(cls, data):
            obj = cls(); obj.data = data; return obj
        async def refresh_if_needed(self): return False
        def to_dict(self): return self.data
    async def no_ban(status): return False
    async def logical(*args): pass
    monkeypatch.setattr(panel, "get_storage_adapter", storage)
    monkeypatch.setattr(panel, "Credentials", Credentials)
    monkeypatch.setattr(panel, "check_should_auto_ban", no_ban)
    monkeypatch.setattr(panel, "record_logical_request", logical)
    return store


def reply(text="测试成功", finish="STOP"):
    return {"response": {"candidates": [{"content": {"parts": [{"text": text}]}, "finishReason": finish}]}}


@pytest.mark.parametrize("origin", ["legacy", "manual"])
@pytest.mark.parametrize("outcome", ["success", "failure", "transport", "cancelled"])
@pytest.mark.parametrize("requested,upstream,stats_model", [
    ("claude-opus-5-5-low", "claude-opus-5-5-low", "claude-opus-5-5-low"),
    ("claude-opus-5-5-medium", "claude-opus-5-5-medium", "claude-opus-5-5-medium"),
    ("claude-opus-5-5-high", "claude-opus-5-5-high", "claude-opus-5-5-high"),
    ("gemini-3.1-pro", "gemini-pro-agent", "gemini-3.1-pro"),
])
async def test_panel_probe_stats_use_routed_opus_generation(
    panel_store, monkeypatch, origin, outcome, requested, upstream, stats_model,
):
    calls, records = [], []
    started = asyncio.Event()

    async def storage():
        return SimpleNamespace(_backend=panel_store, get_credential=panel_store.get_credential)

    async def api_url():
        return "https://synthetic.invalid"

    async def logical(*args):
        records.append(args)

    async def post(**kwargs):
        calls.append(kwargs["json"]["model"])
        started.set()
        if outcome == "cancelled":
            await asyncio.Event().wait()
        if outcome == "transport":
            raise httpx.ConnectError("synthetic transport failure")
        return httpx.Response(200, json=reply() if outcome == "success" else reply("wrong"))

    monkeypatch.setattr(panel, "get_storage_adapter", storage)
    monkeypatch.setattr(panel, "get_antigravity_api_url", api_url)
    monkeypatch.setattr(panel, "record_logical_request", logical)
    monkeypatch.setattr("src.httpx_client.post_async", post)
    probe = panel.test_credential_common(NAME, mode="antigravity", model=requested, origin=origin)
    if outcome == "cancelled":
        task = asyncio.create_task(probe)
        await asyncio.wait_for(started.wait(), timeout=5)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    elif outcome == "transport" and origin == "legacy":
        with pytest.raises(HTTPException) as error:
            await probe
        assert error.value.status_code == 500
    else:
        response = await probe
        assert json.loads(response.body)["success"] is (outcome == "success")

    assert calls == [upstream]
    # Legacy cancellation does not settle a logical request; preserve that policy.
    expected = [] if origin == "legacy" and outcome == "cancelled" else [
        (stats_model, "antigravity", outcome == "success")
    ]
    assert records == expected


@pytest.mark.parametrize("origin", ["legacy", "manual", "direct_manual"])
@pytest.mark.parametrize("model", [
    "claude-opus-4-6", "claude-opus-4-6-thinking", "claude-opus-4.6-high",
    " CLAUDE-OPUS-4-6-LOW ", "假流式/claude-opus-4-6",
    "抗截断/claude-opus-4.6", "流式抗截断/ 假流式/ CLAUDE-OPUS-4-6-thinking ",
    "models/claude-opus-4-6-thinking", "arbitrary/claude-opus-4.6-high",
    "models/ CLAUDE-OPUS-4-6 ",
    "claude-opus-4-6/foo", "claude-opus-4.6/",
    "prefix-claude-opus-4-6-thinking", "notclaude-opus-4.6-high",
])
async def test_retired_opus_panel_probe_rejected_before_any_side_effect(monkeypatch, origin, model):
    async def forbidden(*args, **kwargs):
        pytest.fail("Retired probe must not prepare credentials, dispatch, or record statistics")

    monkeypatch.setattr(panel, "get_storage_adapter", forbidden)
    monkeypatch.setattr(manual, "prepare", forbidden)
    monkeypatch.setattr(panel, "record_logical_request", forbidden)
    monkeypatch.setattr("src.httpx_client.post_async", forbidden)
    if origin == "direct_manual":
        response = await manual.test(NAME, model)
    else:
        response = await panel.test_credential_common(NAME, mode="antigravity", model=model, origin=origin)
    assert response.status_code == 400
    assert json.loads(response.body) == {
        "success": False, "status_code": 400, "upstream_status": None,
        "response_source": "local", "phase": "validation", "phases": [],
        "error": "Invalid request. Check the request parameters and try again.",
        "state_update": {},
    }


@pytest.mark.parametrize("disabled,permanent", [(False, False), (True, False), (True, True)])
async def test_manual_dispatches_through_every_local_gate(panel_store, monkeypatch, disabled, permanent):
    store = panel_store
    await block(store)
    deadline = time.time()+3600
    await store.set_model_cooldown(NAME, GEMINI, deadline, "antigravity")
    await store.set_model_cooldown(NAME, CLAUDE, deadline, "antigravity")
    await store.update_credential_state(NAME, {"disabled": disabled, "permanent_disabled": permanent}, "antigravity")
    assert await store.quota_admit(NAME, GEMINI) is None
    calls = []
    async def post(**kw): calls.append(kw); return httpx.Response(200, json=reply())
    monkeypatch.setattr("src.httpx_client.post_async", post)
    result = await panel.test_credential(NAME, mode="antigravity", model=GEMINI, _token="synthetic")
    body = json.loads(result.body)
    assert result.status_code == 200 and body["success"] and body["verified_reply"]
    assert len(calls) == 1 and calls[0]["json"]["request"]["generationConfig"]["maxOutputTokens"] == 256
    state = await store.get_credential_state(NAME, "antigravity")
    assert bool(state["disabled"]) == disabled and bool(state["permanent_disabled"]) == permanent
    snapshot = await store.quota_snapshot(NAME)
    assert snapshot["quota_group_states"]["gemini-shared"]["state"] == "manual_override"
    assert GEMINI not in snapshot["model_cooldowns"] and snapshot["model_cooldowns"][CLAUDE] == deadline


@pytest.mark.parametrize("status,payload,strict,success", [
    (200, reply(), True, True), (200, reply("wrong"), True, False),
    (200, {"response": {"candidates": [{"finishReason": "MAX_TOKENS"}]}}, False, True),
    (200, {"error": {"message": "SECRET_NATIVE_MODEL"}}, False, False),
    (401, {"error": "SECRET_NATIVE_MODEL"}, False, False),
    (403, {"error": "SECRET_NATIVE_MODEL"}, False, False),
    (429, {"error": "SECRET_NATIVE_MODEL"}, False, False),
    (503, {"error": "SECRET_NATIVE_MODEL"}, True, False),
])
async def test_actual_status_and_fixed_errors(panel_store, monkeypatch, status, payload, strict, success):
    async def post(**kw): return httpx.Response(status, json=payload)
    monkeypatch.setattr("src.httpx_client.post_async", post)
    result = await manual.test(NAME, GEMINI if strict else None)
    body = json.loads(result.body)
    assert result.status_code == body["upstream_status"] == status
    assert body["success"] is success
    assert b"SECRET_NATIVE_MODEL" not in result.body
    assert body["verified_reply"] is None if not strict else body["verified_reply"] is success


async def test_google_success_survives_settlement_failure(panel_store, monkeypatch):
    async def post(**kw): return httpx.Response(200, json=reply())
    async def fail(*args, **kw): raise RuntimeError("SECRET_NATIVE_MODEL")
    monkeypatch.setattr("src.httpx_client.post_async", post)
    monkeypatch.setattr(panel_store, "manual_record_result", fail)
    result = await manual.test(NAME, GEMINI)
    body = json.loads(result.body)
    assert result.status_code == 200 and body["success"]
    assert body["state_update"]["settlement"]["status"] == "failed"
    assert b"SECRET" not in result.body


@pytest.mark.parametrize("old_remaining", [0, None])
async def test_manual_quota_forwards_hidden_opus_raw_values_to_sync(panel_store, monkeypatch, old_remaining):
    current = "claude-opus-5-5-medium"
    deadline = time.time() + 300
    await panel_store.set_model_cooldown(NAME, CLAUDE, deadline, "antigravity")
    models = {
        CLAUDE: {"remaining": old_remaining, "rawModelId": CLAUDE, "visible": False},
        current: {"remaining": 0.8, "rawModelId": current, "visible": True},
    }

    async def fetch(*args, **kwargs):
        return {"success": True, "models": models, "upstream_status": 200}

    monkeypatch.setattr(panel, "fetch_quota_info", fetch)
    result = await manual.quota(NAME, sync=True)
    assert result["models"] == models
    assert result["models"][CLAUDE]["remaining"] == old_remaining
    assert result["models"][current]["remaining"] == 0.8
    assert result["model_cooldowns"] == {CLAUDE: deadline}
    assert result["cleared"] == []
    assert await panel_store.quota_admit(NAME, current) is None


@pytest.mark.parametrize("models,clears", [
    ({GEMINI: {"remaining": 1}}, True),
    ({GEMINI: {"remaining": 1}, "gemini-other": {"remaining": None}}, False),
    ({GEMINI: {"remaining": 1}, "gemini-other": {"remaining": 0}}, False),
    ({GEMINI: {"remaining": None}}, False),
    ({GEMINI: {"remaining": True}}, False),
])
async def test_quota_evidence_matrix(store, models, clears):
    deadline = time.time()+3600
    await store.set_model_cooldown(NAME, GEMINI, deadline, "antigravity")
    result = await store.manual_sync_quota(NAME, models, {}, await store.manual_snapshot(NAME))
    assert (GEMINI not in result["model_cooldowns"]) is clears
    if not clears: assert result["model_cooldowns"][GEMINI] == deadline


async def test_rolling_positive_and_zero_keep_original_rules(store):
    models, observation = week()
    result = await store.manual_sync_quota(NAME, models, observation, await store.manual_snapshot(NAME))
    assert result["quota_group_states"]["gemini-shared"]["state"] == "manual_override"
    assert result["model_cooldowns"] == {}
    models[GEMINI]["remaining"] = 0
    result = await store.manual_sync_quota(NAME, models, observation, await store.manual_snapshot(NAME))
    assert result["model_cooldowns"][GEMINI] > time.time()+600000


async def test_conflicting_policy_does_not_erase_new_state_or_lose_counts(store):
    snap = await store.manual_snapshot(NAME)
    await store.set_model_cooldown(NAME, GEMINI, time.time()+3600, "antigravity")
    result = await store.manual_record_result(NAME, snap, GEMINI, True)
    assert result["counts"]["status"] == "applied" and result["quota"]["reason"] == "state_conflict"
    assert await store.quota_admit(NAME, GEMINI) is None


async def test_identity_replacement_blocks_old_result(store):
    snap = await store.manual_snapshot(NAME)
    await store.store_credential(NAME, {"access_token": "replacement"}, "antigravity")
    result = await store.manual_record_result(NAME, snap, GEMINI, True)
    assert result["counts"]["reason"] == "credential_changed"


async def test_duplicate_settlement_and_normal_group(store):
    snap = await store.manual_snapshot(NAME)
    results = await asyncio.gather(*(store.manual_record_result(NAME, snap, GEMINI, True) for _ in range(3)))
    assert sum(r["counts"]["status"] == "applied" for r in results) == 1
    assert (await store.quota_snapshot(NAME))["quota_group_states"] == {}


async def test_bad_policy_and_missing_generation_across_engines(backend):
    manager, db = backend
    db.row["quota_group_states"] = "bad json"
    snap = await manager.manual_snapshot(NAME)
    assert snap["generation"]
    result = await manager.manual_record_result(NAME, snap, GEMINI, False, status=403,
                                               error="Permission denied.", auto_ban=True)
    assert result["counts"]["status"] == "applied"
    assert result["quota"]["reason"] == "invalid_policy"
    assert db.row["quota_group_states"] == "bad json" and db.row["disabled"]
    assert db.row["call_count"] == 1


async def test_manual_quota_across_engines(backend):
    manager, db = backend
    await manager.set_model_cooldown(NAME, GEMINI, time.time()+3600, "antigravity")
    result = await manager.manual_sync_quota(NAME, {GEMINI: {"remaining": 1}}, {}, await manager.manual_snapshot(NAME))
    assert result["model_cooldowns"] == {} and result["state_update"]["gemini-shared"]["status"] == "applied"


async def test_manual_and_legacy_entry_are_separate(monkeypatch):
    from src.panel import antigravity_manual
    calls = []
    async def quota(filename, **kw): calls.append(kw); return {"success": True}
    monkeypatch.setattr(antigravity_manual, "quota", quota)
    await panel._fetch_quota_for_credential(NAME, "antigravity", origin="manual")
    assert calls == [{}]
    assert panel._fetch_quota_for_credential.__kwdefaults__["origin"] == "legacy"


async def test_quota_http_status_preserved_before_json_parsing(monkeypatch):
    import src.api.antigravity as api
    async def post(**kw): return httpx.Response(200, text="SECRET_NATIVE_MODEL invalid json")
    monkeypatch.setattr(api, "post_async", post)
    result = await api.fetch_quota_info("synthetic", origin="manual")
    assert result["upstream_status"] == 200 and not result["success"]
    assert "SECRET" not in json.dumps(result)


@pytest.mark.parametrize("failure", ["missing", "oauth"])
async def test_batch_quota_failure_retains_selected_filename(panel_store, monkeypatch, failure):
    import src.google_oauth_api as oauth
    filename = "missing.json" if failure == "missing" else NAME
    monkeypatch.setattr(panel, "Credentials", oauth.Credentials)
    if failure == "oauth":
        await panel_store.store_credential(NAME, {"refresh_token": "synthetic-refresh"}, "antigravity")
    async def refresh(*args, **kwargs):
        return httpx.Response(400, text="SECRET_NATIVE_MODEL", request=httpx.Request("POST", "https://synthetic.invalid/token"))
    monkeypatch.setattr(oauth, "post_async", refresh)
    result = await panel.batch_refresh_cooldown(
        panel.CredFileBatchTestRequest(filenames=[filename]), mode="antigravity", _token="synthetic")
    item = json.loads(result.body)["results"][0]
    assert item["filename"] == filename and not item["success"]
    assert item["upstream_status"] == (400 if failure == "oauth" else None)
    assert item["phase"] == ("oauth" if failure == "oauth" else "preparation")
    assert "SECRET" not in json.dumps(item)


async def test_healthy_backend_does_not_report_unsupported_cycles_as_conflict(backend):
    manager, db = backend
    result = await manager.manual_record_result(NAME, await manager.manual_snapshot(NAME), GEMINI, True)
    assert result["counts"]["status"] == "applied"
    assert result["quota"]["status"] == "applied"
    if manager.QUOTA_ENGINE == "postgres":
        assert result["cycle_stats"]["status"] == "applied"
    else:
        assert "cycle_stats" not in result
    assert not any(item.get("reason") == "state_conflict" for item in result.values())


@pytest.mark.parametrize("strict", [False, True])
async def test_retirement_never_returns_notice_or_clears_state(panel_store, monkeypatch, strict):
    await panel_store.set_model_cooldown(NAME, GEMINI, time.time()+500, "antigravity")
    async def post(**kw): return httpx.Response(200, json=reply("Gemini secret-native-model is no longer available."))
    monkeypatch.setattr("src.httpx_client.post_async", post)
    response = await manual.test(NAME, GEMINI if strict else None)
    assert response.status_code == 200 and not json.loads(response.body)["success"]
    assert b"secret-native-model" not in response.body
    assert await panel_store.quota_admit(NAME, GEMINI) is None


@pytest.mark.parametrize("replace", [False, True])
async def test_project_preserves_disabled_and_fences_replace(panel_store, monkeypatch, replace):
    from src.manual_google import observe_response
    await panel_store.update_credential_state(NAME, {"disabled": True, "permanent_disabled": True}, "antigravity")
    async def project(**kw):
        observe_response(httpx.Response(200))
        if replace:
            await panel_store.store_credential(NAME, {"access_token": "new", "project_id": "new-project"}, "antigravity")
        return "updated-project", "pro", 10
    monkeypatch.setattr(panel, "fetch_project_id_and_tier", project)
    response = await panel.verify_credential_project(NAME, token="synthetic", mode="antigravity")
    body = json.loads(response.body)
    assert response.status_code == 200 and body["success"]
    state = await panel_store.get_credential_state(NAME, "antigravity")
    assert state["disabled"] and state["permanent_disabled"]
    data = await panel_store.get_credential(NAME, "antigravity")
    assert data["project_id"] == ("new-project" if replace else "updated-project")
    assert body["state_update"]["project"]["status"] == ("skipped" if replace else "applied")


async def test_oauth_error_is_fixed_at_first_log_and_keeps_phase(panel_store, monkeypatch):
    import src.google_oauth_api as oauth
    from src import manual_google
    await panel_store.store_credential(NAME, {"access_token": "synthetic", "refresh_token": "synthetic-refresh"}, "antigravity")
    messages = []
    class Log:
        def __getattr__(self, level): return lambda msg, *a, **kw: messages.append(msg)
    monkeypatch.setattr(manual_google, "application_log", Log())
    monkeypatch.setattr(panel, "Credentials", oauth.Credentials)
    async def post(*a, **kw):
        return httpx.Response(403, text="SECRET_NATIVE_MODEL", request=httpx.Request("POST", "https://synthetic.invalid/SECRET_TOKEN"))
    monkeypatch.setattr(oauth, "post_async", post)
    response = await manual.test(NAME, GEMINI)
    body = json.loads(response.body)
    assert body["upstream_status"] == 403 and body["phase"] == "oauth"
    assert "SECRET" not in repr(messages) and b"SECRET" not in response.body
    # Outside the manual context, helper logging still follows the old path.
    oauth.log.info("legacy-log")
    assert messages[-1] == "legacy-log"


@pytest.mark.parametrize("replace", [False, True])
async def test_refresh_cas_race_reuses_only_same_generation(panel_store, monkeypatch, replace):
    from datetime import datetime, timedelta, timezone
    import src.google_oauth_api as oauth
    monkeypatch.setattr(panel, "Credentials", oauth.Credentials)
    await panel_store.store_credential(NAME, {"access_token": "synthetic", "refresh_token": "synthetic-refresh", "project_id": "p"}, "antigravity")
    old = await panel_store.manual_snapshot(NAME)
    expiry = (datetime.now(timezone.utc)+timedelta(hours=1)).isoformat()
    async def refresh(*a, **kw):
        fresh = {"access_token": "concurrent-token", "project_id": "p", "expiry": expiry,
                 "refresh_token": "replacement-refresh" if replace else "synthetic-refresh"}
        if replace:
            await panel_store.store_credential(NAME, fresh, "antigravity")
        else:
            await panel_store.quota_refresh_credential(NAME, old["generation"], fresh, expected_version=old["version"])
        return httpx.Response(200, json={"access_token": "losing-token", "expires_in": 3600}, request=httpx.Request("POST", "https://synthetic.invalid/token"))
    calls = []
    async def generate(**kw): calls.append(kw); return httpx.Response(200, json=reply())
    monkeypatch.setattr(oauth, "post_async", refresh)
    monkeypatch.setattr("src.httpx_client.post_async", generate)
    response = await manual.test(NAME, GEMINI)
    body = json.loads(response.body)
    assert body["success"] is (not replace)
    assert len(calls) == (0 if replace else 1)
    if calls: assert calls[0]["headers"]["Authorization"] == "Bearer concurrent-token"
    if replace:
        assert body["response_source"] == "local" and body["upstream_status"] is None
        assert body["phases"][0]["upstream_status"] == 200


async def test_concurrent_real_refresh_preserves_imported_identity_and_token_alias(panel_store, monkeypatch):
    import src.google_oauth_api as oauth
    monkeypatch.setattr(panel, "Credentials", oauth.Credentials)
    metadata = {"scopes": ["synthetic-scope"], "token_uri": "https://synthetic.invalid/token",
                "email": "synthetic@example.invalid"}
    await panel_store.store_credential(NAME, {**metadata, "token": "expired-token",
        "refresh_token": "synthetic-refresh", "project_id": "p"}, "antigravity")
    # Initialize the generation before racing, so both refreshes share a snapshot.
    await panel_store.manual_snapshot(NAME)
    both_refreshing = asyncio.Event()
    refresh_calls, generate_calls = [], []
    async def refresh(*args, **kwargs):
        token = f"refreshed-{len(refresh_calls)}"
        refresh_calls.append(token)
        if len(refresh_calls) == 2:
            both_refreshing.set()
        await both_refreshing.wait()
        return httpx.Response(200, json={"access_token": token, "expires_in": 3600},
                              request=httpx.Request("POST", "https://synthetic.invalid/token"))
    async def generate(**kwargs):
        generate_calls.append(kwargs)
        return httpx.Response(200, json=reply())
    monkeypatch.setattr(oauth, "post_async", refresh)
    monkeypatch.setattr("src.httpx_client.post_async", generate)
    results = await asyncio.wait_for(asyncio.gather(manual.test(NAME, GEMINI), manual.test(NAME, GEMINI)), 10)
    assert all(result.status_code == 200 and json.loads(result.body)["success"] for result in results)
    assert len(refresh_calls) == len(generate_calls) == 2
    saved = await panel_store.get_credential(NAME, "antigravity")
    assert all(saved[key] == value for key, value in metadata.items())
    assert saved["token"] == saved["access_token"] in refresh_calls
    assert oauth.Credentials.from_dict(saved).access_token == saved["access_token"]
    assert all(call["headers"]["Authorization"] == f"Bearer {saved['access_token']}" for call in generate_calls)


async def test_cancelled_dispatch_settles_once_and_keeps_cooldown(panel_store, monkeypatch):
    started = asyncio.Event()
    await panel_store.set_model_cooldown(NAME, GEMINI, time.time()+500, "antigravity")
    async def post(**kw): started.set(); await asyncio.Event().wait()
    monkeypatch.setattr("src.httpx_client.post_async", post)
    task = asyncio.create_task(manual.test(NAME, GEMINI))
    await started.wait(); task.cancel()
    with pytest.raises(asyncio.CancelledError): await task
    state = await panel_store.get_credential_state(NAME, "antigravity")
    assert state["failure_count"] == 1 and await panel_store.quota_admit(NAME, GEMINI) is None


async def test_http_manual_entry_still_requires_panel_auth(panel_store, monkeypatch):
    from fastapi import FastAPI, HTTPException
    app = FastAPI(); app.include_router(panel.router)
    async def deny(): raise HTTPException(401)
    app.dependency_overrides[panel.verify_panel_token] = deny
    async def forbidden(**kw): raise AssertionError("unauthenticated dispatch")
    monkeypatch.setattr("src.httpx_client.post_async", forbidden)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        response = await client.post(f"/creds/test/{NAME}?mode=antigravity")
    assert response.status_code == 401


async def test_corrupt_cycle_does_not_rollback_request_counts(store):
    import aiosqlite
    async with aiosqlite.connect(store._db_path) as db:
        await db.execute("UPDATE antigravity_credentials SET cycle_stats = ? WHERE filename = ?", ('{"total":"bad"}', NAME))
        await db.commit()
    result = await store.manual_record_result(NAME, await store.manual_snapshot(NAME), GEMINI, True)
    assert result["counts"]["status"] == "applied"
    assert result["cycle_stats"]["status"] == "skipped"


async def test_failed_project_lookup_cannot_clear_errors_from_tier_only(panel_store, monkeypatch):
    from src.manual_google import observe_response
    await panel_store.update_credential_state(NAME, {"error_codes": [403]}, "antigravity")
    async def project(**kw):
        observe_response(httpx.Response(200))
        observe_response(httpx.Response(403))
        return None, "pro", None
    monkeypatch.setattr(panel, "fetch_project_id_and_tier", project)
    response = await manual.project(NAME)
    assert response.status_code == 403 and not json.loads(response.body)["success"]
    assert (await panel_store.get_credential_state(NAME, "antigravity"))["error_codes"] == [403]


def test_frontend_shows_google_status_separately_from_validation_and_state():
    import shutil
    import subprocess
    from pathlib import Path
    node = shutil.which("node")
    if not node: pytest.skip("Node runtime unavailable")
    source = Path("front/common.js").read_text(encoding="utf-8")
    start = source.index("function manualResultSummary(")
    end = source.index("async function testAntigravityCredential", start)
    next_function = source.index("\nasync function ", end+1)
    script = r'''
const assert = require('node:assert/strict');
let payload, modal;
global.fetch = async () => ({status: 200, json: async () => payload});
global.getAuthHeaders = () => ({});
global.showStatus = () => {};
global.showMessageModal = (title, text, tone) => {modal = {title, text, tone};};
global.AppState = {antigravityCreds: {refresh: async () => {}}};
'''+source[start:next_function]+r'''
(async () => {
 payload = {success: false, upstream_status: 200, verified_reply: false, message: 'Invalid upstream response.'};
 await testAntigravityCredential('synthetic.json');
 assert.equal(modal.tone, 'error'); assert.match(modal.text, /Google HTTP 200/);
 assert.match(modal.text, /本地回复校验：未通过/);
 payload = {success: true, upstream_status: 200, state_update: {quota: {status:'failed',reason:'state_update_failed'}}};
 await testAntigravityCredential('synthetic.json');
 assert.equal(modal.tone, 'info'); assert.match(modal.text, /更新失败/);
 payload = {success: false, upstream_status: 429, message:'Rate limit exceeded.'};
 await testAntigravityCredential('synthetic.json');
 assert.equal(modal.tone, 'error'); assert.match(modal.text, /Google HTTP 429/);
})().catch(e => { console.error(e); process.exitCode=1; });
'''
    result = subprocess.run([node, "-"], input=script, text=True, encoding="utf-8", capture_output=True)
    assert result.returncode == 0, result.stderr


def test_batch_project_ui_reports_failure_phases_and_incomplete_updates():
    import shutil
    import subprocess
    from pathlib import Path
    node = shutil.which("node")
    if not node: pytest.skip("Node runtime unavailable")
    source = Path("front/common.js").read_text(encoding="utf-8")
    helper_start = source.index("function manualResultSummary(")
    helper_end = source.index("async function testAntigravityCredential", helper_start)
    start = source.index("async function batchVerifyAntigravityProjectIds(")
    end = source.index("\nasync function ", start+1)
    script = r'''
const assert = require('node:assert/strict');
let payloads, modal, status;
global.fetch = async () => {const data = payloads.shift(); return {ok: data.success, json: async () => data};};
global.confirm = () => true;
global.getAuthHeaders = () => ({});
global.showStatus = (text, tone) => {status = {text, tone};};
global.showMessageModal = (title, text, tone) => {modal = {title, text, tone};};
global.AppState = {antigravityCreds: {selectedFiles: new Set(['one.json', 'two.json']), refresh: async () => {}}};
'''+source[helper_start:helper_end]+source[start:end]+r'''
(async () => {
 const ok = {success:true, upstream_status:200, phase:'project', project_id:'synthetic-project', state_update:{project:{status:'applied'}}};
 for (const updateStatus of ['skipped', 'failed']) {
   const incomplete = {...ok, state_update:{project:{status:updateStatus, reason: updateStatus==='skipped'?'state_conflict':'state_update_failed'}}};
   payloads = [incomplete, incomplete];
   await batchVerifyAntigravityProjectIds();
   assert.equal(modal.tone, 'info'); assert.equal(status.tone, 'info');
   assert.match(modal.text, /状态回写未完成: 2 个/); assert.doesNotMatch(status.text, /全部检验成功/);
 }
 const denied = {success:false, upstream_status:403, phase:'project', error:'Permission denied.', phases:[{phase:'oauth',upstream_status:200},{phase:'project',upstream_status:403}]};
 payloads = [denied, denied];
 await batchVerifyAntigravityProjectIds();
 assert.equal(modal.tone, 'error');
 for (const filename of ['one.json', 'two.json']) assert.ok(modal.text.includes(filename));
 assert.match(modal.text, /Permission denied/); assert.match(modal.text, /Google HTTP 403/);
 assert.match(modal.text, /Token 刷新：Google HTTP 200/);
 payloads = [ok, denied]; await batchVerifyAntigravityProjectIds();
 assert.equal(modal.tone, 'info'); assert.match(modal.text, /Google HTTP 403/);
 payloads = [ok, ok]; await batchVerifyAntigravityProjectIds();
 assert.equal(modal.tone, 'success'); assert.match(modal.text, /状态回写未完成: 0 个/);
})().catch(e => {console.error(e);process.exitCode=1;});
'''
    result = subprocess.run([node, "-"], input=script, text=True, encoding="utf-8", capture_output=True)
    assert result.returncode == 0, result.stderr
