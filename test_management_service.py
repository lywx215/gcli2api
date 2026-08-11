from __future__ import annotations

import pytest
from src.management.auth import ManagementApiError
from src.management.service import ManagementService
from src.management.schemas import (
    CredentialActionRequest,
    CredentialBatchActionItem,
    CredentialBatchActionRequest,
)
from src.storage.sqlite_manager import SQLiteManager
from src.storage_adapter import StorageAdapter


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


class FakeWriteBackend:
    def __init__(self) -> None:
        self.credentials = {
            "one.json": {"disabled": False, "permanent_disabled": False, "remark": ""},
            "two.json": {"disabled": False, "permanent_disabled": False, "remark": ""},
        }
        self.config = {}
        self.update_calls: list[tuple[str, dict[str, object]]] = []
        self.delete_calls: list[str] = []
        self.active: dict[str, int] = {}
        self.max_active: dict[str, int] = {}

    def get_backend_type(self) -> str:
        return "sqlite"

    async def list_credentials(self, mode="geminicli"):
        return list(self.credentials)

    async def get_credential_state(self, filename, mode="geminicli"):
        return dict(self.credentials.get(filename, {}))

    async def update_credential_state(self, filename, updates, mode="geminicli"):
        import asyncio

        if filename not in self.credentials:
            return False
        self.active[filename] = self.active.get(filename, 0) + 1
        self.max_active[filename] = max(
            self.max_active.get(filename, 0), self.active[filename]
        )
        await asyncio.sleep(0.001)
        self.credentials[filename].update(updates)
        self.update_calls.append((filename, dict(updates)))
        self.active[filename] -= 1
        return True

    async def delete_credential(self, filename, mode="geminicli"):
        self.delete_calls.append(filename)
        return self.credentials.pop(filename, None) is not None

    async def get_config(self, key, default=None):
        return self.config.get(key, default)

    async def set_config(self, key, value):
        self.config[key] = value
        return True


def write_service(monkeypatch, backend: FakeWriteBackend) -> ManagementService:
    async def storage():
        backend._backend = backend
        return backend

    monkeypatch.setattr("src.management.service.get_storage_adapter", storage)
    return ManagementService()


@pytest.mark.asyncio
async def test_single_action_is_persistent_idempotent_and_conflict_safe(monkeypatch) -> None:
    backend = FakeWriteBackend()
    service = write_service(monkeypatch, backend)
    request = CredentialActionRequest(
        action="disable", parameters={}, idempotency_key="item-key-0001"
    )

    first = await service.execute_action(
        mode="geminicli", filename="one.json", request=request
    )
    replay = await service.execute_action(
        mode="geminicli", filename="one.json", request=request
    )

    assert first == replay
    assert first.credential.status == "disabled"
    assert len(backend.update_calls) == 1
    with pytest.raises(ManagementApiError) as conflict:
        await service.execute_action(
            mode="geminicli",
            filename="two.json",
            request=CredentialActionRequest(
                action="disable", parameters={}, idempotency_key="item-key-0001"
            ),
        )
    assert conflict.value.status_code == 409


@pytest.mark.asyncio
async def test_all_state_actions_read_back_and_delete_is_idempotent(monkeypatch) -> None:
    backend = FakeWriteBackend()
    service = write_service(monkeypatch, backend)

    permanent = await service.execute_action(
        mode="geminicli",
        filename="one.json",
        request=CredentialActionRequest(
            action="permanent_disable", parameters={}, idempotency_key="item-key-0002"
        ),
    )
    enabled = await service.execute_action(
        mode="geminicli",
        filename="one.json",
        request=CredentialActionRequest(
            action="enable", parameters={}, idempotency_key="item-key-0003"
        ),
    )
    remarked = await service.execute_action(
        mode="geminicli",
        filename="one.json",
        request=CredentialActionRequest(
            action="set_remark",
            parameters={"remark": "fixture remark"},
            idempotency_key="item-key-0004",
        ),
    )
    deleted = await service.execute_action(
        mode="geminicli",
        filename="one.json",
        request=CredentialActionRequest(
            action="delete", parameters={}, idempotency_key="item-key-0005"
        ),
    )
    replay = await service.execute_action(
        mode="geminicli",
        filename="one.json",
        request=CredentialActionRequest(
            action="delete", parameters={}, idempotency_key="item-key-0005"
        ),
    )

    assert permanent.credential.status == "permanent_disabled"
    assert enabled.credential.status == "enabled"
    assert remarked.no_change is False
    assert deleted.credential.status is None
    assert replay == deleted
    assert backend.delete_calls == ["one.json"]


