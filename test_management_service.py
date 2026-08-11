from __future__ import annotations

import asyncio

import pytest

from src.management.auth import ManagementApiError
from src.management.schemas import (
    CredentialActionRequest,
    CredentialBatchActionItem,
    CredentialBatchActionRequest,
)
from src.management.service import ManagementService
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


class FakeActiveBackend(FakeWriteBackend):
    def __init__(self) -> None:
        super().__init__()
        self.credentials.update(
            {
                "ag.json": {
                    "disabled": False,
                    "permanent_disabled": False,
                    "enable_credit": False,
                    "model_cooldowns": {"fixture-model": 1_786_509_000},
                },
                **{
                    f"active-{index}.json": {
                        "disabled": False,
                        "permanent_disabled": False,
                    }
                    for index in range(12)
                },
            }
        )
        self.credential_material = {
            filename: {
                "access_token": f"fixture-token-{index}",
                "refresh_token": f"fixture-refresh-{index}",
            }
            for index, filename in enumerate(self.credentials)
        }

    async def get_credential(self, filename, mode="geminicli"):
        value = self.credential_material.get(filename)
        return dict(value) if value is not None else None

    async def store_credential(self, filename, credential, mode="geminicli"):
        self.credential_material[filename] = dict(credential)
        return True

    async def clear_all_model_cooldowns(self, filename, mode="geminicli"):
        if filename not in self.credentials:
            return False
        self.credentials[filename]["model_cooldowns"] = {}
        return True

    async def set_model_cooldown(
        self, filename, model_name, cooldown_until, mode="geminicli"
    ):
        if filename not in self.credentials:
            return False
        cooldowns = self.credentials[filename].setdefault("model_cooldowns", {})
        if cooldown_until is None:
            cooldowns.pop(model_name, None)
        else:
            cooldowns[model_name] = cooldown_until
        return True


class FakeActiveOperations:
    supported_actions = frozenset(
        {"enable_preview", "quota", "test", "risk_check", "sync_cooldown"}
    )

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str]] = []
        self.active = 0
        self.max_active = 0

    async def execute(self, *, action, mode, filename, parameters, storage):
        self.calls.append((action, mode, filename))
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        await asyncio.sleep(0.005)
        try:
            if action == "enable_preview":
                await storage.update_credential_state(
                    filename, {"preview": True}, mode=mode
                )
                payload = {
                    "success": True,
                    "preview": True,
                    "access_token": "must-not-survive",
                }
            elif action == "quota":
                payload = {
                    "success": True,
                    "models": {
                        "fixture-model": {
                            "remaining": 0.75,
                            "resetTimeRaw": "2026-08-13T00:00:00Z",
                            "refresh_token": "must-not-survive",
                        }
                    },
                    "credential": {"access_token": "must-not-survive"},
                }
            elif action == "test":
                payload = {
                    "success": False,
                    "status_code": 403,
                    "error": "Bearer must-not-survive",
                }
            elif action == "risk_check":
                payload = {
                    "health": {
                        "status": "normal",
                        "classification": "verified",
                        "credential": "must-not-survive",
                    }
                }
            else:
                payload = {
                    "success": True,
                    "model_cooldowns": {
                        "fixture-model": "2026-08-13T00:00:00Z"
                    },
                }
            return {
                "payload": payload,
                "latency_ms": 12,
                "token_refreshed": False,
                "state_changed": action == "enable_preview",
                "cooldown_changed": action == "sync_cooldown",
            }
        finally:
            self.active -= 1


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


def active_service(monkeypatch, *, starts_per_minute=10, concurrency=3):
    backend = FakeActiveBackend()
    operations = FakeActiveOperations()

    async def storage():
        backend._backend = backend
        return backend

    monkeypatch.setattr("src.management.service.get_storage_adapter", storage)
    return (
        ManagementService(
            active_operations=operations,
            active_concurrency=concurrency,
            active_starts_per_minute=starts_per_minute,
        ),
        backend,
        operations,
    )


