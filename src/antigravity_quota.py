"""Antigravity quota policy. No network calls, credentials or response bodies here."""
import copy
import json
import math
import re
from datetime import datetime
from email.utils import parsedate_to_datetime

from src.storage._stats_common import normalize_antigravity_cooldown_key as group_for

GROUPS = ("claude-gpt-shared", "gemini-shared")
WEEK = 168 * 3600
GROUP_FILTERS = frozenset({
    "any_restricted", "gemini_restricted", "claude_gpt_restricted",
    "gemini_unrestricted", "claude_gpt_unrestricted", "all_unrestricted",
})
GROUP_FILTER_CAPABILITY = "antigravity.cooldown.group_filter"


class InvalidQuotaState(ValueError):
    pass


def finite_quota_deadline(value):
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        return False


def decode_quota_fields(quota_group_states, model_cooldowns):
    """Validate persisted policy without initializing generations or writing state."""
    def object_field(value):
        try:
            value = json.loads(value) if isinstance(value, str) else value
        except (ValueError, TypeError):
            raise InvalidQuotaState("invalid_quota_state") from None
        if value is None:
            return {}
        if not isinstance(value, dict):
            raise InvalidQuotaState("invalid_quota_state")
        return copy.deepcopy(value)

    states = object_field(quota_group_states)
    cooldowns = object_field(model_cooldowns)
    if any(not finite_quota_deadline(d) for d in cooldowns.values()):
        raise InvalidQuotaState("invalid_quota_cooldown")
    for state in states.values():
        if (not isinstance(state, dict) or state.get("state") not in ("blocked_unknown", "manual_override")
                or type(state.get("revision")) is not int or state["revision"] < 1):
            raise InvalidQuotaState("invalid_quota_state")
    return states, cooldowns


def quota_summary(model_cooldowns, quota_group_states, now):
    """Read-only group restrictions, using the same validation as final admission."""
    try:
        states, cooldowns = decode_quota_fields(quota_group_states, model_cooldowns)
    except InvalidQuotaState:
        return {
            "quota_groups": {group: {"cooldownUntil": 0, "blockedUnknown": False, "restricted": True}
                             for group in GROUPS},
            "quota_state_invalid": True,
        }
    groups = set(GROUPS) | set(states)
    groups.update(group_for(model) for model in cooldowns)
    deadlines = {group: 0 for group in groups}
    for model, until in cooldowns.items():
        if until > now:
            group = group_for(model)
            deadlines[group] = max(deadlines[group], until)
    result = {}
    for group in sorted(groups, key=str):
        blocked = states.get(group, {}).get("state") == "blocked_unknown"
        result[group] = {"cooldownUntil": deadlines[group], "blockedUnknown": blocked,
                         "restricted": blocked or deadlines[group] > now}
    return {"quota_groups": result, "quota_state_invalid": False}


def matches_quota_filter(summary, value):
    if value not in GROUP_FILTERS:
        raise ValueError("invalid Antigravity quota group filter")
    groups = summary["quota_groups"]
    if value in {"any_restricted", "all_unrestricted"}:
        restricted = any(group["restricted"] for group in groups.values())
        return restricted if value == "any_restricted" else not restricted
    group = "gemini-shared" if value.startswith("gemini_") else "claude-gpt-shared"
    restricted = groups[group]["restricted"]
    return restricted if value.endswith("_restricted") else not restricted


def empty_quota_stats():
    return {key: 0 for key in ("quota_restricted", "quota_unrestricted", "quota_blocked_unknown", "quota_state_invalid", "quota_next_expiry")}


def observe_quota_expiry(stats, summary):
    """Earliest upcoming group expiry, including candidates excluded by a filter."""
    deadlines = [state["cooldownUntil"] for state in summary["quota_groups"].values() if state["cooldownUntil"] > 0]
    if deadlines:
        stats["quota_next_expiry"] = min(deadlines + ([stats["quota_next_expiry"]] if stats["quota_next_expiry"] else []))


def count_quota_summary(stats, summary):
    """Count once per enabled credential, independently of list filters."""
    stats["quota_restricted" if matches_quota_filter(summary, "any_restricted") else "quota_unrestricted"] += 1
    stats["quota_blocked_unknown"] += int(any(group["blockedUnknown"] for group in summary["quota_groups"].values()))
    stats["quota_state_invalid"] += int(summary["quota_state_invalid"])
    observe_quota_expiry(stats, summary)


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
