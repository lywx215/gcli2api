from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import json
import math
import os
import time
import weakref
from collections import deque
from datetime import datetime, timezone
from typing import Any

from src.embed_policy import EMBED_CAPABILITY, embed_protocol_available
from src.storage_adapter import get_storage_adapter
from src.versioning import load_version_metadata

from .active_operations import ActiveOperationFailure, PanelActiveOperations
from .auth import ManagementApiError
from .schemas import (
    ActiveActionResult,
    CapabilitiesResponse,
    CredentialActionIdentity,
    CredentialActionRequest,
    CredentialActionResponse,
    CredentialBatchActionItem,
    CredentialBatchActionRequest,
    CredentialBatchActionResponse,
    CredentialBatchActionResult,
    CredentialListResponse,
    CredentialSummary,
    DailyStats,
    ModeSummary,
    PageInfo,
    SideEffect,
    StatsCounts,
    StatsResponse,
    SummaryResponse,
)

MODES = ("geminicli", "antigravity")
WINDOWS = ("5m", "15m", "1h", "24h", "7d")
GROUPS = ("node", "mode", "model")
STARTED_AT = time.monotonic()
IDEMPOTENCY_CONFIG_KEY = "management_idempotency_v1"
IDEMPOTENCY_LIMIT = 5000
_IDEMPOTENCY_LOCKS: weakref.WeakValueDictionary[str, asyncio.Lock] = (
    weakref.WeakValueDictionary()
)
_CREDENTIAL_LOCKS: weakref.WeakValueDictionary[str, asyncio.Lock] = (
    weakref.WeakValueDictionary()
)
_PERSISTENCE_LOCK = asyncio.Lock()
ACTIVE_ACTIONS = frozenset(
    {
        "enable_preview",
        "disable_preview",
        "enable_credit",
        "disable_credit",
        "quota",
        "errors",
        "test",
        "risk_check",
        "sync_cooldown",
    }
)
EXTERNAL_ACTIVE_ACTIONS = frozenset(
    {"enable_preview", "disable_preview", "quota", "test", "risk_check", "sync_cooldown"}
)
ACTION_CAPABILITIES = {
    "set_remark": "credential.remark",
    "enable_preview": "credential.preview.enable",
    "disable_preview": "credential.preview.disable",
    "enable_credit": "credential.credit.enable",
    "disable_credit": "credential.credit.disable",
    "quota": "credential.quota",
    "errors": "credential.errors",
    "test": "credential.test",
    "risk_check": "credential.risk_check",
    "sync_cooldown": "credential.cooldown.sync",
}


