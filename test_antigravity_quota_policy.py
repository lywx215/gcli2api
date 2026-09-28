"""Synthetic, isolated tests of persistent quota admission and recovery."""
import asyncio
import json
import time
from datetime import datetime, timezone

import aiosqlite
import pytest

from src.antigravity_quota import rolling_week, group_for
from src.storage.sqlite_manager import SQLiteManager

GEMINI = "gemini-3.8-flash-high"
CLAUDE = "claude-opus-4-6-thinking"
NAME = "synthetic.json"


@pytest.fixture
async def store(tmp_path, monkeypatch):
    monkeypatch.setenv("CREDENTIALS_DIR", str(tmp_path))
    manager = SQLiteManager()
    await manager.initialize()
    await manager.store_credential(NAME, {"access_token": "synthetic", "project_id": "synthetic"}, "antigravity")
    try:
        yield manager
    finally:
        await manager.close()


def week(now=None):
    now = now or time.time()
    return {GEMINI: {"remaining": 1, "resetTimeRaw": datetime.fromtimestamp(now + 604800, timezone.utc).isoformat()}}, {"sentAt": now, "receivedAt": now + .1}


async def block(store):
    models, observation = week()
    return await store.quota_sync(NAME, models, observation, await store.quota_snapshot(NAME))


@pytest.mark.parametrize("model", [GEMINI, "gemini-3.8-flash-tiered", "gemini-pro-agent", "gemini-2.5-flash-lite", "gemini-3.1-flash-image", "流式抗截断/gemini-3.8-flash-high"])
def test_every_gemini_variant_shares(model):
    assert group_for(model) == "gemini-shared"
    assert group_for(CLAUDE) == group_for("gpt-oss-120b") == "claude-gpt-shared"
    assert group_for("unknown-model") == "unknown-model"


def test_week_clock_uses_server_date_and_bounded_local_interval():
    reset = "2026-10-04T09:05:12Z"
    assert rolling_week(reset, {"serverDate": "Sun, 27 Sep 2026 09:05:12 GMT"})
    assert not rolling_week(reset, {"serverDate": "Sun, 27 Sep 2026 10:05:12 GMT"})
    assert not rolling_week(reset, {"sentAt": 0, "receivedAt": 100})
    assert not rolling_week("invalid", {})


async def test_independent_groups_and_credentials(store):
    now = time.time()
    await store.set_model_cooldown(NAME, CLAUDE, now + 41 * 3600, "antigravity")
    await store.set_model_cooldown(NAME, GEMINI, now + 66 * 3600, "antigravity")
    snapshot = await store.quota_snapshot(NAME)
    assert snapshot["model_cooldowns"][CLAUDE] == now + 41 * 3600
    assert snapshot["model_cooldowns"][GEMINI] == now + 66 * 3600
    await store.set_model_cooldown(NAME, GEMINI, None, "antigravity")
    assert await store.quota_admit(NAME, GEMINI)
    assert await store.quota_admit(NAME, "gpt-oss-120b") is None
    await store.store_credential("second.json", {}, "antigravity")
    assert await store.quota_admit("second.json", CLAUDE)


async def test_rolling_week_never_writes_a_deadline_and_survives_restart(store):
    first = await block(store)
    state = first["quota_group_states"]["gemini-shared"]
    models, observation = week(time.time() + 51)
    second = await store.quota_sync(NAME, models, observation, await store.quota_snapshot(NAME))
    assert second["quota_group_states"]["gemini-shared"]["firstSeen"] == state["firstSeen"]
    assert second["model_cooldowns"] == {}
    assert await store.quota_admit(NAME, GEMINI) is None
    assert await store.quota_admit(NAME, CLAUDE)
    other = SQLiteManager()
    await other.initialize()
    try:
        assert await other.quota_admit(NAME, GEMINI) is None
        assert await other.get_next_available_credential(mode="antigravity", model_name=GEMINI) is None
        assert await other.get_next_available_credential(mode="antigravity", model_name=None)
    finally:
        await other.close()


