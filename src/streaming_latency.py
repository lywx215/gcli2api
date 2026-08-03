"""Streaming latency guards, request tracing, and typed stream failures."""

from __future__ import annotations

import json
import math
import os
import random
import re
import time
import uuid
from contextvars import ContextVar, Token
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, Optional

from fastapi import Response

from log import log
from src.log_safety import credential_log_id


def _env_float(name: str, default: float, minimum: float = 0.01) -> float:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = float(raw)
        if not math.isfinite(value) or value < minimum:
            raise ValueError
        return value
    except (TypeError, ValueError):
        log.warning(f"Invalid {name}={raw!r}; using {default}")
        return default


def _env_int(name: str, default: int, minimum: int = 1, maximum: int = 10) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = int(raw)
        if not minimum <= value <= maximum:
            raise ValueError
        return value
    except (TypeError, ValueError):
        log.warning(f"Invalid {name}={raw!r}; using {default}")
        return default


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    log.warning(f"Invalid {name}={raw!r}; using {default}")
    return default


@dataclass(frozen=True)
class StreamLatencyConfig:
    credential_acquire_timeout: float = 10.0
    oauth_refresh_timeout: float = 20.0
    pool_timeout: float = 5.0
    connect_timeout: float = 10.0
    write_timeout: float = 30.0
    response_header_timeout: float = 20.0
    first_event_timeout: float = 45.0
    first_content_timeout: float = 75.0
    idle_timeout: float = 90.0
    transport_max_attempts: int = 2
    nonstream_transport_max_attempts: int = 2
    perf_log_sample_rate: float = 0.01
    guard_enabled: bool = True
    diagnostics_enabled: bool = False
    upstream_http2_enabled: bool = False
    upstream_http2_client_max_age: float = 2700.0
    header_hedge_enabled: bool = False
    header_hedge_delay: float = 15.0
    header_hedge_max_inflight: int = 20
    header_hedge_sample_rate: float = 0.05
    header_hedge_daily_budget: int = 10

    @classmethod
    def from_env(cls) -> "StreamLatencyConfig":
        from config import (
            get_cached_geminicli_stream_header_hedge_daily_budget,
            get_cached_geminicli_stream_header_hedge_sample_rate,
            is_geminicli_stream_header_hedge_enabled,
            is_stream_diagnostics_enabled,
        )

        return cls(
            credential_acquire_timeout=_env_float("CREDENTIAL_ACQUIRE_TIMEOUT", 10.0),
            oauth_refresh_timeout=_env_float("OAUTH_REFRESH_TIMEOUT", 20.0),
            pool_timeout=_env_float("UPSTREAM_POOL_TIMEOUT", 5.0),
            connect_timeout=_env_float("UPSTREAM_CONNECT_TIMEOUT", 10.0),
            write_timeout=_env_float("UPSTREAM_WRITE_TIMEOUT", 30.0),
            response_header_timeout=_env_float("UPSTREAM_RESPONSE_HEADER_TIMEOUT", 20.0),
            first_event_timeout=_env_float("UPSTREAM_FIRST_EVENT_TIMEOUT", 45.0),
            first_content_timeout=_env_float("STREAM_FIRST_CONTENT_TIMEOUT", 75.0),
            idle_timeout=_env_float("UPSTREAM_STREAM_IDLE_TIMEOUT", 90.0),
            transport_max_attempts=_env_int("STREAM_TRANSPORT_MAX_ATTEMPTS", 2, 1, 5),
            nonstream_transport_max_attempts=_env_int(
                "NONSTREAM_TRANSPORT_MAX_ATTEMPTS", 2, 1, 5
            ),
            perf_log_sample_rate=min(1.0, _env_float("STREAM_PERF_LOG_SAMPLE_RATE", 0.01, 0.0)),
            guard_enabled=_env_bool("STREAM_LATENCY_GUARD_ENABLED", True),
            diagnostics_enabled=is_stream_diagnostics_enabled(),
            upstream_http2_enabled=_env_bool("UPSTREAM_HTTP2_ENABLED", False),
            upstream_http2_client_max_age=_env_float(
                "UPSTREAM_HTTP2_CLIENT_MAX_AGE", 2700.0, 0.0
            ),
            header_hedge_enabled=is_geminicli_stream_header_hedge_enabled(),
            header_hedge_delay=_env_float(
                "GEMINICLI_STREAM_HEADER_HEDGE_DELAY", 15.0
            ),
            header_hedge_max_inflight=_env_int(
                "GEMINICLI_STREAM_HEADER_HEDGE_MAX_INFLIGHT",
                20,
                1,
                100,
            ),
            header_hedge_sample_rate=(
                get_cached_geminicli_stream_header_hedge_sample_rate()
            ),
            header_hedge_daily_budget=(
                get_cached_geminicli_stream_header_hedge_daily_budget()
            ),
        )