def _keyed_lock(
    locks: weakref.WeakValueDictionary[str, asyncio.Lock], key: str
) -> asyncio.Lock:
    lock = locks.get(key)
    if lock is None:
        lock = asyncio.Lock()
        locks[key] = lock
    return lock


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
    if len(cursor) > 32:
        raise ManagementApiError(
            status_code=400,
            code="INVALID_ACTION",
            message="Invalid pagination cursor",
        )
    try:
        decoded = base64.b64decode(
            cursor.encode("ascii"), altchars=b"-_", validate=True
        ).decode("ascii")
        value = int(decoded)
    except (binascii.Error, UnicodeError, ValueError) as exc:
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
    def __init__(
        self,
        *,
        active_operations: object | None = None,
        active_concurrency: int = 3,
        active_starts_per_minute: int = 10,
    ) -> None:
        self._active_operations = active_operations or PanelActiveOperations()
        self._active_semaphore = asyncio.Semaphore(max(1, active_concurrency))
        self._active_start_lock = asyncio.Lock()
        self._active_starts: deque[float] = deque()
        self._active_starts_per_minute = max(1, active_starts_per_minute)

    def _metadata(self) -> dict[str, str]:
        version = load_version_metadata()
        return {
            "server_version": version.get("version") or "unknown",
            "revision": version.get("full_hash") or "unknown",
            "generated_at": _utc_now(),
        }

    async def _storage(self):
        return await get_storage_adapter()

    def _read_capabilities(self, backend: object, backend_type: str) -> list[str]:
        capabilities: list[str] = []
        if embed_protocol_available():
            capabilities.append(EMBED_CAPABILITY)
        if hasattr(backend, "get_credentials_summary"):
            capabilities.extend(("node.summary", "credential.list"))
        # MongoDB currently exposes no-op compatibility stubs, not statistics.
        if backend_type != "mongodb" and hasattr(backend, "get_recent_daily_stats"):
            capabilities.append("stats.daily")
        if backend_type != "mongodb" and hasattr(backend, "get_today_stats_by_model"):
            capabilities.extend(("stats.model", "stats.rpm"))
        if all(
            hasattr(backend, name)
            for name in (
                "list_credentials",
                "get_credential_state",
                "update_credential_state",
                "delete_credential",
                "get_config",
                "set_config",
            )
        ):
            capabilities.extend(
                (
                    "credential.enable",
                    "credential.disable",
                    "credential.permanent_disable",
                    "credential.delete",
                    "credential.remark",
                    "credential.batch_action",
                )
            )
        active_storage = all(
            hasattr(backend, name)
            for name in (
                "list_credentials",
                "get_credential",
                "store_credential",
                "get_credential_state",
                "update_credential_state",
                "get_config",
                "set_config",
            )
        )
        if active_storage:
            capabilities.append("credential.errors")
            if hasattr(backend, "clear_all_model_cooldowns"):
                capabilities.extend(
                    ("credential.credit.enable", "credential.credit.disable")
                )
            supported = getattr(self._active_operations, "supported_actions", frozenset())
            supports = getattr(self._active_operations, "supports", None)
            for action in ("enable_preview", "quota", "test", "risk_check"):
                if (
                    supports(action)
                    if callable(supports)
                    else action in supported
                ):
                    capabilities.append(ACTION_CAPABILITIES[action])
            sync_supported = (
                supports("sync_cooldown")
                if callable(supports)
                else "sync_cooldown" in supported
            )
            if sync_supported and hasattr(backend, "set_model_cooldown"):
                capabilities.append("credential.cooldown.sync")
        return sorted(set(capabilities))

    async def capabilities(self) -> CapabilitiesResponse:
        storage = await self._storage()
        backend = getattr(storage, "_backend", None)
        backend_type = storage.get_backend_type()
        return CapabilitiesResponse(
            **self._metadata(),
            storage_backend=backend_type,
            capabilities=self._read_capabilities(backend, backend_type),
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
        if storage.get_backend_type() == "mongodb" or backend is None or not (
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

    @staticmethod
    def _validate_write_target(mode: str, filename: str) -> None:
        if mode not in MODES:
            raise ManagementApiError(
                status_code=400,
                code="INVALID_MODE",
                message="Invalid credential mode",
            )
        if (
            not filename
            or len(filename) > 512
            or filename in (".", "..")
            or filename != os.path.basename(filename)
            or not filename.endswith(".json")
        ):
            raise ManagementApiError(
                status_code=400,
                code="INVALID_ACTION",
                message="Invalid credential filename",
            )

    @staticmethod
    def _fingerprint(kind: str, payload: dict[str, object]) -> str:
        serialized = json.dumps(
            {"kind": kind, **payload},
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        return hashlib.sha256(serialized.encode("utf-8")).hexdigest()

    async def _idempotency_entry(self, storage, key: str) -> dict[str, object] | None:
        values = await storage.get_config(IDEMPOTENCY_CONFIG_KEY, {})
        if not isinstance(values, dict):
            return None
        entry = values.get(key)
        return entry if isinstance(entry, dict) else None

    async def _save_idempotency(
        self, storage, key: str, entry: dict[str, object]
    ) -> None:
        async with _PERSISTENCE_LOCK:
            values = await storage.get_config(IDEMPOTENCY_CONFIG_KEY, {})
            records = dict(values) if isinstance(values, dict) else {}
            records.pop(key, None)
            while len(records) >= IDEMPOTENCY_LIMIT:
                records.pop(next(iter(records)))
            records[key] = entry
            if not await storage.set_config(IDEMPOTENCY_CONFIG_KEY, records):
                raise ManagementApiError(
                    status_code=500,
                    code="INTERNAL_ERROR",
                    message="Could not persist idempotency state",
                )

    @staticmethod
    def _stored_error(value: object) -> ManagementApiError | None:
        if not isinstance(value, dict):
            return None
        status_code = value.get("status_code")
        error = value.get("error")
        if not isinstance(status_code, int) or not isinstance(error, dict):
            return None
        code = error.get("code")
        message = error.get("message")
        if not isinstance(code, str) or not isinstance(message, str):
            return None
        details = error.get("details")
        return ManagementApiError(
            status_code=status_code,
            code=code,
            message=message,
            retryable=error.get("retryable") is True,
            details=details if isinstance(details, dict) else {},
        )

    @staticmethod
    async def _current_state(storage, mode: str, filename: str) -> tuple[bool, dict[str, object]]:
        filenames = await storage.list_credentials(mode=mode)
        exists = filename in {
            os.path.basename(item)
            for item in filenames
            if isinstance(item, str)
        }
        if not exists:
            return False, {}
        state = await storage.get_credential_state(filename, mode=mode)
        return True, state if isinstance(state, dict) else {}

    @staticmethod
    def _credential_status(state: dict[str, object]) -> str:
        if state.get("permanent_disabled") is True:
            return "permanent_disabled"
        return "disabled" if state.get("disabled") is True else "enabled"

    @classmethod
    def _target_confirmed(
        cls,
        action: str,
        parameters: dict[str, object],
        exists: bool,
        state: dict[str, object],
    ) -> bool:
        if action == "delete":
            return not exists
        if not exists:
            return False
        if action == "enable":
            return cls._credential_status(state) == "enabled"
        if action == "disable":
            return cls._credential_status(state) == "disabled"
        if action == "permanent_disable":
            return cls._credential_status(state) == "permanent_disabled"
        if action == "set_remark":
            return state.get("remark", "") == parameters.get("remark")
        if action == "enable_preview":
            return state.get("preview") is True
        if action == "enable_credit":
            return state.get("enable_credit") is True
        if action == "disable_credit":
            return state.get("enable_credit") is False
        return False

    @staticmethod
    def _confirmed_active_result(action: str) -> dict[str, object] | None:
        if action == "enable_preview":
            return {"kind": "preview", "enabled": True}
        if action in ("enable_credit", "disable_credit"):
            return {"kind": "credit", "enabled": action == "enable_credit"}
        return None

    def _action_success(
        self,
        *,
        mode: str,
        filename: str,
        action: str,
        state: dict[str, object],
        no_change: bool,
        result: ActiveActionResult | dict[str, object] | None = None,
        side_effects: list[SideEffect] | None = None,
    ) -> CredentialActionResponse:
        return CredentialActionResponse(
            **self._metadata(),
            action=action,
            no_change=no_change,
            credential=CredentialActionIdentity(
                mode=mode,
                filename=filename,
                status=None if action == "delete" else self._credential_status(state),
            ),
            result=result,
            side_effects=(
                side_effects
                if side_effects is not None
                else []
                if no_change
                else [SideEffect(kind="credential_state_updated", occurred=True)]
            ),
        )

    async def _reserve_active_start(self) -> None:
        async with self._active_start_lock:
            now = time.monotonic()
            while self._active_starts and self._active_starts[0] <= now - 60:
                self._active_starts.popleft()
            if len(self._active_starts) >= self._active_starts_per_minute:
                retry_after = max(1, math.ceil(60 - (now - self._active_starts[0])))
                raise ManagementApiError(
                    status_code=429,
                    code="RATE_LIMITED",
                    message="Active operation start rate exceeded",
                    retryable=True,
                    details={"retry_after_seconds": retry_after},
                )
            self._active_starts.append(now)

    @staticmethod
    def _quota_result(payload: dict[str, object]) -> dict[str, object]:
        models = payload.get("models")
        safe_models: list[dict[str, object]] = []
        if isinstance(models, dict):
            for raw_name, raw_value in list(models.items())[:128]:
                name = _text(raw_name, 200)
                if name is None or not isinstance(raw_value, dict):
                    continue
                remaining = raw_value.get("remaining")
                remaining_percent: float | None = None
                if (
                    isinstance(remaining, (int, float))
                    and not isinstance(remaining, bool)
                    and math.isfinite(remaining)
                    and 0 <= remaining <= 100
                ):
                    remaining_percent = float(remaining * 100 if remaining <= 1 else remaining)
                    remaining_percent = round(min(100.0, remaining_percent), 4)
                safe_models.append(
                    {
                        "model_name": name,
                        "remaining_percent": remaining_percent,
                        "resets_at": _utc(raw_value.get("resetTimeRaw")),
                    }
                )
        return {"kind": "quota", "captured_at": _utc_now(), "models": safe_models}

    @staticmethod
    def _errors_result(state: dict[str, object]) -> dict[str, object]:
        codes = _error_codes(state.get("error_codes")) or []
        return {
            "kind": "errors",
            "entries": [
                {
                    "code": str(code),
                    "message": f"Recorded HTTP status {code}",
                    "last_seen": None,
                }
                for code in codes
            ],
        }

    @staticmethod
    def _risk_result(payload: dict[str, object]) -> dict[str, object]:
        health = payload.get("health")
        if not isinstance(health, dict):
            health = {}
        status = _text(health.get("status"), 64)
        classification = _text(
            health.get("classification") or payload.get("classification"), 64
        )
        normalized = (status or "").lower()
        if normalized in ("normal", "healthy", "quota_exhausted"):
            level = "low"
        elif normalized in ("checking", "cooldown", "rate_limited"):
            level = "medium"
        elif normalized in ("invalid", "disabled", "quarantined", "risk_controlled"):
            level = "high"
        else:
            level = "unknown"
        codes = [item for item in (status, classification) if item is not None]
        return {"kind": "risk", "level": level, "codes": codes}

    @staticmethod
    def _cooldown_result(payload: dict[str, object]) -> dict[str, object]:
        raw = payload.get("model_cooldowns")
        cooldowns: dict[str, str | None] = {}
        if isinstance(raw, dict):
            for raw_model, raw_until in list(raw.items())[:128]:
                model = _text(raw_model, 200)
                if model is not None:
                    cooldowns[model] = _utc(raw_until) if raw_until is not None else None
        return {"kind": "cooldown_sync", "model_cooldowns": cooldowns}

    async def _execute_external_active(
        self,
        *,
        storage: object,
        mode: str,
        filename: str,
        action: str,
        parameters: dict[str, object],
    ) -> tuple[dict[str, object], list[SideEffect]]:
        async with self._active_semaphore:
            await self._reserve_active_start()
            try:
                raw = await self._active_operations.execute(
                    action=action,
                    mode=mode,
                    filename=filename,
                    parameters=parameters,
                    storage=storage,
                )
            except ActiveOperationFailure as exc:
                code = "OUTCOME_UNKNOWN" if exc.code == "UPSTREAM_ERROR" else exc.code
                status_code = 409 if code == "OUTCOME_UNKNOWN" else exc.status_code
                raise ManagementApiError(
                    status_code=status_code,
                    code=code,
                    message=(
                        "Active operation outcome cannot be confirmed"
                        if code == "OUTCOME_UNKNOWN"
                        else "Active provider operation failed"
                    ),
                    retryable=exc.retryable,
                    details={"outcome_unknown": code == "OUTCOME_UNKNOWN"},
                ) from exc
        if not isinstance(raw, dict):
            raise ManagementApiError(
                status_code=409,
                code="OUTCOME_UNKNOWN",
                message="Active operation outcome cannot be confirmed",
                retryable=True,
                details={"outcome_unknown": True},
            )
        payload = raw.get("payload")
        if not isinstance(payload, dict):
            payload = {}
        status_code = payload.get("_status_code")
        if action in ("enable_preview", "quota", "sync_cooldown") and (
            payload.get("success") is not True
            or isinstance(status_code, int) and status_code >= 400
        ):
            raise ManagementApiError(
                status_code=502,
                code="UPSTREAM_ERROR",
                message="Active provider operation was not completed",
                retryable=True,
                details={"outcome_unknown": False},
            )
        if action == "enable_preview":
            result: dict[str, object] = {"kind": "preview", "enabled": True}
        elif action == "quota":
            result = self._quota_result(payload)
        elif action == "test":
            result = {
                "kind": "test",
                "outcome": "passed" if payload.get("success") is True else "failed",
                "model_name": _text(parameters.get("model_name"), 200)
                or "gemini-2.5-flash",
                "latency_ms": raw.get("latency_ms")
                if isinstance(raw.get("latency_ms"), (int, float))
                and not isinstance(raw.get("latency_ms"), bool)
                else None,
            }
        elif action == "risk_check":
            result = self._risk_result(payload)
        else:
            result = self._cooldown_result(payload)
        effects = [SideEffect(kind="google_api_called", occurred=True)]
        if raw.get("token_refreshed") is True:
            effects.append(SideEffect(kind="token_refreshed", occurred=True))
        if raw.get("state_changed") is True:
            effects.append(SideEffect(kind="credential_state_updated", occurred=True))
        if raw.get("cooldown_changed") is True:
            effects.append(SideEffect(kind="cooldown_updated", occurred=True))
        return result, effects

    async def _execute_active_action(
        self,
        *,
        storage: object,
        backend: object,
        mode: str,
        filename: str,
        action: str,
        parameters: dict[str, object],
        state: dict[str, object],
    ) -> tuple[dict[str, object], bool, list[SideEffect]]:
        if action == "errors":
            return self._errors_result(state), True, []
        if action == "enable_preview" and state.get("preview") is True:
            return {"kind": "preview", "enabled": True}, True, []
        if action in ("enable_credit", "disable_credit"):
            target = action == "enable_credit"
            no_change = state.get("enable_credit") is target
            effects: list[SideEffect] = []
            if not no_change:
                try:
                    changed = await storage.update_credential_state(
                        filename, {"enable_credit": target}, mode=mode
                    )
                except Exception as exc:
                    raise ManagementApiError(
                        status_code=409,
                        code="OUTCOME_UNKNOWN",
                        message="Active operation outcome cannot be confirmed",
                        retryable=True,
                        details={"outcome_unknown": True},
                    ) from exc
                if not changed:
                    raise ManagementApiError(
                        status_code=500,
                        code="INTERNAL_ERROR",
                        message="Credential credit action failed",
                    )
                effects.append(
                    SideEffect(kind="credential_state_updated", occurred=True)
                )
                try:
                    cleared = await backend.clear_all_model_cooldowns(
                        filename, mode=mode
                    )
                except Exception as exc:
                    raise ManagementApiError(
                        status_code=409,
                        code="OUTCOME_UNKNOWN",
                        message="Active operation outcome cannot be confirmed",
                        retryable=True,
                        details={"outcome_unknown": True},
                    ) from exc
                if cleared:
                    effects.append(SideEffect(kind="cooldown_updated", occurred=True))
            return {"kind": "credit", "enabled": target}, no_change, effects
        result, effects = await self._execute_external_active(
            storage=storage,
            mode=mode,
            filename=filename,
            action=action,
            parameters=parameters,
        )
        return result, False, effects

    @staticmethod
    async def _apply_action(
        storage,
        *,
        mode: str,
        filename: str,
        action: str,
        parameters: dict[str, object],
        state: dict[str, object],
    ) -> None:
        version = int(state.get("health_state_version", 0) or 0) + 1
        if action == "enable":
            updates: dict[str, object] = {
                "disabled": False,
                "permanent_disabled": False,
            }
            if mode == "geminicli":
                updates.update(
                    health_state_version=version,
                    health_status="healthy",
                    quarantine_reason=None,
                    probe_stage=0,
                    next_probe_at=None,
                )
            changed = await storage.update_credential_state(
                filename, updates, mode=mode
            )
        elif action == "disable":
            updates = {"disabled": True}
            if mode == "geminicli":
                updates["health_state_version"] = version
            changed = await storage.update_credential_state(
                filename, updates, mode=mode
            )
        elif action == "permanent_disable":
            updates = {"disabled": True, "permanent_disabled": True}
            if mode == "geminicli":
                updates["health_state_version"] = version
            changed = await storage.update_credential_state(
                filename, updates, mode=mode
            )
        elif action == "set_remark":
            changed = await storage.update_credential_state(
                filename, {"remark": parameters["remark"]}, mode=mode
            )
        else:
            if mode == "geminicli":
                await storage.update_credential_state(
                    filename, {"health_state_version": version}, mode=mode
                )
            changed = await storage.delete_credential(filename, mode=mode)
        if not changed:
            raise ManagementApiError(
                status_code=500,
                code="INTERNAL_ERROR",
                message="Credential action failed",
            )

    async def execute_action(
        self,
        *,
        mode: str,
        filename: str,
        request: CredentialActionRequest,
    ) -> CredentialActionResponse:
        self._validate_write_target(mode, filename)
        storage = await self._storage()
        backend = getattr(storage, "_backend", None)
        capability = ACTION_CAPABILITIES.get(
            request.action, f"credential.{request.action}"
        )
        if capability not in self._read_capabilities(backend, storage.get_backend_type()):
            raise ManagementApiError(
                status_code=501,
                code="CAPABILITY_NOT_SUPPORTED",
                message="Credential action is unavailable",
            )
        if request.action in ("enable_preview", "disable_preview", "risk_check") and mode != "geminicli":
            raise ManagementApiError(
                status_code=501,
                code="CAPABILITY_NOT_SUPPORTED",
                message="Credential action is unavailable for this mode",
            )
        if request.action in ("enable_credit", "disable_credit") and mode != "antigravity":
            raise ManagementApiError(
                status_code=501,
                code="CAPABILITY_NOT_SUPPORTED",
                message="Credential action is unavailable for this mode",
            )
        fingerprint = self._fingerprint(
            "action",
            {
                "mode": mode,
                "filename": filename,
                "action": request.action,
                "parameters": request.parameters,
            },
        )
        async with _keyed_lock(_IDEMPOTENCY_LOCKS, request.idempotency_key):
            entry = await self._idempotency_entry(storage, request.idempotency_key)
            if entry is not None and entry.get("fingerprint") != fingerprint:
                raise ManagementApiError(
                    status_code=409,
                    code="CONFLICT",
                    message="Idempotency key was used for a different request",
                    retryable=True,
                )
            stored_result = entry.get("result") if entry is not None else None
            if isinstance(stored_result, dict):
                return CredentialActionResponse.model_validate(stored_result)
            stored_error = self._stored_error(
                entry.get("error") if entry is not None else None
            )
            if stored_error is not None:
                raise stored_error
            recovering = entry is not None
            if entry is None:
                await self._save_idempotency(
                    storage,
                    request.idempotency_key,
                    {"fingerprint": fingerprint, "state": "pending"},
                )
            credential_key = f"{mode}:{filename}"
            async with _keyed_lock(_CREDENTIAL_LOCKS, credential_key):
                exists, state = await self._current_state(storage, mode, filename)
                if recovering and self._target_confirmed(
                    request.action, request.parameters, exists, state
                ):
                    response = self._action_success(
                        mode=mode,
                        filename=filename,
                        action=request.action,
                        state=state,
                        no_change=True,
                        result=self._confirmed_active_result(request.action),
                    )
                else:
                    if not exists:
                        error = ManagementApiError(
                            status_code=404,
                            code="CREDENTIAL_NOT_FOUND",
                            message="Credential was not found",
                        )
                        await self._save_idempotency(
                            storage,
                            request.idempotency_key,
                            {
                                "fingerprint": fingerprint,
                                "state": "completed",
                                "error": {
                                    "status_code": error.status_code,
                                    **error.payload,
                                },
                            },
                        )
                        raise error
                    if (
                        recovering
                        and request.action in EXTERNAL_ACTIVE_ACTIONS
                    ):
                        raise ManagementApiError(
                            status_code=409,
                            code="OUTCOME_UNKNOWN",
                            message="Active operation outcome cannot be confirmed",
                            retryable=True,
                            details={"outcome_unknown": True},
                        )
                    if request.action == "disable" and state.get("permanent_disabled") is True:
                        error = ManagementApiError(
                            status_code=409,
                            code="CONFLICT",
                            message="Permanently disabled credential must be enabled explicitly",
                            retryable=True,
                        )
                        await self._save_idempotency(
                            storage,
                            request.idempotency_key,
                            {
                                "fingerprint": fingerprint,
                                "state": "completed",
                                "error": {
                                    "status_code": error.status_code,
                                    **error.payload,
                                },
                            },
                        )
                        raise error
                    if request.action in ACTIVE_ACTIONS:
                        try:
                            result, no_change, side_effects = (
                                await self._execute_active_action(
                                    storage=storage,
                                    backend=backend,
                                    mode=mode,
                                    filename=filename,
                                    action=request.action,
                                    parameters=request.parameters,
                                    state=state,
                                )
                            )
                        except ManagementApiError as error:
                            error_detail = error.payload["error"]
                            details = error_detail.get("details", {})
                            if (
                                error_detail["code"] == "RATE_LIMITED"
                                or isinstance(details, dict)
                                and details.get("outcome_unknown") is False
                            ):
                                await self._save_idempotency(
                                    storage,
                                    request.idempotency_key,
                                    {
                                        "fingerprint": fingerprint,
                                        "state": "completed",
                                        "error": {
                                            "status_code": error.status_code,
                                            **error.payload,
                                        },
                                    },
                                )
                            raise
                        exists, state = await self._current_state(storage, mode, filename)
                        if request.action in (
                            "enable_preview",
                            "enable_credit",
                            "disable_credit",
                        ) and not self._target_confirmed(
                            request.action, request.parameters, exists, state
                        ):
                            raise ManagementApiError(
                                status_code=409,
                                code="OUTCOME_UNKNOWN",
                                message="Active operation outcome cannot be confirmed",
                                retryable=True,
                                details={"outcome_unknown": True},
                            )
                        response = self._action_success(
                            mode=mode,
                            filename=filename,
                            action=request.action,
                            state=state,
                            no_change=no_change,
                            result=result,
                            side_effects=side_effects,
                        )
                    else:
                        no_change = self._target_confirmed(
                            request.action, request.parameters, exists, state
                        )
                        if not no_change:
                            await self._apply_action(
                                storage,
                                mode=mode,
                                filename=filename,
                                action=request.action,
                                parameters=request.parameters,
                                state=state,
                            )
                            exists, state = await self._current_state(
                                storage, mode, filename
                            )
                            if not self._target_confirmed(
                                request.action, request.parameters, exists, state
                            ):
                                raise ManagementApiError(
                                    status_code=500,
                                    code="INTERNAL_ERROR",
                                    message="Credential action readback failed",
                                )
                        response = self._action_success(
                            mode=mode,
                            filename=filename,
                            action=request.action,
                            state=state,
                            no_change=no_change,
                        )
            await self._save_idempotency(
                storage,
                request.idempotency_key,
                {
                    "fingerprint": fingerprint,
                    "state": "completed",
                    "result": response.model_dump(mode="json"),
                },
            )
            return response

    async def _batch_item(
        self, item: CredentialBatchActionItem
    ) -> CredentialBatchActionResult:
        try:
            response = await self.execute_action(
                mode=item.mode,
                filename=item.filename,
                request=CredentialActionRequest(
                    action=item.action,
                    parameters=item.parameters,
                    idempotency_key=item.idempotency_key,
                ),
            )
            return CredentialBatchActionResult(
                mode=item.mode,
                filename=item.filename,
                action=item.action,
                status="succeeded",
                no_change=response.no_change,
                credential_status=response.credential.status,
                result=response.result,
                error=None,
                side_effects=response.side_effects,
            )
        except ManagementApiError as exc:
            detail = exc.payload["error"]
            return CredentialBatchActionResult(
                mode=item.mode,
                filename=item.filename,
                action=item.action,
                status="failed",
                no_change=False,
                credential_status=None,
                result=None,
                error=detail,
                side_effects=[],
            )
        except Exception:
            return CredentialBatchActionResult(
                mode=item.mode,
                filename=item.filename,
                action=item.action,
                status="failed",
                no_change=False,
                credential_status=None,
                result=None,
                error={
                    "code": "INTERNAL_ERROR",
                    "message": "Credential action failed",
                    "retryable": False,
                    "details": {},
                },
                side_effects=[],
            )

    async def execute_batch(
        self, request: CredentialBatchActionRequest
    ) -> CredentialBatchActionResponse:
        fingerprint = self._fingerprint(
            "batch",
            {
                "items": [item.model_dump(mode="json") for item in request.items],
            },
        )
        storage = await self._storage()
        async with _keyed_lock(_IDEMPOTENCY_LOCKS, request.idempotency_key):
            entry = await self._idempotency_entry(storage, request.idempotency_key)
            if entry is not None and entry.get("fingerprint") != fingerprint:
                raise ManagementApiError(
                    status_code=409,
                    code="CONFLICT",
                    message="Idempotency key was used for a different request",
                    retryable=True,
                )
            stored_result = entry.get("result") if entry is not None else None
            if isinstance(stored_result, dict):
                return CredentialBatchActionResponse.model_validate(stored_result)
            if entry is None:
                await self._save_idempotency(
                    storage,
                    request.idempotency_key,
                    {"fingerprint": fingerprint, "state": "pending"},
                )
            results = list(await asyncio.gather(*(self._batch_item(item) for item in request.items)))
            succeeded = sum(item.status == "succeeded" for item in results)
            status = (
                "succeeded"
                if succeeded == len(results)
                else "failed"
                if succeeded == 0
                else "partially_succeeded"
            )
            response = CredentialBatchActionResponse(
                **self._metadata(), status=status, results=results
            )
            await self._save_idempotency(
                storage,
                request.idempotency_key,
                {
                    "fingerprint": fingerprint,
                    "state": "completed",
                    "result": response.model_dump(mode="json"),
                },
            )
            return response


management_service = ManagementService()


def get_management_service() -> ManagementService:
    return management_service
