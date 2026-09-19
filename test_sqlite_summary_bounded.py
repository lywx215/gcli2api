import json
import sqlite3
import time

import aiosqlite
import pytest

from src.storage.sqlite_manager import SQLiteManager


async def _create_manager(tmp_path, monkeypatch) -> SQLiteManager:
    monkeypatch.setenv("CREDENTIALS_DIR", str(tmp_path))
    monkeypatch.setenv("CREDENTIAL_SUMMARY_BOUNDED_FAST_PATH", "1")
    manager = SQLiteManager()
    await manager.initialize()
    return manager


async def _seed_summary_rows(manager: SQLiteManager, mode: str) -> None:
    for filename in ("zeta.json", "alpha.json", "mu.json", "delta.json"):
        assert await manager.store_credential(filename, {"kind": "synthetic"}, mode=mode)

    future = time.time() + 3600
    await manager.update_credential_state(
        "zeta.json",
        {
            "model_cooldowns": {"model-pro": future},
            "remark": "blue",
            "error_codes": [403],
            "error_messages": {"403": {"error": {"message": "synthetic"}}},
        },
        mode=mode,
    )
    await manager.update_credential_state(
        "alpha.json", {"disabled": True, "remark": "red"}, mode=mode
    )
    await manager.update_credential_state(
        "mu.json", {"permanent_disabled": True, "remark": "blue"}, mode=mode
    )
    if mode == "geminicli":
        await manager.update_credential_state(
            "alpha.json", {"preview": False}, mode=mode
        )

    table = "credentials" if mode == "geminicli" else "antigravity_credentials"
    connection = sqlite3.connect(manager._db_path)
    connection.execute(f"UPDATE {table} SET rotation_order = 7")
    connection.execute(
        f"UPDATE {table} SET tier = NULL, remark = NULL WHERE filename = ?",
        ("delta.json",),
    )
    if mode == "geminicli":
        connection.execute(
            "UPDATE credentials SET preview = NULL WHERE filename = ?",
            ("delta.json",),
        )
    connection.commit()
    connection.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["geminicli", "antigravity"])
async def test_sqlite_bounded_summary_matches_legacy_matrix(
    tmp_path, monkeypatch, mode
):
    manager = await _create_manager(tmp_path, monkeypatch)
    try:
        await _seed_summary_rows(manager, mode)
        cases = [
            {"offset": 0, "limit": 2, "status_filter": "all"},
            {"offset": 1, "limit": 2, "status_filter": "all"},
            {"offset": 0, "limit": 25, "status_filter": "enabled"},
            {"offset": 0, "limit": 25, "status_filter": "disabled"},
            {"offset": 0, "limit": 25, "status_filter": "permanent_disabled"},
            {"offset": 0, "limit": 25, "status_filter": "all", "remark_filter": "blue"},
            {
                "offset": 0,
                "limit": 25,
                "status_filter": "all",
                "tier_filter": "unknown" if mode == "geminicli" else "pro",
            },
            {
                "offset": 0,
                "limit": 25,
                "status_filter": "all",
                "preview_filter": "no_preview",
            },
            {"offset": 99, "limit": 25, "status_filter": "all"},
        ]
        for case in cases:
            monkeypatch.setenv("CREDENTIAL_SUMMARY_BOUNDED_FAST_PATH", "1")
            bounded = await manager.get_credentials_summary(
                mode=mode,
                include_error_classifications=True,
                **case,
            )
            monkeypatch.setenv("CREDENTIAL_SUMMARY_BOUNDED_FAST_PATH", "0")
            legacy = await manager.get_credentials_summary(
                mode=mode,
                include_error_classifications=True,
                **case,
            )
            assert bounded == legacy
            assert len(bounded["items"]) <= case["limit"]
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_sqlite_summary_ignores_malformed_cooldown_values_on_both_paths(
    tmp_path, monkeypatch
):
    manager = await _create_manager(tmp_path, monkeypatch)
    try:
        assert await manager.store_credential("synthetic.json", {"kind": "synthetic"})
        future = time.time() + 3600
        assert await manager.update_credential_state(
            "synthetic.json",
            {
                "model_cooldowns": {
                    "valid": future,
                    "string": "200",
                    "boolean": True,
                }
            },
        )

        for enabled in ("1", "0"):
            monkeypatch.setenv("CREDENTIAL_SUMMARY_BOUNDED_FAST_PATH", enabled)
            result = await manager.get_credentials_summary(limit=25)
            assert result["total"] == 1
            assert result["stats"]["in_cooldown"] == 1
            assert result["items"][0]["model_cooldowns"] == {"valid": future}

        connection = sqlite3.connect(manager._db_path)
        connection.execute(
            "UPDATE credentials SET model_cooldowns = ? WHERE filename = ?",
            ("not-json", "synthetic.json"),
        )
        connection.commit()
        connection.close()

        monkeypatch.setenv("CREDENTIAL_SUMMARY_BOUNDED_FAST_PATH", "1")
        result = await manager.get_credentials_summary(limit=25)
        assert result["total"] == 1
        assert result["stats"]["no_cooldown"] == 1
        assert result["items"][0]["model_cooldowns"] == {}
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_sqlite_bounded_summary_order_uses_rotation_index_without_temp_sort(
    tmp_path, monkeypatch
):
    manager = await _create_manager(tmp_path, monkeypatch)
    try:
        await _seed_summary_rows(manager, "geminicli")
        result = await manager.get_credentials_summary(limit=25)
        assert [item["filename"] for item in result["items"]] == [
            "zeta.json",
            "alpha.json",
            "mu.json",
            "delta.json",
        ]

        connection = sqlite3.connect(manager._db_path)
        plan = connection.execute(
            "EXPLAIN QUERY PLAN "
            "SELECT filename FROM credentials "
            "ORDER BY rotation_order, rowid LIMIT ? OFFSET ?",
            (25, 0),
        ).fetchall()
        connection.close()
        assert not any("TEMP B-TREE" in row[-1] for row in plan)
        assert any("idx_rotation_order" in row[-1] for row in plan)
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_sqlite_bounded_summary_failure_falls_back_to_legacy(
    tmp_path, monkeypatch
):
    manager = await _create_manager(tmp_path, monkeypatch)
    try:
        assert await manager.store_credential("synthetic.json", {"kind": "synthetic"})

        async def fail_bounded(**_kwargs):
            raise RuntimeError("synthetic bounded failure")

        monkeypatch.setattr(manager, "_get_credentials_summary_bounded", fail_bounded)
        result = await manager.get_credentials_summary(limit=25)
        assert result["total"] == 1
        assert [item["filename"] for item in result["items"]] == ["synthetic.json"]
    finally:
        await manager.close()


