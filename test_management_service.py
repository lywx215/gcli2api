from __future__ import annotations

import pytest
from src.management.auth import ManagementApiError
from src.management.service import ManagementService
from src.storage.sqlite_manager import SQLiteManager


class FakeBackend:
    async def get_credentials_summary(self, **kwargs):
        mode = kwargs["mode"]
        if mode == "antigravity":
            return {
                "items": [],
                "stats": {
                    "total": 0,
                    "normal": 0,
                    "disabled": 0,
                    "permanent_disabled": 0,
                },
            }
        return {
            "items": [
                {
                    "filename": "credential-001.json",
                    "user_email": "user001@example.invalid",
                    "disabled": False,
                    "permanent_disabled": False,
                    "health_status": "healthy",
                    "error_codes": [429, "invalid"],
                    "last_success": None,
                    "model_cooldowns": {"fixture-family": 1786509000},
                    "tier": "fixture-tier",
                    "preview": True,
                    "success_count": 10,
                    "failure_count": 1,
                    "cycle_stats": {"fixture-family": 11},
                    "last_cycle_stats": {},
                    "remark": "fixture",
                    "access_token": "must-not-leave-service",
                    "future_metadata": {"ignored": True},
                },
                {
                    "filename": "credential-002.json",
                    "user_email": None,
                    "disabled": True,
                    "permanent_disabled": False,
                    "error_codes": [],
                    "last_success": 1786507200,
                    "model_cooldowns": {},
                    "tier": None,
                    "preview": False,
                    "success_count": None,
                    "failure_count": None,
                    "cycle_stats": None,
                    "last_cycle_stats": None,
                    "remark": None,
                },
            ],
            "stats": {
                "total": 2,
                "normal": 1,
                "disabled": 1,
                "permanent_disabled": 0,
            },
        }

    async def get_today_stats_by_model(self, mode=None):
        return {
            "totals": {"success": 10, "failure": 1, "total": 11, "rpm": 2},
            "by_family": {
                "fixture-family": {
                    "success": 10,
                    "failure": 1,
                    "total": 11,
                    "rpm": 2,
                }
            },
        }

    async def get_recent_daily_stats(self, days=7, mode=None):
        return [
            {
                "date": "2026-08-12",
                "success_count": 10,
                "failure_count": 1,
                "total_count": 11,
            }
        ]


class FakeStorage:
    def __init__(self, backend=None, backend_type="sqlite") -> None:
        self._backend = backend or FakeBackend()
        self._backend_type = backend_type

    def get_backend_type(self) -> str:
        return self._backend_type


@pytest.fixture
def service(monkeypatch) -> ManagementService:
    async def storage():
        return FakeStorage()

    monkeypatch.setattr("src.management.service.get_storage_adapter", storage)
    return ManagementService()


@pytest.mark.asyncio
async def test_capabilities_are_declared_from_real_backend_methods(service) -> None:
    response = await service.capabilities()

    assert response.capabilities == [
        "credential.list",
        "node.summary",
        "stats.daily",
        "stats.model",
        "stats.rpm",
    ]


@pytest.mark.asyncio
async def test_summary_and_credentials_are_whitelisted_paginated_and_nullable(service) -> None:
    summary = await service.summary()
    first = await service.credentials(
        mode="geminicli",
        cursor=None,
        offset=0,
        limit=1,
        status=None,
        error_code=None,
        cooldown=None,
        preview=None,
        tier=None,
        remark=None,
    )
    second = await service.credentials(
        mode="geminicli",
        cursor=first.page.next_cursor,
        offset=None,
        limit=1,
        status=None,
        error_code=None,
        cooldown=None,
        preview=None,
        tier=None,
        remark=None,
    )

    assert summary.modes["geminicli"].total == 2
    assert summary.modes["geminicli"].cooling_down is None
    assert first.credentials[0].last_success is None
    assert first.credentials[0].error_codes == [429]
    assert first.page.has_more is True
    assert second.credentials[0].status == "disabled"
    serialized = first.model_dump_json() + second.model_dump_json()
    assert "must-not-leave-service" not in serialized
    assert "access_token" not in serialized
    assert "future_metadata" not in serialized

    with pytest.raises(ManagementApiError) as exc:
        await service.credentials(
            mode="geminicli",
            cursor="not-valid-base64!",
            offset=None,
            limit=1,
            status=None,
            error_code=None,
            cooldown=None,
            preview=None,
            tier=None,
            remark=None,
        )
    assert exc.value.status_code == 400


