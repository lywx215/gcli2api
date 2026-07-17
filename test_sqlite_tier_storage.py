import json
import sqlite3

import pytest

from src.storage.sqlite_manager import SQLiteManager
from src.subscription_tiers import TIER_CODE_ASSIST_STANDARD, TIER_UNKNOWN


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