@pytest.mark.asyncio
async def test_batch_preserves_order_partial_results_and_serializes_one_credential(monkeypatch) -> None:
    backend = FakeWriteBackend()
    service = write_service(monkeypatch, backend)
    request = CredentialBatchActionRequest(
        idempotency_key="batch-key-0001",
        items=[
            CredentialBatchActionItem(
                mode="geminicli",
                filename="one.json",
                action="set_remark",
                parameters={"remark": "first"},
                idempotency_key="item-key-0010",
            ),
            CredentialBatchActionItem(
                mode="geminicli",
                filename="one.json",
                action="set_remark",
                parameters={"remark": "second"},
                idempotency_key="item-key-0011",
            ),
            CredentialBatchActionItem(
                mode="geminicli",
                filename="missing.json",
                action="disable",
                parameters={},
                idempotency_key="item-key-0012",
            ),
        ],
    )

    first = await service.execute_batch(request)
    updates = len(backend.update_calls)
    replay = await service.execute_batch(request)
    regrouped = await service.execute_batch(
        CredentialBatchActionRequest(
            idempotency_key="batch-key-0002",
            items=[request.items[0]],
        )
    )

    assert first == replay
    assert first.status == "partially_succeeded"
    assert [item.filename for item in first.results] == [
        "one.json",
        "one.json",
        "missing.json",
    ]
    assert [item.status for item in first.results] == ["succeeded", "succeeded", "failed"]
    assert first.results[2].error.code == "CREDENTIAL_NOT_FOUND"
    assert backend.max_active["one.json"] == 1
    assert len(backend.update_calls) == updates
    assert regrouped.results[0].status == "succeeded"


@pytest.mark.asyncio
async def test_pending_delete_recovers_by_readback_without_replaying(monkeypatch) -> None:
    backend = FakeWriteBackend()
    backend.credentials.pop("one.json")
    service = write_service(monkeypatch, backend)
    request = CredentialActionRequest(
        action="delete", parameters={}, idempotency_key="item-key-0020"
    )
    fingerprint = service._fingerprint(
        "action",
        {
            "mode": "geminicli",
            "filename": "one.json",
            "action": "delete",
            "parameters": {},
        },
    )
    backend.config["management_idempotency_v1"] = {
        "item-key-0020": {"fingerprint": fingerprint, "state": "pending"}
    }

    result = await service.execute_action(
        mode="geminicli", filename="one.json", request=request
    )

    assert result.status == "succeeded"
    assert result.no_change is True
    assert backend.delete_calls == []


@pytest.mark.asyncio
async def test_failed_item_idempotency_does_not_later_mutate_a_new_credential(monkeypatch) -> None:
    backend = FakeWriteBackend()
    service = write_service(monkeypatch, backend)
    request = CredentialActionRequest(
        action="disable", parameters={}, idempotency_key="item-key-0021"
    )

    with pytest.raises(ManagementApiError) as first:
        await service.execute_action(
            mode="geminicli", filename="later.json", request=request
        )
    backend.credentials["later.json"] = {
        "disabled": False,
        "permanent_disabled": False,
        "remark": "",
    }
    with pytest.raises(ManagementApiError) as replay:
        await service.execute_action(
            mode="geminicli", filename="later.json", request=request
        )

    assert first.value.status_code == replay.value.status_code == 404
    assert backend.credentials["later.json"]["disabled"] is False


@pytest.mark.asyncio
async def test_real_sqlite_write_and_idempotency_survive_service_recreation(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setenv("CREDENTIALS_DIR", str(tmp_path))
    backend = SQLiteManager()
    await backend.initialize()
    adapter = StorageAdapter()
    adapter._backend = backend
    adapter._initialized = True

    async def storage():
        return adapter

    monkeypatch.setattr("src.management.service.get_storage_adapter", storage)
    try:
        await backend.store_credential(
            "fixture-write.json",
            {
                "access_token": "fixture-secret-token",
                "refresh_token": "fixture-secret-refresh",
            },
            mode="geminicli",
        )
        request = CredentialActionRequest(
            action="disable", parameters={}, idempotency_key="sqlite-item-key-0001"
        )
        first = await ManagementService().execute_action(
            mode="geminicli", filename="fixture-write.json", request=request
        )
        replay = await ManagementService().execute_action(
            mode="geminicli", filename="fixture-write.json", request=request
        )
        state = await backend.get_credential_state(
            "fixture-write.json", mode="geminicli"
        )
        capabilities = await ManagementService().capabilities()

        assert first == replay
        assert state["disabled"] is True
        assert "credential.batch_action" in capabilities.capabilities
        assert "credential.delete" in capabilities.capabilities
        serialized = first.model_dump_json() + replay.model_dump_json()
        assert "fixture-secret-token" not in serialized
        assert "fixture-secret-refresh" not in serialized
    finally:
        await backend.close()
