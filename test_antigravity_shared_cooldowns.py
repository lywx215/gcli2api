import time
from pathlib import Path

from src.storage._stats_common import (
    clear_antigravity_cooldown_family,
    cooldowns_affect_antigravity_family,
    get_antigravity_cooldown_until,
    normalize_antigravity_cooldown_key,
)
from src.storage.sqlite_manager import SQLiteManager


def test_antigravity_cooldown_families_and_legacy_keys():
    assert normalize_antigravity_cooldown_key("gemini-3.1-pro-preview") == "gemini-shared"
    assert normalize_antigravity_cooldown_key("gemini-3.5-flash-high") == "gemini-shared"
    assert normalize_antigravity_cooldown_key("gemini-3.6-flash") == "gemini-shared"
    assert normalize_antigravity_cooldown_key("gemini-3.7-flash-low") == "gemini-shared"
    assert normalize_antigravity_cooldown_key("gemini-3.8-flash") == "gemini-3.8-flash"
    assert normalize_antigravity_cooldown_key("claude-sonnet-4-6") == "claude-gpt-shared"
    assert normalize_antigravity_cooldown_key("gpt-oss-120b") == "claude-gpt-shared"

    cooldowns = {
        "gemini-shared": 110.0,
        "gemini-3.5-flash-high": 120.0,
        "gemini-3.1-pro-preview": 115.0,
        "gemini-3.8-flash": 130.0,
        "ignored": "not-a-number",
    }
    assert get_antigravity_cooldown_until(cooldowns, "gemini-3.7-flash") == 120.0
    assert get_antigravity_cooldown_until(cooldowns, "gemini-3.8-flash") == 130.0
    assert set(clear_antigravity_cooldown_family(cooldowns, "gemini-3.1-pro")) == {
        "gemini-3.8-flash",
        "ignored",
    }
    assert cooldowns_affect_antigravity_family({"gemini-shared": 120}, "pro")
    assert cooldowns_affect_antigravity_family({"gemini-shared": 120}, "flash")


def test_all_storage_backends_use_shared_cooldown_helpers():
    root = Path(__file__).parent / "src" / "storage"
    for filename in (
        "sqlite_manager.py",
        "mongodb_manager.py",
        "psql_manager.py",
        "mysql_manager.py",
    ):
        source = (root / filename).read_text(encoding="utf-8")
        assert "get_antigravity_cooldown_until" in source
        assert "clear_antigravity_cooldown_family" in source
        assert "cooldowns_affect_antigravity_family" in source


async def test_sqlite_selection_clear_and_panel_filters_share_family_semantics(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("CREDENTIALS_DIR", str(tmp_path))
    manager = SQLiteManager()
    await manager.initialize()
    future = time.time() + 3600
    try:
        for filename in ("shared.json", "independent.json", "ready.json"):
            assert await manager.store_credential(
                filename,
                {"access_token": "synthetic", "project_id": filename},
                mode="antigravity",
            )

        await manager.update_credential_state(
            "shared.json",
            {
                "model_cooldowns": {
                    "gemini-shared": future - 10,
                    "gemini-3.5-flash-high": future,
                    "gemini-3.8-flash": future + 10,
                }
            },
            mode="antigravity",
        )
        await manager.update_credential_state(
            "independent.json",
            {"model_cooldowns": {"gemini-3.8-flash": future}, "disabled": True},
            mode="antigravity",
        )

        selected = await manager.get_next_available_credential(
            mode="antigravity",
            model_name="gemini-3.1-pro-preview",
        )
        assert selected is not None
        assert selected[0] == "ready.json"
        await manager.update_credential_state(
            "independent.json", {"disabled": False}, mode="antigravity"
        )

        assert await manager.set_model_cooldown(
            "shared.json", "gemini-3.1-pro-preview", None, mode="antigravity"
        )
        state = await manager.get_credential_state("shared.json", mode="antigravity")
        assert state["model_cooldowns"] == {"gemini-3.8-flash": future + 10}

        assert await manager.set_model_cooldown(
            "ready.json", "gemini-3.7-flash", future, mode="antigravity"
        )
        ready_state = await manager.get_credential_state("ready.json", mode="antigravity")
        assert ready_state["model_cooldowns"] == {"gemini-3.7-flash": future}
        assert "gemini-shared" not in ready_state["model_cooldowns"]

        pro_result = await manager.get_credentials_summary(
            mode="antigravity", cooldown_filter="pro_no_cooldown"
        )
        assert {item["filename"] for item in pro_result["items"]} == {
            "shared.json",
            "independent.json",
        }

        flash_result = await manager.get_credentials_summary(
            mode="antigravity", cooldown_filter="flash_no_cooldown"
        )
        assert {item["filename"] for item in flash_result["items"]} == set()
    finally:
        await manager.close()
