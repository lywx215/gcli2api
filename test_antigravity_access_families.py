"""Synthetic family migration, native-route evidence and database fencing."""
import asyncio
import copy
import json
import time

import pytest

from src.antigravity_model_access import (
    MODELS, ROUTES, FAMILIES, OPUS_46, VALID_FOR, RECHECK, PAUSE, QUERY_RETRY,
    access_model, access_family, decode, eligible, public_families, public,
)
from src.storage.sqlite_manager import SQLiteManager
from test_antigravity_quota_backends import backend

NAME = "family-synthetic.json"
LOW, MEDIUM, HIGH = MODELS
F55, F46 = FAMILIES


@pytest.fixture
async def family_store(tmp_path, monkeypatch):
    monkeypatch.setenv("CREDENTIALS_DIR", str(tmp_path))
    store = SQLiteManager()
    await store.initialize()
    await store.store_credential(NAME, {"access_token": "synthetic", "project_id": "synthetic"}, "antigravity")
    try:
        yield store
    finally:
        await store.close()


async def directory(store, models, name=NAME, now=None):
    snapshot = await store.model_access_snapshot(name)
    assert await store.model_access_observe(name, snapshot, models, now=now)
    return await store.model_access_snapshot(name)


def legacy(state="supported", now=100000):
    return {"models": {model: {"state": state, "revision": 1, "checked_at": now,
        "next_check_at": now + RECHECK, "blocked_until": 0 if state == "supported" else now + PAUSE,
        "reason": "directory_supported" if state == "supported" else "directory_missing"} for model in MODELS}}


@pytest.mark.parametrize("model,native,family", [
    ("claude-opus-5-5", MEDIUM, F55), (LOW, LOW, F55),
    ("claude-opus-4-6", OPUS_46, F46), ("假流式/claude-opus-4-6-thinking", OPUS_46, F46),
    ("claude-opus-4.6", OPUS_46, F46), ("claude-sonnet-4-6", None, None),
])
def test_native_and_family_are_distinct(model, native, family):
    assert access_model(model) == native
    assert access_family(model) == family


def test_legacy_complete_consistent_read_normalizes_without_mutation_or_ttl_refresh():
    original = legacy()
    saved = copy.deepcopy(original)
    converted = decode(original)
    assert original == saved
    assert converted["schema_version"] == 2
    assert eligible(converted, HIGH, 100001)
    assert not eligible(converted, OPUS_46, 100001)
    assert not eligible(converted, HIGH, 100000 + VALID_FOR)
    assert set(converted["models"]) == set(MODELS)
    assert set(public(converted)) == set(MODELS)


@pytest.mark.parametrize("kind", ["partial", "conflict", "different_time"])
def test_legacy_ambiguous_state_cannot_grant_family(kind):
    value = legacy()
    if kind == "partial":
        value["models"].pop(HIGH)
    elif kind == "conflict":
        value["models"][HIGH]["state"] = "unavailable"
    else:
        value["models"][HIGH]["checked_at"] += 1
    converted = decode(value)
    assert not eligible(converted, LOW, 100001)
    assert public_families(converted)[F55]["state"] == "unknown"


def test_v2_legacy_writer_invalidates_new_evidence():
    value = decode(legacy())
    value["models"][HIGH]["revision"] += 1
    value["models"][HIGH]["state"] = "unavailable"
    assert not eligible(value, LOW, 100001)
    assert decode(value)["families"] == {}


async def test_family_support_does_not_manufacture_native_routes(family_store):
    store = family_store
    snapshot = await directory(store, [HIGH])
    state = snapshot["access"]
    assert public_families(state)[F55]["state"] == "supported"
    assert eligible(state, HIGH)
    assert not eligible(state, LOW)
    assert not eligible(state, MEDIUM)
    assert not eligible(state, OPUS_46)
    assert await store.model_access_union() == {HIGH}
    assert await store.quota_admit(NAME, OPUS_46) is None
    assert await store.quota_admit(NAME, LOW) is None
    assert await store.quota_admit(NAME, HIGH)


