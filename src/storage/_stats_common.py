"""
公共统计工具 — 模型家族归一化 & 日期工具

从 psql_manager.py 提取，供 SQLite / PostgreSQL / MongoDB 等后端共用。
"""

import json
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping, Optional, Tuple


def _today_beijing_str() -> str:
    """返回当前北京时间 yyyy-mm-dd。"""
    return (datetime.now(timezone.utc) + timedelta(hours=8)).strftime("%Y-%m-%d")


def utc_iso8601(timestamp: float) -> str:
    """Render a Unix timestamp as a stable UTC ISO-8601 value."""
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat().replace("+00:00", "Z")


def active_model_cooldowns(
    value: Any, current_time: Optional[float] = None
) -> Tuple[dict[Any, float], int]:
    """Return active numeric cooldowns and the number of malformed values ignored."""
    if value in (None, "", b""):
        return {}, 0
    if isinstance(value, bytes):
        try:
            value = value.decode("utf-8")
        except UnicodeDecodeError:
            return {}, 1
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (TypeError, ValueError):
            return {}, 1
    if not isinstance(value, dict):
        return {}, 1

    now = time.time() if current_time is None else current_time
    active: dict[Any, float] = {}
    invalid_count = 0
    for model_name, deadline in value.items():
        if isinstance(deadline, bool) or not isinstance(deadline, (int, float)):
            invalid_count += 1
            continue
        if deadline > now:
            active[model_name] = deadline
    return active, invalid_count


def has_active_model_cooldown(value: Any, current_time: Optional[float] = None) -> bool:
    """Return whether a persisted cooldown mapping contains an active deadline."""
    active, _ = active_model_cooldowns(value, current_time)
    return bool(active)


def normalize_antigravity_cooldown_key(model_name: str) -> str:
    """Return the effective Antigravity cooldown family for a model/key."""
    model = str(model_name or "").strip().lower()
    if model == "gemini-shared" or model.startswith(
        ("gemini-3.1-pro", "gemini-3.5-flash", "gemini-3.6-flash", "gemini-3.7-flash")
    ):
        return "gemini-shared"
    if model == "claude-gpt-shared" or model.startswith(("claude-", "gpt-oss-")):
        return "claude-gpt-shared"
    return model


def get_antigravity_cooldown_until(
    cooldowns: Mapping[str, Any], model_name: str
) -> Optional[float]:
    """Return the latest deadline affecting a model, including legacy family keys."""
    family = normalize_antigravity_cooldown_key(model_name)
    deadlines = []
    for key, value in (cooldowns or {}).items():
        if normalize_antigravity_cooldown_key(key) != family:
            continue
        if isinstance(value, bool):
            continue
        try:
            deadlines.append(float(value))
        except (TypeError, ValueError):
            continue
    return max(deadlines) if deadlines else None


def clear_antigravity_cooldown_family(
    cooldowns: Mapping[str, Any], model_name: str
) -> dict[str, Any]:
    """Return a copy with every concrete/legacy key in the model family removed."""
    family = normalize_antigravity_cooldown_key(model_name)
    return {
        key: value
        for key, value in (cooldowns or {}).items()
        if normalize_antigravity_cooldown_key(key) != family
    }


def cooldowns_affect_antigravity_family(
    cooldowns: Mapping[str, Any], family: str
) -> bool:
    """Whether active cooldown keys affect the panel's Pro/Flash family filter."""
    family = str(family or "").strip().lower()
    for key in (cooldowns or {}):
        normalized = normalize_antigravity_cooldown_key(key)
        key_lower = str(key).lower()
        if family == "pro" and ("pro" in key_lower or normalized == "gemini-shared"):
            return True
        if family == "flash" and ("flash" in key_lower or normalized == "gemini-shared"):
            return True
    return False


