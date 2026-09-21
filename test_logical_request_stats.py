import sqlite3

import pytest

from src.storage._stats_common import normalize_logical_request_model_family
from src.storage.sqlite_manager import SQLiteManager


@pytest.mark.parametrize(
    ("model_name", "expected"),
    [
        ("gemini-3.6-flash-preview", "3.6-flash"),
        ("gemini-3.7-pro", "3.7-pro"),
        ("gemini-3.8-flash", "3.8-flash"),
        ("gemini-3.1-pro-preview", "3.1-pro"),
        ("gemini-3.1-flash-image-preview", "3.1-flash-image"),
        ("gemini-3.1-flash-lite-preview", "3.1-flash-lite-preview"),
        ("claude-sonnet-4-6", "claude-sonnet-4-6"),
        ("claude-opus-4-6-thinking", "claude-opus-4-6"),
        ("gpt-oss-120b", "gpt-oss-120b"),
        ("gemini-pro-agent", "3.1-pro"),
        ("gemini-3-flash-preview", "3-flash"),
        ("custom/model@@id", "modelid"),
    ],
)
def test_logical_request_model_family_is_specific_and_safe(model_name, expected):
    assert normalize_logical_request_model_family(model_name) == expected


@pytest.mark.asyncio
async def test_sqlite_logical_requests_use_dedicated_tables_and_metadata(tmp_path, monkeypatch):
    monkeypatch.setenv("CREDENTIALS_DIR", str(tmp_path))
    manager = SQLiteManager()
    await manager.initialize()
    try:
        # Legacy attempt history must not leak into logical-request endpoints.
        manager._bump_stats_buffer("gemini-3.1-pro", "geminicli", True)
        await manager.record_logical_request("gemini-3.1-pro-preview", "geminicli", True)
        await manager.record_logical_request("gemini-3.1-pro-preview", "geminicli", False)
        await manager.record_logical_request("", "geminicli", True)

        today = await manager.get_today_stats("geminicli")
        assert today["success_count"] == 1
        assert today["failure_count"] == 1
        assert today["metric"] == "logical_requests"
        assert today["since"].endswith("Z")
        assert "upstream-attempt" in today["description"]

        by_model = await manager.get_today_stats_by_model("geminicli")
        assert by_model["by_family"]["3.1-pro"] == {
            "success": 1, "failure": 1, "total": 2, "rpm": 2,
        }

        await manager._flush_stats_to_db()
        connection = sqlite3.connect(manager._db_path)
        try:
            assert connection.execute("SELECT COUNT(*) FROM daily_stats").fetchone()[0] == 1
            assert connection.execute("SELECT success_count, failure_count FROM request_daily_stats").fetchone() == (1, 1)
            assert connection.execute("SELECT value FROM request_stats_metadata WHERE key = 'logical_requests_enabled_at'").fetchone()
        finally:
            connection.close()
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_logical_stats_reject_blank_model_without_creating_bucket(tmp_path, monkeypatch):
    monkeypatch.setenv("CREDENTIALS_DIR", str(tmp_path))
    manager = SQLiteManager()
    await manager.initialize()
    try:
        await manager.record_logical_request(None, "geminicli", True)
        await manager._flush_stats_to_db()
        assert (await manager.get_today_stats_by_model("geminicli"))["by_family"] == {}
    finally:
        await manager.close()
