"""OAuth ownership and one-shot completion tests: no sockets, Google, or storage."""

import asyncio
import hashlib
import hmac
import io
import json
import threading
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from urllib.parse import parse_qs, urlencode, urlparse

import httpx
import pytest
from fastapi import FastAPI

from src import auth, google_oauth_api
from src.panel import auth as panel_auth


PASSWORD = "synthetic-panel-password-only"
CODE = "synthetic-authorization-code-only"
TOKEN = "synthetic-access-token-only"
REAL_SAVE_CREDENTIALS = auth.save_credentials


@pytest.fixture
def isolated(monkeypatch):
    clock = SimpleNamespace(now=1000.0)
    servers, flows = [], []
    creds = SimpleNamespace(access_token=TOKEN, refresh_token="synthetic-refresh-only", expires_at=None)

    class FakeFlow:
        def __init__(self, **kwargs):
            self.redirect_uri = kwargs["redirect_uri"]
            self.exchange_code = AsyncMock(return_value=creds)
            flows.append(self)

        def get_auth_url(self, state):
            return "https://synthetic.example.invalid/authorize?" + urlencode({"state": state})

    class FakeServer:
        def __init__(self, port):
            self.server_port = port
            self.closed = False
            self.started = False
            servers.append(self)

        def serve_forever(self):
            self.started = True

        def server_close(self):
            self.closed = True

    class FakeThread:
        def __init__(self, target, **kwargs):
            self.target = target

        def start(self):
            self.target()

    async def find_port():
        return 12000 + len(servers)

    def shutdown(server, port):
        assert port == server.server_port
        server.server_close()

    monkeypatch.setattr(auth, "auth_flows", {})
    monkeypatch.setattr(auth, "time", SimpleNamespace(time=lambda: clock.now))
    monkeypatch.setattr(auth, "threading", SimpleNamespace(Thread=FakeThread, Lock=threading.Lock))
    monkeypatch.setattr(auth, "Flow", FakeFlow)
    monkeypatch.setattr(auth, "find_available_port", find_port)
    monkeypatch.setattr(auth, "create_callback_server", FakeServer)
    monkeypatch.setattr(auth, "async_shutdown_server", shutdown)
    monkeypatch.setattr(auth, "get_antigravity_api_url", AsyncMock(return_value="https://synthetic.example.invalid"))
    monkeypatch.setattr(auth, "get_code_assist_endpoint", AsyncMock(return_value="https://synthetic.example.invalid"))
    monkeypatch.setattr(auth, "fetch_project_id_and_tier", AsyncMock(return_value=("synthetic-project", "free")))
    monkeypatch.setattr(auth, "get_user_projects", AsyncMock(return_value=[]))
    monkeypatch.setattr(auth, "enable_required_apis", AsyncMock())
    monkeypatch.setattr(auth, "select_default_project", AsyncMock(return_value=None))
    info = SimpleNamespace(tier="free", raw_tier_id=None, raw_tier_name=None, detected_at=None, status="available")
    monkeypatch.setattr(auth, "_detect_geminicli_subscription", AsyncMock(return_value=info))
    monkeypatch.setattr(auth, "save_credentials", AsyncMock(return_value="synthetic-file.json"))
    # Any unexpected production access fails closed.
    monkeypatch.setattr(auth, "get_storage_adapter", AsyncMock(side_effect=AssertionError("unexpected storage")))
    monkeypatch.setattr(google_oauth_api, "post_async", AsyncMock(side_effect=AssertionError("unexpected network")))
    logger = Mock()
    monkeypatch.setattr(auth, "log", logger)
    monkeypatch.setattr(panel_auth, "log", logger)
    monkeypatch.setattr(google_oauth_api, "log", logger)
    for key in ("CLIENT_ID", "CLIENT_SECRET", "ANTIGRAVITY_CLIENT_ID", "ANTIGRAVITY_CLIENT_SECRET"):
        monkeypatch.setattr(auth, key, "synthetic-client-value")
    return SimpleNamespace(clock=clock, servers=servers, flows=flows, creds=creds, log=logger)