# 模型家族归一化：各种变种（-search / -thinking / -lite / preview / pro / flash 等）
# 会被映射到其基础系列。按"更特殊在前"的顺序匹配。
MODEL_FAMILY_RULES = [
    # 3.5 系（Antigravity 后端别名：低/中/高 thinking budget 的 Gemini 3.5 Flash）
    ("gemini-3.5-flash",              ("3.5-flash",      "3.5-flash")),
    ("gemini-3-flash-agent",          ("3.5-flash",      "3.5-flash-high")),
    # 3.1 系
    ("gemini-3.1-flash-lite-preview", ("3.1-flash-lite", "3.1-flash-lite-preview")),
    ("gemini-3.1-flash-lite",         ("3.1-flash-lite", "3.1-flash-lite")),
    ("gemini-3.1-flash-image",        ("3.1-flash-image","3.1-flash-image")),
    ("gemini-3.1-pro-preview",        ("3.1-pro",        "3.1-pro-preview")),
    ("gemini-3.1-pro",                ("3.1-pro",        "3.1-pro")),
    ("gemini-3.1-flash",              ("3.1-flash",      "3.1-flash")),
    # 3.0 系
    ("gemini-3-flash-preview",        ("3-flash",        "3-flash-preview")),
    ("gemini-3-pro-preview",          ("3-pro",          "3-pro-preview")),
    ("gemini-3-flash",                ("3-flash",        "3-flash")),
    ("gemini-3-pro",                  ("3-pro",          "3-pro")),
    # 2.5 系
    ("gemini-2.5-flash-lite",         ("2.5-flash-lite", "2.5-flash-lite")),
    ("gemini-2.5-flash",              ("2.5-flash",      "2.5-flash")),
    ("gemini-2.5-pro",                ("2.5-pro",        "2.5-pro")),
    # 2.0 / 其他常见家族（预留，避免丢失）
    ("gemini-2.0-flash",              ("2.0-flash",      "2.0-flash")),
    ("gemini-2.0-pro",                ("2.0-pro",        "2.0-pro")),
    # Antigravity 专用别名（无版本号 agent 后缀）
    ("gemini-pro-agent",              ("pro-agent",      "pro-agent")),
    ("claude-opus-4-6",               ("claude-opus-4-6","claude-opus-4-6")),
    ("claude-sonnet-4-6",             ("claude-sonnet-4-6","claude-sonnet-4-6")),
    ("gpt-oss-120b",                  ("gpt-oss-120b",   "gpt-oss-120b")),
]


def normalize_model_family(model_name: Optional[str]) -> str:
    """将模型名归一化为家族 key。

    例如 'gemini-2.5-pro-search' / 'gemini-2.5-pro-thinking' 均归为 '2.5-pro'。
    未识别的返回 'other'。空返回 'unknown'。
    """
    if not model_name:
        return "unknown"
    name = str(model_name).strip().lower()
    # 剧本会传入带前缀 '流式抗截断/' 之类的，去掉
    if "/" in name:
        name = name.rsplit("/", 1)[-1]
    for prefix, (_short, family) in MODEL_FAMILY_RULES:
        if name.startswith(prefix):
            return family
    # 带 antigravity 名字、或未知型号
    return "other"


def normalize_logical_request_model_family(model_name: Optional[str]) -> Optional[str]:
    """Return a safe logical-request model family, or ``None`` for blank input.

    Logical-request metrics are deliberately more precise than the legacy
    attempt counters.  Unknown non-empty IDs remain visible after conservative
    sanitising; collapsing them into ``other`` or ``unknown`` hides useful
    capacity signals and can merge unrelated models.
    """
    if model_name is None:
        return None
    name = str(model_name).strip().lower()
    if not name:
        return None
    if "/" in name:
        name = name.rsplit("/", 1)[-1].strip()
    if not name:
        return None

    # Only persist printable, bounded identifiers.  This is also safe as a
    # document key when a non-SQL backend is used.
    cleaned = "".join(ch for ch in name if ch.isalnum() or ch in "._-")[:160]
    if not cleaned:
        return None

    # Keep each recent Gemini generation distinct.  More-specific rules must
    # precede broad prefixes.
    if cleaned.startswith("gemini-pro-agent"):
        return "3.1-pro"
    if cleaned.startswith("gemini-3.1-flash-lite-preview"):
        return "3.1-flash-lite-preview"
    if cleaned.startswith("gemini-3.1-flash-lite"):
        return "3.1-flash-lite"
    if cleaned.startswith("gemini-3.1-flash-image"):
        return "3.1-flash-image"
    if cleaned.startswith("gemini-3.1-pro"):
        return "3.1-pro"
    if cleaned.startswith("gemini-3-flash"):
        return "3-flash"
    for version in ("3.8", "3.7", "3.6", "3.5"):
        prefix = f"gemini-{version}-"
        if cleaned.startswith(prefix):
            if "pro" in cleaned:
                return f"{version}-pro"
            if "flash" in cleaned:
                return f"{version}-flash"
            return version
    if cleaned.startswith("claude-sonnet-4-6"):
        return "claude-sonnet-4-6"
    if cleaned.startswith("claude-opus-4-6"):
        return "claude-opus-4-6"
    if cleaned.startswith("gpt-oss-120b"):
        return "gpt-oss-120b"

    for prefix, (_short, family) in MODEL_FAMILY_RULES:
        if cleaned.startswith(prefix):
            return family
    return cleaned
