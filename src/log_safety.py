"""Small, dependency-free helpers for safe operational logging."""

from __future__ import annotations

import hashlib
import os
import re
from typing import Any, Optional
from urllib.parse import urlsplit, urlunsplit


_BEARER_RE = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+")
_EMAIL_RE = re.compile(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b")
_TOKEN_PARAM_RE = re.compile(
    r"(?i)([?&](?:access_token|token|key|api_key|authorization)=)[^&#\s]+"
)
_JSON_SECRET_RE = re.compile(
    r'(?i)(["\']?(?:access_token|refresh_token|token|authorization|api_key|password|client_secret)["\']?\s*[:=]\s*["\']?)[^"\'\s,}]+'
)
_URL_USERINFO_RE = re.compile(r"(?i)(https?://)[^/@\s]+@")
_CREDENTIAL_JSON_RE = re.compile(
    r"(?i)(?<![A-Za-z0-9])([/\\A-Za-z0-9._@+-]+\.json)\b"
)


def credential_log_id(filename: Optional[str]) -> str:
    """Return a stable, non-reversible identifier suitable for logs and UI mapping."""
    if not filename:
        return "unknown"
    normalized = os.path.basename(str(filename).replace("\\", "/"))
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:12]


def safe_url(value: str) -> str:
    """Remove URL user-info and sensitive query values without rejecting malformed input."""
    try:
        parts = urlsplit(value)
        host = parts.hostname or ""
        if parts.port:
            host = f"{host}:{parts.port}"
        value = urlunsplit((parts.scheme, host, parts.path, parts.query, parts.fragment))
    except (TypeError, ValueError):
        pass
    return _TOKEN_PARAM_RE.sub(r"\1[REDACTED]", value)


def safe_text(value: Any, *, limit: Optional[int] = 240) -> str:
    """Bound and redact text that may have originated from an exception."""
    text = str(value or "")
    text = _BEARER_RE.sub("Bearer [REDACTED]", text)
    text = _URL_USERINFO_RE.sub(r"\1[REDACTED]@", text)
    text = _EMAIL_RE.sub("[REDACTED_EMAIL]", text)
    text = _TOKEN_PARAM_RE.sub(r"\1[REDACTED]", text)
    text = _JSON_SECRET_RE.sub(r"\1[REDACTED]", text)
    text = _CREDENTIAL_JSON_RE.sub(
        lambda match: f"credential:{credential_log_id(match.group(1))}", text
    )
    return text if limit is None else text[:limit]


def safe_exception(exc: BaseException, *, limit: int = 240) -> str:
    """Always include the exception class, even when ``str(exc)`` is empty."""
    message = safe_text(exc, limit=limit)
    return f"{type(exc).__name__}: {message}" if message else type(exc).__name__
