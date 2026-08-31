from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.management.router import install_management_api
from src.management.schemas import (
    CapabilitiesResponse,
    CredentialActionResponse,
    CredentialBatchActionResponse,
    CredentialListResponse,
    PageInfo,
    StatsCounts,
    StatsResponse,
    SummaryResponse,
)
from src.management.service import get_management_service


class FakeManagementService:
    metadata = {
        "server_version": "fixture-modern",
        "revision": "fixture-revision",
        "generated_at": "2026-08-12T01:30:00Z",
    }

    async def capabilities(self) -> CapabilitiesResponse:
        return CapabilitiesResponse(
            **self.metadata,
            storage_backend="sqlite",
            capabilities=["credential.list", "node.summary"],
        )

    async def summary(self) -> SummaryResponse:
        return SummaryResponse(
            **self.metadata,
            uptime_seconds=10,
            modes={
                "geminicli": {
                    "total": 1,
                    "enabled": 1,
                    "disabled": 0,
                    "permanent_disabled": 0,
                    "cooling_down": None,
                },
                "antigravity": {
                    "total": None,
                    "enabled": None,
                    "disabled": None,
                    "permanent_disabled": None,
                    "cooling_down": None,
                },
            },
        )

    async def credentials(self, **_: object) -> CredentialListResponse:
        return CredentialListResponse(
            **self.metadata,
            credentials=[],
            page=PageInfo(total=0, limit=100, has_more=False, next_cursor=None),
        )

    async def stats(self, *, mode: str, window: str, group_by: str) -> StatsResponse:
        return StatsResponse(
            **self.metadata,
            mode=mode,
            window=window,
            group_by=group_by,
            totals=StatsCounts(success=None, failure=None, total=None, rpm=None),
            by_family={},
            daily=[],
        )

    async def execute_action(self, *, mode, filename, request) -> CredentialActionResponse:
        return CredentialActionResponse(
            **self.metadata,
            action=request.action,
            no_change=False,
            credential={"mode": mode, "filename": filename, "status": "disabled"},
            side_effects=[],
        )

    async def execute_batch(self, request) -> CredentialBatchActionResponse:
        return CredentialBatchActionResponse(
            **self.metadata,
            status="succeeded",
            results=[
                {
                    "mode": item.mode,
                    "filename": item.filename,
                    "action": item.action,
                    "status": "succeeded",
                    "no_change": False,
                    "credential_status": "disabled",
                    "error": None,
                    "side_effects": [],
                }
                for item in request.items
            ],
        )


def build_client() -> TestClient:
    app = FastAPI()
    install_management_api(app)
    app.dependency_overrides[get_management_service] = FakeManagementService
    return TestClient(app)


def test_management_api_is_disabled_for_every_path_without_token(monkeypatch) -> None:
    monkeypatch.delenv("NODE_MANAGEMENT_TOKEN", raising=False)
    client = build_client()

    capabilities = client.get("/management/v1/capabilities")
    unknown = client.get("/management/v1/not-implemented")

    assert capabilities.status_code == 503
    assert capabilities.json()["error"]["code"] == "MANAGEMENT_API_DISABLED"
    assert unknown.status_code == 503
    for method in ("head", "options", "post", "put", "patch", "delete"):
        response = client.request(method, "/management/v1/any-path")
        assert response.status_code == 503


def test_management_token_is_independent_and_wrong_token_is_401(monkeypatch) -> None:
    monkeypatch.setenv("NODE_MANAGEMENT_TOKEN", "fixture-management-token")
    monkeypatch.setenv("PANEL_PASSWORD", "fixture-panel-password")
    client = build_client()

    response = client.get(
        "/management/v1/capabilities",
        headers={"Authorization": "Bearer fixture-panel-password"},
    )

    assert response.status_code == 401
    assert response.json()["error"] == {
        "code": "AUTHENTICATION_FAILED",
        "message": "Management authentication failed",
        "retryable": False,
        "details": {},
    }


def test_management_success_envelope_and_validation_are_contract_shaped(monkeypatch) -> None:
    monkeypatch.setenv("NODE_MANAGEMENT_TOKEN", "fixture-management-token")
    client = build_client()
    headers = {"Authorization": "Bearer fixture-management-token"}

    success = client.get("/management/v1/capabilities", headers=headers)
    invalid = client.get(
        "/management/v1/credentials?mode=geminicli&error_code=1000",
        headers=headers,
    )

    assert success.status_code == 200
    assert success.json()["schema_version"] == "1.3"
    assert success.headers["cache-control"] == "no-store"
    assert invalid.status_code == 400
    assert invalid.json()["error"]["code"] == "INVALID_ACTION"
    combined = success.text + invalid.text
    assert "fixture-management-token" not in combined
    assert "fixture-panel-password" not in combined


def test_legacy_routes_remain_registered() -> None:
    from web import app

    paths = set(app.openapi()["paths"])
    assert "/version/info" in paths
    assert "/creds/status" in paths


def test_management_action_and_batch_responses_are_contract_shaped(monkeypatch) -> None:
    monkeypatch.setenv("NODE_MANAGEMENT_TOKEN", "fixture-management-token")
    client = build_client()
    headers = {"Authorization": "Bearer fixture-management-token"}

    single = client.post(
        "/management/v1/credentials/geminicli/credential.json/actions",
        headers=headers,
        json={
            "action": "disable",
            "parameters": {},
            "idempotency_key": "item-key-0001",
        },
    )
    batch = client.post(
        "/management/v1/credentials/batch-actions",
        headers=headers,
        json={
            "idempotency_key": "batch-key-0001",
            "items": [
                {
                    "mode": "geminicli",
                    "filename": "credential.json",
                    "action": "disable",
                    "parameters": {},
                    "idempotency_key": "item-key-0002",
                }
            ],
        },
    )

    assert single.status_code == 200
    assert single.json()["credential"]["status"] == "disabled"
    assert batch.status_code == 200
    assert batch.json()["results"][0]["status"] == "succeeded"
    assert single.headers["cache-control"] == "no-store"


def test_management_write_validation_is_strict_and_secret_safe(monkeypatch) -> None:
    monkeypatch.setenv("NODE_MANAGEMENT_TOKEN", "fixture-management-token")
    client = build_client()
    response = client.post(
        "/management/v1/credentials/geminicli/credential.json/actions",
        headers={"Authorization": "Bearer fixture-management-token"},
        json={
            "action": "disable",
            "parameters": {"token": "must-not-be-echoed"},
            "idempotency_key": "item-key-0003",
        },
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "INVALID_ACTION"
    assert "must-not-be-echoed" not in response.text


def test_management_batch_is_limited_to_one_hundred_items(monkeypatch) -> None:
    monkeypatch.setenv("NODE_MANAGEMENT_TOKEN", "fixture-management-token")
    client = build_client()
    response = client.post(
        "/management/v1/credentials/batch-actions",
        headers={"Authorization": "Bearer fixture-management-token"},
        json={
            "idempotency_key": "batch-key-too-large",
            "items": [
                {
                    "mode": "geminicli",
                    "filename": f"credential-{index}.json",
                    "action": "disable",
                    "parameters": {},
                    "idempotency_key": f"item-key-{index:04d}",
                }
                for index in range(101)
            ],
        },
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "INVALID_ACTION"