class StreamPhase(str, Enum):
    PREPARING = "preparing"
    SELECTING_CREDENTIAL = "selecting_credential"
    REFRESHING_TOKEN = "refreshing_token"
    WAITING_HEADERS = "waiting_headers"
    WAITING_FIRST_EVENT = "waiting_first_event"
    UPSTREAM_STARTED = "upstream_started"
    CONTENT_EMITTED = "content_emitted"
    FINISHED = "finished"
    FAILED = "failed"


class StreamFailure(Exception):
    """An upstream stream failure that can cross API/router boundaries safely."""

    def __init__(
        self,
        message: str,
        *,
        stage: str,
        status_code: int = 503,
        retryable: bool = False,
        body: Optional[bytes] = None,
        headers: Optional[Dict[str, str]] = None,
        request_id: Optional[str] = None,
        error_type: Optional[str] = None,
        connection_invalidated: bool = False,
        transport_generation: Optional[int] = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.stage = stage
        self.status_code = status_code
        self.retryable = retryable
        self.body = body
        self.headers = headers or {}
        self.request_id = request_id
        self.error_type = error_type
        self.connection_invalidated = connection_invalidated
        self.transport_generation = transport_generation

    @classmethod
    def from_response(
        cls,
        response: Response,
        *,
        stage: str,
        retryable: bool = False,
        request_id: Optional[str] = None,
    ) -> "StreamFailure":
        body = (
            response.body if isinstance(response.body, bytes) else str(response.body or "").encode()
        )
        return cls(
            "upstream request failed",
            stage=stage,
            status_code=response.status_code,
            retryable=retryable,
            body=body,
            headers=dict(response.headers),
            request_id=request_id,
            error_type=f"http_{response.status_code}",
        )

    def to_response(self) -> Response:
        # Never expose ``body`` or provider headers here.  They are retained
        # only for internal classification and diagnostics.
        from src.public_errors import render_public_error

        return render_public_error(self, protocol="gemini", request_id=self.request_id)


def _default_hedge_trace() -> Dict[str, Any]:
    config = StreamLatencyConfig.from_env()
    return {
        "enabled": config.header_hedge_enabled,
        "sampled": False,
        "launched": False,
        "delay_ms": round(config.header_hedge_delay * 1000, 2),
        "max_inflight": config.header_hedge_max_inflight,
        "sample_rate": config.header_hedge_sample_rate,
        "daily_budget": config.header_hedge_daily_budget,
        "winner_attempt": None,
        "loser_outcome": None,
        "skipped_reason": None if config.header_hedge_enabled else "disabled",
    }


@dataclass
class StreamRequestTrace:
    model: str = ""
    protocol: str = "gemini"
    request_id: str = field(default_factory=lambda: uuid.uuid4().hex)
    started_at: float = field(default_factory=time.perf_counter)
    phase: StreamPhase = StreamPhase.PREPARING
    attempts: int = 0
    retry_reason: Optional[str] = None
    result: Optional[str] = None
    upstream_request_id: Optional[str] = None
    client_request_id: Optional[str] = None
    credential_hash: Optional[str] = None
    diagnostics_enabled: bool = field(
        default_factory=lambda: StreamLatencyConfig.from_env().diagnostics_enabled
    )
    perf_log_sample_rate: float = field(
        default_factory=lambda: StreamLatencyConfig.from_env().perf_log_sample_rate
    )
    timings_ms: Dict[str, float] = field(default_factory=dict)
    retries: Dict[str, Any] = field(
        default_factory=lambda: {
            "status": 0,
            "transport": 0,
            "capacity": 0,
            "hedge": 0,
            "reasons": [],
        }
    )
    upstream_http2_enabled: bool = field(
        default_factory=lambda: StreamLatencyConfig.from_env().upstream_http2_enabled
    )
    hedge: Dict[str, Any] = field(default_factory=_default_hedge_trace)
    last_failure: Optional[Dict[str, Any]] = None
    attempt_details: list[Dict[str, Any]] = field(default_factory=list)
    stream: Dict[str, Any] = field(
        default_factory=lambda: {
            "first_content_emitted": False,
            "events_out": 0,
            "bytes_out": 0,
            "duration_after_first_content_ms": None,
            "last_upstream_event_age_ms": None,
            "cancel_phase": None,
        }
    )
    _marks: Dict[str, float] = field(default_factory=dict, repr=False)
    _attempt_started_at: Optional[float] = field(default=None, repr=False)
    _attempt_started_at_by_id: Dict[int, float] = field(default_factory=dict, repr=False)
    _last_upstream_event_at: Optional[float] = field(default=None, repr=False)
    _logged: bool = field(default=False, repr=False)

    def mark(self, name: str, *, phase: Optional[StreamPhase] = None) -> None:
        now = time.perf_counter()
        self._marks[name] = now
        self.timings_ms[name] = round((now - self.started_at) * 1000, 2)
        if phase is not None:
            self.phase = phase

    def duration(self, name: str, started_at: float) -> None:
        self.timings_ms[name] = round((time.perf_counter() - started_at) * 1000, 2)

    def duration_since_mark(self, name: str, mark: str) -> None:
        self.duration(name, self._marks.get(mark, self.started_at))

    def add_duration_ms(self, name: str, value: float) -> None:
        self.timings_ms[name] = round(self.timings_ms.get(name, 0.0) + max(0.0, value), 2)

    def set_credential(self, filename: str) -> None:
        self.credential_hash = credential_log_id(filename)

    def set_client_request_id(self, value: Optional[str]) -> None:
        if value and re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", value):
            self.client_request_id = value

    def _attempt_detail(self, attempt: Optional[int] = None) -> Optional[Dict[str, Any]]:
        target = self.attempts if attempt is None else attempt
        for detail in reversed(self.attempt_details):
            if detail.get("attempt") == target:
                return detail
        return None

    def begin_attempt(self, filename: Optional[str] = None) -> int:
        self.attempts += 1
        self._attempt_started_at = time.perf_counter()
        attempt = self.attempts
        self._attempt_started_at_by_id[attempt] = self._attempt_started_at
        if len(self.attempt_details) < 8:
            self.attempt_details.append(
                {
                    "attempt": attempt,
                    "credential": credential_log_id(filename),
                    "started_ms": round(
                        (self._attempt_started_at - self.started_at) * 1000, 2
                    ),
                    "duration_ms": None,
                    "transport_ms": {},
                    "http_version": None,
                    "upstream_request_id": None,
                }
            )
        return attempt

    def finish_attempt(self, attempt: Optional[int] = None) -> None:
        target = self.attempts if attempt is None else attempt
        started_at = self._attempt_started_at_by_id.get(target)
        detail = self._attempt_detail(target)
        if started_at is None or detail is None:
            return
        if detail.get("duration_ms") is None:
            detail["duration_ms"] = round(
                (time.perf_counter() - started_at) * 1000, 2
            )

    def add_attempt_transport(
        self, values: Dict[str, float], *, attempt: Optional[int] = None
    ) -> None:
        detail = self._attempt_detail(attempt)
        if detail is not None:
            target = detail["transport_ms"]
            target.update({key: round(value, 2) for key, value in values.items()})
        for key, value in values.items():
            self.add_duration_ms(key, value)

    def set_attempt_http_version(self, value: str, *, attempt: Optional[int] = None) -> None:
        detail = self._attempt_detail(attempt)
        if detail is not None:
            detail["http_version"] = value

    def set_attempt_transport_generation(
        self, value: Optional[int], *, attempt: Optional[int] = None
    ) -> None:
        detail = self._attempt_detail(attempt)
        if detail is not None and value is not None:
            detail["transport_generation"] = value

    def record_connection_invalidation(
        self, reason: str, *, attempt: Optional[int] = None
    ) -> None:
        detail = self._attempt_detail(attempt)
        if detail is not None:
            detail["connection_invalidated"] = True
            detail["invalidation_reason"] = reason

    def set_attempt_upstream_request_id(
        self, value: Optional[str], *, attempt: Optional[int] = None
    ) -> None:
        if not value:
            return
        detail = self._attempt_detail(attempt)
        if detail is not None:
            detail["upstream_request_id"] = value
        self.upstream_request_id = value

    def select_attempt(self, attempt: int) -> None:
        """Promote request-scoped fields from the selected parallel attempt."""
        detail = self._attempt_detail(attempt)
        if detail is not None and detail.get("upstream_request_id"):
            self.upstream_request_id = detail["upstream_request_id"]

    def record_retry(
        self,
        kind: str,
        reason: str,
        *,
        capacity: bool = False,
        attempt: Optional[int] = None,
    ) -> None:
        if kind in {"status", "transport", "hedge"}:
            self.retries[kind] += 1
        if capacity:
            self.retries["capacity"] += 1
        reasons = self.retries["reasons"]
        if len(reasons) < 8:
            reasons.append(reason)
        detail = self._attempt_detail(attempt)
        if detail is not None:
            detail["retry_kind"] = kind
            detail["retry_reason"] = reason
            detail["capacity"] = capacity
        self.retry_reason = reason

    def record_failure(
        self,
        *,
        stage: str,
        error_type: str,
        status_code: Optional[int],
        retryable: bool,
        attempt: Optional[int] = None,
        update_last: bool = True,
    ) -> None:
        failure = {
            "stage": stage,
            "error_type": error_type,
            "status_code": status_code,
            "retryable": retryable,
        }
        if update_last:
            self.last_failure = failure
        detail = self._attempt_detail(attempt)
        if detail is not None:
            detail.update(failure)
        self.finish_attempt(attempt)

    def record_attempt_outcome(self, attempt: int, outcome: str) -> None:
        detail = self._attempt_detail(attempt)
        if detail is not None:
            detail["outcome"] = outcome
        self.finish_attempt(attempt)

    def mark_upstream_event(self) -> None:
        self._last_upstream_event_at = time.perf_counter()

    def record_output(self, item: Any) -> None:
        if isinstance(item, str):
            size = len(item.encode("utf-8"))
        elif isinstance(item, (bytes, bytearray, memoryview)):
            size = len(item)
        else:
            size = len(str(item).encode("utf-8"))
        now = time.perf_counter()
        self.stream["events_out"] += 1
        self.stream["bytes_out"] += size
        if not self.stream["first_content_emitted"]:
            self.stream["first_content_emitted"] = True
            self._marks.setdefault("first_content_emitted", now)

    def record_cancellation(self) -> None:
        now = time.perf_counter()
        self.stream["cancel_phase"] = (
            "after_first_content"
            if self.stream["first_content_emitted"]
            else "before_first_content"
        )
        first = self._marks.get("first_content_emitted")
        if first is not None:
            self.stream["duration_after_first_content_ms"] = round((now - first) * 1000, 2)
        if self._last_upstream_event_at is not None:
            self.stream["last_upstream_event_age_ms"] = round(
                (now - self._last_upstream_event_at) * 1000, 2
            )

    def remaining_first_content(self) -> float:
        configured = StreamLatencyConfig.from_env().first_content_timeout
        return max(0.0, configured - (time.perf_counter() - self.started_at))

    def finish(self, result: str, *, force_log: bool = False) -> None:
        if self._logged:
            return
        self.result = result
        self.phase = StreamPhase.FINISHED if result == "success" else StreamPhase.FAILED
        total_ms = round((time.perf_counter() - self.started_at) * 1000, 2)
        self.timings_ms["total"] = total_ms
        for attempt in tuple(self._attempt_started_at_by_id):
            self.finish_attempt(attempt)
        first = self._marks.get("first_content_emitted")
        if first is not None and self.stream["duration_after_first_content_ms"] is None:
            self.stream["duration_after_first_content_ms"] = round(
                (time.perf_counter() - first) * 1000, 2
            )
        if (
            self._last_upstream_event_at is not None
            and self.stream["last_upstream_event_age_ms"] is None
        ):
            self.stream["last_upstream_event_age_ms"] = round(
                (time.perf_counter() - self._last_upstream_event_at) * 1000, 2
            )
        if not self.diagnostics_enabled:
            self._logged = True
            return
        slow = self.timings_ms.get("first_content", total_ms) >= 30000
        should_log = force_log or result != "success" or self.attempts > 1 or slow
        should_log = should_log or random.random() < self.perf_log_sample_rate
        if should_log:
            payload = {
                "schema_version": 2,
                "request_id": self.request_id,
                "client_request_id": self.client_request_id,
                "model": self.model,
                "protocol": self.protocol,
                "phase": self.phase.value,
                "result": result,
                "attempts": self.attempts,
                "retry_reason": self.retry_reason,
                "credential": self.credential_hash,
                "upstream_request_id": self.upstream_request_id,
                "upstream_http2_enabled": self.upstream_http2_enabled,
                "timings_ms": self.timings_ms,
                "retries": self.retries,
                "hedge": self.hedge,
                "last_failure": self.last_failure,
                "attempt_details": self.attempt_details,
                "attempt_details_truncated": self.attempts > len(self.attempt_details),
                "stream": self.stream,
            }
            log.info(
                f"STREAM_PERF_SUMMARY {json.dumps(payload, ensure_ascii=False, separators=(',', ':'))}"
            )
        self._logged = True


_CURRENT_TRACE: ContextVar[Optional[StreamRequestTrace]] = ContextVar(
    "stream_request_trace", default=None
)


def bind_stream_trace(trace: StreamRequestTrace) -> Token:
    return _CURRENT_TRACE.set(trace)


def reset_stream_trace(token: Token) -> None:
    _CURRENT_TRACE.reset(token)


def current_stream_trace() -> Optional[StreamRequestTrace]:
    return _CURRENT_TRACE.get()