async def start(owner=PASSWORD, mode="antigravity", project=None):
    result = await auth.create_auth_url(project, owner, mode)
    assert result["success"]
    return result["state"], auth.auth_flows[result["state"]], result


def callback_url(state, data, code=CODE):
    return data["callback_url"] + "/?" + urlencode({"state": state, "code": code})


async def finish_url(state, data, owner=PASSWORD, mode="antigravity", **kwargs):
    return await auth.complete_auth_flow_from_callback_url(
        callback_url(state, data), user_session=owner, mode=mode, **kwargs
    )


@pytest.mark.asyncio
async def test_state_is_opaque_and_owner_never_leaves_process(isolated):
    state, data, result = await start()
    assert len(state) == 43
    assert parse_qs(urlparse(result["auth_url"]).query)["state"] == [state]
    expected = hmac.new(auth._SESSION_SECRET, PASSWORD.encode(), hashlib.sha256).hexdigest()
    assert data["session_key"] == expected
    assert "user_session" not in data
    assert PASSWORD not in json.dumps(result)
    assert expected not in json.dumps(result)
    assert PASSWORD not in str(isolated.log.mock_calls)
    assert state not in str(isolated.log.mock_calls)


@pytest.mark.asyncio
async def test_restart_replaces_only_same_owner_and_mode(isolated):
    first, old, _ = await start()
    other, other_data, _ = await start("synthetic-other-owner")
    cli, cli_data, _ = await start(mode="geminicli")
    latest, _, _ = await start()
    assert set(auth.auth_flows) == {other, cli, latest}
    assert old["server"].closed
    assert not other_data["server"].closed
    assert not cli_data["server"].closed
    assert not (await finish_url(first, old))["success"]


@pytest.mark.asyncio
@pytest.mark.parametrize("owner,mode", [(None, "antigravity"), ("synthetic-other-owner", "antigravity"), (PASSWORD, "geminicli")])
async def test_callback_url_rejects_other_owner_or_mode(isolated, owner, mode):
    state, data, _ = await start(project="synthetic-project")
    assert not (await finish_url(state, data, owner, mode))["success"]
    data["flow"].exchange_code.assert_not_awaited()
    auth.save_credentials.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("entry", [auth.complete_auth_flow, auth.asyncio_complete_auth_flow])
async def test_legacy_completions_do_not_fall_back_across_owner_or_mode(isolated, entry):
    state, data, _ = await start(project="synthetic-project")
    assert auth._accept_callback(state, CODE, data["callback_port"])
    for owner, mode in [(None, "antigravity"), ("synthetic-other-owner", "antigravity"), (PASSWORD, "geminicli")]:
        assert not (await entry("synthetic-project", owner, mode))["success"]
        assert auth.get_auth_status("synthetic-project", owner, mode) == {"status": "not_found"}
    data["flow"].exchange_code.assert_not_awaited()
    assert auth.get_auth_status("synthetic-project", PASSWORD, "antigravity")["state"] == state


@pytest.mark.asyncio
@pytest.mark.parametrize("method", ["url", "status", "async", "legacy", "provider"])
async def test_expiry_at_600_seconds_rejects_and_closes_resources(isolated, method):
    state, data, _ = await start(project="synthetic-project")
    isolated.clock.now += 600
    if method == "url":
        assert not (await finish_url(state, data))["success"]
    elif method == "status":
        assert auth.get_auth_status("synthetic-project", PASSWORD, "antigravity")["status"] == "not_found"
    elif method == "provider":
        assert not auth._accept_callback(state, CODE, data["callback_port"])
    else:
        entry = auth.complete_auth_flow if method == "legacy" else auth.asyncio_complete_auth_flow
        assert not (await entry("synthetic-project", PASSWORD, "antigravity"))["success"]
    assert not auth.auth_flows
    assert data["server"].closed
    data["flow"].exchange_code.assert_not_awaited()