async def test_404_pauses_only_version_family_and_stale_directory_is_fenced(family_store):
    store = family_store
    await directory(store, ROUTES)
    stale = await store.model_access_snapshot(NAME)
    admission = await store.quota_admit(NAME, OPUS_46)
    assert await store.model_access_observe(NAME, admission["model_access_snapshot"],
        model=OPUS_46, success=False, reason="generation_retired")
    assert await store.quota_admit(NAME, OPUS_46) is None
    assert await store.quota_admit(NAME, HIGH)
    await store.model_access_observe(NAME, stale, ROUTES)
    assert await store.quota_admit(NAME, OPUS_46) is None
    now = await store.model_access_snapshot(NAME)
    assert await store.model_access_observe(NAME, now, model=HIGH, success=False, reason="generation_404")
    assert await store.quota_admit(NAME, LOW) is None
    assert await store.quota_admit(NAME, MEDIUM) is None
    assert not (await store._quota_rows(NAME))[0]["disabled"]
    await directory(store, ROUTES)
    assert await store.quota_admit(NAME, OPUS_46)
    assert await store.quota_admit(NAME, LOW)


async def test_query_failure_and_recheck_keep_pause_not_automatic_restore(family_store, monkeypatch):
    store = family_store
    clock = [100000]
    monkeypatch.setattr("src.storage.antigravity_model_access.time.time", lambda: clock[0])
    await directory(store, [])
    assert not await store.model_access_claim(NAME)
    clock[0] += RECHECK
    leased = await store.model_access_claim(NAME)
    assert leased
    assert await store.model_access_observe(NAME, leased, reason="directory_timeout")
    families = await store.model_access_family_public(NAME)
    assert families[F46]["blocked_until"] == 100000 + PAUSE
    assert families[F46]["next_check_at"] == clock[0] + QUERY_RETRY
    clock[0] += PAUSE
    assert not await store.quota_admit(NAME, OPUS_46)
    await directory(store, [OPUS_46])
    assert await store.quota_admit(NAME, OPUS_46)


async def test_new_lease_and_new_family_revision_fence_old_results(family_store, monkeypatch):
    store = family_store
    await directory(store, ROUTES)
    first = await store.model_access_claim(NAME, force=True)
    clock = time.time() + 121
    monkeypatch.setattr("src.storage.antigravity_model_access.time.time", lambda: clock)
    second = await store.model_access_claim(NAME, force=True)
    assert second and first["lease_id"] != second["lease_id"]
    assert not await store.model_access_observe(NAME, first, [])
    assert (await store.model_access_snapshot(NAME))["access"]["lease"]["id"] == second["lease_id"]
    assert await store.model_access_observe(NAME, second, ROUTES)
    stale = await store.model_access_snapshot(NAME)
    await directory(store, ROUTES)
    assert not await store.model_access_observe(NAME, stale, model=HIGH, success=False)
    assert await store.quota_admit(NAME, LOW)


async def test_three_driver_backends_family_cas_and_46_admission(backend):
    store, db = backend
    name = db.row["filename"]
    store.model_access_storage_ready = True
    await directory(store, ROUTES, name)
    admission = await store.quota_admit(name, OPUS_46)
    assert admission
    snapshots = await asyncio.gather(*(store.model_access_claim(name, force=True) for _ in range(3)))
    assert sum(snapshot is not None for snapshot in snapshots) == 1
    assert await store.model_access_observe(name, admission["model_access_snapshot"], model=HIGH, success=False)
    assert not await store.quota_admit(name, LOW)
    assert await store.quota_admit(name, OPUS_46)
    state = db.row["model_access_state"]
    if isinstance(state, str):
        state = json.loads(state)
    assert state["schema_version"] == 2
    assert set(state["models"]) == set(MODELS)


@pytest.mark.parametrize("field", ["checked_at", "lease"])
def test_extreme_numeric_state_fails_closed(field):
    state = legacy()
    if field == "lease":
        state["lease"] = {"id": "synthetic", "until": 10 ** 1000}
    else:
        state["models"][LOW][field] = 10 ** 1000
    with pytest.raises(ValueError):
        decode(state)
    assert public_families(state)[F55]["state"] == "unknown"


