import json
import sqlite3
import time

import pytest

from src.storage.sqlite_manager import SQLiteManager
from src.subscription_tiers import (
    TIER_CODE_ASSIST_ENTERPRISE,
    TIER_CODE_ASSIST_STANDARD,
    TIER_PRO,
    TIER_UNKNOWN,
)


@pytest.mark.asyncio
async def test_sqlite_migrates_raw_fields_without_rewriting_existing_tier(tmp_path, monkeypatch):
    db_path = tmp_path / "credentials.db"
    connection = sqlite3.connect(db_path)
    connection.execute(
        "CREATE TABLE credentials (filename TEXT PRIMARY KEY, credential_data TEXT NOT NULL, tier TEXT DEFAULT 'pro')"
    )
    connection.execute(
        "INSERT INTO credentials (filename, credential_data, tier) VALUES (?, ?, ?)",
        ("legacy.json", json.dumps({"project_id": "legacy"}), "pro"),
    )
    connection.commit()
    connection.close()

    monkeypatch.setenv("CREDENTIALS_DIR", str(tmp_path))
    manager = SQLiteManager()
    await manager.initialize()
    try:
        legacy = await manager.get_credential_state("legacy.json", mode="geminicli")
        assert legacy["tier"] == "pro"
        assert legacy["tier_raw_id"] is None

        await manager.store_credential("new.json", {"project_id": "new"}, mode="geminicli")
        new_state = await manager.get_credential_state("new.json", mode="geminicli")
        assert new_state["tier"] == TIER_UNKNOWN

        await manager.update_credential_state(
            "new.json",
            {
                "tier": TIER_CODE_ASSIST_STANDARD,
                "tier_raw_id": "standard-tier",
                "tier_raw_name": "Gemini Code Assist Standard",
                "tier_detected_at": 1234567890,
            },
            mode="geminicli",
        )
        round_trip = await manager.get_credential_state("new.json", mode="geminicli")
        assert round_trip["tier"] == TIER_CODE_ASSIST_STANDARD
        assert round_trip["tier_raw_id"] == "standard-tier"
        assert round_trip["tier_raw_name"] == "Gemini Code Assist Standard"
        assert round_trip["tier_detected_at"] == 1234567890

        filtered = await manager.get_credentials_summary(
            mode="geminicli", tier_filter=TIER_CODE_ASSIST_STANDARD
        )
        assert [item["filename"] for item in filtered["items"]] == ["new.json"]
        assert filtered["items"][0]["tier_raw_id"] == "standard-tier"
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_sqlite_routes_gemini_35_flash_only_to_supported_tiers(tmp_path, monkeypatch):
    monkeypatch.setenv("CREDENTIALS_DIR", str(tmp_path))
    manager = SQLiteManager()
    await manager.initialize()
    try:
        for filename, tier in (
            ("pro.json", TIER_PRO),
            ("unknown.json", TIER_UNKNOWN),
            ("standard.json", TIER_CODE_ASSIST_STANDARD),
        ):
            await manager.store_credential(filename, {"project_id": filename}, mode="geminicli")
            await manager.update_credential_state(filename, {"tier": tier}, mode="geminicli")

        selected = await manager.get_next_available_credential(
            mode="geminicli", model_name="gemini-3-flash"
        )
        assert selected is not None
        assert selected[0] == "standard.json"

        await manager.update_credential_state(
            "standard.json", {"disabled": True}, mode="geminicli"
        )
        assert await manager.get_next_available_credential(
            mode="geminicli", model_name="gemini-3.5-flash-high-search"
        ) is None

        # The preview model must not be mistaken for Gemini 3.5 Flash.
        await manager.update_credential_state(
            "unknown.json", {"disabled": True}, mode="geminicli"
        )
        preview_selected = await manager.get_next_available_credential(
            mode="geminicli", model_name="gemini-3-flash-preview"
        )
        assert preview_selected is not None
        assert preview_selected[0] == "pro.json"

        await manager.update_credential_state(
            "standard.json",
            {
                "disabled": False,
                "tier": TIER_CODE_ASSIST_ENTERPRISE,
                "model_cooldowns": {"gemini-3-flash": time.time() + 300},
            },
            mode="geminicli",
        )
        assert await manager.get_next_available_credential(
            mode="geminicli", model_name="gemini-3-flash"
        ) is None
    finally:
        await manager.close()