@pytest.mark.asyncio
async def test_provider_callback_checks_port_and_refuses_replay(isolated):
    state, data, _ = await start()
    assert not auth._accept_callback(state, CODE, data["callback_port"] + 1)
    assert data["code"] is None
    assert auth._accept_callback(state, CODE, data["callback_port"])
    assert not auth._accept_callback(state, "synthetic-other-code", data["callback_port"])
    assert data["code"] == CODE


@pytest.mark.asyncio
async def test_http_callback_handler_validates_duplicate_parameters_and_port(isolated):
    state, data, _ = await start()
    handler = object.__new__(auth.AuthCallbackHandler)
    handler.send_response = Mock()
    handler.send_header = Mock()
    handler.end_headers = Mock()
    handler.wfile = io.BytesIO()
    handler.server = SimpleNamespace(server_port=data["callback_port"])
    handler.path = "/?" + urlencode({"state": state, "code": CODE}) + "&state=synthetic-other"
    handler.do_GET()
    handler.send_response.assert_called_with(400)
    handler.path = "/?" + urlencode({"state": state, "code": CODE})
    handler.server.server_port += 1
    handler.do_GET()
    handler.send_response.assert_called_with(400)
    handler.server.server_port -= 1
    handler.do_GET()
    handler.send_response.assert_called_with(200)
    assert CODE not in str(isolated.log.mock_calls)
    assert state not in str(isolated.log.mock_calls)


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["port", "host", "path", "scheme", "userinfo", "fragment", "duplicate", "missing", "unknown"])
async def test_callback_url_requires_exact_flow_and_callback_binding(isolated, change):
    state, data, _ = await start()
    url = callback_url(state, data)
    if change == "port":
        url = url.replace(str(data["callback_port"]), str(data["callback_port"] + 1))
    elif change == "host":
        url = url.replace(auth.CALLBACK_HOST, "synthetic.example.invalid")
    elif change == "path":
        url = url.replace("/?", "/different?")
    elif change == "scheme":
        url = url.replace("http:", "https:")
    elif change == "userinfo":
        url = url.replace("://", "://synthetic-user@")
    elif change == "fragment":
        url += "#synthetic-fragment"
    elif change == "duplicate":
        url += "&code=synthetic-other-code"
    elif change == "missing":
        url = data["callback_url"]
    else:
        url = url.replace(state, "synthetic-unknown-state")
    result = await auth.complete_auth_flow_from_callback_url(url, mode="antigravity", user_session=PASSWORD)
    assert not result["success"]
    data["flow"].exchange_code.assert_not_awaited()


@pytest.mark.asyncio
async def test_concurrent_completion_exchanges_and_saves_once(isolated):
    state, data, _ = await start()
    entered, release = asyncio.Event(), asyncio.Event()

    async def exchange(code):
        entered.set()
        await release.wait()
        return isolated.creds

    data["flow"].exchange_code.side_effect = exchange
    first = asyncio.create_task(finish_url(state, data))
    await entered.wait()
    duplicate = await auth.asyncio_complete_auth_flow(user_session=PASSWORD, mode="antigravity")
    assert not duplicate["success"]
    release.set()
    assert (await first)["success"]
    assert not (await finish_url(state, data))["success"]
    data["flow"].exchange_code.assert_awaited_once_with(CODE)
    auth.save_credentials.assert_awaited_once()
    assert data["server"].closed
    for secret in (PASSWORD, CODE, TOKEN, state, data["session_key"], data["callback_url"]):
        assert secret not in str(isolated.log.mock_calls)


@pytest.mark.asyncio
async def test_unknown_exchange_outcome_is_not_retried_or_logged(isolated):
    state, data, _ = await start()
    data["flow"].exchange_code.side_effect = RuntimeError(PASSWORD + CODE + TOKEN)
    result = await finish_url(state, data)
    assert not result["success"]
    assert not (await finish_url(state, data))["success"]
    data["flow"].exchange_code.assert_awaited_once()
    auth.save_credentials.assert_not_awaited()
    assert data["server"].closed
    for secret in (PASSWORD, CODE, TOKEN):
        assert secret not in str(isolated.log.mock_calls) + str(result)


