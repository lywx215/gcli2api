"""SMART 429 classification, credential quarantine, and single-instance guards."""

from __future__ import annotations

import asyncio
import json
import random
import time
from collections import defaultdict, deque
from dataclasses import dataclass
from enum import Enum
from typing import Any, Dict, Optional

from config import (
    get_smart_429_config_sync,
    is_geminicli_capacity_fast_fail_enabled,
    is_smart_429_protection_enabled,
    set_smart_429_runtime_blocked_reason,
    workers_not_supported,
)
from log import log
from src.storage_adapter import get_storage_adapter


RISK_CONTROL_MESSAGE = "Resource has been exhausted (e.g. check quota)"
CAPACITY_REASONS = {"MODEL_CAPACITY_EXHAUSTED", "NO_CAPACITY_AVAILABLE"}


class Upstream429Kind(str, Enum):
    QUOTA_EXHAUSTED = "quota_exhausted"
    MODEL_CAPACITY_EXHAUSTED = "model_capacity_exhausted"
    RISK_CHECK_REQUIRED = "risk_check_required"
    INDETERMINATE = "indeterminate"


class RiskCheckStatus(str, Enum):
    NORMAL = "normal"
    RISK_CONTROLLED = "risk_controlled"
    QUOTA_EXHAUSTED = "quota_exhausted"
    INDETERMINATE = "indeterminate"


class ModelCapacityGuard:
    """Aggressive, process-local fast-fail guard independent from SMART 429."""

    _REOPEN_DELAYS = (10, 20, 30)

    def __init__(self) -> None:
        self._events: dict[tuple[str, str], deque[float]] = defaultdict(deque)
        self._open_until: dict[tuple[str, str], float] = {}
        self._half_open_inflight: set[tuple[str, str]] = set()
        self._reopen_stage: dict[tuple[str, str], int] = defaultdict(int)
        self._configured_enabled = is_geminicli_capacity_fast_fail_enabled()

    @staticmethod
    def _key(mode: str, model: str) -> tuple[str, str]:
        return mode, model.strip().lower()

    def reset(self) -> None:
        self._events.clear()
        self._open_until.clear()
        self._half_open_inflight.clear()
        self._reopen_stage.clear()

    def reconfigure(self) -> None:
        enabled = is_geminicli_capacity_fast_fail_enabled()
        if enabled != self._configured_enabled:
            self.reset()
            self._configured_enabled = enabled

    def admission_retry_after(
        self, mode: str, model: str, *, enabled: Optional[bool] = None
    ) -> int:
        if enabled is None:
            enabled = is_geminicli_capacity_fast_fail_enabled()
        if not enabled:
            return 0
        key = self._key(mode, model)
        until = self._open_until.get(key)
        if until is None:
            return 0
        remaining = until - time.time()
        if remaining > 0:
            return max(1, int(remaining + 0.999))
        if key in self._half_open_inflight:
            return 1
        self._half_open_inflight.add(key)
        return 0

    def record_failure(
        self, mode: str, model: str, *, enabled: Optional[bool] = None
    ) -> int:
        """Record one capacity event and return current Retry-After, if opened."""
        if enabled is None:
            enabled = is_geminicli_capacity_fast_fail_enabled()
        if not enabled:
            return 0
        key = self._key(mode, model)
        now_monotonic = time.monotonic()
        if key in self._half_open_inflight:
            self._half_open_inflight.discard(key)
            stage = min(self._reopen_stage[key], len(self._REOPEN_DELAYS) - 1)
            delay = self._REOPEN_DELAYS[stage]
            self._reopen_stage[key] = min(stage + 1, len(self._REOPEN_DELAYS) - 1)
            self._open_until[key] = time.time() + delay
            return delay

        events = self._events[key]
        events.append(now_monotonic)
        while events and events[0] < now_monotonic - 10:
            events.popleft()
        if len(events) >= 2:
            self._open_until[key] = time.time() + 5
            self._reopen_stage[key] = 0
            return 5
        return 0

    def record_success(
        self, mode: str, model: str, *, enabled: Optional[bool] = None
    ) -> None:
        if enabled is None:
            enabled = is_geminicli_capacity_fast_fail_enabled()
        if not enabled:
            return
        key = self._key(mode, model)
        self._events.pop(key, None)
        self._open_until.pop(key, None)
        self._half_open_inflight.discard(key)
        self._reopen_stage.pop(key, None)


