"""
公共统计工具 — 模型家族归一化 & 日期工具

从 psql_manager.py 提取，供 SQLite / PostgreSQL / MongoDB 等后端共用。
"""

from datetime import datetime, timedelta, timezone
from typing import Optional


def _today_beijing_str() -> str:
    """返回当前北京时间 yyyy-mm-dd。"""
    return (datetime.now(timezone.utc) + timedelta(hours=8)).strftime("%Y-%m-%d")


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
