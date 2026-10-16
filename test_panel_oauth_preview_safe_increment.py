"""Synthetic panel response tests: no OAuth, Google, database or credential access."""
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from src.panel import auth, creds
from src.panel.credential_capabilities import panel_operation_capabilities
from src.antigravity_email_enrichment import WARNING


@pytest.fixture
async def panel(monkeypatch):
    result = {
        "success": True,
        "credentials": {"project_id": "synthetic-project", "token": "SYNTHETIC_PRIVATE_MARKER",
                        "refresh_token": "SYNTHETIC_PRIVATE_MARKER", "nested": {"client_secret": "SYNTHETIC_PRIVATE_MARKER"}},
        "file_path": "synthetic-file.json", "auto_detected_project": True,
        "subscription_tier": "unknown", "tier_raw_id": None, "tier_raw_name": None,
        "tier_detected_at": None, "tier_detection_status": "unavailable",
        "email_enrichment": {"job_id": "a" * 32, "accepted": 1, "skipped": 0,
                             "status_url": "https://unexpected.example.invalid/SYNTHETIC_PRIVATE_MARKER",
                             "extra": "SYNTHETIC_PRIVATE_MARKER"},
        "warnings": [WARNING, "SYNTHETIC_PRIVATE_MARKER"],
        "extra": "SYNTHETIC_PRIVATE_MARKER",
    }
    flow = AsyncMock(return_value=result)
    callback_url = AsyncMock(return_value=result)
    monkeypatch.setattr(auth, "asyncio_complete_auth_flow", flow)
    monkeypatch.setattr(auth, "complete_auth_flow_from_callback_url", callback_url)
    adapter = SimpleNamespace(
        get_credential=AsyncMock(return_value={"access_token": "synthetic-access-only", "project_id": "synthetic-project"}),
        update_credential_state=AsyncMock(return_value=True),
        store_credential=AsyncMock(),
    )
    monkeypatch.setattr(creds, "get_storage_adapter", AsyncMock(return_value=adapter))
    credentials = SimpleNamespace(refresh_if_needed=AsyncMock(return_value=False))
    monkeypatch.setattr(creds, "Credentials", SimpleNamespace(from_dict=lambda _: credentials))
    from src import httpx_client
    post = AsyncMock(side_effect=[SimpleNamespace(status_code=201), SimpleNamespace(status_code=201)])
    get = AsyncMock(side_effect=AssertionError("unexpected network call"))
    monkeypatch.setattr(httpx_client, "post_async", post)
    monkeypatch.setattr(httpx_client, "get_async", get)
    app = FastAPI()
    app.include_router(auth.router)
    app.include_router(creds.router)
    app.dependency_overrides[auth.verify_panel_token] = lambda: "synthetic-panel-only"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://synthetic.test") as client:
        yield SimpleNamespace(client=client, result=result, flow=flow, callback_url=callback_url,
                              adapter=adapter, post=post, get=get)


def callback_body(route, mode, include=None):
    body = {"project_id": "synthetic-project", "mode": mode}
    if route == "callback-url":
        body["callback_url"] = "http://localhost:12345/oauth2callback?code=synthetic&state=synthetic"
    if include is not None:
        body["include_credentials"] = include
    return body


@pytest.mark.parametrize("route", ["callback", "callback-url"])
@pytest.mark.parametrize("mode", ["geminicli", "antigravity"])
@pytest.mark.parametrize("include", [None, True])
async def test_callback_default_and_explicit_true_preserve_complete_legacy_fields(panel, route, mode, include):
    response = await panel.client.post(f"/auth/{route}", json=callback_body(route, mode, include))
    assert response.status_code == 200
    expected = {"credentials": panel.result["credentials"], "file_path": panel.result["file_path"],
                "message": "认证成功，凭证已保存" if route == "callback" else "从回调URL认证成功，凭证已保存",
                "auto_detected_project": True,
                **auth._oauth_subscription_fields(panel.result, mode)}
    assert response.json() == expected
    assert "cache-control" not in response.headers


@pytest.mark.parametrize("route", ["callback", "callback-url"])
@pytest.mark.parametrize("mode", ["geminicli", "antigravity"])
async def test_callback_safe_response_is_whitelisted_and_does_not_change_flow_arguments(panel, route, mode):
    if mode == "antigravity":
        panel.result.pop("subscription_tier")  # Real AG OAuth does not expose Tier in the flow result.
    response = await panel.client.post(f"/auth/{route}", json=callback_body(route, mode, False))
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    data = response.json()
    base = {"success", "mode", "filename", "project_id", "subscription_tier", "message", "auto_detected_project"}
    extra = ({"tier_raw_id", "tier_raw_name", "tier_detected_at", "tier_detection_status"}
             if mode == "geminicli" else {"email_enrichment", "warnings"})
    assert set(data) == base | extra
    assert data["filename"] == "synthetic-file.json" and data["project_id"] == "synthetic-project"
    assert data["subscription_tier"] == ("unknown" if mode == "geminicli" else None)
    assert "SYNTHETIC_PRIVATE_MARKER" not in response.text
    if mode == "antigravity":
        assert data["warnings"] == [WARNING]
        assert data["email_enrichment"] == {"job_id": "a" * 32, "accepted": 1, "skipped": 0,
                                              "status_url": "/creds/email-enrichment/" + "a" * 32}
    if route == "callback":
        panel.flow.assert_awaited_once_with("synthetic-project", "synthetic-panel-only", mode=mode)
        panel.callback_url.assert_not_awaited()
    else:
        panel.callback_url.assert_awaited_once_with(callback_body(route, mode)["callback_url"],
            "synthetic-project", mode=mode, user_session="synthetic-panel-only")
        panel.flow.assert_not_awaited()
    panel.adapter.get_credential.assert_not_awaited()
    panel.post.assert_not_awaited()


