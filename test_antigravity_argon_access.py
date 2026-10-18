"""Argon directory permissions, identity fencing and bounded synthetic selection."""
import copy
import json
import time
from types import SimpleNamespace

import pytest

from src.antigravity_model_access import (
    ARGON_FAMILY, ARGON_MODELS, MODELS, ROUTES, FAMILIES, VALID_FOR, QUERY_RETRY,
    access_model, access_family, argon_model, decode, eligible, check_due, public,
)
from src.antigravity_access_runtime import ModelAccessService
from src.credential_manager import CredentialManager
from src.storage.sqlite_manager import SQLiteManager
from src.api import antigravity as api
from test_antigravity_access_families import family_store, directory, NAME
from test_antigravity_quota_backends import backend

LOW, MEDIUM, HIGH = ARGON_MODELS


def listing(*enabled, **extra):
    return {**{model: {} for model in enabled}, **extra}


@pytest.mark.parametrize("model,expected", [
    (LOW, LOW), (MEDIUM, MEDIUM), (HIGH, HIGH), (ARGON_FAMILY, LOW),
    ("假流式/GEMINI-4-ARGON-HIGH", HIGH),
    ("流式抗截断/gemini-4-argon-medium", MEDIUM),
    ("gemini-4-argon-disabled", None), ("gemini-4-argon-extra-low", None),
    ("gemini-4-argon-high-search", None), ("gemini-3.8-flash", None),
])
def test_exact_argon_identity(model, expected):
    assert argon_model(model) == expected
    assert access_model(model) == expected
    assert access_family(model) == (ARGON_FAMILY if expected else None)


async def test_directory_exact_tiers_no_weekly_evidence_and_old_projection(family_store):
    store = family_store
    before = await directory(store, listing(*ROUTES))
    assert not eligible(before["access"], LOW)
    observed = await directory(store, listing(*ROUTES, HIGH, **{
        MEDIUM: {"disabled": True}, LOW: {"enabled": False},
        "gemini-4-argon-disabled": {"disabled": False},
        "gemini-argon-wtu-weekly": {"remainingFraction": 1},
    }))
    state = observed["access"]
    assert eligible(state, HIGH) and not eligible(state, MEDIUM) and not eligible(state, LOW)
    assert set(state["models"]) == set(MODELS)
    assert set(state["families"]) == set(FAMILIES)
    assert set(state["routes"]) == set(ROUTES)
    assert set(public(state)) == set(MODELS)
    assert state["schema_version"] == 2
    assert set(state["argon"]["routes"]) == set(ARGON_MODELS)
    assert await store.model_access_union() == set(ROUTES) | {HIGH}
    assert await store.quota_admit(NAME, HIGH)
    assert not await store.quota_admit(NAME, LOW)
    assert not await store.quota_admit(NAME, MEDIUM)


@pytest.mark.parametrize("metadata", [None, [], True, {"disabled": "false"},
    {"enabled": "true"}, {"disabled": 0}, {"enabled": 1}, {"disabled": True}, {"enabled": False}])
async def test_malformed_or_disabled_directory_metadata_never_grants(family_store, metadata):
    state = (await directory(family_store, {LOW: metadata}))["access"]
    assert not eligible(state, LOW)
    assert not await family_store.quota_admit(NAME, LOW)


async def test_unknown_expiry_failure_backoff_and_atomic_target_claim(family_store, monkeypatch):
    store = family_store
    clock = [100000]
    monkeypatch.setattr("src.storage.antigravity_model_access.time.time", lambda: clock[0])
    old = await store.model_access_snapshot(NAME)
    assert "argon" not in old["access"]
    assert not await store.quota_admit(NAME, HIGH)
    state = (await directory(store, listing(HIGH)))["access"]
    assert eligible(state, HIGH)
    clock[0] += VALID_FOR
    assert not eligible(state, HIGH) and check_due(state, HIGH)
    claimed = await store.model_access_claim(NAME, model=HIGH)
    assert claimed and not await store.model_access_claim(NAME, model=HIGH)
    await store.model_access_observe(NAME, claimed, reason="directory_timeout")
    failed = (await store.model_access_snapshot(NAME))["access"]
    assert not eligible(failed, HIGH) and not check_due(failed, HIGH)
    assert not await store.model_access_claim(NAME, model=HIGH)
    clock[0] += QUERY_RETRY
    assert check_due(failed, HIGH)
    await directory(store, listing(HIGH))
    assert await store.quota_admit(NAME, HIGH)


async def test_argon_404_isolated_and_stale_evidence_cannot_restore(family_store):
    store = family_store
    await directory(store, listing(*ROUTES, *ARGON_MODELS))
    old = await store.model_access_snapshot(NAME)
    admission = await store.quota_admit(NAME, HIGH)
    assert await store.model_access_observe(NAME, admission["model_access_snapshot"],
        model=HIGH, success=False, reason="generation_404")
    paused = (await store.model_access_snapshot(NAME))["access"]
    assert all(not eligible(paused, model) for model in ARGON_MODELS)
    assert await store.quota_admit(NAME, ROUTES[0])
    assert not (await store._quota_rows(NAME))[0]["disabled"]
    await store.model_access_observe(NAME, old, listing(*ROUTES, *ARGON_MODELS))
    assert not await store.quota_admit(NAME, LOW)
    await directory(store, listing(*ROUTES, LOW))
    assert await store.quota_admit(NAME, LOW)
    assert not await store.quota_admit(NAME, HIGH)