async def test_business_pause_not_requeried_when_other_version_due(family_store, monkeypatch):
    from types import SimpleNamespace
    from src.antigravity_access_runtime import ModelAccessService
    from src.antigravity_model_access import project
    store = family_store
    await directory(store, [])
    def other_version_due(row):
        state = decode(row["model_access_state"])
        state["families"][F46]["next_check_at"] = 0
        row["model_access_state"] = project(state)
    await store._quota_atomic(NAME, other_version_due, validate=False)
    async def unchecked(mode, model, excluded):
        return None if NAME in excluded else (NAME, {"access_token": "synthetic"})
    manager = SimpleNamespace(_storage_adapter=SimpleNamespace(_backend=store),
                              _get_valid_credential_unchecked=unchecked)
    service = ModelAccessService()
    async def deny(*args, **kwargs):
        raise AssertionError("paused requested family must not queue or query")
    monkeypatch.setattr(service, "check", deny)
    monkeypatch.setattr(store, "model_access_queue", deny)
    assert await service.select(manager, HIGH, set()) is None


async def test_mixed_family_union_disabled_exclusion_and_safe_read(family_store):
    store = family_store
    other = "family-46-synthetic.json"
    await store.store_credential(other, {"access_token": "other-synthetic"}, "antigravity")
    await directory(store, [HIGH])
    await directory(store, [OPUS_46], other)
    assert await store.model_access_union() == {HIGH, OPUS_46}
    before = copy.deepcopy(await store._quota_rows())
    families = await store.model_access_list_family_public()
    assert families[NAME][F55]["state"] == "supported"
    assert families[other][F46]["state"] == "supported"
    assert await store._quota_rows() == before
    for private in ("identity", "revision", "lease", "access_token", "credential_data"):
        assert private not in json.dumps(families)
    await store.update_credential_state(other, {"disabled": True}, "antigravity")
    assert await store.model_access_union() == {HIGH}
    assert (await store.model_access_list_family_public())[other][F46]["state"] == "supported"


async def test_final_admit_rechecks_after_selection_snapshot(family_store):
    store = family_store
    selected = await directory(store, ROUTES)
    assert eligible(selected["access"], LOW)
    await store.model_access_observe(NAME, selected, model=HIGH, success=False)
    assert await store.quota_admit(NAME, LOW, generation=selected["generation"],
                                  expected_version=selected["version"]) is None
    assert await store.quota_admit(NAME, OPUS_46, generation=selected["generation"],
                                  expected_version=selected["version"])


@pytest.mark.parametrize("established", [False, True])
async def test_failed_directory_does_not_hide_inflight_generation_404(family_store, established):
    store = family_store
    if established:
        await directory(store, ROUTES)
    # Manual probes may begin with unknown evidence; business starts supported.
    admission = await store.quota_admit(NAME, HIGH, purpose="credential_test")
    assert admission
    query = await store.model_access_snapshot(NAME)
    await store.model_access_observe(NAME, query, reason="directory_query_failed")
    assert await store.model_access_observe(NAME, admission["model_access_snapshot"],
                                           model=HIGH, success=False, reason="generation_404")
    assert await store.quota_admit(NAME, HIGH) is None
    assert await store.quota_admit(NAME, LOW) is None
    assert (await store.model_access_family_public(NAME))[F55]["state"] == "unavailable"


@pytest.mark.parametrize("confirmation", ["directory", "manual_success"])
async def test_new_valid_confirmation_still_fences_older_404(family_store, confirmation):
    store = family_store
    await directory(store, ROUTES)
    old = await store.quota_admit(NAME, HIGH)
    current = await store.model_access_snapshot(NAME)
    if confirmation == "directory":
        assert await store.model_access_observe(NAME, current, ROUTES)
    else:
        assert await store.model_access_observe(NAME, current, model=HIGH, success=True)
    assert not await store.model_access_observe(NAME, old["model_access_snapshot"],
                                               model=HIGH, success=False, reason="generation_404")
    assert await store.quota_admit(NAME, HIGH)