@pytest.mark.asyncio
async def test_stats_keep_short_window_unknowns_and_return_seven_day_data(service) -> None:
    short = await service.stats(mode="geminicli", window="5m", group_by="model")
    weekly = await service.stats(mode="geminicli", window="7d", group_by="model")

    assert short.totals.success is None
    assert short.totals.rpm == 2
    assert weekly.totals.total == 11
    assert weekly.daily[0].total == 11


@pytest.mark.asyncio
async def test_stats_are_501_when_backend_does_not_implement_them(monkeypatch) -> None:
    class ReadOnlyBackend:
        async def get_credentials_summary(self, **kwargs):
            return {"items": [], "stats": {}}

    async def storage():
        return FakeStorage(ReadOnlyBackend())

    monkeypatch.setattr("src.management.service.get_storage_adapter", storage)
    service = ManagementService()
    capabilities = await service.capabilities()

    assert capabilities.capabilities == ["credential.list", "node.summary"]
    with pytest.raises(ManagementApiError) as exc:
        await service.stats(mode="geminicli", window="24h", group_by="mode")
    assert exc.value.status_code == 501


@pytest.mark.asyncio
async def test_mongodb_noop_stats_stubs_are_not_declared(monkeypatch) -> None:
    async def storage():
        return FakeStorage(FakeBackend(), backend_type="mongodb")

    monkeypatch.setattr("src.management.service.get_storage_adapter", storage)
    service = ManagementService()

    capabilities = await service.capabilities()
    assert capabilities.capabilities == ["credential.list", "node.summary"]
    with pytest.raises(ManagementApiError) as exc:
        await service.stats(mode="geminicli", window="24h", group_by="model")
    assert exc.value.status_code == 501


@pytest.mark.asyncio
async def test_real_sqlite_metadata_is_nullable_utc_and_secret_free(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setenv("CREDENTIALS_DIR", str(tmp_path))
    backend = SQLiteManager()
    await backend.initialize()
    try:
        await backend.store_credential(
            "fixture.json",
            {
                "project_id": "fixture-project",
                "access_token": "fixture-access-token",
                "refresh_token": "fixture-refresh-token",
                "client_secret": "fixture-client-secret",
            },
            mode="geminicli",
        )
        await backend.update_credential_state(
            "fixture.json",
            {
                "last_success": 1786507200,
                "success_count": 1,
                "user_email": "fixture@example.invalid",
            },
            mode="geminicli",
        )
        await backend.store_credential(
            "unknown-time.json",
            {"refresh_token": "second-fixture-refresh-token"},
            mode="antigravity",
        )

        async def storage():
            return FakeStorage(backend)

        monkeypatch.setattr("src.management.service.get_storage_adapter", storage)
        service = ManagementService()
        geminicli = await service.credentials(
            mode="geminicli",
            cursor=None,
            offset=0,
            limit=100,
            status=None,
            error_code=None,
            cooldown=None,
            preview=None,
            tier=None,
            remark=None,
        )
        antigravity = await service.credentials(
            mode="antigravity",
            cursor=None,
            offset=0,
            limit=100,
            status=None,
            error_code=None,
            cooldown=None,
            preview=None,
            tier=None,
            remark=None,
        )

        assert geminicli.credentials[0].last_success == "2026-08-12T04:00:00Z"
        assert geminicli.credentials[0].health_status is None
        assert antigravity.credentials[0].last_success is None
        serialized = geminicli.model_dump_json() + antigravity.model_dump_json()
        assert "fixture-access-token" not in serialized
        assert "fixture-refresh-token" not in serialized
        assert "fixture-client-secret" not in serialized
    finally:
        await backend.close()