def test_sqlite_bounded_summary_eligibility_is_conservative(monkeypatch):
    manager = SQLiteManager()
    base = {
        "offset": 0,
        "limit": 25,
        "status_filter": "all",
        "mode": "geminicli",
        "error_code_filter": None,
        "cooldown_filter": None,
        "preview_filter": None,
        "tier_filter": None,
        "remark_filter": None,
    }
    monkeypatch.delenv("CREDENTIAL_SUMMARY_BOUNDED_FAST_PATH", raising=False)
    assert manager._supports_bounded_summary_path(**base)

    for change in (
        {"limit": None},
        {"error_code_filter": "403"},
        {"cooldown_filter": "in_cooldown"},
        {"status_filter": "invalid"},
        {"preview_filter": "invalid"},
        {"tier_filter": "invalid"},
    ):
        assert not manager._supports_bounded_summary_path(**(base | change))

    monkeypatch.setenv("CREDENTIAL_SUMMARY_BOUNDED_FAST_PATH", "0")
    assert not manager._supports_bounded_summary_path(**base)
    monkeypatch.setenv("CREDENTIAL_SUMMARY_BOUNDED_FAST_PATH", "invalid")
    assert not manager._supports_bounded_summary_path(**base)


@pytest.mark.asyncio
async def test_sqlite_read_transaction_keeps_count_and_page_on_one_snapshot(
    tmp_path, monkeypatch
):
    manager = await _create_manager(tmp_path, monkeypatch)
    try:
        for filename in ("one.json", "two.json"):
            assert await manager.store_credential(filename, {"kind": "synthetic"})

        async with aiosqlite.connect(manager._db_path) as reader:
            await reader.execute("BEGIN")
            async with reader.execute("SELECT COUNT(*) FROM credentials") as cursor:
                count_before = (await cursor.fetchone())[0]

            async with aiosqlite.connect(manager._db_path) as writer:
                await writer.execute(
                    "INSERT INTO credentials "
                    "(filename, credential_data, rotation_order, last_success, tier) "
                    "VALUES (?, ?, ?, ?, ?)",
                    ("three.json", json.dumps({"kind": "synthetic"}), 2, time.time(), "unknown"),
                )
                await writer.commit()

            async with reader.execute(
                "SELECT filename FROM credentials ORDER BY rotation_order, rowid"
            ) as cursor:
                snapshot_rows = await cursor.fetchall()
            await reader.commit()

        assert count_before == 2
        assert [row[0] for row in snapshot_rows] == ["one.json", "two.json"]
    finally:
        await manager.close()
