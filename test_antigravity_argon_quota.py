"""Argon quota isolation with synthetic credentials and temporary SQLite only."""
import copy
import time
from datetime import datetime, timezone

import pytest

from src.antigravity_quota import group_for
from src.storage._stats_common import (clear_antigravity_cooldown_family,
    get_antigravity_cooldown_until, prepare_antigravity_cooldown)
from test_antigravity_quota_policy import store, NAME, GEMINI, CLAUDE

ARGON = tuple(f"gemini-4-argon-{tier}" for tier in ("low", "medium", "high"))


async def grant(store, models=ARGON):
    from src.antigravity_model_access import ROUTES
    assert await store.model_access_observe(NAME, await store.model_access_snapshot(NAME),
                                            {model: {} for model in (*ROUTES, *models)})


@pytest.mark.parametrize("model", [*ARGON, "gemini-4-argon", "argon-shared"])
def test_argon_family_exact_and_independent(model):
    assert group_for(model) == "argon-shared"
    deadlines = {ARGON[0]: 100, ARGON[2]: 200, "argon-shared": 150,
                 GEMINI: 300, "gemini-shared": 400, CLAUDE: 500}
    assert get_antigravity_cooldown_until(deadlines, model) == 200
    assert clear_antigravity_cooldown_family(deadlines, model) == {
        GEMINI: 300, "gemini-shared": 400, CLAUDE: 500}
    assert group_for("gemini-4-argon-preview") == "gemini-shared"
    assert group_for("gemini-4-argon-high-extra") == "gemini-shared"


def test_argon_cycle_does_not_share_settlement_or_extension_with_old_groups():
    original = {GEMINI: 500, CLAUDE: 600}
    first, close = prepare_antigravity_cooldown(original, ARGON[0], 200, now=100)
    assert close and original == {GEMINI: 500, CLAUDE: 600}
    second, close = prepare_antigravity_cooldown(first, ARGON[2], 300, now=100)
    assert not close and second == {**original, ARGON[0]: 300, ARGON[2]: 300}
    legacy, close = prepare_antigravity_cooldown({"argon-shared": 200}, ARGON[1], 300, now=100)
    assert not close and legacy == {"argon-shared": 300, ARGON[1]: 300}


@pytest.mark.parametrize("purpose", ["business", "credential_test", "manual"])
async def test_argon_requires_exact_permission_and_current_credential_identity(store, purpose):
    assert await store.quota_admit(NAME, ARGON[0], purpose) is None
    await grant(store, [ARGON[0]])
    assert await store.quota_admit(NAME, "gemini-4-argon", purpose)
    assert await store.quota_admit(NAME, ARGON[1], purpose) is None
    assert await store.quota_admit(NAME, ARGON[2], purpose) is None
    assert await store.quota_admit(NAME, CLAUDE)
    # Change only this disposable account's stable identity, retaining stale access evidence.
    await store._quota_atomic(NAME, lambda row: row.update(credential_data={"project_id": "replacement"}))
    assert await store.quota_admit(NAME, ARGON[0], purpose) is None
    assert await store.quota_admit(NAME, GEMINI)


async def test_argon_429_selection_clear_and_manual_recovery_are_isolated(store):
    await grant(store)
    await store.set_model_cooldown(NAME, GEMINI, time.time() + 300, "antigravity")
    admission = await store.quota_admit(NAME, ARGON[0])
    assert admission and admission["group"] == "argon-shared"
    assert (await store.get_next_available_credential("antigravity", ARGON[2]))[0] == NAME
    assert await store.quota_record_result(NAME, admission, ARGON[0], False, 429, time.time() + 100)
    assert not await store.quota_record_result(NAME, admission, ARGON[0], False, 429, time.time() + 200)
    for model in ARGON:
        assert await store.quota_admit(NAME, model) is None
        assert await store.get_next_available_credential("antigravity", model) is None
    assert await store.quota_admit(NAME, CLAUDE)
    before = (await store.quota_snapshot(NAME))["model_cooldowns"][GEMINI]
    result = await store.manual_record_result(NAME, await store.manual_snapshot(NAME), ARGON[2], True)
    assert result["quota"]["status"] == "applied"
    assert (await store.quota_snapshot(NAME))["model_cooldowns"] == {GEMINI: before}
    for model in ARGON:
        assert await store.quota_admit(NAME, model)
    await store.set_model_cooldown(NAME, "argon-shared", time.time() + 200, "antigravity")
    await store.set_model_cooldown(NAME, ARGON[1], None, "antigravity")
    assert (await store.quota_snapshot(NAME))["model_cooldowns"] == {GEMINI: before}