@dataclass(frozen=True)
class Classification:
    kind: Upstream429Kind
    reasons: frozenset[str]
    error: Dict[str, Any]


def _error_info(error_response: Any) -> tuple[Dict[str, Any], frozenset[str]]:
    if not isinstance(error_response, dict):
        return {}, frozenset()
    error = error_response.get("error", error_response)
    if not isinstance(error, dict):
        return {}, frozenset()
    reasons = set()
    for detail in error.get("details", []) or []:
        if not isinstance(detail, dict):
            continue
        reason = detail.get("reason")
        if reason:
            reasons.add(str(reason))
    return error, frozenset(reasons)


def classify_upstream_429(error_response: Any, mode: str = "geminicli") -> Classification:
    """Classify 429s with quota > concrete capacity > risk-check priority."""
    error, reasons = _error_info(error_response)
    details = error.get("details", []) if isinstance(error, dict) else []
    has_reset = False
    for detail in details or []:
        if not isinstance(detail, dict):
            continue
        metadata = detail.get("metadata") or {}
        if isinstance(metadata, dict) and (
            metadata.get("quotaResetTimeStamp") or metadata.get("quotaResetDelay")
        ):
            has_reset = True
            break
    if "QUOTA_EXHAUSTED" in reasons or has_reset:
        kind = Upstream429Kind.QUOTA_EXHAUSTED
    elif reasons & CAPACITY_REASONS:
        kind = Upstream429Kind.MODEL_CAPACITY_EXHAUSTED
    elif mode == "geminicli":
        kind = Upstream429Kind.RISK_CHECK_REQUIRED
    else:
        kind = Upstream429Kind.INDETERMINATE
    return Classification(kind=kind, reasons=reasons, error=error)


def classify_quota_result(result: Dict[str, Any]) -> RiskCheckStatus:
    """Classify a retrieveUserQuota result without reusing cooldown parsing."""
    if result.get("success"):
        return RiskCheckStatus.NORMAL
    error_body = result.get("error_body")
    error, reasons = _error_info(error_body)
    if "QUOTA_EXHAUSTED" in reasons:
        return RiskCheckStatus.QUOTA_EXHAUSTED
    if reasons & CAPACITY_REASONS:
        return RiskCheckStatus.INDETERMINATE
    try:
        code = int(error.get("code", result.get("http_status", 0)))
    except (TypeError, ValueError):
        code = 0
    message = str(error.get("message", "")).strip().rstrip(".").strip()
    if (
        code == 429
        and error.get("status") == "RESOURCE_EXHAUSTED"
        and message == RISK_CONTROL_MESSAGE
    ):
        return RiskCheckStatus.RISK_CONTROLLED
    return RiskCheckStatus.INDETERMINATE