async def test_individual_route_expiry_rechecks_after_other_route_success(family_store, monkeypatch):
    from types import SimpleNamespace
    from src.antigravity_access_runtime import ModelAccessService
    from src.antigravity_model_access import check_due
    from src.api import antigravity as api
    store = family_store
    clock = [100000]
    monkeypatch.setattr('src.storage.antigravity_model_access.time.time', lambda: clock[0])
    await directory(store, ROUTES)
    clock[0] += VALID_FOR - 1
    # Both families are fresh; only Low/Medium retain the original route TTL.
    for model in (HIGH, OPUS_46):
        current = await store.model_access_snapshot(NAME)
        assert await store.model_access_observe(NAME, current, model=model, success=True)
    clock[0] += 2
    state = (await store.model_access_snapshot(NAME))['access']
    assert all(entry['next_check_at'] > clock[0] for entry in state['families'].values())
    assert eligible(state, HIGH) and eligible(state, OPUS_46)
    assert not eligible(state, LOW) and check_due(state, LOW)
    assert not check_due(state, HIGH)
    assert NAME in await store.model_access_due()
    assert await store.get_next_available_credential(mode='antigravity', model_name=LOW)
    calls = []
    async def query(token, **kwargs):
        calls.append(token)
        return {'success': True, 'models': {model: {} for model in ROUTES}}
    async def unchecked(mode, model, excluded):
        return await store.get_next_available_credential(mode, model, excluded)
    async def refresh_needed(data): return False
    manager = SimpleNamespace(_storage_adapter=SimpleNamespace(_backend=store),
        _get_valid_credential_unchecked=unchecked, _should_refresh_token=refresh_needed)
    monkeypatch.setattr(api, 'fetch_quota_info', query)
    assert (await ModelAccessService().select(manager, LOW, set()))[0] == NAME
    assert calls == ['synthetic']
    assert await store.quota_admit(NAME, LOW)


async def test_target_claim_rechecks_concurrent_pause_and_failed_query_backoff(family_store, monkeypatch):
    from src.antigravity_model_access import check_due, project
    store = family_store
    clock = [100000]
    monkeypatch.setattr('src.storage.antigravity_model_access.time.time', lambda: clock[0])
    await directory(store, ROUTES)
    clock[0] += VALID_FOR
    before = await store.model_access_snapshot(NAME)
    assert check_due(before['access'], LOW)
    # A denial wins after the selector read; the atomic target claim must reject.
    await store.model_access_observe(NAME, before, model=HIGH, success=False)
    def other_family_due(row):
        state = decode(row['model_access_state'])
        state['families'][F46]['next_check_at'] = 0
        row['model_access_state'] = project(state)
    await store._quota_atomic(NAME, other_family_due, validate=False)
    assert await store.model_access_claim(NAME, model=LOW) is None
    # A failed attempt with expired routes remains subject to its 15-minute backoff.
    await directory(store, ROUTES)
    clock[0] += VALID_FOR
    before = await store.model_access_snapshot(NAME)
    await store.model_access_observe(NAME, before, reason='directory_query_failed')
    state = (await store.model_access_snapshot(NAME))['access']
    assert not check_due(state, LOW)
    assert not await store.model_access_due()
    assert await store.model_access_claim(NAME, model=LOW) is None
    clock[0] += QUERY_RETRY
    assert check_due(state, LOW)
    assert await store.model_access_claim(NAME, model=LOW)


async def test_manual_known_route_allows_unknown_sibling_to_be_queried(family_store):
    from src.antigravity_model_access import check_due
    store = family_store
    unknown = await store.model_access_snapshot(NAME)
    assert await store.model_access_observe(NAME, unknown, model=HIGH, success=True)
    state = (await store.model_access_snapshot(NAME))['access']
    assert eligible(state, HIGH) and not eligible(state, LOW)
    assert check_due(state, LOW)
    assert await store.model_access_claim(NAME, model=LOW)
