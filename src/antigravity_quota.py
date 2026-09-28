"""Antigravity quota policy. No network calls, credentials or response bodies here."""
import math
import re
from datetime import datetime
from email.utils import parsedate_to_datetime

from src.storage._stats_common import normalize_antigravity_cooldown_key as group_for

GROUPS = ("claude-gpt-shared", "gemini-shared")
WEEK = 168 * 3600


def valid_group(group):
    return (isinstance(group, str) and 0 < len(group) <= 200
            and all(ord(c) >= 32 for c in group) and group_for(group) == group)


def fraction(value):
    return value if type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 1 else None


def duration(value):
    """Strict, finite Google duration; never extract a duration from prose."""
    if not isinstance(value, str) or not re.fullmatch(r"(?:\s*\d+(?:\.\d+)?[smhd])+\s*", value, re.I):
        return None
    units = {"s": 1, "m": 60, "h": 3600, "d": 86400}
    total = sum(float(n) * units[u.lower()] for n, u in re.findall(r"(\d+(?:\.\d+)?)([smhd])", value, re.I))
    return total if math.isfinite(total) and total > 0 else None


def timestamp(value):
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return dt.timestamp() if dt.tzinfo else None
    except (AttributeError, TypeError, ValueError, OverflowError):
        return None


def rolling_week(reset, observation):
    deadline = timestamp(reset)
    if deadline is None:
        return False
    try:
        base = parsedate_to_datetime(observation.get("serverDate", ""))
        if base.tzinfo:
            return abs(deadline - base.timestamp() - WEEK) <= 60
    except (TypeError, ValueError, OverflowError):
        pass
    if observation.get("serverDate"):
        return False
    start, end = observation.get("sentAt"), observation.get("receivedAt")
    return (type(start) in (int, float) and type(end) in (int, float)
            and 0 <= end - start <= 30
            and end + WEEK - 60 <= deadline <= start + WEEK + 60)


def public_state(row):
    """Only protection state, never credential material."""
    result = {key: row[key] for key in ("quota_group_states", "quota_credential_generation", "model_cooldowns")}
    groups = set(GROUPS) | set(row["quota_group_states"])
    groups.update(group_for(model) for model in row["model_cooldowns"])
    result["quota_groups"] = {
        group: {"cooldownUntil": max([0] + [until for model, until in row["model_cooldowns"].items() if group_for(model) == group])}
        for group in groups
    }
    return result


def ticket(row, model, purpose, version=None):
    group = group_for(model)
    state = row["quota_group_states"].get(group, {})
    return {"generation": row["quota_credential_generation"], "group": group,
            "revision": state.get("revision", 0), "purpose": purpose, "credentialVersion": version,
            "state": state.get("state", "normal"), "quotaObservedAt": state.get("lastSeen"),
            "cooldownUntil": None}


def matches(row, admission):
    if not admission or admission.get("generation") != row["quota_credential_generation"]:
        return False
    group = admission.get("group")
    return row["quota_group_states"].get(group, {}).get("revision", 0) == admission.get("revision")


def observe_week(row, group, info, now):
    previous = row["quota_group_states"].get(group, {})
    row["quota_group_states"][group] = {
        **previous, "state": previous.get("state", "blocked_unknown"),
        "reason": previous.get("reason", "rolling_168h"),
        "firstSeen": previous.get("firstSeen", now), "lastSeen": now,
        "rawRemaining": fraction(info.get("remaining")), "observedReset": info.get("resetTimeRaw"),
        "revision": previous.get("revision", 0) + 1,
        "credentialGeneration": row["quota_credential_generation"],
    }
    # Observation must not invalidate a business admission after manual release.
    # Only policy transitions (release/reblock) change that group's revision.
    if previous:
        row["quota_group_states"][group]["revision"] = previous["revision"]
