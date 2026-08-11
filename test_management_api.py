from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.management.router import install_management_api
from src.management.schemas import (
    CapabilitiesResponse,
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
    assert success.json()["schema_version"] == "1.0"
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
