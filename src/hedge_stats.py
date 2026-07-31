"""Persistent accounting and budget reservations for GeminiCLI stream hedges."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Dict, Optional

from log import log
from src.log_safety import credential_log_id, safe_exception
from src.storage._stats_common import _today_beijing_str, normalize_model_family


HEDGE_COUNTERS = (
    "extra_upstream_requests",
    "primary_wins",
    "backup_wins",
    "confirmed_rescues",
    "both_failed",
    "client_cancelled",
    "budget_skips",
    "outcome_pending",
)


def _empty_counters() -> Dict[str, int]:
    return {key: 0 for key in HEDGE_COUNTERS}


@dataclass(frozen=True)
class HedgeReservation:
    date: str
    credential_name: str
    model_family: str


class HedgeStatsService:
    """Storage-neutral, fail-closed budget service."""

    reservation_timeout = 0.5

    def __init__(self) -> None:
        self._tasks: set[asyncio.Task] = set()

    async def _backend(self):
        from src.storage_adapter import get_storage_adapter

        adapter = await get_storage_adapter()
        backend = getattr(adapter, "_backend", None)
        if backend is None:
            raise RuntimeError("storage backend unavailable")
        return backend

    async def reserve(
        self,
        credential_name: str,
        model_name: str,
        daily_budget: int,
    ) -> tuple[Optional[HedgeReservation], Optional[str]]:
        date = _today_beijing_str()
        family = normalize_model_family(model_name)
        if daily_budget <= 0:
            self.record_budget_skip(credential_name, family, date)
            return None, "daily_budget_exhausted"
        try:
            backend = await self._backend()
            reserve = getattr(backend, "reserve_hedge_budget", None)
            if reserve is None:
                raise RuntimeError("hedge budget storage unsupported")
            async with asyncio.timeout(self.reservation_timeout):
                accepted = await reserve(
                    date,
                    credential_name,
                    family,
                    daily_budget,
                )
            if not accepted:
                self.record_budget_skip(credential_name, family, date)
                return None, "daily_budget_exhausted"
            return HedgeReservation(date, credential_name, family), None
        except Exception as exc:
            log.warning(
                "[HEDGE_STATS] budget reservation failed: "
                f"{safe_exception(exc)}, credential={credential_log_id(credential_name)}"
            )
            return None, "budget_check_failed"

    def record_budget_skip(
        self, credential_name: str, model_family: str, date: Optional[str] = None
    ) -> None:
        self._schedule(
            self._record_metric(
                date or _today_beijing_str(),
                credential_name,
                model_family,
                "budget_skips",
            )
        )

    def record_outcome(
        self,
        reservation: HedgeReservation,
        outcome: str,
        *,
        confirmed_rescue: bool = False,
    ) -> None:
        if outcome not in {
            "primary_wins",
            "backup_wins",
            "both_failed",
            "client_cancelled",
        }:
            return
        self._schedule(
            self._record_outcome(
                reservation,
                outcome,
                confirmed_rescue=(
                    bool(confirmed_rescue) and outcome == "backup_wins"
                ),
            )
        )

    async def _record_metric(
        self,
        date: str,
        credential_name: str,
        model_family: str,
        metric: str,
    ) -> None:
        try:
            backend = await self._backend()
            await backend.record_hedge_metric(
                date,
                credential_name,
                model_family,
                metric,
            )
        except Exception as exc:
            log.warning(
                f"[HEDGE_STATS] metric update failed: {safe_exception(exc)}"
            )

    async def _record_outcome(
        self,
        reservation: HedgeReservation,
        outcome: str,
        *,
        confirmed_rescue: bool,
    ) -> None:
        try:
            backend = await self._backend()
            await backend.record_hedge_outcome(
                reservation.date,
                reservation.credential_name,
                reservation.model_family,
                outcome,
                confirmed_rescue,
            )
        except Exception as exc:
            log.warning(
                f"[HEDGE_STATS] outcome update failed: {safe_exception(exc)}"
            )

    def _schedule(self, coro) -> None:
        task = asyncio.create_task(coro)
        self._tasks.add(task)

        def consume_result(done: asyncio.Task) -> None:
            self._tasks.discard(done)
            try:
                done.result()
            except asyncio.CancelledError:
                pass
            except Exception as exc:
                log.warning(
                    f"[HEDGE_STATS] background update failed: {safe_exception(exc)}"
                )

        task.add_done_callback(consume_result)

    async def drain(self, timeout: float = 1.0) -> None:
        """Best-effort flush of outcome counters before storage shutdown."""
        pending = list(self._tasks)
        if not pending:
            return
        try:
            async with asyncio.timeout(timeout):
                await asyncio.gather(*pending, return_exceptions=True)
        except TimeoutError:
            for task in pending:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)

    async def get_stats(
        self,
        *,
        days: int,
        daily_budget: int,
        sample_rate: float,
    ) -> Dict[str, Any]:
        days = max(1, min(int(days or 7), 90))
        backend = await self._backend()
        rows = await backend.get_hedge_stats(days)
        return build_hedge_stats_response(
            rows,
            days=days,
            daily_budget=daily_budget,
            sample_rate=sample_rate,
        )


def build_hedge_stats_response(
    rows: list[Dict[str, Any]],
    *,
    days: int,
    daily_budget: int,
    sample_rate: float,
) -> Dict[str, Any]:
    today = _today_beijing_str()
    totals = _empty_counters()
    today_totals = _empty_counters()
    by_date: Dict[str, Dict[str, int]] = {}
    by_family: Dict[str, Dict[str, int]] = {}
    today_by_family: Dict[str, Dict[str, int]] = {}
    by_credential: Dict[str, Dict[str, Any]] = {}
    today_by_credential: Dict[str, Dict[str, int]] = {}
    today_family_credentials: Dict[str, set[str]] = {}
    today_credential_families: Dict[str, set[str]] = {}
    today_buckets: set[tuple[str, str]] = set()

    for raw in rows:
        date = str(raw.get("date") or "")
        family = str(raw.get("model_family") or "unknown")
        credential = str(raw.get("credential_name") or "")
        diagnostic_id = credential_log_id(credential)
        counters = {
            key: max(0, int(raw.get(key) or 0))
            for key in HEDGE_COUNTERS
        }
        date_entry = by_date.setdefault(date, _empty_counters())
        family_entry = by_family.setdefault(family, _empty_counters())
        credential_entry = by_credential.setdefault(
            diagnostic_id,
            {
                "diagnostic_id": diagnostic_id,
                **_empty_counters(),
                "by_model_family": {},
            },
        )
        credential_family = credential_entry["by_model_family"].setdefault(
            family, _empty_counters()
        )
        for key, value in counters.items():
            totals[key] += value
            date_entry[key] += value
            family_entry[key] += value
            credential_entry[key] += value
            credential_family[key] += value
            if date == today:
                today_totals[key] += value
        if date == today:
            today_buckets.add((diagnostic_id, family))
            today_family_entry = today_by_family.setdefault(
                family, _empty_counters()
            )
            today_credential_entry = today_by_credential.setdefault(
                diagnostic_id, _empty_counters()
            )
            today_family_credentials.setdefault(family, set()).add(
                diagnostic_id
            )
            today_credential_families.setdefault(diagnostic_id, set()).add(
                family
            )
            for key, value in counters.items():
                today_family_entry[key] += value
                today_credential_entry[key] += value

    def enrich(counters: Dict[str, int]) -> Dict[str, Any]:
        extra = counters["extra_upstream_requests"]
        backup_wins = counters["backup_wins"]
        return {
            **counters,
            "backup_win_rate": round(backup_wins / extra, 4) if extra else 0.0,
            "cost_per_backup_win": (
                round(extra / backup_wins, 2) if backup_wins else None
            ),
        }

    active_budget = daily_budget * len(today_buckets)
    remaining_budget = max(
        0, active_budget - today_totals["extra_upstream_requests"]
    )
    return {
        "date": today,
        "timezone": "Asia/Shanghai",
        "days": days,
        "daily_budget_per_credential_model_family": daily_budget,
        "sample_rate": sample_rate,
        "sample_rate_percent": round(sample_rate * 100, 2),
        "today": {
            **enrich(today_totals),
            "active_budget": active_budget,
            "remaining_budget": remaining_budget,
            "budget_usage_rate": (
                round(
                    today_totals["extra_upstream_requests"] / active_budget,
                    4,
                )
                if active_budget
                else 0.0
            ),
        },
        "totals": enrich(totals),
        "by_date": [
            {"date": date, **enrich(counters)}
            for date, counters in sorted(by_date.items(), reverse=True)
        ],
        "by_model_family": {
            family: enrich(counters)
            for family, counters in sorted(by_family.items())
        },
        "today_by_model_family": {
            family: {
                **enrich(counters),
                "active_budget": (
                    daily_budget * len(today_family_credentials.get(family, ()))
                ),
                "remaining_budget": max(
                    0,
                    daily_budget
                    * len(today_family_credentials.get(family, ()))
                    - counters["extra_upstream_requests"],
                ),
            }
            for family, counters in sorted(today_by_family.items())
        },
        "today_by_credential": [
            {
                "diagnostic_id": diagnostic_id,
                **enrich(counters),
                "active_budget": (
                    daily_budget
                    * len(today_credential_families.get(diagnostic_id, ()))
                ),
                "remaining_budget": max(
                    0,
                    daily_budget
                    * len(today_credential_families.get(diagnostic_id, ()))
                    - counters["extra_upstream_requests"],
                ),
            }
            for diagnostic_id, counters in sorted(today_by_credential.items())
        ],
        "by_credential": [
            {
                **{
                    key: value
                    for key, value in entry.items()
                    if key != "by_model_family"
                },
                "by_model_family": {
                    family: enrich(counters)
                    for family, counters in sorted(
                        entry["by_model_family"].items()
                    )
                },
            }
            for entry in sorted(
                by_credential.values(),
                key=lambda item: item["diagnostic_id"],
            )
        ],
        "note": (
            "额外上游请求按保守口径估算，已取消请求是否由 Google 最终计入额度"
            "需以 Google 配额为准。"
        ),
    }


hedge_stats_service = HedgeStatsService()
