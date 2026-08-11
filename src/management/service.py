from __future__ import annotations

import base64
import math
import os
import time
from datetime import datetime, timezone
from typing import Any

from src.storage_adapter import get_storage_adapter
from src.versioning import load_version_metadata

from .auth import ManagementApiError
from .schemas import (
    CapabilitiesResponse,
    CredentialListResponse,
    CredentialSummary,
    DailyStats,
    ModeSummary,
    PageInfo,
    StatsCounts,
    StatsResponse,
    SummaryResponse,
)

MODES = ("geminicli", "antigravity")
WINDOWS = ("5m", "15m", "1h", "24h", "7d")
GROUPS = ("node", "mode", "model")
STARTED_AT = time.monotonic()


def _utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace(
        "+00:00", "Z"
    )


def _utc(value: Any) -> str | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, (int, float)) and math.isfinite(value):
        try:
            parsed = datetime.fromtimestamp(value, timezone.utc)
        except (OSError, OverflowError, ValueError):
            return None
    elif isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    else:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _text(value: Any, maximum: int) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    return normalized[:maximum] if normalized else None


def _count(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def _count_map(value: Any) -> dict[str, int] | None:
    if not isinstance(value, dict):
        return None
    result: dict[str, int] = {}
    for key, item in list(value.items())[:128]:
        safe_key = _text(key, 128)
        safe_value = _count(item)
        if safe_key is not None and safe_value is not None:
            result[safe_key] = safe_value
    return result


def _error_codes(value: Any) -> list[int] | None:
    if not isinstance(value, list):
        return None
    return sorted(
        {
            item
            for item in value[:128]
            if isinstance(item, int) and not isinstance(item, bool) and 0 <= item <= 999
        }
    )


def _cooldowns(value: Any) -> dict[str, str] | None:
    if not isinstance(value, dict):
        return None
    result: dict[str, str] = {}
    for key, item in list(value.items())[:128]:
        safe_key = _text(key, 128)
        safe_time = _utc(item)
        if safe_key is not None and safe_time is not None:
            result[safe_key] = safe_time
    return result


def _bool(value: Any) -> bool | None:
    return value if isinstance(value, bool) else None


def _encode_cursor(offset: int) -> str:
    return base64.urlsafe_b64encode(str(offset).encode("ascii")).decode("ascii")


def _decode_cursor(cursor: str) -> int:
    try:
        decoded = base64.urlsafe_b64decode(cursor.encode("ascii")).decode("ascii")
        value = int(decoded)
    except (UnicodeError, ValueError) as exc:
        raise ManagementApiError(
            status_code=400,
            code="INVALID_ACTION",
            message="Invalid pagination cursor",
        ) from exc
    if value < 0:
        raise ManagementApiError(
            status_code=400,
            code="INVALID_ACTION",
            message="Invalid pagination cursor",
        )
    return value


class ManagementService:
    def _metadata(self) -> dict[str, str]:
        version = load_version_metadata()
        return {
            "server_version": version.get("version") or "unknown",
            "revision": version.get("full_hash") or "unknown",
            "generated_at": _utc_now(),
        }

    async def _storage(self):
        return await get_storage_adapter()

    @staticmethod
    def _read_capabilities(backend: object) -> list[str]:
        capabilities: list[str] = []
        if hasattr(backend, "get_credentials_summary"):
            capabilities.extend(("node.summary", "credential.list"))
        if hasattr(backend, "get_recent_daily_stats"):
            capabilities.append("stats.daily")
        if hasattr(backend, "get_today_stats_by_model"):
            capabilities.extend(("stats.model", "stats.rpm"))
        return sorted(set(capabilities))

    async def capabilities(self) -> CapabilitiesResponse:
        storage = await self._storage()
        backend = getattr(storage, "_backend", None)
        return CapabilitiesResponse(
            **self._metadata(),
            storage_backend=storage.get_backend_type(),
            capabilities=self._read_capabilities(backend),
        )

    async def _all_summaries(self, mode: str) -> dict[str, object]:
        storage = await self._storage()
        backend = getattr(storage, "_backend", None)
        if backend is None or not hasattr(backend, "get_credentials_summary"):
            raise ManagementApiError(
                status_code=501,
                code="CAPABILITY_NOT_SUPPORTED",
                message="Credential metadata is unavailable",
            )
        result = await backend.get_credentials_summary(
            offset=0,
            limit=None,
            status_filter="all",
            mode=mode,
        )
        return result if isinstance(result, dict) else {"items": [], "stats": {}}

    async def summary(self) -> SummaryResponse:
        modes: dict[str, ModeSummary] = {}
        for mode in MODES:
            result = await self._all_summaries(mode)
            stats = result.get("stats") if isinstance(result.get("stats"), dict) else {}
            modes[mode] = ModeSummary(
                total=_count(stats.get("total")),
                enabled=_count(stats.get("normal")),
                disabled=_count(stats.get("disabled")),
                permanent_disabled=_count(stats.get("permanent_disabled")),
                cooling_down=None,
            )
        return SummaryResponse(
            **self._metadata(),
            uptime_seconds=max(0, int(time.monotonic() - STARTED_AT)),
            modes=modes,
        )

    @staticmethod
    def _credential(mode: str, raw: object) -> CredentialSummary | None:
        if not isinstance(raw, dict):
            return None
        source_filename = _text(raw.get("filename"), 512)
        if source_filename is None:
            return None
        filename = os.path.basename(source_filename.replace("\\", "/"))
        permanent = raw.get("permanent_disabled") is True
        disabled = raw.get("disabled") is True
        status = "permanent_disabled" if permanent else "disabled" if disabled else "enabled"
        health_observed = (
            _count(raw.get("health_state_version")) not in (None, 0)
            or raw.get("last_health_check_at") is not None
        )
        success_count = _count(raw.get("success_count"))
        return CredentialSummary(
            id=f"{mode}:{filename}",
            mode=mode,
            filename=filename,
            user_email=_text(raw.get("user_email"), 320),
            status=status,
            health_status=(
                _text(raw.get("health_status"), 32) if health_observed else None
            ),
            error_codes=_error_codes(raw.get("error_codes")),
            last_success=(
                _utc(raw.get("last_success"))
                if success_count not in (None, 0)
                else None
            ),
            model_cooldowns=_cooldowns(raw.get("model_cooldowns")),
            tier=_text(raw.get("tier"), 64),
            preview=_bool(raw.get("preview")),
            enable_credit=_bool(raw.get("enable_credit")),
            success_count=success_count,
            failure_count=_count(raw.get("failure_count")),
            cycle_stats=_count_map(raw.get("cycle_stats")),
            last_cycle_stats=_count_map(raw.get("last_cycle_stats")),
            remark=_text(raw.get("remark"), 500),
        )

    async def credentials(
        self,
        *,
        mode: str,
        cursor: str | None,
        offset: int | None,
        limit: int,
        status: str | None,
        error_code: int | None,
        cooldown: bool | None,
        preview: bool | None,
        tier: str | None,
        remark: str | None,
    ) -> CredentialListResponse:
        if mode not in MODES:
            raise ManagementApiError(
                status_code=400, code="INVALID_MODE", message="Invalid credential mode"
            )
        if cursor is not None and offset is not None:
            raise ManagementApiError(
                status_code=400,
                code="INVALID_ACTION",
                message="cursor and offset cannot be combined",
            )
        if limit < 1 or limit > 1000 or (offset is not None and offset < 0):
            raise ManagementApiError(
                status_code=400,
                code="INVALID_ACTION",
                message="Invalid pagination parameters",
            )
        start = _decode_cursor(cursor) if cursor is not None else (offset or 0)
        result = await self._all_summaries(mode)
        raw_items = result.get("items")
        normalized = [
            item
            for raw in raw_items
            if (item := self._credential(mode, raw)) is not None
        ] if isinstance(raw_items, list) else []
        filtered: list[CredentialSummary] = []
        for item in normalized:
            if status is not None and item.status != status:
                continue
            if error_code is not None and error_code not in (item.error_codes or []):
                continue
            if cooldown is not None and bool(item.model_cooldowns) != cooldown:
                continue
            if preview is not None and item.preview != preview:
                continue
            if tier is not None and item.tier != tier:
                continue
            if remark is not None and item.remark != remark:
                continue
            filtered.append(item)
        total = len(filtered)
        selected = filtered[start : start + limit]
        has_more = start + limit < total
        return CredentialListResponse(
            **self._metadata(),
            credentials=selected,
            page=PageInfo(
                total=total,
                limit=limit,
                has_more=has_more,
                next_cursor=_encode_cursor(start + limit) if has_more else None,
            ),
        )

    async def stats(self, *, mode: str, window: str, group_by: str) -> StatsResponse:
        if mode not in MODES:
            raise ManagementApiError(
                status_code=400, code="INVALID_MODE", message="Invalid credential mode"
            )
        if window not in WINDOWS or group_by not in GROUPS:
            raise ManagementApiError(
                status_code=400,
                code="INVALID_ACTION",
                message="Invalid stats query",
            )
        storage = await self._storage()
        backend = getattr(storage, "_backend", None)
        if backend is None or not (
            hasattr(backend, "get_today_stats_by_model")
            or hasattr(backend, "get_recent_daily_stats")
        ):
            raise ManagementApiError(
                status_code=501,
                code="CAPABILITY_NOT_SUPPORTED",
                message="Statistics are unavailable",
            )

        today: dict[str, object] = {}
        if hasattr(backend, "get_today_stats_by_model"):
            value = await backend.get_today_stats_by_model(mode=mode)
            if isinstance(value, dict) and "error" not in value:
                today = value
        raw_totals = today.get("totals") if isinstance(today.get("totals"), dict) else {}
        totals = StatsCounts(
            success=_count(raw_totals.get("success")) if window == "24h" else None,
            failure=_count(raw_totals.get("failure")) if window == "24h" else None,
            total=_count(raw_totals.get("total")) if window == "24h" else None,
            rpm=_count(raw_totals.get("rpm")),
        )
        by_family: dict[str, StatsCounts] = {}
        raw_families = today.get("by_family")
        if group_by == "model" and isinstance(raw_families, dict):
            for name, raw in list(raw_families.items())[:128]:
                safe_name = _text(name, 128)
                if safe_name is None or not isinstance(raw, dict):
                    continue
                by_family[safe_name] = StatsCounts(
                    success=_count(raw.get("success")) if window == "24h" else None,
                    failure=_count(raw.get("failure")) if window == "24h" else None,
                    total=_count(raw.get("total")) if window == "24h" else None,
                    rpm=_count(raw.get("rpm")),
                )
        daily: list[DailyStats] = []
        if window == "7d" and hasattr(backend, "get_recent_daily_stats"):
            values = await backend.get_recent_daily_stats(days=7, mode=mode)
            for raw in values[:7] if isinstance(values, list) else []:
                if not isinstance(raw, dict):
                    continue
                date = _text(raw.get("date"), 10)
                if date is None:
                    continue
                daily.append(
                    DailyStats(
                        date=date,
                        success=_count(raw.get("success_count")),
                        failure=_count(raw.get("failure_count")),
                        total=_count(raw.get("total_count")),
                    )
                )
        if window == "7d" and daily:
            success_values = [item.success for item in daily]
            failure_values = [item.failure for item in daily]
            total_values = [item.total for item in daily]
            totals.success = (
                sum(value for value in success_values if value is not None)
                if all(value is not None for value in success_values)
                else None
            )
            totals.failure = (
                sum(value for value in failure_values if value is not None)
                if all(value is not None for value in failure_values)
                else None
            )
            totals.total = (
                sum(value for value in total_values if value is not None)
                if all(value is not None for value in total_values)
                else None
            )
        return StatsResponse(
            **self._metadata(),
            mode=mode,
            window=window,
            group_by=group_by,
            totals=totals,
            by_family=by_family,
            daily=daily,
        )


management_service = ManagementService()


def get_management_service() -> ManagementService:
    return management_service