async def test_release_preserves_timed_cooldown_and_only_new_business_429_reblocks(store):
    await block(store)
    await store.set_model_cooldown(NAME, GEMINI, time.time() + 100, "antigravity")
    await store.quota_release(NAME, "gemini-shared")
    assert await store.quota_admit(NAME, GEMINI) is None
    await store.set_model_cooldown(NAME, GEMINI, None, "antigravity")
    admission = await store.quota_admit(NAME, GEMINI)
    await block(store)
    assert await store.quota_admit(NAME, GEMINI)
    await store.quota_business_result(NAME, {**admission, "purpose": "credential_test"}, 429)
    await store.quota_business_result(NAME, admission, 503)
    assert await store.quota_admit(NAME, GEMINI)
    await store.quota_record_result(NAME, admission, GEMINI, False, 429)
    assert await store.quota_admit(NAME, GEMINI) is None
    state = (await store.quota_snapshot(NAME))["quota_group_states"]["gemini-shared"]
    assert state["reason"] == "override_failed_429"


async def test_old_request_snapshot_and_same_name_recreation_cannot_write(store):
    old_request = await store.quota_admit(NAME, GEMINI)
    old_snapshot = await store.quota_snapshot(NAME)
    await block(store)
    await store.quota_release(NAME, "gemini-shared")
    await store.quota_business_result(NAME, old_request, 429)
    models, observation = week()
    assert (await store.quota_sync(NAME, models, observation, old_snapshot))["stale"]
    assert await store.quota_admit(NAME, GEMINI)
    await store.delete_credential(NAME, "antigravity")
    await store.store_credential(NAME, {"access_token": "replacement"}, "antigravity")
    assert await store.quota_record_result(NAME, old_request, GEMINI, False, 429, time.time()+100) is False
    assert await store.quota_refresh_credential(NAME, old_request["generation"], {"access_token": "old"}) is False
    assert (await store.get_credential(NAME, "antigravity"))["access_token"] == "replacement"
    assert (await store.quota_sync(NAME, models, observation, old_snapshot))["stale"]


async def test_prefetch_success_cannot_clear_new_failure_and_bad_candidate_skipped(store):
    prefetch = await store.get_next_available_credential(mode="antigravity", model_name=GEMINI)
    old = await store.quota_admit(NAME, GEMINI)
    await block(store)
    assert await store.quota_admit(NAME, GEMINI, generation=prefetch[1]["_quota_generation"]) is None
    await store.quota_record_result(NAME, old, GEMINI, True)
    assert await store.quota_admit(NAME, GEMINI) is None
    await store.store_credential("good.json", {}, "antigravity")
    async with aiosqlite.connect(store._db_path) as conn:
        await conn.execute("UPDATE antigravity_credentials SET quota_group_states = 'broken' WHERE filename = ?", (NAME,))
        await conn.commit()
    assert (await store.get_next_available_credential(mode="antigravity", model_name=GEMINI))[0] == "good.json"


async def test_concurrent_group_updates_do_not_overwrite_and_partial_snapshot_keeps_cooldown(store):
    other = SQLiteManager()
    await other.initialize()
    try:
        await asyncio.gather(store.set_model_cooldown(NAME, GEMINI, time.time()+100, "antigravity"),
                             other.set_model_cooldown(NAME, CLAUDE, time.time()+200, "antigravity"))
        snapshot = await store.quota_snapshot(NAME)
        assert len(snapshot["model_cooldowns"]) == 2
        result = await store.quota_sync(NAME, {GEMINI: {"remaining": 1}}, {}, snapshot)
        assert result["cleared"] == []
        assert result["model_cooldowns"] == snapshot["model_cooldowns"]
        result = await store.quota_sync(NAME, {GEMINI: {"remaining": 1}}, {}, snapshot, required_models=[GEMINI])
        assert result["cleared"] == [GEMINI]
        assert await store.quota_admit(NAME, GEMINI)
        assert await store.quota_admit(NAME, CLAUDE) is None
    finally:
        await other.close()


@pytest.mark.parametrize("value", [None, True, -1, 2, "0", float("nan"), float("inf")])
async def test_unknown_fraction_never_exhausts_or_clears(store, value):
    snapshot = await store.quota_snapshot(NAME)
    result = await store.quota_sync(NAME, {GEMINI: {"remaining": value}}, {}, snapshot)
    assert result["added"] == result["cleared"] == []
