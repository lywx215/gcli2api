"""Security policy shared by the panel and Management API."""

from __future__ import annotations

import os
from dataclasses import dataclass
from urllib.parse import urlsplit

import config


EMBED_ALLOWED_ORIGINS_ENV = "GCLI_EMBED_ALLOWED_ORIGINS"
EMBED_CAPABILITY = "ui.credential_console.embed"
ANY_HTTPS_EMBED_CAPABILITY = "ui.credential_console.embed.any_https"
EMBED_MODES = frozenset(("any_https", "exact", "disabled"))


@dataclass(frozen=True)
class EmbedOrigins:
    origins: tuple[str, ...]
    valid: bool

    @property
    def enabled(self) -> bool:
        return self.valid and bool(self.origins)


@dataclass(frozen=True)
class EmbedPolicy:
    mode: str
    origins: tuple[str, ...] = ()
    valid: bool = True
    source: str = "default"

    @property
    def enabled(self) -> bool:
        return self.valid and self.mode in ("any_https", "exact")

    @property
    def capability(self) -> str | None:
        if not self.enabled:
            return None
        return ANY_HTTPS_EMBED_CAPABILITY if self.mode == "any_https" else EMBED_CAPABILITY


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


def parse_embed_allowed_origins(
    value: str | list[str] | tuple[str, ...] | None,
) -> EmbedOrigins:
    """Parse an exact allowlist without partially accepting invalid input."""
    if value is None or value == "" or value == [] or value == ():
        return EmbedOrigins(origins=(), valid=True)
    raw_origins = value.split(",") if isinstance(value, str) else list(value)
    try:
        origins = tuple(_canonical_https_origin(item) for item in raw_origins)
    except (TypeError, ValueError):
        return EmbedOrigins(origins=(), valid=False)
    if len(origins) != len(set(origins)):
        return EmbedOrigins(origins=(), valid=False)
    return EmbedOrigins(origins=origins, valid=True)


async def get_embed_policy() -> EmbedPolicy:
    raw_env = os.getenv(EMBED_ALLOWED_ORIGINS_ENV)
    if raw_env:
        parsed = parse_embed_allowed_origins(raw_env)
        if not parsed.enabled:
            return EmbedPolicy(mode="disabled", valid=False, source="environment")
        return EmbedPolicy(mode="exact", origins=parsed.origins, source="environment")

    missing = object()
    raw_mode = await config.get_config_value(config.GCLI_EMBED_MODE_KEY, missing)
    source = "storage"
    if raw_mode is missing:
        raw_mode = "any_https"
        source = "default"
    if not isinstance(raw_mode, str) or raw_mode not in EMBED_MODES:
        return EmbedPolicy(mode="disabled", valid=False, source="storage")
    if raw_mode == "any_https":
        return EmbedPolicy(mode="any_https", source=source)
    if raw_mode == "disabled":
        return EmbedPolicy(mode="disabled", source=source)

    raw_origins = await config.get_config_value(config.GCLI_EMBED_ORIGINS_KEY, [])
    parsed = parse_embed_allowed_origins(raw_origins)
    if not parsed.enabled:
        return EmbedPolicy(mode="disabled", valid=False, source="storage")
    return EmbedPolicy(mode="exact", origins=parsed.origins, source="storage")


def frame_ancestors_policy(policy: EmbedPolicy | EmbedOrigins) -> str:
    if isinstance(policy, EmbedOrigins):
        if not policy.enabled:
            return "frame-ancestors 'none'"
        return "frame-ancestors " + " ".join(policy.origins)
    if not policy.enabled:
        return "frame-ancestors 'none'"
    if policy.mode == "any_https":
        return "frame-ancestors https:"
    return "frame-ancestors " + " ".join(policy.origins)
