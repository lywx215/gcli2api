from __future__ import annotations

import asyncio
import time

import pytest

from src.management.auth import ManagementApiError
from src.management.schemas import CredentialActionRequest
from src.management.service import ManagementService
from src.storage.sqlite_manager import SQLiteManager
from src.storage_adapter import StorageAdapter


@pytest.fixture
async def sqlite_service(tmp_path, monkeypatch):
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
        yield ManagementService(), backend
    finally:
        await backend.close()


async def store_candidate(backend: SQLiteManager, filename: str, **updates) -> None:
    await backend.store_credential(
        filename,
        {
            "access_token": f"fixture-{filename}",
            "refresh_token": "fixture-refresh",
        },
        mode="geminicli",
    )
    state = {
        "disabled": True,
        "permanent_disabled": False,
        "user_email": filename.replace(".json", "@example.invalid"),
        "error_codes": [],
        "model_cooldowns": {},
        "health_status": "healthy",
        "quarantine_reason": None,
        "health_state_version": 1,
    }
    state.update(updates)
    await backend.update_credential_state(filename, state, mode="geminicli")


@pytest.mark.asyncio
async def test_sqlite_keyset_page_is_stable_bounded_and_filterable(sqlite_service) -> None:
    service, backend = sqlite_service
    for name in ("c.json", "a.json", "b.json"):
        await store_candidate(backend, name)

    first = await service.credentials(
        mode="geminicli",
        after="",
        cursor=None,
        offset=None,
        limit=2,
        status="disabled",
        error_code=None,
        cooldown=False,
        preview=None,
        tier=None,
        remark=None,
    )
    second = await service.credentials(
        mode="geminicli",
        after=first.page.next_after,
        cursor=None,
        offset=None,
        limit=2,
        status="disabled",
        error_code=None,
        cooldown=False,
        preview=None,
        tier=None,
        remark=None,
    )

    assert [item.filename for item in first.credentials] == ["a.json", "b.json"]
    assert first.page.total == 3
    assert first.page.has_more is True
    assert first.page.next_after == "b.json"
    assert first.page.next_cursor is None
    assert all(item.metadata_complete is True for item in first.credentials)
    assert all(item.observed_at.endswith("Z") for item in first.credentials)
    assert all(item.missing_fields == [] for item in first.credentials)
    assert all(item.state_token is None for item in first.credentials)
    assert [item.filename for item in second.credentials] == ["c.json"]
    assert second.page.has_more is False
    assert second.page.next_after is None


@pytest.mark.asyncio
async def test_detail_is_safe_and_payload_replacement_invalidates_token(sqlite_service) -> None:
    service, backend = sqlite_service
    await store_candidate(backend, "candidate.json")
    detail = await service.credential_detail(
        mode="geminicli", filename="candidate.json"
    )
    assert detail.metadata_complete is True
    assert detail.missing_fields == []
    assert detail.credential.metadata_complete is True
    assert detail.credential.observed_at is not None
    assert len(detail.state_token) == 64
    assert "fixture-candidate" not in detail.model_dump_json()

    await backend.store_credential(
        "candidate.json",
        {"access_token": "replacement", "refresh_token": "replacement-refresh"},
        mode="geminicli",
    )
    with pytest.raises(ManagementApiError) as error:
        await service.execute_action(
            mode="geminicli",
            filename="candidate.json",
            request=CredentialActionRequest(
                action="enable",
                parameters={
                    "expected_state_token": detail.state_token,
                    "required_models": ["gemini-pro"],
                },
                idempotency_key="conditional-replaced-0001",
            ),
        )
    assert error.value.status_code == 409
    assert error.value.payload["error"]["details"]["reason"] == "state_token_mismatch"


@pytest.mark.asyncio
async def test_bounded_list_does_not_invent_health_from_unobserved_state(
    sqlite_service,
) -> None:
    service, backend = sqlite_service
    await store_candidate(
        backend,
        "unknown.json",
        user_email=None,
        health_status=None,
        health_state_version=0,
    )
    page = await service.credentials(
        mode="geminicli",
        after="",
        cursor=None,
        offset=None,
        limit=10,
        status="disabled",
        error_code=None,
        cooldown=False,
        preview=None,
        tier=None,
        remark=None,
    )

    item = page.credentials[0]
    assert item.metadata_complete is False
    assert item.health_status is None
    assert item.missing_fields == ["health_status", "user_email"]