async def test_generation_success_never_substitutes_for_directory_grant(family_store):
    store = family_store
    unknown = await store.model_access_snapshot(NAME)
    assert not await store.model_access_observe(NAME, unknown, model=HIGH, success=True)
    assert not await store.quota_admit(NAME, HIGH)
    assert "argon" not in (await store.model_access_snapshot(NAME))["access"]


async def test_final_gate_fences_pause_and_credential_replacement(family_store):
    store = family_store
    selected = await directory(store, listing(*ARGON_MODELS, *ROUTES))
    await store.model_access_observe(NAME, selected, model=HIGH, success=False)
    assert not await store.quota_admit(NAME, LOW, generation=selected["generation"], expected_version=selected["version"])
    await directory(store, listing(LOW))
    current = await store.model_access_snapshot(NAME)
    await store.store_credential(NAME, {"access_token": "replacement", "project_id": "replacement"}, "antigravity")
    assert not await store.model_access_observe(NAME, current, listing(LOW))
    assert not await store.quota_admit(NAME, LOW)
    assert not await store.quota_admit(NAME, LOW, generation=current["generation"], expected_version=current["version"])


async def test_mixed_pool_bounded_directory_selection_and_union(family_store, monkeypatch):
    store = family_store
    other = "argon-other-synthetic.json"
    await store.store_credential(other, {"access_token": "other", "project_id": "other"}, "antigravity")
    manager = CredentialManager()
    manager._initialized = True
    manager._storage_adapter = SimpleNamespace(_backend=store)
    async def no_refresh(data): return False
    manager._should_refresh_token = no_refresh
    calls = []
    async def fetch(token, **kwargs):
        calls.append(token)
        return {"success": True, "models": listing(HIGH if token == "other" else LOW)}
    monkeypatch.setattr(api, "fetch_quota_info", fetch)
    service = ModelAccessService()
    selected = await service.select(manager, HIGH, set())
    assert selected[0] == other and 1 <= len(calls) <= 2
    calls.clear()
    assert (await manager.get_valid_credential("antigravity", HIGH))[0] == other
    assert not calls
    assert await service.select(manager, MEDIUM, set()) is None
    assert len(calls) <= 1
    assert await store.model_access_union() == {LOW, HIGH}
    assert all(row["call_count"] == 0 for row in await store._quota_rows())
    await store.update_credential_state(other, {"disabled": True}, "antigravity")
    assert await store.model_access_union() == {LOW}


async def test_failed_directory_bound_and_no_generation(family_store, monkeypatch):
    store = family_store
    manager = CredentialManager()
    manager._initialized = True
    manager._storage_adapter = SimpleNamespace(_backend=store)
    async def no_refresh(data): return False
    manager._should_refresh_token = no_refresh
    calls = []
    async def fetch(*args, **kwargs):
        calls.append(1)
        return {"success": False}
    monkeypatch.setattr(api, "fetch_quota_info", fetch)
    assert await manager.get_valid_credential("antigravity", HIGH) is None
    assert await manager.get_valid_credential("antigravity", HIGH) is None
    assert len(calls) == 1
    state = (await store.model_access_snapshot(NAME))["access"]
    assert state["argon"]["families"][ARGON_FAMILY]["next_check_at"] > time.time()
    assert not await store.quota_admit(NAME, HIGH)


async def test_restart_and_read_only_compatibility(family_store):
    store = family_store
    observed = await directory(store, listing(*ROUTES, LOW))
    before = copy.deepcopy(await store._quota_rows())
    state = copy.deepcopy(observed["access"])
    assert decode(state) == state
    # An old implementation ignores the extension and still sees valid Opus state.
    state.pop("argon")
    assert all(eligible(state, model) for model in ROUTES)
    assert not eligible(state, LOW)
    assert set(public(state)) == set(MODELS)
    assert await store._quota_rows() == before
    reopened = SQLiteManager()
    await reopened.initialize()
    try:
        assert await reopened.quota_admit(NAME, LOW)
        assert not await reopened.quota_admit(NAME, HIGH)
    finally:
        await reopened.close()


async def test_malformed_argon_extension_preserves_opus(family_store):
    state = (await directory(family_store, listing(*ROUTES, LOW)))["access"]
    state["argon"]["routes"][LOW]["checked_at"] = "invalid"
    assert not eligible(state, LOW)
    assert all(eligible(state, model) for model in ROUTES)


async def test_argon_namespace_three_driver_backends(backend):
    store, db = backend
    name = db.row["filename"]
    store.model_access_storage_ready = True
    await directory(store, listing(*ROUTES, HIGH), name=name)
    assert await store.quota_admit(name, HIGH)
    assert not await store.quota_admit(name, LOW)
    state = db.row["model_access_state"]
    state = json.loads(state) if isinstance(state, str) else state
    assert state["schema_version"] == 2 and set(state["models"]) == set(MODELS)
    assert set(state["argon"]["routes"]) == set(ARGON_MODELS)