class Smart429Service:
    PROBE_DELAYS = (24 * 3600, 3 * 24 * 3600, 7 * 24 * 3600)

    def __init__(self) -> None:
        self._policy_epoch = 0
        self._requested_enabled = False
        self._configuration_signature: tuple[bool, Optional[str]] = (False, None)
        self._tasks: dict[str, asyncio.Task] = {}
        self._pending_checks: set[str] = set()
        self._task_lock = asyncio.Lock()
        self._quota_semaphore = asyncio.Semaphore(2)
        self._rate_lock = asyncio.Lock()
        self._last_probe_started = 0.0
        self._worker: Optional[asyncio.Task] = None
        self._capacity_streaks: dict[tuple[str, str, str], int] = defaultdict(int)
        self._capacity_cooldowns: dict[tuple[str, str, str], float] = {}
        self._capacity_events: dict[tuple[str, str], deque[tuple[float, bool]]] = defaultdict(deque)
        self._breaker_windows: dict[tuple[str, str], int] = defaultdict(int)
        self._breaker_last_qualified_bucket: dict[tuple[str, str], int] = {}
        self._breaker_until: dict[tuple[str, str], float] = {}
        self._half_open_inflight: set[tuple[str, str]] = set()

    @property
    def epoch(self) -> int:
        return self._policy_epoch

    def status(self) -> Dict[str, Any]:
        status = dict(get_smart_429_config_sync())
        status["policy_epoch"] = self._policy_epoch
        status["single_instance_only"] = True
        return status

    async def reconfigure(self) -> None:
        requested = bool(get_smart_429_config_sync().get("requested_enabled"))
        blocked_reason: Optional[str] = None
        set_smart_429_runtime_blocked_reason(None)
        if requested and not workers_not_supported():
            try:
                adapter = await get_storage_adapter()
                backend = getattr(adapter, "_backend", None)
                checker = getattr(backend, "check_smart_429_capability", None)
                if checker is None:
                    blocked_reason = "health_storage_capability_missing"
                else:
                    capable, reason = await checker()
                    if not capable:
                        blocked_reason = reason or "health_storage_unavailable"
            except Exception as exc:
                blocked_reason = f"health_storage_unavailable:{exc}"
        set_smart_429_runtime_blocked_reason(blocked_reason)
        signature = (requested, get_smart_429_config_sync().get("blocked_reason"))
        if signature != self._configuration_signature:
            self._policy_epoch += 1
            self._configuration_signature = signature
            self._requested_enabled = requested
        if is_smart_429_protection_enabled():
            if self._worker is None or self._worker.done():
                self._worker = asyncio.create_task(self._probe_loop())
        else:
            await self._stop_worker()
            async with self._task_lock:
                tasks = list(self._tasks.values())
                self._tasks.clear()
                self._pending_checks.clear()
            for task in tasks:
                task.cancel()
            self._reset_runtime_guards()

    async def close(self) -> None:
        self._policy_epoch += 1
        await self._stop_worker()
        async with self._task_lock:
            tasks = list(self._tasks.values())
            self._tasks.clear()
            self._pending_checks.clear()
        for task in tasks:
            task.cancel()

    async def _stop_worker(self) -> None:
        if self._worker and not self._worker.done():
            self._worker.cancel()
            try:
                await self._worker
            except asyncio.CancelledError:
                pass
        self._worker = None

    def _reset_runtime_guards(self) -> None:
        self._capacity_streaks.clear()
        self._capacity_cooldowns.clear()
        self._capacity_events.clear()
        self._breaker_windows.clear()
        self._breaker_last_qualified_bucket.clear()
        self._breaker_until.clear()
        self._half_open_inflight.clear()

    async def _rate_limit_probe(self) -> None:
        async with self._rate_lock:
            wait = 1.0 - (time.monotonic() - self._last_probe_started)
            if wait > 0:
                await asyncio.sleep(wait)
            self._last_probe_started = time.monotonic()

    async def verify_credential(
        self,
        filename: str,
        credential_data: Optional[Dict[str, Any]] = None,
        *,
        source: str = "runtime",
    ) -> Dict[str, Any]:
        if not is_smart_429_protection_enabled():
            return {"status": RiskCheckStatus.INDETERMINATE.value, "feature_disabled": True}
        async with self._task_lock:
            existing = self._tasks.get(filename)
            if existing and not existing.done():
                task = existing
            else:
                task = asyncio.create_task(
                    self._verify_once(filename, credential_data, source=source)
                )
                self._tasks[filename] = task
            self._pending_checks.discard(filename)
        try:
            return await task
        finally:
            async with self._task_lock:
                if self._tasks.get(filename) is task and task.done():
                    self._tasks.pop(filename, None)

    def schedule_verification(self, filename: str, credential_data: Optional[Dict[str, Any]] = None) -> None:
        if not is_smart_429_protection_enabled():
            return
        task = asyncio.create_task(self.verify_credential(filename, credential_data, source="runtime"))
        task.add_done_callback(self._consume_task)

    @staticmethod
    def _consume_task(task: asyncio.Task) -> None:
        if task.cancelled():
            return
        try:
            task.result()
        except Exception as exc:
            log.warning(f"[SMART429] background verification failed: {exc}")

    async def mark_checking(self, filename: str) -> bool:
        if not is_smart_429_protection_enabled():
            return False
        async with self._task_lock:
            existing = self._tasks.get(filename)
            if filename in self._pending_checks or (existing and not existing.done()):
                return True
            self._pending_checks.add(filename)
        adapter = await get_storage_adapter()
        state = await adapter.get_credential_state(filename, mode="geminicli")
        version = int(state.get("health_state_version", 0) or 0) + 1
        now = time.time()
        try:
            updated = await adapter.update_credential_state(
                filename,
                {
                    "health_status": "checking",
                    "health_check_started_at": now,
                    "next_probe_at": now + 3600,
                    "health_state_version": version,
                },
                mode="geminicli",
            )
            if not updated:
                async with self._task_lock:
                    self._pending_checks.discard(filename)
            return updated
        except Exception:
            async with self._task_lock:
                self._pending_checks.discard(filename)
            raise

    async def _verify_once(
        self,
        filename: str,
        credential_data: Optional[Dict[str, Any]],
        *,
        source: str,
    ) -> Dict[str, Any]:
        epoch = self._policy_epoch
        adapter = await get_storage_adapter()
        state = await adapter.get_credential_state(filename, mode="geminicli")
        version = int(state.get("health_state_version", 0) or 0)
        if credential_data is None:
            credential_data = await adapter.get_credential(filename, mode="geminicli")
        if not credential_data:
            return {"status": RiskCheckStatus.INDETERMINATE.value, "error": "credential_not_found"}

        access_token = credential_data.get("access_token") or credential_data.get("token")
        project_id = credential_data.get("project_id")
        if not access_token or not project_id:
            return {"status": RiskCheckStatus.INDETERMINATE.value, "error": "credential_incomplete"}

        async with self._quota_semaphore:
            await self._rate_limit_probe()
            from src.api.geminicli import fetch_geminicli_quota_info

            result = await fetch_geminicli_quota_info(access_token, project_id)
        status = classify_quota_result(result)

        current = await adapter.get_credential_state(filename, mode="geminicli")
        if (
            not is_smart_429_protection_enabled()
            or epoch != self._policy_epoch
            or int(current.get("health_state_version", 0) or 0) != version
        ):
            return {"status": status.value, "discarded": True, "reason": "stale_policy_or_state"}

        return await self.apply_health_check_result(
            filename=filename,
            status=status,
            quota_result=result,
            current=current,
            expected_version=version,
            expected_epoch=epoch,
            source=source,
        )

    async def apply_health_check_result(
        self,
        *,
        filename: str,
        status: RiskCheckStatus,
        quota_result: Dict[str, Any],
        current: Dict[str, Any],
        expected_version: int,
        expected_epoch: int,
        source: str,
    ) -> Dict[str, Any]:
        """Apply every synchronous or background quota result through one state writer."""
        adapter = await get_storage_adapter()
        latest = await adapter.get_credential_state(filename, mode="geminicli")
        if (
            not is_smart_429_protection_enabled()
            or expected_epoch != self._policy_epoch
            or int(latest.get("health_state_version", 0) or 0) != expected_version
        ):
            return {"status": status.value, "discarded": True, "reason": "stale_policy_or_state"}
        current = latest
        now = time.time()
        stage = int(current.get("probe_stage", 0) or 0)
        updates: Dict[str, Any] = {
            "last_health_check_at": now,
            "health_check_started_at": None,
            "health_state_version": expected_version + 1,
        }
        if status in (RiskCheckStatus.NORMAL, RiskCheckStatus.QUOTA_EXHAUSTED):
            updates.update(
                health_status="healthy",
                quarantine_reason=None,
                probe_stage=0,
                next_probe_at=None,
            )
        elif status == RiskCheckStatus.RISK_CONTROLLED:
            if stage >= 3:
                updates.update(
                    health_status="manual_review",
                    quarantine_reason="risk_control_429",
                    probe_stage=3,
                    next_probe_at=None,
                )
            else:
                next_stage = stage + 1
                updates.update(
                    health_status="risk_quarantined",
                    quarantine_reason="risk_control_429",
                    probe_stage=next_stage,
                    next_probe_at=now + self.PROBE_DELAYS[next_stage - 1],
                )
        else:
            if current.get("health_status") in ("checking", "risk_quarantined", "manual_review"):
                updates.update(
                    health_status=current.get("health_status"),
                    quarantine_reason=current.get("quarantine_reason"),
                    probe_stage=stage,
                    next_probe_at=now + 3600,
                )
            else:
                updates.update(
                    health_status="healthy",
                    quarantine_reason=None,
                    probe_stage=0,
                    next_probe_at=now + 3600,
                )
        await adapter.update_credential_state(filename, updates, mode="geminicli")
        return {
            "status": status.value,
            "health_status": updates["health_status"],
            "next_probe_at": updates.get("next_probe_at"),
            "source": source,
            "quota": quota_result,
        }

    async def _probe_loop(self) -> None:
        try:
            while is_smart_429_protection_enabled():
                try:
                    adapter = await get_storage_adapter()
                    states = await adapter.get_all_credential_states(mode="geminicli")
                    now = time.time()
                    for filename, state in states.items():
                        if state.get("health_status") not in ("checking", "risk_quarantined"):
                            continue
                        next_probe = state.get("next_probe_at")
                        if next_probe is not None and float(next_probe) <= now:
                            task = asyncio.create_task(
                                self.verify_credential(filename, source="scheduled_probe")
                            )
                            task.add_done_callback(self._consume_task)
                    await asyncio.sleep(60)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    log.warning(f"[SMART429] probe loop error: {exc}")
                    await asyncio.sleep(60)
        except asyncio.CancelledError:
            pass

    def capacity_cooldown_until(self, mode: str, model: str, filename: str) -> float:
        key = (mode, model, filename)
        self._capacity_streaks[key] += 1
        delay = min(30.0, 2.0 ** self._capacity_streaks[key])
        delay *= random.uniform(0.8, 1.2)
        self.record_capacity_event(mode, model, failed=True)
        until = time.time() + delay
        self._capacity_cooldowns[key] = until
        return until

    def record_success(self, mode: str, model: str, filename: str) -> None:
        self._capacity_streaks.pop((mode, model, filename), None)
        self._capacity_cooldowns.pop((mode, model, filename), None)
        self.record_capacity_event(mode, model, failed=False)
        self._breaker_until.pop((mode, model), None)
        self._half_open_inflight.discard((mode, model))

    def record_capacity_event(self, mode: str, model: str, *, failed: bool) -> None:
        key = (mode, model)
        now = time.monotonic()
        if failed and key in self._half_open_inflight:
            self._half_open_inflight.discard(key)
            self._breaker_until[key] = time.time() + 5
        events = self._capacity_events[key]
        events.append((now, failed))
        while events and events[0][0] < now - 20:
            events.popleft()
        bucket = int(now // 10)
        current = [event for event in events if int(event[0] // 10) == bucket]
        qualifies = len(current) >= 10 and sum(1 for _, value in current if value) / len(current) >= 0.8
        if qualifies and self._breaker_last_qualified_bucket.get(key) != bucket:
            previous = self._breaker_last_qualified_bucket.get(key)
            self._breaker_windows[key] = self._breaker_windows[key] + 1 if previous == bucket - 1 else 1
            self._breaker_last_qualified_bucket[key] = bucket
            if self._breaker_windows[key] >= 2:
                self._breaker_until[key] = max(self._breaker_until.get(key, 0), time.time() + 5)

    def breaker_retry_after(self, mode: str, model: str) -> int:
        until = self._breaker_until.get((mode, model), 0)
        return max(0, int(until - time.time() + 0.999))

    def capacity_admission_retry_after(self, mode: str, model: str) -> int:
        """Reject while open; after expiry admit exactly one in-process half-open probe."""
        key = (mode, model)
        until = self._breaker_until.get(key)
        if until is None:
            return 0
        remaining = until - time.time()
        if remaining > 0:
            return max(1, int(remaining + 0.999))
        if key in self._half_open_inflight:
            return 1
        self._half_open_inflight.add(key)
        return 0

    def all_capacity_cooling_retry_after(
        self, mode: str, model: str, filenames: set[str]
    ) -> int:
        if not filenames:
            return 0
        now = time.time()
        values = [self._capacity_cooldowns.get((mode, model, name), 0) for name in filenames]
        if not all(value > now for value in values):
            return 0
        return max(1, int(min(values) - now + 0.999))


smart_429_service = Smart429Service()
model_capacity_guard = ModelCapacityGuard()


async def verify_geminicli_risk_control(
    filename: str,
    credential_data: Optional[Dict[str, Any]] = None,
    *,
    source: str = "runtime",
) -> Dict[str, Any]:
    """Unified, cooldown-parser-independent GeminiCLI quota risk verification."""
    return await smart_429_service.verify_credential(
        filename, credential_data, source=source
    )