async def test_old_group_cooldowns_do_not_prevent_argon_selection_or_admission(store):
    await grant(store)
    for model in (GEMINI, CLAUDE):
        await store.set_model_cooldown(NAME, model, time.time() + 100, "antigravity")
    for model in ARGON:
        assert (await store.get_next_available_credential("antigravity", model))[0] == NAME
        assert await store.quota_admit(NAME, model)


async def test_argon_quota_sync_never_copies_remaining_into_old_models(store):
    await grant(store)
    now = time.time()
    models = {ARGON[0]: {"remaining": 0, "resetTimeRaw": datetime.fromtimestamp(now+100, timezone.utc).isoformat()},
              ARGON[1]: {"remaining": None}, GEMINI: {"remaining": .8}, CLAUDE: {"remaining": .4}}
    original = copy.deepcopy(models)
    result = await store.quota_sync(NAME, models, {}, await store.quota_snapshot(NAME),
                                    required_models=[*ARGON, GEMINI, CLAUDE])
    assert result["added"] == [ARGON[0]] and models == original
    assert await store.quota_admit(NAME, ARGON[2]) is None
    assert await store.quota_admit(NAME, GEMINI)
    assert await store.quota_admit(NAME, CLAUDE)


@pytest.mark.parametrize("model", [*ARGON, GEMINI, CLAUDE])
@pytest.mark.parametrize("marker", [None, "gemini-argon-wtu-weekly", "gemini-argon-wtu-weekly-extra"])
async def test_only_exact_argon_weekly_bucket_avoids_168h_anomaly(store, model, marker):
    await grant(store)
    now = time.time()
    info = {"remaining": .6, "resetTimeRaw": datetime.fromtimestamp(now+604800, timezone.utc).isoformat()}
    if marker is not None:
        info["quotaBucketId"] = marker
    result = await store.quota_sync(NAME, {model: info}, {"sentAt": now, "receivedAt": now+.1},
                                    await store.quota_snapshot(NAME), required_models=[model])
    allowed = model in ARGON and marker == "gemini-argon-wtu-weekly"
    assert (group_for(model) not in result["quota_group_states"]) == allowed
    assert bool(await store.quota_admit(NAME, model)) == allowed
    assert info["remaining"] == .6


async def test_explicit_weekly_argon_zero_writes_deadline_instead_of_unknown_block(store):
    await grant(store)
    now = time.time()
    reset = datetime.fromtimestamp(now+604800, timezone.utc).isoformat()
    result = await store.quota_sync(NAME,
        {ARGON[0]: {"remaining": 0, "resetTimeRaw": reset, "quotaBucketId": "gemini-argon-wtu-weekly"}},
        {"sentAt": now, "receivedAt": now+.1}, await store.quota_snapshot(NAME))
    assert result["added"] == [ARGON[0]]
    assert "argon-shared" not in result["quota_group_states"]
    assert result["quota_groups"]["argon-shared"]["cooldownUntil"] == pytest.approx(now+604800)
    assert await store.quota_admit(NAME, ARGON[2]) is None
    assert await store.quota_admit(NAME, GEMINI)
    assert await store.quota_admit(NAME, CLAUDE)


async def test_manual_argon_week_recovery_clears_only_argon_without_anomaly_state(store):
    await grant(store)
    now = time.time()
    for model in (ARGON[0], GEMINI, CLAUDE):
        await store.set_model_cooldown(NAME, model, now + 300, "antigravity")
    models = {model: {"remaining": .7, "resetTimeRaw": datetime.fromtimestamp(now+604800, timezone.utc).isoformat(),
                      "quotaBucketId": "gemini-argon-wtu-weekly"} for model in ARGON}
    result = await store.manual_sync_quota(NAME, models, {"sentAt": now, "receivedAt": now+.1},
                                           await store.manual_snapshot(NAME))
    assert result["model_cooldowns"] == {GEMINI: now+300, CLAUDE: now+300}
    assert "argon-shared" not in result["quota_group_states"]
    assert await store.quota_admit(NAME, ARGON[0])
