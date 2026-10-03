import json
import time

import pytest

from src.storage.sqlite_manager import SQLiteManager
from src.storage._stats_common import (
    get_antigravity_cooldown_until,
    has_active_model_cooldown,
    normalize_antigravity_cooldown_key,
)


@pytest.mark.parametrize("tier", ["low", "medium", "high"])
def test_opus_55_keeps_shared_claude_gpt_cooldown(tier):
    model = f"claude-opus-5-5-{tier}"
    assert normalize_antigravity_cooldown_key(model) == "claude-gpt-shared"
    assert get_antigravity_cooldown_until(
        {"claude-opus-4-6-thinking": 200, "gpt-oss-120b": 300, "gemini-shared": 400},
        model,
    ) == 300
    assert get_antigravity_cooldown_until({model: 300}, "claude-sonnet-4-6") == 300


def test_active_cooldown_detection_accepts_persisted_and_parsed_values():
    assert has_active_model_cooldown({"gemini-pro": 200}, current_time=100)
    assert has_active_model_cooldown(
        json.dumps({"gemini-pro": 200}), current_time=100
    )
    assert not has_active_model_cooldown({"gemini-pro": 100}, current_time=100)


def test_active_cooldown_detection_treats_invalid_history_as_not_in_cooldown():
    for value in (None, "", "not-json", [], {"gemini-pro": "200"}, {"x": True}):
        assert not has_active_model_cooldown(value, current_time=100)


@pytest.mark.asyncio
async def test_cooldown_stats_only_count_normal_credentials(tmp_path, monkeypatch):
    monkeypatch.setenv("CREDENTIALS_DIR", str(tmp_path))
    manager = SQLiteManager()
    await manager.initialize()
    try:
        filenames = (
            "normal-ready.json",
            "normal-cd.json",
            "disabled-ready.json",
            "disabled-cd.json",
            "permanent-ready.json",
            "permanent-cd.json",
        )
        for filename in filenames:
            await manager.store_credential(
                filename, {"project_id": filename}, mode="geminicli"
            )

        active_cooldown = {"gemini-3-pro": time.time() + 300}
        await manager.update_credential_state(
            "normal-cd.json", {"model_cooldowns": active_cooldown}
        )
        await manager.update_credential_state(
            "disabled-ready.json", {"disabled": True}
        )
        await manager.update_credential_state(
            "disabled-cd.json",
            {"disabled": True, "model_cooldowns": active_cooldown},
        )
        await manager.update_credential_state(
            "permanent-ready.json", {"permanent_disabled": True}
        )
        await manager.update_credential_state(
            "permanent-cd.json",
            {"permanent_disabled": True, "model_cooldowns": active_cooldown},
        )

        for status_filter in (None, "enabled", "disabled", "permanent_disabled"):
            result = await manager.get_credentials_summary(
                mode="geminicli", status_filter=status_filter
            )
            assert result["stats"]["normal"] == 2
            assert result["stats"]["no_cooldown"] == 1
            assert result["stats"]["in_cooldown"] == 1
    finally:
        await manager.close()
