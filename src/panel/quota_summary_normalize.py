"""Parse only quota group/bucket display fields; never return upstream objects."""
import math
import re
from datetime import datetime, timezone

from .quota_summary_models import QuotaSummary, QuotaSummaryBucket, QuotaSummaryGroup

SOURCES = {
    "antigravity": "antigravity_quota_summary",
    "geminicli": "geminicli_retrieve_user_quota",
}
GROUPS = ("groups", "quotaGroups", "quota_groups")
BUCKETS = ("buckets", "quotaBuckets", "quota_buckets")
WINDOWS = ("window", "windowType", "window_type", "quotaWindow", "quota_window")
SECOND_WINDOWS = ("windowDurationSeconds", "window_duration_seconds",
                  "durationSeconds", "duration_seconds")


def utc_now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def first(data, keys):
    return next((data[key] for key in keys if key in data), None)


def text(value, limit=240):
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not value or len(value) > limit or any(ord(char) < 32 for char in value):
        return None
    return value


def fraction(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, str):
        value = value.strip()
        percent = value.endswith("%")
        try:
            value = float(value[:-1] if percent else value)
            if percent:
                value /= 100
        except (ValueError, OverflowError):
            return None
    if not isinstance(value, (float, int)):
        return None
    try:
        return float(value) if math.isfinite(value) and 0 <= value <= 1 else None
    except (OverflowError, TypeError):
        return None


def utc_timestamp(value):
    # A timezone is required. No local timezone or reset-window inference.
    value = text(value, 80)
    if value is None:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            return None
        return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    except (ValueError, OverflowError):
        return None


def explicit_window(data, mode):
    value = first(data, WINDOWS)
    if isinstance(value, dict):
        value = first(value, ("type", "window", "windowType", "window_type"))
    raw = text(value, 80)
    normalized = re.sub(r"[\s_-]+", "", raw.lower()) if raw else ""
    names = {
        "5h": "5h", "fivehour": "5h", "fivehours": "5h",
        "week": "weekly", "weekly": "weekly",
        "day": "daily", "daily": "daily",
        "month": "monthly", "monthly": "monthly",
    }
    if raw is not None or mode == "antigravity":
        return raw, names.get(normalized, "unknown")
    # Only GeminiCLI fields whose names explicitly say seconds have numeric
    # duration semantics. Generic duration/period fields, reset deltas, labels
    # and tokenType cannot create five-hour or weekly windows.
    seconds = first(data, SECOND_WINDOWS)
    if isinstance(seconds, bool) or not isinstance(seconds, (str, int, float)):
        return None, "unknown"
    try:
        number = float(seconds)
        raw = text(str(seconds), 80)
        if math.isfinite(number) and number.is_integer():
            return raw, {18000: "5h", 604800: "weekly", 86400: "daily"}.get(int(number), "unknown")
    except (ValueError, OverflowError):
        pass
    return raw, "unknown"


def bucket(data, fallback_id, mode):
    identifier = text(first(data, ("bucketId", "bucket_id", "id", "name"))) or fallback_id
    raw_window, window = explicit_window(data, mode)
    name = text(first(data, ("displayName", "display_name"))) or text(data.get("description")) or raw_window or identifier
    remaining = fraction(first(data, ("remainingFraction", "remaining_fraction")))
    reset_raw = first(data, ("resetTime", "reset_time", "resetAt", "reset_at"))
    reset = utc_timestamp(reset_raw)
    return QuotaSummaryBucket(
        bucket_id=identifier, display_name=name, raw_window=raw_window, window=window,
        remaining_fraction=remaining, reset_at=reset,
    ), remaining is None or window == "unknown" or reset is None


def normalize_summary(payload, mode, *, captured_at=None, upstream_status=200):
    """Retain every returned bucket, including unknown windows and missing values."""
    metadata = dict(source=SOURCES[mode], captured_at=captured_at or utc_now(), upstream_status=upstream_status)
    if not isinstance(payload, dict) or "error" in payload:
        return QuotaSummary(status="error", reason="invalid_upstream_response", **metadata)
    groups, incomplete = [], False
    if mode == "antigravity":
        raw_groups = first(payload, GROUPS)
        if not isinstance(raw_groups, list):
            return QuotaSummary(status="unknown", reason="unrecognized_quota_summary", **metadata)
        for index, raw in enumerate(raw_groups):
            if not isinstance(raw, dict):
                incomplete = True
                continue
            identifier = text(first(raw, ("groupId", "group_id", "id", "name"))) or f"group-{index + 1}"
            group = QuotaSummaryGroup(
                group_id=identifier,
                display_name=text(first(raw, ("displayName", "display_name"))) or identifier,
                description=text(raw.get("description"), 1000),
            )
            raw_buckets = first(raw, BUCKETS)
            if not isinstance(raw_buckets, list):
                incomplete = True
                raw_buckets = []
            for position, item in enumerate(raw_buckets):
                if not isinstance(item, dict):
                    incomplete = True
                    continue
                parsed, partial = bucket(item, f"{identifier}-bucket-{position + 1}", mode)
                group.buckets.append(parsed)
                incomplete |= partial
            incomplete |= not bool(group.buckets)
            groups.append(group)
    else:
        raw_buckets = first(payload, BUCKETS)
        if not isinstance(raw_buckets, list):
            return QuotaSummary(status="unknown", reason="unrecognized_quota_summary", **metadata)
        by_id = {}
        for position, raw in enumerate(raw_buckets):
            if not isinstance(raw, dict):
                incomplete = True
                continue
            model = text(first(raw, ("modelId", "model_id")))
            identifier = model or "quota"
            if identifier not in by_id:
                by_id[identifier] = QuotaSummaryGroup(group_id=identifier, display_name=identifier)
                groups.append(by_id[identifier])
            token_type = text(first(raw, ("tokenType", "token_type")))
            parsed, partial = bucket(raw, f"{identifier}:{token_type or 'bucket'}:{position + 1}", mode)
            by_id[identifier].buckets.append(parsed)
            incomplete |= partial or model is None
    if not any(group.buckets for group in groups):
        return QuotaSummary(status="unknown", reason="empty_quota_summary", groups=groups, **metadata)
    return QuotaSummary(status="partial" if incomplete else "available",
                        reason="incomplete_quota_summary" if incomplete else None, groups=groups, **metadata)
