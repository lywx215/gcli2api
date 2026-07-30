"""Streaming latency guards, request tracing, and typed stream failures."""

from __future__ import annotations

import hashlib
import json
import math
import os
import random
import time
import uuid
from contextvars import ContextVar, Token
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, Optional

from fastapi import Response

from log import log


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
    perf_log_sample_rate: float = 0.01
    guard_enabled: bool = True
    diagnostics_enabled: bool = False

    @classmethod
    def from_env(cls) -> "StreamLatencyConfig":
        from config import is_stream_diagnostics_enabled

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
            perf_log_sample_rate=min(1.0, _env_float("STREAM_PERF_LOG_SAMPLE_RATE", 0.01, 0.0)),
            guard_enabled=_env_bool("STREAM_LATENCY_GUARD_ENABLED", True),
            diagnostics_enabled=is_stream_diagnostics_enabled(),
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
    ) -> None:
        super().__init__(message)
        self.message = message
        self.stage = stage
        self.status_code = status_code
        self.retryable = retryable
        self.body = body
        self.headers = headers or {}
        self.request_id = request_id

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
        )

    def to_response(self) -> Response:
        body = self.body
        if body is None:
            body = json.dumps(
                {
                    "error": {
                        "code": self.status_code,
                        "message": self.message,
                        "status": "DEADLINE_EXCEEDED" if self.status_code == 504 else "UNAVAILABLE",
                        "request_id": self.request_id,
                    }
                },
                ensure_ascii=False,
            ).encode("utf-8")
        safe_headers = {
            key: value
            for key, value in self.headers.items()
            if key.lower() in {"retry-after", "content-type"}
        }
        return Response(content=body, status_code=self.status_code, headers=safe_headers)


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
    credential_hash: Optional[str] = None
    diagnostics_enabled: bool = field(
        default_factory=lambda: StreamLatencyConfig.from_env().diagnostics_enabled
    )
    perf_log_sample_rate: float = field(
        default_factory=lambda: StreamLatencyConfig.from_env().perf_log_sample_rate
    )
    timings_ms: Dict[str, float] = field(default_factory=dict)
    _marks: Dict[str, float] = field(default_factory=dict, repr=False)
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

    def set_credential(self, filename: str) -> None:
        self.credential_hash = hashlib.sha256(filename.encode("utf-8")).hexdigest()[:12]

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
        if not self.diagnostics_enabled:
            self._logged = True
            return
        slow = self.timings_ms.get("first_content", total_ms) >= 30000
        should_log = force_log or result != "success" or self.attempts > 1 or slow
        should_log = should_log or random.random() < self.perf_log_sample_rate
        if should_log:
            payload = {
                "request_id": self.request_id,
                "model": self.model,
                "protocol": self.protocol,
                "phase": self.phase.value,
                "result": result,
                "attempts": self.attempts,
                "retry_reason": self.retry_reason,
                "credential": self.credential_hash,
                "upstream_request_id": self.upstream_request_id,
                "timings_ms": self.timings_ms,
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