@pytest.mark.asyncio
async def test_project_selection_resumes_cached_credentials(isolated):
    state, data, _ = await start(mode="geminicli")
    auth.fetch_project_id_and_tier.return_value = (None, None)
    auth.get_user_projects.return_value = [
        {"projectId": "synthetic-one", "displayName": "One", "projectNumber": "1"},
        {"projectId": "synthetic-two", "displayName": "Two", "projectNumber": "2"},
    ]
    assert auth._accept_callback(state, CODE, data["callback_port"])
    result = await auth.asyncio_complete_auth_flow(user_session=PASSWORD, mode="geminicli")
    assert result["requires_project_selection"]
    assert result["available_projects"][1]["project_id"] == "synthetic-two"
    assert not data["server"].closed
    assert (await auth.complete_auth_flow("synthetic-two", PASSWORD, "geminicli"))["success"]
    assert auth.save_credentials.await_args.args[1] == "synthetic-two"
    data["flow"].exchange_code.assert_awaited_once()
    assert data["server"].closed


@pytest.mark.asyncio
async def test_replacement_during_exchange_cannot_save_stale_flow(isolated):
    state, data, _ = await start()

    async def exchange(code):
        await start()
        return isolated.creds

    data["flow"].exchange_code.side_effect = exchange
    assert not (await finish_url(state, data))["success"]
    auth.save_credentials.assert_not_awaited()
    assert state not in auth.auth_flows
    assert data["server"].closed


@pytest.mark.asyncio
async def test_expiry_during_project_lookup_cannot_save(isolated):
    state, data, _ = await start()

    async def detect(*args):
        isolated.clock.now += 600
        return "synthetic-project", "free"

    auth.fetch_project_id_and_tier.side_effect = detect
    assert not (await finish_url(state, data))["success"]
    auth.save_credentials.assert_not_awaited()
    assert data["server"].closed


@pytest.mark.asyncio
async def test_route_passes_owner_to_callback_url_and_status(isolated):
    app = FastAPI()
    app.include_router(panel_auth.router)
    app.dependency_overrides[panel_auth.verify_panel_token] = lambda: PASSWORD
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/auth/start", json={"project_id": "synthetic-project", "mode": "antigravity"})
        assert response.status_code == 200
        result = response.json()
        assert set(result) == {"auth_url", "state", "auto_project_detection", "detected_project_id"}
        state = result["state"]
        data = auth.auth_flows[state]
        status = await client.get("/auth/status/synthetic-project?mode=antigravity")
        assert status.json()["state"] == state
        app.dependency_overrides[panel_auth.verify_panel_token] = lambda: "synthetic-other-owner"
        denied = await client.post("/auth/callback-url", json={"callback_url": callback_url(state, data), "mode": "antigravity"})
        assert denied.status_code == 400
        data["flow"].exchange_code.assert_not_awaited()
        app.dependency_overrides[panel_auth.verify_panel_token] = lambda: PASSWORD
        completed = await client.post("/auth/callback-url", json={"callback_url": callback_url(state, data), "mode": "antigravity"})
        assert completed.status_code == 200
        assert set(completed.json()) == {"credentials", "file_path", "message", "auto_detected_project", "email_enrichment", "warnings"}
        assert PASSWORD not in completed.text
        assert data["session_key"] not in completed.text


@pytest.mark.asyncio
async def test_provider_exchange_error_does_not_expose_exception(isolated, monkeypatch):
    monkeypatch.setattr(google_oauth_api, "get_oauth_proxy_url", AsyncMock(return_value="https://synthetic.example.invalid"))
    google_oauth_api.post_async.side_effect = RuntimeError(PASSWORD + CODE + TOKEN)
    flow = google_oauth_api.Flow(client_id="synthetic", client_secret="synthetic", scopes=[], redirect_uri="http://localhost:12000")
    with pytest.raises(google_oauth_api.TokenError) as exc:
        await flow.exchange_code(CODE)
    assert str(exc.value) == "获取token失败"
    for secret in (PASSWORD, CODE, TOKEN):
        assert secret not in str(isolated.log.mock_calls)