@pytest.mark.asyncio
async def test_conditional_enable_returns_legacy_action_envelope(sqlite_service) -> None:
    service, backend = sqlite_service
    await store_candidate(backend, "enabled.json")
    detail = await service.credential_detail(mode="geminicli", filename="enabled.json")
    response = await service.execute_action(
        mode="geminicli",
        filename="enabled.json",
        request=CredentialActionRequest(
            action="enable",
            parameters={
                "expected_state_token": detail.state_token,
                "required_models": ["gemini-pro"],
            },
            idempotency_key="conditional-success-0001",
        ),
    )
    assert response.status == "succeeded"
    assert response.no_change is False
    assert response.credential.status == "enabled"
    assert response.result is None
    assert response.side_effects[0].kind == "credential_state_updated"


@pytest.mark.asyncio
async def test_conditional_enable_is_atomic_and_only_one_racer_succeeds(sqlite_service) -> None:
    service, backend = sqlite_service
    await store_candidate(backend, "race.json")
    detail = await service.credential_detail(mode="geminicli", filename="race.json")

    async def enable():
        return await backend.management_conditional_enable(
            mode="geminicli",
            filename="race.json",
            expected_state_token=detail.state_token,
            required_models=["gemini-pro"],
        )

    # Calls bypass ManagementService's process lock and contend in SQLite itself.
    results = await asyncio.gather(enable(), enable())
    assert sum(result.get("status") == "enabled" for result in results) == 1
    assert sum(result.get("reason") == "state_token_mismatch" for result in results) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("updates", "reason"),
    [
        ({"user_email": None}, "incomplete_metadata"),
        ({"error_codes": [403]}, "forbidden_error"),
        ({"health_status": "checking"}, "unsafe_health"),
        ({"health_status": "risk_quarantined"}, "unsafe_health"),
        ({"quarantine_reason": "manual_review"}, "unsafe_health"),
        ({"permanent_disabled": True}, "permanently_disabled"),
        ({"model_cooldowns": {"gemini-pro": time.time() + 3600}}, "active_cooldown"),
    ],
)
async def test_conditional_enable_fails_closed(sqlite_service, updates, reason) -> None:
    service, backend = sqlite_service
    await store_candidate(backend, "blocked.json", **updates)
    detail = await service.credential_detail(mode="geminicli", filename="blocked.json")
    with pytest.raises(ManagementApiError) as error:
        await service.execute_action(
            mode="geminicli",
            filename="blocked.json",
            request=CredentialActionRequest(
                action="enable",
                parameters={
                    "expected_state_token": detail.state_token,
                    "required_models": ["gemini-pro"],
                },
                idempotency_key=f"conditional-blocked-{reason}",
            ),
        )
    assert error.value.status_code == 409
    assert error.value.payload["error"]["details"]["reason"] == reason


@pytest.mark.asyncio
async def test_sqlite_alone_declares_database_safe_capabilities(sqlite_service) -> None:
    service, _ = sqlite_service
    capabilities = (await service.capabilities()).capabilities
    assert "credential.list.bounded" in capabilities
    assert "credential.detail" in capabilities
    assert "credential.enable.conditional" in capabilities
    assert "credential.test.precise" in capabilities


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "classification", "call_succeeded"),
    [(200, "success", True), (429, "rate_limited", False)],
)
async def test_precise_test_distinguishes_actual_200_from_legacy_429_pass(
    sqlite_service, status, classification, call_succeeded
) -> None:
    _, backend = sqlite_service
    await store_candidate(backend, f"test-{status}.json")

    class Operations:
        supported_actions = frozenset({"test"})

        @staticmethod
        def supports(action: str) -> bool:
            return action == "test"

        async def execute(self, **_):
            return {
                "payload": {"success": True, "_status_code": status},
                "latency_ms": 1.25,
            }

    service = ManagementService(active_operations=Operations())
    response = await service.execute_action(
        mode="geminicli",
        filename=f"test-{status}.json",
        request=CredentialActionRequest(
            action="test",
            parameters={"model_name": "gemini-pro"},
            idempotency_key=f"precise-test-{status}-0001",
        ),
    )
    assert response.result.outcome == "passed"
    assert response.result.upstream_status == status
    assert response.result.classification == classification
    assert response.result.call_succeeded is call_succeeded
