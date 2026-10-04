"""Safe JSON preflight: ``python -m src.model_routing.preflight``.

The real candidate compiler is loaded lazily from this checkout. Unit tests may
inject a compiler, but such tests do not constitute candidate-policy acceptance.
"""

from __future__ import annotations

import asyncio
import importlib
import json
import re
import sys
from typing import Any, Mapping

from .readonly import read_routing_config_readonly
from .types import CHANNELS, RoutingConfigReadError, ValidationIssue, thaw

_REASONS = frozenset({
    "DUPLICATE_PUBLIC_NAME", "PUBLIC_ID_COLLISION", "PROTECTED_ENTRY_CAPTURE",
    "UNSUPPORTED_CHANNEL", "INVALID_STRUCTURE", "INVALID_FIELD_TYPE", "UNKNOWN_FIELD",
    "INVALID_NAME", "RESERVED_SUFFIX", "INVALID_IDENTITY_ROUTE", "AMBIGUOUS_COMPATIBILITY",
    "AMBIGUOUS_TARGET_NAME", "UNSTABLE_TARGET_DISPATCH",
    "BACKEND_READ_FAILED", "CANDIDATE_COMPILER_UNAVAILABLE", "CANDIDATE_VALIDATION_FAILED",
})
_FIELDS = frozenset({"routes", "channel", "public_name", "upstream_name", "enabled"})


def _safe_issue(issue: ValidationIssue) -> dict[str, Any]:
    """Do not echo free-text compiler diagnostics or untrusted field values."""
    return {
        "channel": issue.channel if issue.channel in CHANNELS else None,
        "row": issue.row if type(issue.row) is int and issue.row >= 0 else None,
        "field": issue.field if issue.field in _FIELDS else None,
        "reason": issue.reason if issue.reason in _REASONS else "AMBIGUOUS_COMPATIBILITY",
        "related_rows": [row for row in issue.related_rows if type(row) is int and row >= 0],
        "message": "Invalid model routing configuration.",
    }


def _failure(reason: str, *, backend_digest: str | None = None, config_digest: str | None = None, policy_digest: str | None = None) -> dict[str, Any]:
    issue = _safe_issue(ValidationIssue(None, None, None, reason))
    return {
        "backend_identity_digest": backend_digest,
        "config_digest": config_digest,
        "policy_digest": policy_digest,
        "validation": {channel: {"valid": False, "issues": [dict(issue)]} for channel in CHANNELS},
    }


def _candidate_modules() -> tuple[Any, Any]:
    return (
        importlib.import_module("src.model_routing.compiler"),
        importlib.import_module("src.model_routing.policy"),
    )


async def run_preflight(environment: Mapping[str, str] | None = None) -> tuple[dict[str, Any], int]:
    """Exit 0 validates the snapshot; it does not authorize an online cutover."""
    try:
        read = await read_routing_config_readonly(environment)
    except RoutingConfigReadError:
        return _failure("BACKEND_READ_FAILED"), 3

    base = {"backend_digest": read.backend_identity_digest, "config_digest": read.snapshot.digest}
    try:
        compiler, policy_module = _candidate_modules()
    except Exception:
        return _failure("CANDIDATE_COMPILER_UNAVAILABLE", **base), 2
    policy_digest: str | None = None
    try:
        policy = policy_module.build_policy_snapshot()
        if not isinstance(policy.digest, str) or not re.fullmatch(r"[0-9a-f]{64}", policy.digest):
            raise ValueError
        policy_digest = policy.digest
        parsed = compiler.parse_route_table(thaw(read.snapshot.raw_table))
        validation: dict[str, Any] = {}
        for channel in CHANNELS:
            result = compiler.compile_channel(channel, parsed, policy)
            issues = tuple(result.issues)
            valid = bool(result.valid) and not parsed.global_error
            if not valid and not issues:
                issues = (ValidationIssue(channel, None, None, "AMBIGUOUS_COMPATIBILITY"),)
            validation[channel] = {"valid": valid, "issues": [_safe_issue(issue) for issue in issues]}
        report = {
            "backend_identity_digest": read.backend_identity_digest,
            "config_digest": read.snapshot.digest,
            "policy_digest": policy_digest,
            "validation": validation,
        }
        return report, 0 if all(item["valid"] for item in validation.values()) else 2
    except asyncio.CancelledError:
        raise
    except Exception:
        return _failure("CANDIDATE_VALIDATION_FAILED", policy_digest=policy_digest, **base), 2


def main(argv: list[str] | None = None) -> int:
    # Reject every command-line parameter without printing it. Backend scope
    # comes only from the existing process environment, never URI/key arguments.
    args = sys.argv[1:] if argv is None else argv
    if args:
        report, code = _failure("INVALID_STRUCTURE"), 2
    else:
        try:
            report, code = asyncio.run(run_preflight())
        except (Exception, KeyboardInterrupt):
            report, code = _failure("BACKEND_READ_FAILED"), 3
    print(json.dumps(report, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
