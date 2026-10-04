"""Authoritative, dedicated-only model routing configuration.

Imports are inert. Runtime operations require an already initialized adapter;
no route read initializes storage, refreshes credentials, or fetches a catalog.
"""

import asyncio
import hashlib
import json
from collections import OrderedDict
from dataclasses import replace
from typing import Any

from .types import (
    CHANNELS, CompileResult, ParsedRouteTable, RoutingConfigReadError,
    RoutingConfigSnapshot, RoutingPolicySnapshot, ValidationIssue, thaw,
)

CONFIG_KEY = "model_routing"
_MISSING = object()
_CACHE_LIMIT = 128
_compiled_cache: OrderedDict[tuple[str, str, str], CompileResult] = OrderedDict()
_save_lock = asyncio.Lock()


class RoutingConfigValidationError(ValueError):
    def __init__(self, issues: tuple[ValidationIssue, ...]) -> None:
        self.issues = issues
        super().__init__("Invalid model routing configuration.")


class RoutingConfigWriteError(RuntimeError):
    def __init__(self) -> None:
        super().__init__("Model routing configuration could not be saved.")


def config_digest(exists: bool, raw_value: Any) -> str:
    """Hash the authoritative value and presence; never a backend or target log."""
    canonical = json.dumps(
        {"exists": exists, "value": thaw(raw_value) if exists else None},
        sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _get_adapter():
    # Do not call get_storage_adapter(): its cold path initializes credentials.
    from src.storage_adapter import _storage_adapter

    if _storage_adapter is None or not _storage_adapter._initialized:
        raise RoutingConfigReadError()
    return _storage_adapter


def _policy() -> RoutingPolicySnapshot:
    from .policy import build_policy_snapshot

    return build_policy_snapshot()


def _parse(raw_value: Any) -> ParsedRouteTable:
    from .compiler import parse_route_table

    return parse_route_table(raw_value)


def _compile(channel, parsed_table, policy_snapshot) -> CompileResult:
    from .compiler import compile_channel

    return compile_channel(channel, parsed_table, policy_snapshot)


def _validate(parsed_table, policy_snapshot) -> tuple[ValidationIssue, ...]:
    from .compiler import validate_table

    return validate_table(parsed_table, policy_snapshot)


def _compile_snapshot(exists, raw_value, policy_snapshot) -> RoutingConfigSnapshot:
    digest = config_digest(exists, raw_value)
    table = raw_value if exists else {"routes": []}
    parsed = _parse(table)
    channels = {}
    for channel in CHANNELS:
        key = (channel, digest, policy_snapshot.digest)
        if key in _compiled_cache:
            result = _compiled_cache[key]
            _compiled_cache.move_to_end(key)
        else:
            result = _compile(channel, parsed, policy_snapshot)
            if result.compiled is not None:
                if result.compiled.channel != channel or result.compiled.policy_digest != policy_snapshot.digest:
                    raise RoutingConfigReadError()
                # A pure compiler cannot know whether a backend key existed.
                # Runtime contexts must carry the same authoritative digest
                # as the fresh snapshot and the read-only preflight report.
                result = replace(result, compiled=replace(result.compiled, config_digest=digest))
            _compiled_cache[key] = result
            if len(_compiled_cache) > _CACHE_LIMIT:
                _compiled_cache.popitem(last=False)
        channels[channel] = result
    return RoutingConfigSnapshot(exists, table, digest, channels)


async def _read_snapshot(policy_snapshot) -> RoutingConfigSnapshot:
    try:
        adapter = _get_adapter()
        value = await adapter.get_config_fresh(CONFIG_KEY, _MISSING)
        return _compile_snapshot(value is not _MISSING, None if value is _MISSING else value, policy_snapshot)
    except asyncio.CancelledError:
        raise
    except Exception:
        raise RoutingConfigReadError() from None


async def read_routing_config_fresh() -> RoutingConfigSnapshot:
    """Read one current value and compile each channel with the current policy."""
    try:
        policy_snapshot = _policy()
    except Exception:
        raise RoutingConfigReadError() from None
    return await _read_snapshot(policy_snapshot)


async def load_channel_routes(channel, policy_snapshot) -> CompileResult:
    if channel not in CHANNELS:
        raise ValueError("Unsupported model routing channel.")
    snapshot = await _read_snapshot(policy_snapshot)
    return snapshot.channels[channel]


async def _settled_write(adapter, table) -> bool:
    """Keep tracking a dispatched commit even if its request is cancelled.

    Motor executes writes in a thread; cancelling its await cannot stop that
    commit. Shield the operation and hold the save lock until it settles, so a
    later accepted write cannot be overtaken by an abandoned earlier write.
    """
    task = asyncio.create_task(adapter.set_config(CONFIG_KEY, table))
    cancelled = False
    while True:
        try:
            result = await asyncio.shield(task)
            break
        except asyncio.CancelledError:
            if task.cancelled():
                raise
            cancelled = True
        except Exception:
            if cancelled:
                raise asyncio.CancelledError() from None
            raise
    if cancelled:
        raise asyncio.CancelledError()
    return result


async def save_routing_config(parsed_table, policy_snapshot) -> RoutingConfigSnapshot:
    """Validate the complete table, then commit it as one atomic backend key."""
    issues = tuple(_validate(parsed_table, policy_snapshot))
    if issues:
        raise RoutingConfigValidationError(issues)
    # A parser failure must never be silently reduced to its valid rows, even
    # if a future compiler accidentally fails to propagate parse issues.
    if parsed_table.global_error or parsed_table.issues:
        raise RoutingConfigValidationError(tuple(parsed_table.issues) or (
            ValidationIssue(None, None, None, "INVALID_STRUCTURE"),
        ))
    table = {"routes": [
        {"channel": row.channel, "public_name": row.public_name,
         "upstream_name": row.upstream_name, "enabled": row.enabled}
        for row in parsed_table.valid_rows
    ]}
    candidate = _compile_snapshot(True, table, policy_snapshot)
    compile_issues = tuple(issue for result in candidate.channels.values() for issue in result.issues)
    if compile_issues or any(not result.valid for result in candidate.channels.values()):
        raise RoutingConfigValidationError(compile_issues or (
            ValidationIssue(None, None, None, "AMBIGUOUS_COMPATIBILITY"),
        ))
    # Serialize accepted writes in this process. Other processes remain last
    # committed writer wins; every load bypasses their memory/Redis caches.
    async with _save_lock:
        try:
            adapter = _get_adapter()
            if not await _settled_write(adapter, table):
                raise RoutingConfigWriteError()
        except asyncio.CancelledError:
            raise
        except Exception:
            raise RoutingConfigWriteError() from None
        return await _read_snapshot(policy_snapshot)