@pytest.mark.asyncio
async def test_active_capabilities_modes_results_and_replay_are_safe(monkeypatch) -> None:
    service, backend, operations = active_service(monkeypatch)
    capabilities = (await service.capabilities()).capabilities

    assert "credential.preview.enable" in capabilities
    assert "credential.preview.disable" not in capabilities
    assert "credential.credit.enable" in capabilities
    assert "credential.credit.disable" in capabilities
    assert "credential.quota" in capabilities
    assert "credential.errors" in capabilities
    assert "credential.test" in capabilities
    assert "credential.risk_check" in capabilities
    assert "credential.cooldown.sync" in capabilities

    with pytest.raises(ManagementApiError) as wrong_mode:
        await service.execute_action(
            mode="antigravity",
            filename="ag.json",
            request=CredentialActionRequest(
                action="enable_preview",
                parameters={},
                idempotency_key="active-mode-key-0001",
            ),
        )
    assert wrong_mode.value.status_code == 501
    assert operations.calls == []

    preview = await service.execute_action(
        mode="geminicli",
        filename="one.json",
        request=CredentialActionRequest(
            action="enable_preview",
            parameters={},
            idempotency_key="active-preview-0001",
        ),
    )
    replay = await service.execute_action(
        mode="geminicli",
        filename="one.json",
        request=CredentialActionRequest(
            action="enable_preview",
            parameters={},
            idempotency_key="active-preview-0001",
        ),
    )
    credit = await service.execute_action(
        mode="antigravity",
        filename="ag.json",
        request=CredentialActionRequest(
            action="enable_credit",
            parameters={},
            idempotency_key="active-credit-0001",
        ),
    )
    quota = await service.execute_action(
        mode="geminicli",
        filename="two.json",
        request=CredentialActionRequest(
            action="quota",
            parameters={"refresh": True},
            idempotency_key="active-quota-0001",
        ),
    )
    errors = await service.execute_action(
        mode="geminicli",
        filename="two.json",
        request=CredentialActionRequest(
            action="errors",
            parameters={},
            idempotency_key="active-errors-0001",
        ),
    )
    tested = await service.execute_action(
        mode="geminicli",
        filename="two.json",
        request=CredentialActionRequest(
            action="test",
            parameters={"model_name": "fixture-model"},
            idempotency_key="active-test-0001",
        ),
    )
    risk = await service.execute_action(
        mode="geminicli",
        filename="two.json",
        request=CredentialActionRequest(
            action="risk_check",
            parameters={},
            idempotency_key="active-risk-0001",
        ),
    )
    synced = await service.execute_action(
        mode="geminicli",
        filename="two.json",
        request=CredentialActionRequest(
            action="sync_cooldown",
            parameters={},
            idempotency_key="active-sync-0001",
        ),
    )

    assert replay == preview
    assert sum(call[0] == "enable_preview" for call in operations.calls) == 1
    assert preview.result.model_dump() == {"kind": "preview", "enabled": True}
    assert credit.result.model_dump() == {"kind": "credit", "enabled": True}
    assert backend.credentials["ag.json"]["model_cooldowns"] == {}
    assert quota.result.models[0].remaining_percent == 75
    assert quota.result.models[0].resets_at == "2026-08-13T00:00:00Z"
    assert errors.result.model_dump() == {"kind": "errors", "entries": []}
    assert tested.result.outcome == "failed"
    assert tested.result.model_name == "fixture-model"
    assert risk.result.model_dump() == {
        "kind": "risk",
        "level": "low",
        "codes": ["normal", "verified"],
    }
    assert synced.result.model_cooldowns == {
        "fixture-model": "2026-08-13T00:00:00Z"
    }
    serialized = "".join(
        response.model_dump_json()
        for response in (preview, credit, quota, errors, tested, risk, synced)
    )
    assert "must-not-survive" not in serialized
    assert "access_token" not in serialized
    assert "refresh_token" not in serialized


@pytest.mark.asyncio
async def test_pending_external_action_returns_unknown_without_replay(monkeypatch) -> None:
    service, backend, operations = active_service(monkeypatch)
    request = CredentialActionRequest(
        action="quota",
        parameters={},
        idempotency_key="active-pending-0001",
    )
    fingerprint = service._fingerprint(
        "action",
        {
            "mode": "geminicli",
            "filename": "one.json",
            "action": "quota",
            "parameters": {},
        },
    )
    backend.config["management_idempotency_v1"] = {
        request.idempotency_key: {"fingerprint": fingerprint, "state": "pending"}
    }

    with pytest.raises(ManagementApiError) as unknown:
        await service.execute_action(
            mode="geminicli", filename="one.json", request=request
        )

    assert unknown.value.status_code == 409
    assert unknown.value.payload["error"]["code"] == "OUTCOME_UNKNOWN"
    assert unknown.value.payload["error"]["retryable"] is True
    assert operations.calls == []


@pytest.mark.asyncio
async def test_external_active_operations_are_concurrency_and_start_rate_bounded(
    monkeypatch,
) -> None:
    service, _, operations = active_service(
        monkeypatch, starts_per_minute=20, concurrency=3
    )

    async def quota(index: int):
        return await service.execute_action(
            mode="geminicli",
            filename=f"active-{index}.json",
            request=CredentialActionRequest(
                action="quota",
                parameters={},
                idempotency_key=f"active-concurrency-{index:04d}",
            ),
        )

    await asyncio.gather(*(quota(index) for index in range(6)))
    assert operations.max_active == 3

    limited, _, limited_operations = active_service(
        monkeypatch, starts_per_minute=2, concurrency=3
    )
    await limited.execute_action(
        mode="geminicli",
        filename="active-0.json",
        request=CredentialActionRequest(
            action="quota", parameters={}, idempotency_key="active-rate-0001"
        ),
    )
    await limited.execute_action(
        mode="geminicli",
        filename="active-1.json",
        request=CredentialActionRequest(
            action="quota", parameters={}, idempotency_key="active-rate-0002"
        ),
    )
    with pytest.raises(ManagementApiError) as limited_error:
        await limited.execute_action(
            mode="geminicli",
            filename="active-2.json",
            request=CredentialActionRequest(
                action="quota", parameters={}, idempotency_key="active-rate-0003"
            ),
        )
    assert limited_error.value.status_code == 429
    assert limited_error.value.payload["error"]["code"] == "RATE_LIMITED"
    with pytest.raises(ManagementApiError) as replayed_error:
        await limited.execute_action(
            mode="geminicli",
            filename="active-2.json",
            request=CredentialActionRequest(
                action="quota", parameters={}, idempotency_key="active-rate-0003"
            ),
        )
    assert replayed_error.value.payload == limited_error.value.payload
    assert len(limited_operations.calls) == 2