@pytest.mark.asyncio
async def test_cancelled_exchange_cleans_server_and_cannot_be_redeemed_again(isolated):
    state, data, _ = await start()
    entered = asyncio.Event()

    async def exchange(code):
        entered.set()
        await asyncio.Event().wait()

    data["flow"].exchange_code.side_effect = exchange
    task = asyncio.create_task(finish_url(state, data))
    await entered.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert data["server"].closed
    assert not (await finish_url(state, data))["success"]
    data["flow"].exchange_code.assert_awaited_once()


@pytest.mark.asyncio
async def test_failed_save_does_not_repeat_exchange_or_persistence(isolated):
    state, data, _ = await start()
    auth.save_credentials.side_effect = RuntimeError(PASSWORD)
    assert not (await finish_url(state, data))["success"]
    assert not (await finish_url(state, data))["success"]
    auth.save_credentials.assert_awaited_once()
    data["flow"].exchange_code.assert_awaited_once()
    assert data["server"].closed
    assert PASSWORD not in str(isolated.log.mock_calls)


@pytest.mark.asyncio
async def test_start_failure_after_server_creation_closes_resource(isolated, monkeypatch):
    class BrokenThread:
        def __init__(self, **kwargs):
            pass

        def start(self):
            raise RuntimeError(PASSWORD)

    monkeypatch.setattr(auth.threading, "Thread", BrokenThread)
    result = await auth.create_auth_url(user_session=PASSWORD, mode="antigravity")
    assert not result["success"]
    assert isolated.servers[0].closed
    assert not auth.auth_flows
    assert PASSWORD not in str(result) + str(isolated.log.mock_calls)


@pytest.mark.asyncio
async def test_capacity_and_memory_cleanup_close_removed_servers(isolated):
    states = []
    for index in range(auth.MAX_AUTH_FLOWS + 1):
        state, data, _ = await start(owner=f"synthetic-owner-{index}")
        states.append((state, data))
        isolated.clock.now += 1
    assert len(auth.auth_flows) == auth.MAX_AUTH_FLOWS
    assert states[0][1]["server"].closed
    assert auth.cleanup_auth_flows_for_memory() == 10
    for state, data in states:
        assert data["server"].closed == (state not in auth.auth_flows)


@pytest.mark.asyncio
async def test_waiting_completion_rechecks_ttl_without_exchanging(isolated, monkeypatch):
    state, data, _ = await start()

    async def sleep(seconds):
        isolated.clock.now += 600

    monkeypatch.setattr(auth, "asyncio", SimpleNamespace(sleep=sleep, CancelledError=asyncio.CancelledError))
    result = await auth.asyncio_complete_auth_flow(user_session=PASSWORD, mode="antigravity")
    assert not result["success"]
    data["flow"].exchange_code.assert_not_awaited()
    assert data["server"].closed


@pytest.mark.asyncio
@pytest.mark.parametrize("flag", ["requires_manual_project_id", "requires_project_selection"])
async def test_route_keeps_manual_project_intermediate_response(isolated, monkeypatch, flag):
    result = {"success": False, "error": "请选择项目", flag: True, "available_projects": []}
    monkeypatch.setattr(panel_auth, "asyncio_complete_auth_flow", AsyncMock(return_value=result))
    app = FastAPI()
    app.include_router(panel_auth.router)
    app.dependency_overrides[panel_auth.verify_panel_token] = lambda: PASSWORD
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/auth/callback", json={"mode": "antigravity"})
    assert response.status_code == 400
    assert response.json()[flag] is True


