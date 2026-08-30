"""Security policy shared by the panel and Management API."""

from __future__ import annotations

import os
from dataclasses import dataclass
from urllib.parse import urlsplit


EMBED_ALLOWED_ORIGINS_ENV = "GCLI_EMBED_ALLOWED_ORIGINS"
EMBED_CAPABILITY = "ui.credential_console.embed"


@dataclass(frozen=True)
class EmbedOrigins:
    origins: tuple[str, ...]
    valid: bool

    @property
    def enabled(self) -> bool:
        return self.valid and bool(self.origins)


def _canonical_https_origin(value: str) -> str:
    if not value or value != value.strip() or "*" in value:
        raise ValueError("origin is empty, padded, or contains a wildcard")

    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname:
        raise ValueError("origin must use HTTPS and include a host")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("origin must not include user information")
    if parsed.path or parsed.query or parsed.fragment:
        raise ValueError("origin must not include a path, query, or fragment")

    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("origin has an invalid port") from exc
    if port == 443:
        raise ValueError("the default HTTPS port must be omitted")

    hostname = parsed.hostname
    try:
        hostname.encode("ascii")
    except UnicodeEncodeError as exc:
        raise ValueError("origin host must use its ASCII IDNA form") from exc
    if hostname.endswith("."):
        raise ValueError("origin host must not include a trailing dot")

    host = f"[{hostname}]" if ":" in hostname else hostname
    canonical = f"https://{host}"
    if port is not None:
        canonical = f"{canonical}:{port}"
    if value != canonical:
        raise ValueError("origin is not canonical")
    return canonical


def parse_embed_allowed_origins(value: str | None) -> EmbedOrigins:
    """Parse an exact comma-separated allowlist without partially accepting it."""
    if value is None or value == "":
        return EmbedOrigins(origins=(), valid=True)

    raw_origins = value.split(",")
    try:
        origins = tuple(_canonical_https_origin(item) for item in raw_origins)
    except ValueError:
        return EmbedOrigins(origins=(), valid=False)
    if len(origins) != len(set(origins)):
        return EmbedOrigins(origins=(), valid=False)
    return EmbedOrigins(origins=origins, valid=True)


def get_embed_allowed_origins() -> EmbedOrigins:
    return parse_embed_allowed_origins(os.getenv(EMBED_ALLOWED_ORIGINS_ENV))


def embed_protocol_available() -> bool:
    """Return whether every runtime-configurable protocol prerequisite is present."""
    return get_embed_allowed_origins().enabled


def frame_ancestors_policy(origins: EmbedOrigins) -> str:
    if not origins.enabled:
        return "frame-ancestors 'none'"
    return "frame-ancestors " + " ".join(origins.origins)
