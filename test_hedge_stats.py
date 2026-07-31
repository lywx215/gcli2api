import asyncio

import pytest

from src.hedge_stats import (
    HedgeStatsService,
    build_hedge_stats_response,
)
from src.storage._stats_common import _today_beijing_str
from src.storage.mongodb_manager import MongoDBManager
from src.storage.mysql_manager import MySQLManager
from src.storage.psql_manager import PSQLManager
from src.storage.sqlite_manager import SQLiteManager
from src.panel import creds as creds_routes


@pytest.mark.asyncio
async def test_sqlite_200_concurrent_reservations_stop_at_budget(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("CREDENTIALS_DIR", str(tmp_path))
    manager = SQLiteManager()
    await manager.initialize()
    try:
        results = await asyncio.gather(
            *[
                manager.reserve_hedge_budget(
                    _today_beijing_str(),
                    "backup@example.com.json",
                    "2.5-pro",
                    10,
                )
                for _ in range(200)
            ]
        )
        assert sum(results) == 10
        rows = await manager.get_hedge_stats(1)
        assert len(rows) == 1
        assert rows[0]["extra_upstream_requests"] == 10
        assert rows[0]["outcome_pending"] == 10
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_sqlite_budget_buckets_and_model_aliases_are_independent(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("CREDENTIALS_DIR", str(tmp_path))
    manager = SQLiteManager()
    await manager.initialize()
    service = HedgeStatsService()

    async def backend():
        return manager

    monkeypatch.setattr(service, "_backend", backend)
    try:
        first, reason = await service.reserve(
            "one.json", "gemini-2.5-pro-search", 1
        )
        alias, alias_reason = await service.reserve(
            "one.json", "gemini-2.5-pro-thinking", 1
        )
        other_credential, _ = await service.reserve(
            "two.json", "gemini-2.5-pro", 1
        )
        other_family, _ = await service.reserve(
            "one.json", "gemini-2.5-flash", 1
        )
        next_date_reserved = await manager.reserve_hedge_budget(
            "2099-01-02",
            "one.json",
            "2.5-pro",
            1,
        )

        assert first is not None and reason is None
        assert alias is None and alias_reason == "daily_budget_exhausted"
        assert other_credential is not None
        assert other_family is not None
        assert next_date_reserved is True
    finally:
        await asyncio.sleep(0)
        await manager.close()


@pytest.mark.asyncio
async def test_budget_storage_failure_skips_hedge():
    class FailingBackend:
        async def reserve_hedge_budget(self, *args):
            raise RuntimeError("storage down")

    service = HedgeStatsService()

    async def backend():
        return FailingBackend()

    service._backend = backend
    reservation, reason = await service.reserve(
        "backup.json", "gemini-2.5-pro", 10
    )
    assert reservation is None
    assert reason == "budget_check_failed"


def test_stats_response_uses_only_credential_diagnostic_ids():
    filename = "private-user@example.com.json"
    response = build_hedge_stats_response(
        [
            {
                "date": _today_beijing_str(),
                "credential_name": filename,
                "model_family": "2.5-pro",
                "extra_upstream_requests": 3,
                "primary_wins": 1,
                "backup_wins": 2,
                "confirmed_rescues": 1,
                "both_failed": 0,
                "client_cancelled": 0,
                "budget_skips": 1,
                "outcome_pending": 0,
            }
        ],
        days=7,
        daily_budget=10,
        sample_rate=0.05,
    )
    assert filename not in repr(response)
    assert response["today"]["remaining_budget"] == 7
    assert response["today"]["cost_per_backup_win"] == 1.5
    assert response["today_by_model_family"]["2.5-pro"][
        "extra_upstream_requests"
    ] == 3
    assert len(response["today_by_credential"][0]["diagnostic_id"]) == 12


@pytest.mark.parametrize(
    "manager_class",
    [SQLiteManager, MySQLManager, PSQLManager, MongoDBManager],
)
def test_all_storage_backends_implement_hedge_budget_contract(manager_class):
    for method in (
        "reserve_hedge_budget",
        "record_hedge_metric",
        "record_hedge_outcome",
        "get_hedge_stats",
    ):
        assert callable(getattr(manager_class, method, None))


@pytest.mark.asyncio
async def test_hedge_stats_management_endpoint_validates_days(monkeypatch):
    async def get_stats(**kwargs):
        return {"days": kwargs["days"], "today": {}}

    async def budget():
        return 10

    async def sample_rate():
        return 0.05

    monkeypatch.setattr(
        creds_routes.hedge_stats_service,
        "get_stats",
        get_stats,
    )
    monkeypatch.setattr(
        creds_routes,
        "get_geminicli_stream_header_hedge_daily_budget",
        budget,
    )
    monkeypatch.setattr(
        creds_routes,
        "get_geminicli_stream_header_hedge_sample_rate",
        sample_rate,
    )
    response = await creds_routes.get_hedge_stats(days=7, token="test")
    assert b'"days":7' in response.body

    with pytest.raises(Exception) as caught:
        await creds_routes.get_hedge_stats(days=91, token="test")
    assert getattr(caught.value, "status_code", None) == 400