@pytest.mark.asyncio
@pytest.mark.parametrize("entry", ["url", "async", "legacy"])
@pytest.mark.parametrize("pause_at", ["get_storage", "import"])
async def test_persistence_boundary_survives_replacement_and_expiry_attempts(isolated, monkeypatch, entry, pause_at):
    from src import antigravity_email_enrichment as enrichment

    state, data, _ = await start()
    entered, release = asyncio.Event(), asyncio.Event()
    storage = SimpleNamespace(store_credential=AsyncMock(return_value=True))

    async def get_storage():
        if pause_at == "get_storage":
            entered.set()
            await release.wait()
        return storage

    async def import_receipt(adapter, filename, creds_data, **kwargs):
        if pause_at == "import":
            entered.set()
            await release.wait()
        await adapter.store_credential(filename, creds_data)

    batch = SimpleNamespace(seal=Mock(), public=lambda: {}, warnings=[])
    monkeypatch.setattr(auth, "save_credentials", REAL_SAVE_CREDENTIALS)
    monkeypatch.setattr(auth, "get_storage_adapter", get_storage)
    monkeypatch.setattr(enrichment, "import_with_email_receipt", import_receipt)
    monkeypatch.setattr(enrichment.email_enrichment_service, "batch", lambda: batch)
    if entry == "url":
        pending = asyncio.create_task(finish_url(state, data))
    else:
        assert auth._accept_callback(state, CODE, data["callback_port"])
        complete = auth.complete_auth_flow if entry == "legacy" else auth.asyncio_complete_auth_flow
        pending = asyncio.create_task(complete(user_session=PASSWORD, mode="antigravity"))
    await entered.wait()
    storage.store_credential.assert_not_awaited()
    assert data["persisting"]
    isolated.clock.now += 600
    auth.cleanup_expired_flows()
    auth.cleanup_auth_flows_for_memory()
    replacement = await auth.create_auth_url(user_session=PASSWORD, mode="antigravity")
    assert not replacement["success"]
    assert "保存中" in replacement["error"]
    assert auth.auth_flows[state] is data
    assert not data["server"].closed
    assert not (await finish_url(state, data))["success"]
    release.set()
    assert (await pending)["success"]
    storage.store_credential.assert_awaited_once()
    data["flow"].exchange_code.assert_awaited_once()
    assert data["server"].closed
    assert not auth.auth_flows
    assert (await auth.create_auth_url(user_session=PASSWORD, mode="antigravity"))["success"]


@pytest.mark.asyncio
@pytest.mark.parametrize("pause_at", ["get_storage", "atomic_import"])
async def test_cancelled_http_waiter_retains_commit_admission_until_real_registry_settles(isolated, monkeypatch, pause_at):
    from src import antigravity_email_enrichment as enrichment
    from src.antigravity_directory_runtime import AtomicRegistry

    state, data, _ = await start()
    entered, release = asyncio.Event(), asyncio.Event()
    writes = []

    async def import_receipt(filename, creds_data, **kwargs):
        if pause_at == "atomic_import":
            entered.set()
            await release.wait()
        writes.append(filename)
        return SimpleNamespace(filename=filename)

    storage = SimpleNamespace(add_antigravity_credential_with_receipt=import_receipt)

    async def get_storage():
        if pause_at == "get_storage":
            entered.set()
            await release.wait()
        return storage

    batch = SimpleNamespace(job=None, seal=Mock(), public=lambda: {}, warnings=[], add=Mock())
    registry = AtomicRegistry()
    monkeypatch.setattr(enrichment, "atomic_registry", registry)
    monkeypatch.setattr(enrichment.email_enrichment_service, "batch", lambda: batch)
    monkeypatch.setattr(auth, "save_credentials", REAL_SAVE_CREDENTIALS)
    monkeypatch.setattr(auth, "get_storage_adapter", get_storage)
    pending = asyncio.create_task(finish_url(state, data))
    await entered.wait()
    pending.cancel()
    await asyncio.sleep(0)
    pending.cancel()  # A second disconnect/shutdown signal cannot release it.
    await asyncio.sleep(0)
    assert not pending.done()
    assert not writes
    isolated.clock.now += 600
    auth.cleanup_expired_flows()
    replacement = await auth.create_auth_url(user_session=PASSWORD, mode="antigravity")
    assert not replacement["success"]
    assert auth.auth_flows[state] is data
    assert data["completion_lock"].locked()
    assert not data["server"].closed
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await pending
    assert len(writes) == 1
    assert not registry.tasks
    batch.add.assert_called_once()
    assert not auth.auth_flows
    assert data["server"].closed
    assert not (await finish_url(state, data))["success"]
    data["flow"].exchange_code.assert_awaited_once()
