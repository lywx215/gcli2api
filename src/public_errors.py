"""Stable, provider-neutral errors exposed at public API boundaries."""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from enum import Enum
from typing import Any, Mapping, Optional

from fastapi import Response


class PublicErrorCode(str, Enum):
    INVALID_REQUEST = "invalid_request"
    UPSTREAM_UNAVAILABLE = "upstream_unavailable"
    UPSTREAM_CONNECTION_ERROR = "upstream_connection_error"
    UPSTREAM_TIMEOUT = "upstream_timeout"
    CREDENTIAL_POOL_UNAVAILABLE = "credential_pool_unavailable"
    INTERNAL_ERROR = "internal_error"


@dataclass(frozen=True)
class PublicError:
    status_code: int
    code: PublicErrorCode
    message: str
    retry_after: Optional[int] = None


_MESSAGES = {
    PublicErrorCode.INVALID_REQUEST: "The request parameters are invalid.",
    PublicErrorCode.UPSTREAM_UNAVAILABLE: (
        "The service is temporarily unavailable. Please retry later."
    ),
    PublicErrorCode.UPSTREAM_CONNECTION_ERROR: (
        "The service could not reach its upstream provider."
    ),
    PublicErrorCode.UPSTREAM_TIMEOUT: "The upstream service did not respond in time.",
    PublicErrorCode.CREDENTIAL_POOL_UNAVAILABLE: (
        "The service is temporarily unavailable. Please retry later."
    ),
    PublicErrorCode.INTERNAL_ERROR: "The service failed to process the request.",
}


def _safe_retry_after(headers: Mapping[str, Any]) -> Optional[int]:
    value = None
    for key, candidate in headers.items():
        if str(key).lower() == "retry-after":
            value = candidate
            break
    try:
        parsed = int(float(str(value)))
    except (TypeError, ValueError):
        return None
    return max(1, min(3600, parsed))


def public_error_from_failure(failure: Any) -> PublicError:
    """Map an internal failure without carrying provider text or metadata."""
    status = int(getattr(failure, "status_code", 503) or 503)
    stage = str(getattr(failure, "stage", "") or "")
    error_type = str(getattr(failure, "error_type", "") or "")
    headers = getattr(failure, "headers", {}) or {}

    if stage in {"conversion", "preparing"}:
        public_status = 500
        code = PublicErrorCode.INTERNAL_ERROR
    elif status == 400:
        public_status = 400
        code = PublicErrorCode.INVALID_REQUEST
    elif status == 504 or "timeout" in error_type.lower():
        public_status = 504
        code = PublicErrorCode.UPSTREAM_TIMEOUT
    elif status == 502 or stage in {
        "pool",
        "connect",
        "write",
        "response_headers",
        "streaming",
        "stream_idle",
    }:
        public_status = 502
        code = PublicErrorCode.UPSTREAM_CONNECTION_ERROR
    elif stage in {"credential", "credential_capacity"}:
        public_status = 503
        code = PublicErrorCode.CREDENTIAL_POOL_UNAVAILABLE
    elif stage == "upstream_status" or status in {401, 403, 429, 500, 503}:
        public_status = 503
        code = PublicErrorCode.UPSTREAM_UNAVAILABLE
    elif status >= 500 and status not in {502, 503, 504}:
        public_status = 500
        code = PublicErrorCode.INTERNAL_ERROR
    else:
        # Upstream authentication, rate limit, capacity, and transient server
        # failures all become a provider-neutral availability response.
        public_status = 503
        code = PublicErrorCode.UPSTREAM_UNAVAILABLE

    retry_after = _safe_retry_after(headers) if public_status == 503 else None
    return PublicError(
        status_code=public_status,
        code=code,
        message=_MESSAGES[code],
        retry_after=retry_after,
    )


def public_error_payload(
    error: PublicError, *, protocol: str, request_id: Optional[str]
) -> dict[str, Any]:
    request_id = request_id or "unknown"
    if protocol == "anthropic":
        return {
            "type": "error",
            "error": {
                "type": (
                    "invalid_request_error"
                    if error.status_code == 400
                    else "overloaded_error"
                    if error.status_code == 503
                    else "api_error"
                ),
                "message": error.message,
                "request_id": request_id,
            },
        }
    if protocol == "openai":
        return {
            "error": {
                "message": error.message,
                "type": (
                    "invalid_request_error"
                    if error.status_code == 400
                    else "service_unavailable_error"
                    if error.status_code == 503
                    else "server_error"
                ),
                "code": error.code.value,
                "request_id": request_id,
            }
        }
    return {
        "error": {
            "code": error.status_code,
            "message": error.message,
            "status": (
                "INVALID_ARGUMENT"
                if error.status_code == 400
                else "DEADLINE_EXCEEDED"
                if error.status_code == 504
                else "INTERNAL"
                if error.status_code == 500
                else "UNAVAILABLE"
            ),
            "request_id": request_id,
        }
    }


def render_public_error(
    failure: Any, *, protocol: str = "gemini", request_id: Optional[str] = None
) -> Response:
    error = public_error_from_failure(failure)
    request_id = request_id or getattr(failure, "request_id", None) or uuid.uuid4().hex
    headers = {
        "Content-Type": "application/json",
        "X-Request-ID": request_id,
    }
    if error.retry_after is not None:
        headers["Retry-After"] = str(error.retry_after)
    return Response(
        content=json.dumps(
            public_error_payload(error, protocol=protocol, request_id=request_id),
            ensure_ascii=False,
        ).encode("utf-8"),
        status_code=error.status_code,
        headers=headers,
        media_type="application/json",
    )


def render_public_sse_error(
    failure: Any, *, protocol: str, request_id: Optional[str] = None
) -> list[bytes]:
    error = public_error_from_failure(failure)
    request_id = request_id or getattr(failure, "request_id", None)
    payload = public_error_payload(error, protocol=protocol, request_id=request_id)
    data = json.dumps(payload, ensure_ascii=False)
    if protocol == "anthropic":
        return [f"event: error\ndata: {data}\n\n".encode("utf-8")]
    return [f"data: {data}\n\n".encode("utf-8"), b"data: [DONE]\n\n"]