@pytest.mark.parametrize("route", ["callback", "callback-url"])
@pytest.mark.parametrize("flag", ["requires_manual_project_id", "requires_project_selection"])
async def test_safe_response_option_preserves_existing_failure_navigation(panel, route, flag):
    panel.result.clear()
    panel.result.update(success=False, error="synthetic safe failure", **{flag: True})
    if flag == "requires_project_selection":
        panel.result["available_projects"] = [{"project_id": "synthetic-project", "name": "Synthetic"}]
    response = await panel.client.post(f"/auth/{route}", json=callback_body(route, "geminicli", False))
    assert response.status_code == 400
    assert response.json() == {key: value for key, value in panel.result.items() if key != "success"}


async def test_invalid_callback_url_does_not_start_oauth(panel):
    response = await panel.client.post("/auth/callback-url", json={"callback_url": "invalid", "include_credentials": False})
    assert response.status_code == 400
    panel.callback_url.assert_not_awaited()


def test_safe_oauth_unknown_metadata_and_untrusted_receipt_remain_unknown():
    data = auth._oauth_success_fields({"file_path": "synthetic.json", "credentials": {"project_id": {"unexpected": "object"}},
        "tier_raw_name": ["not scalar"], "tier_detected_at": True,
        "email_enrichment": {"job_id": "untrusted", "accepted": -1, "skipped": "unknown"}},
        "antigravity", "local fixed message", False)
    assert data["project_id"] is None and data["subscription_tier"] is None
    assert data["email_enrichment"] == {"job_id": None, "accepted": 0, "skipped": 0, "status_url": None}
    gcli = auth._oauth_success_fields({"file_path": "synthetic.json", "credentials": {}, "tier_detected_at": True},
                                    "geminicli", "local fixed message", False)
    assert gcli["tier_detected_at"] is None


@pytest.mark.parametrize("binding", [200, 201, 409])
@pytest.mark.parametrize("stored", [True, False])
async def test_preview_retains_legacy_success_and_reports_actual_state_write(panel, binding, stored):
    panel.post.side_effect = [SimpleNamespace(status_code=201), SimpleNamespace(status_code=binding)]
    panel.adapter.update_credential_state.return_value = stored
    response = await panel.client.post("/creds/configure-preview/synthetic.json?mode=geminicli")
    assert response.status_code == 200
    data = response.json()
    assert data["success"] is True and data["preview"] is True and data["filename"] == "synthetic.json"
    assert data["state_update"] == {"preview": {"status": "applied"} if stored else
                                     {"status": "failed", "reason": "state_update_failed"}}
    assert set(data) == ({"success", "filename", "preview", "message", "state_update"} |
                         ({"setting_id", "binding_id"} if binding != 409 else set()))
    panel.adapter.update_credential_state.assert_awaited_once_with("synthetic.json", {"preview": True}, mode="geminicli")
    panel.adapter.store_credential.assert_not_awaited()
    assert panel.post.await_count == 2


async def test_preview_unsupported_mode_has_no_side_effects(panel):
    response = await panel.client.post("/creds/configure-preview/synthetic.json?mode=antigravity")
    assert response.status_code == 400
    panel.adapter.get_credential.assert_not_awaited()
    panel.adapter.update_credential_state.assert_not_awaited()
    panel.post.assert_not_awaited()


async def test_preview_upstream_failure_does_not_report_applied(panel):
    panel.post.side_effect = [SimpleNamespace(status_code=403, text="synthetic rejected")]
    response = await panel.client.post("/creds/configure-preview/synthetic.json?mode=geminicli")
    assert response.status_code == 403 and response.json()["success"] is False
    assert "state_update" not in response.json()
    panel.adapter.update_credential_state.assert_not_awaited()


async def test_preview_write_exception_retains_failure_status(panel):
    panel.adapter.update_credential_state.side_effect = RuntimeError("synthetic write failure")
    response = await panel.client.post("/creds/configure-preview/synthetic.json?mode=geminicli")
    assert response.status_code == 500


@pytest.mark.parametrize("mode,expected", [
    ("geminicli", ("geminicli.oauth.safe_response", "geminicli.preview.state_update")),
    ("antigravity", ("antigravity.oauth.safe_response",)), ("unknown", ()),
])
def test_response_capabilities_declare_only_implemented_modes(mode, expected):
    assert panel_operation_capabilities(mode) == expected
