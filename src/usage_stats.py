"""
凭证使用统计模块 — 基于 Redis 的 per-credential per-model 调用计数

Redis Key 格式:
  gcli:{server}:stats:{mode}:{cred}:{model}:{counter}
  counter ∈ {total, success, fail}

TTL 与每个模型的 resetTime 对齐（通过 set_stats_ttl 在查询额度时更新），
首次写入时默认 TTL = 24h。
"""

import time
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from log import log


def _escape_key_part(name: str) -> str:
    """转义 Redis key 中可能包含的冒号和点"""
    return name.replace(":", "_").replace(".", "-")


async def _get_redis():
    """
    复用 MySQL Manager / MongoDB Manager 中已有的 Redis 实例。
    如果存储后端没有 Redis 或 Redis 未启用，返回 None。
    """
    try:
        from src.storage_adapter import _storage_adapter
        if _storage_adapter and _storage_adapter._initialized:
            backend = _storage_adapter._backend
            if getattr(backend, '_redis_enabled', False) and getattr(backend, '_redis', None):
                return backend._redis
    except Exception:
        pass
    return None


def _get_server_name() -> str:
    """获取当前 server_name（与存储后端一致）"""
    import os
    return os.getenv("GCLI_SERVER_NAME", "default")


def _stat_key(server: str, mode: str, cred: str, model: str, counter: str) -> str:
    """构建统计 Redis key"""
    return f"gcli:{server}:stats:{mode}:{_escape_key_part(cred)}:{_escape_key_part(model)}:{counter}"


# ==================== 写入 ====================

async def record_usage(
    credential_name: str,
    model_name: Optional[str],
    success: bool,
    mode: str = "geminicli",
) -> None:
    """
    记录一次 API 调用（fire-and-forget，异常静默）。

    - INCRBY total
    - INCRBY success / fail
    - 首次写入时设置默认 TTL = 24h
    """
    if not model_name:
        return

    redis = await _get_redis()
    if redis is None:
        return

    try:
        server = _get_server_name()
        key_total = _stat_key(server, mode, credential_name, model_name, "total")
        key_result = _stat_key(server, mode, credential_name, model_name, "success" if success else "fail")

        pipe = redis.pipeline()
        pipe.incr(key_total)
        pipe.incr(key_result)
        results = await pipe.execute()

        # 如果 total 是 1（首次写入），设置默认 TTL = 24h
        if results[0] == 1:
            default_ttl = 86400  # 24h
            pipe2 = redis.pipeline()
            pipe2.expire(key_total, default_ttl)
            pipe2.expire(key_result, default_ttl)
            await pipe2.execute()

    except Exception as e:
        log.warning(f"[USAGE_STATS] record_usage error: {e}")


async def set_stats_ttl(
    credential_name: str,
    model_name: str,
    reset_time_raw: str,
    mode: str = "geminicli",
) -> None:
    """
    根据模型的 resetTimeRaw（ISO 8601 UTC）更新统计 key 的 TTL。
    在查询额度信息时调用。
    """
    redis = await _get_redis()
    if redis is None:
        return

    try:
        # 解析 resetTime
        utc_dt = datetime.fromisoformat(reset_time_raw.replace("Z", "+00:00"))
        ttl = int(utc_dt.timestamp() - time.time())
        if ttl <= 0:
            return  # 已过期，等待 Redis 自然过期或下一次重置

        server = _get_server_name()
        counters = ("total", "success", "fail")
        pipe = redis.pipeline()
        for counter in counters:
            key = _stat_key(server, mode, credential_name, model_name, counter)
            pipe.expire(key, ttl)
        await pipe.execute()

    except Exception as e:
        log.warning(f"[USAGE_STATS] set_stats_ttl error: {e}")


# ==================== 读取 ====================

async def get_credential_stats(
    credential_name: str,
    mode: str = "geminicli",
) -> Dict[str, Dict[str, int]]:
    """
    返回该凭证所有模型的统计快照。

    Returns:
        {
            "gemini-2.5-flash": {"total": 10, "success": 9, "fail": 1},
            "gemini-2.5-pro":   {"total": 5,  "success": 5, "fail": 0},
        }
    """
    redis = await _get_redis()
    if redis is None:
        return {}

    try:
        server = _get_server_name()
        prefix = f"gcli:{server}:stats:{mode}:{_escape_key_part(credential_name)}:"

        # SCAN 找到所有相关 key
        keys = []
        cursor = 0
        while True:
            cursor, batch = await redis.scan(cursor, match=prefix + "*", count=500)
            keys.extend(batch)
            if cursor == 0:
                break

        if not keys:
            return {}

        # 解析 key 结构: prefix + {model}:{counter}
        model_stats: Dict[str, Dict[str, int]] = {}
        # 批量 GET
        values = await redis.mget(*keys)

        for key, value in zip(keys, values):
            suffix = key[len(prefix):]  # e.g. "gemini-2-5-flash:total"
            parts = suffix.rsplit(":", 1)
            if len(parts) != 2:
                continue
            model_escaped, counter = parts
            if counter not in ("total", "success", "fail"):
                continue

            if model_escaped not in model_stats:
                model_stats[model_escaped] = {"total": 0, "success": 0, "fail": 0}
            model_stats[model_escaped][counter] = int(value or 0)

        # 将 escaped model name 还原（将 - 替换回 .）
        # 但这有歧义（gemini-2.5-flash 中的 - 和 . 都会被转义）
        # 所以我们直接返回 escaped 名，在比较时做 escape 匹配
        return model_stats

    except Exception as e:
        log.warning(f"[USAGE_STATS] get_credential_stats error: {e}")
        return {}
