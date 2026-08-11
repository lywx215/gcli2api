"""
MySQL 存储管理器
支持多 gcli2api 实例通过 server_name 共享同一数据库
"""

import asyncio
import json
import os
import random
import time
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse, parse_qs

import aiomysql

from log import log
from src.subscription_tiers import (
    default_tier_for_mode,
    required_tiers_for_geminicli_model,
    valid_tiers_for_mode,
)


class MySQLManager:
    """MySQL 数据库管理器"""

    # 状态字段常量
    STATE_FIELDS = {
        "error_codes",
        "error_messages",
        "disabled",
        "last_success",
        "user_email",
        "model_cooldowns",
        "preview",
        "tier",
        "tier_raw_id",
        "tier_raw_name",
        "tier_detected_at",
        "health_status",
        "quarantine_reason",
        "probe_stage",
        "next_probe_at",
        "last_health_check_at",
        "health_check_started_at",
        "health_state_version",
    }

    def __init__(self):
        self._pool: Optional[aiomysql.Pool] = None
        self._initialized = False
        self._lock = asyncio.Lock()

        # 多实例隔离用 server_name
        self._server_name = os.getenv("GCLI_SERVER_NAME", "default")

        # 内存配置缓存 - 初始化时加载一次
        self._config_cache: Dict[str, Any] = {}
        self._config_loaded = False

        # Redis 缓存（仅当 REDIS_URL 环境变量存在时启用）
        self._redis = None
        self._redis_enabled: bool = False

    @staticmethod
    def _parse_mysql_uri(uri: str) -> dict:
        """
        解析 MySQL URI 为连接参数

        支持格式:
          mysql://user:pass@host:port/dbname
          mysql+aiomysql://user:pass@host:port/dbname
          mysql+pymysql://user:pass@host:port/dbname
        """
        parsed = urlparse(uri)
        params = parse_qs(parsed.query)

        return {
            "host": parsed.hostname or "127.0.0.1",
            "port": parsed.port or 3306,
            "user": parsed.username or "root",
            "password": parsed.password or "",
            "db": parsed.path.lstrip("/") or "gcli2api",
            "charset": params.get("charset", ["utf8mb4"])[0],
        }

    async def initialize(self) -> None:
        """初始化 MySQL 连接池"""
        if self._initialized:
            return

        async with self._lock:
            if self._initialized:
                return

            try:
                mysql_uri = os.getenv("MYSQL_URI", "")
                if not mysql_uri:
                    raise ValueError("MYSQL_URI environment variable not set")

                conn_params = self._parse_mysql_uri(mysql_uri)

                self._pool = await aiomysql.create_pool(
                    host=conn_params["host"],
                    port=conn_params["port"],
                    user=conn_params["user"],
                    password=conn_params["password"],
                    db=conn_params["db"],
                    charset=conn_params["charset"],
                    autocommit=False,
                    minsize=2,
                    maxsize=10,
                )

                # 创建表和索引
                await self._create_tables()

                # 加载配置到内存
                await self._load_config_cache()

                self._initialized = True
                log.info(
                    f"MySQL storage initialized "
                    f"(host={conn_params['host']}:{conn_params['port']}, "
                    f"db={conn_params['db']}, server_name={self._server_name})"
                )

                # 尝试初始化 Redis（可选）
                await self._init_redis()

            except Exception as e:
                log.error(f"Error initializing MySQL: {e}")
                raise

    async def _create_tables(self):
        """创建数据库表和索引"""
        async with self._pool.acquire() as conn:
            async with conn.cursor() as cur:
                # geminicli 凭证表
                await cur.execute("""
                    CREATE TABLE IF NOT EXISTS gcli_credentials (
                        id INT AUTO_INCREMENT PRIMARY KEY,
                        server_name VARCHAR(64) NOT NULL DEFAULT 'default',
                        filename VARCHAR(255) NOT NULL,
                        credential_data LONGTEXT NOT NULL,

                        -- 状态字段
                        disabled TINYINT(1) DEFAULT 0,
                        error_codes TEXT,
                        error_messages LONGTEXT,
                        last_success DOUBLE,
                        user_email VARCHAR(255),

                        -- 模型级 CD 支持 (JSON)
                        model_cooldowns TEXT,

                        -- preview 状态 (只对 geminicli 有效)
                        preview TINYINT(1) DEFAULT 1,

                        -- tier 等级 (free/pro/ultra)
                        tier VARCHAR(32) DEFAULT 'unknown',
                        tier_raw_id VARCHAR(255),
                        tier_raw_name VARCHAR(255),
                        tier_detected_at BIGINT,

                        health_status VARCHAR(32) DEFAULT 'healthy',
                        quarantine_reason VARCHAR(255),
                        probe_stage INT DEFAULT 0,
                        next_probe_at DOUBLE,
                        last_health_check_at DOUBLE,
                        health_check_started_at DOUBLE,
                        health_state_version BIGINT DEFAULT 0,

                        -- 轮换相关
                        rotation_order INT DEFAULT 0,
                        call_count INT DEFAULT 0,

                        -- 时间戳
                        created_at DOUBLE,
                        updated_at DOUBLE,

                        UNIQUE KEY uk_server_filename (server_name, filename),
                        KEY idx_server_disabled (server_name, disabled),
                        KEY idx_server_disabled_preview (server_name, disabled, preview),
                        KEY idx_server_rotation (server_name, disabled, rotation_order),
                        KEY idx_server_email (server_name, user_email)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                """)

                # antigravity 凭证表
                await cur.execute("""
                    CREATE TABLE IF NOT EXISTS gcli_antigravity_credentials (
                        id INT AUTO_INCREMENT PRIMARY KEY,
                        server_name VARCHAR(64) NOT NULL DEFAULT 'default',
                        filename VARCHAR(255) NOT NULL,
                        credential_data LONGTEXT NOT NULL,

                        -- 状态字段
                        disabled TINYINT(1) DEFAULT 0,
                        error_codes TEXT,
                        error_messages LONGTEXT,
                        last_success DOUBLE,
                        user_email VARCHAR(255),

                        -- 模型级 CD 支持 (JSON)
                        model_cooldowns TEXT,

                        -- tier 等级 (free/pro/ultra)
                        tier VARCHAR(32) DEFAULT 'pro',

                        -- 轮换相关
                        rotation_order INT DEFAULT 0,
                        call_count INT DEFAULT 0,

                        -- 时间戳
                        created_at DOUBLE,
                        updated_at DOUBLE,

                        UNIQUE KEY uk_server_filename (server_name, filename),
                        KEY idx_server_disabled (server_name, disabled),
                        KEY idx_server_rotation (server_name, disabled, rotation_order),
                        KEY idx_server_email (server_name, user_email)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                """)

                # 配置表
                await cur.execute("""
                    CREATE TABLE IF NOT EXISTS gcli_config (
                        id INT AUTO_INCREMENT PRIMARY KEY,
                        server_name VARCHAR(64) NOT NULL DEFAULT 'default',
                        `key` VARCHAR(255) NOT NULL,
                        value TEXT NOT NULL,
                        updated_at DOUBLE,

                        UNIQUE KEY uk_server_key (server_name, `key`)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                """)

            await conn.commit()

            # 自动添加缺失的 tier 列（兼容旧表结构）
            await self._ensure_tier_column()
            await self._ensure_smart_429_columns()

            log.debug("MySQL tables and indexes created")

    async def _ensure_tier_column(self):
        """确保 tier 列存在（兼容旧表结构）"""
        for table, mode in (
            ("gcli_credentials", "geminicli"),
            ("gcli_antigravity_credentials", "antigravity"),
        ):
            try:
                async with self._pool.acquire() as conn:
                    async with conn.cursor() as cur:
                        tier_default = default_tier_for_mode(mode)
                        await cur.execute(f"""SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
                            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '{table}' AND COLUMN_NAME = 'tier'""")
                        if await cur.fetchone():
                            await cur.execute(
                                f"ALTER TABLE {table} MODIFY COLUMN tier VARCHAR(32) DEFAULT '{tier_default}'"
                            )
                        else:
                            await cur.execute(
                                f"ALTER TABLE {table} ADD COLUMN tier VARCHAR(32) DEFAULT '{tier_default}'"
                            )
                        if mode == "geminicli":
                            for name, definition in (
                                ("tier_raw_id", "VARCHAR(255)"),
                                ("tier_raw_name", "VARCHAR(255)"),
                                ("tier_detected_at", "BIGINT"),
                            ):
                                await cur.execute(f"""SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
                                    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '{table}' AND COLUMN_NAME = '{name}'""")
                                if not await cur.fetchone():
                                    await cur.execute(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")
                    await conn.commit()
            except Exception as e:
                log.warning(f"Failed to ensure tier columns in {table}: {e}")

    async def _ensure_smart_429_columns(self):
        definitions = {
            "health_status": "VARCHAR(32) DEFAULT 'healthy'",
            "quarantine_reason": "VARCHAR(255)",
            "probe_stage": "INT DEFAULT 0",
            "next_probe_at": "DOUBLE",
            "last_health_check_at": "DOUBLE",
            "health_check_started_at": "DOUBLE",
            "health_state_version": "BIGINT DEFAULT 0",
        }
        try:
            async with self._pool.acquire() as conn:
                async with conn.cursor() as cur:
                    for name, definition in definitions.items():
                        await cur.execute(
                            "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS "
                            "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gcli_credentials' "
                            "AND COLUMN_NAME = %s",
                            (name,),
                        )
                        if not await cur.fetchone():
                            await cur.execute(f"ALTER TABLE gcli_credentials ADD COLUMN {name} {definition}")
                await conn.commit()
        except Exception as exc:
            log.warning(f"Failed to ensure SMART 429 columns in gcli_credentials: {exc}")

    async def _load_config_cache(self):
        """加载配置到内存缓存（仅在初始化时调用一次）"""
        if self._config_loaded:
            return

        try:
            async with self._pool.acquire() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        "SELECT `key`, value FROM gcli_config WHERE server_name = %s",
                        (self._server_name,)
                    )
                    rows = await cur.fetchall()

            for key, value in rows:
                try:
                    self._config_cache[key] = json.loads(value)
                except json.JSONDecodeError:
                    self._config_cache[key] = value

            self._config_loaded = True
            log.debug(f"Loaded {len(self._config_cache)} config items into cache")

        except Exception as e:
            log.error(f"Error loading config cache: {e}")
            self._config_cache = {}

    async def close(self) -> None:
        """关闭连接池"""
        if self._pool:
            self._pool.close()
            await self._pool.wait_closed()
            self._pool = None
        self._initialized = False
        log.debug("MySQL storage closed")

    def _ensure_initialized(self):
        """确保已初始化"""
        if not self._initialized:
            raise RuntimeError("MySQL manager not initialized")

    def _get_table_name(self, mode: str) -> str:
        """根据 mode 获取对应的表名"""
        if mode == "antigravity":
            return "gcli_antigravity_credentials"
        elif mode == "geminicli":
            return "gcli_credentials"
        else:
            raise ValueError(f"Invalid mode: {mode}. Must be 'geminicli' or 'antigravity'")

    # ============ Redis 缓存（可选，仅当 REDIS_URL 存在时启用）============

    @staticmethod
    def _escape_model_name(model_name: str) -> str:
        """转义模型名中的特殊字符（用于 Redis key）"""
        return model_name.replace(".", "-")

    async def _init_redis(self) -> None:
        """初始化 Redis 连接并重建凭证池缓存（若 REDIS_URL 存在）"""
        redis_url = os.getenv("REDIS_URL")
        if not redis_url:
            return

        try:
            import redis.asyncio as aioredis  # type: ignore
        except ImportError:
            log.warning("redis package not installed, Redis cache disabled. Run: pip install redis")
            return

        try:
            self._redis = aioredis.from_url(redis_url, decode_responses=True)
            await self._redis.ping()
            self._redis_enabled = True
            log.info("Redis connected, rebuilding credential pool cache...")

            # 并行重建两个 mode 的缓存
            await asyncio.gather(
                self._rebuild_redis_cache("geminicli"),
                self._rebuild_redis_cache("antigravity"),
            )
            log.info("Redis credential pool cache ready")
        except Exception as e:
            log.warning(f"Redis init failed, falling back to MySQL-only mode: {e}")
            self._redis = None
            self._redis_enabled = False

    # ---- Redis key 工具 ----

    def _rk_avail(self, mode: str) -> str:
        """所有未禁用凭证的 Redis Set key"""
        return f"gcli:avail:{mode}"

    def _rk_preview(self, mode: str) -> str:
        """未禁用且 preview=True 的凭证 Redis Set key（仅 geminicli）"""
        return f"gcli:preview:{mode}"

    def _rk_tier(self, mode: str, tier: str) -> str:
        """按 tier 分桶的未禁用凭证 Redis Set key"""
        return f"gcli:tier:{mode}:{tier}"

    def _rk_cd(self, mode: str, filename: str, escaped_model: str) -> str:
        """模型冷却 Redis key（带 TTL）"""
        return f"gcli:cd:{mode}:{filename}:{escaped_model}"

    # ---- Redis 缓存维护 ----

    async def _rebuild_redis_cache(self, mode: str) -> None:
        """
        从 MySQL 重建指定 mode 的 Redis 凭证池缓存。
        使用临时 key + RENAME 原子替换
        """
        if not self._redis:
            return
        try:
            table_name = self._get_table_name(mode)
            async with self._pool.acquire() as conn:
                async with conn.cursor() as cur:
                    if mode == "geminicli":
                        await cur.execute(f"""
                            SELECT filename, disabled, preview, model_cooldowns, tier
                            FROM {table_name}
                            WHERE server_name = %s
                        """, (self._server_name,))
                    else:
                        await cur.execute(f"""
                            SELECT filename, disabled, 0, model_cooldowns, tier
                            FROM {table_name}
                            WHERE server_name = %s
                        """, (self._server_name,))
                    rows = await cur.fetchall()

            avail: List[str] = []
            preview: List[str] = []
            tier_buckets: Dict[str, List[str]] = {}
            cooldown_entries: List[tuple] = []  # (cd_key, ttl_seconds, value)
            current_time = time.time()

            for filename, disabled, is_preview, model_cooldowns_json, tier in rows:
                if not disabled:
                    avail.append(filename)
                    normalized_tier = tier or default_tier_for_mode(mode)
                    tier_buckets.setdefault(normalized_tier, []).append(filename)
                    if mode == "geminicli" and is_preview:
                        preview.append(filename)

                    # 收集未过期的模型冷却，重建 Redis TTL Key
                    model_cooldowns = json.loads(model_cooldowns_json or '{}')
                    for escaped_model, cooldown_until in model_cooldowns.items():
                        if isinstance(cooldown_until, (int, float)) and cooldown_until > current_time:
                            ttl = int(cooldown_until - current_time)
                            if ttl > 0:
                                cd_key = self._rk_cd(mode, filename, escaped_model)
                                cooldown_entries.append((cd_key, ttl, str(cooldown_until)))

            tmp_avail = self._rk_avail(mode) + ":tmp"
            tmp_preview = self._rk_preview(mode) + ":tmp"

            pipe = self._redis.pipeline()
            pipe.delete(tmp_avail)
            pipe.delete(tmp_preview)
            if avail:
                pipe.sadd(tmp_avail, *avail)
            if mode == "geminicli" and preview:
                pipe.sadd(tmp_preview, *preview)
            await pipe.execute()

            # RENAME 原子替换
            pipe2 = self._redis.pipeline()
            if avail:
                pipe2.rename(tmp_avail, self._rk_avail(mode))
            else:
                pipe2.delete(self._rk_avail(mode))
                pipe2.delete(tmp_avail)
            if mode == "geminicli":
                if preview:
                    pipe2.rename(tmp_preview, self._rk_preview(mode))
                else:
                    pipe2.delete(self._rk_preview(mode))
                    pipe2.delete(tmp_preview)
            await pipe2.execute()

            # Tier 分桶同样通过临时 key 原子替换。
            all_tiers = valid_tiers_for_mode(mode)
            tier_write_pipe = self._redis.pipeline()
            for tier in all_tiers:
                tier_key = self._rk_tier(mode, tier)
                tmp_tier_key = tier_key + ":tmp"
                tier_write_pipe.delete(tmp_tier_key)
                members = tier_buckets.get(tier, [])
                if members:
                    tier_write_pipe.sadd(tmp_tier_key, *members)
            await tier_write_pipe.execute()

            tier_swap_pipe = self._redis.pipeline()
            for tier in all_tiers:
                tier_key = self._rk_tier(mode, tier)
                tmp_tier_key = tier_key + ":tmp"
                members = tier_buckets.get(tier, [])
                if members:
                    tier_swap_pipe.rename(tmp_tier_key, tier_key)
                else:
                    tier_swap_pipe.delete(tier_key)
                    tier_swap_pipe.delete(tmp_tier_key)
            await tier_swap_pipe.execute()

            # 批量恢复未过期的模型冷却 TTL Key
            if cooldown_entries:
                pipe3 = self._redis.pipeline()
                for cd_key, ttl, value in cooldown_entries:
                    pipe3.setex(cd_key, ttl, value)
                await pipe3.execute()

            log.debug(
                f"Redis cache rebuilt [{mode}]: {len(avail)} avail, {len(preview)} preview, "
                f"tiers={{{', '.join(f'{t}:{len(tier_buckets.get(t, []))}' for t in all_tiers)}}}, "
                f"{len(cooldown_entries)} cooldown key(s) restored"
            )
        except Exception as e:
            log.warning(f"Redis rebuild cache error [{mode}]: {e}")

    async def _redis_add_cred(
        self, mode: str, filename: str, tier: Optional[str] = None, preview: bool = True
    ) -> None:
        """将凭证加入 Redis 可用池、Tier 分桶及 preview 分桶"""
        if not self._redis_enabled:
            return
        try:
            tier = tier or default_tier_for_mode(mode)
            pipe = self._redis.pipeline()
            pipe.sadd(self._rk_avail(mode), filename)
            pipe.sadd(self._rk_tier(mode, tier), filename)
            if mode == "geminicli" and preview:
                pipe.sadd(self._rk_preview(mode), filename)
            await pipe.execute()
        except Exception as e:
            log.warning(f"Redis add_cred error: {e}")

    async def _redis_remove_cred(self, mode: str, filename: str) -> None:
        """从 Redis 所有池中移除凭证"""
        if not self._redis_enabled:
            return
        try:
            pipe = self._redis.pipeline()
            pipe.srem(self._rk_avail(mode), filename)
            pipe.srem(self._rk_preview(mode), filename)
            for tier in valid_tiers_for_mode(mode):
                pipe.srem(self._rk_tier(mode, tier), filename)
            await pipe.execute()
        except Exception as e:
            log.warning(f"Redis remove_cred error: {e}")

    async def _redis_sync_cred(
        self,
        mode: str,
        filename: str,
        disabled: bool,
        tier: Optional[str] = None,
        preview: bool = True,
    ) -> None:
        """根据最新状态同步单个凭证在 Redis 中的集合成员"""
        if not self._redis_enabled:
            return
        try:
            tier = tier or default_tier_for_mode(mode)
            pipe = self._redis.pipeline()
            for known_tier in valid_tiers_for_mode(mode):
                pipe.srem(self._rk_tier(mode, known_tier), filename)
            if disabled:
                pipe.srem(self._rk_avail(mode), filename)
                pipe.srem(self._rk_preview(mode), filename)
            else:
                pipe.sadd(self._rk_avail(mode), filename)
                pipe.sadd(self._rk_tier(mode, tier), filename)
                if mode == "geminicli":
                    if preview:
                        pipe.sadd(self._rk_preview(mode), filename)
                    else:
                        pipe.srem(self._rk_preview(mode), filename)
            await pipe.execute()
        except Exception as e:
            log.warning(f"Redis sync_cred error: {e}")

    async def _redis_set_cooldown(self, mode: str, filename: str, model_name: str, cooldown_until: float) -> None:
        """设置 Redis 模型冷却 TTL key"""
        if not self._redis_enabled:
            return
        try:
            ttl = int(cooldown_until - time.time())
            if ttl > 0:
                cd_key = self._rk_cd(mode, filename, self._escape_model_name(model_name))
                await self._redis.setex(cd_key, ttl, str(cooldown_until))
        except Exception as e:
            log.warning(f"Redis set_cooldown error: {e}")

    async def _redis_clear_cooldown(self, mode: str, filename: str, model_name: str) -> None:
        """清除 Redis 模型冷却 TTL key"""
        if not self._redis_enabled:
            return
        try:
            cd_key = self._rk_cd(mode, filename, self._escape_model_name(model_name))
            await self._redis.delete(cd_key)
        except Exception as e:
            log.warning(f"Redis clear_cooldown error: {e}")

    async def _get_next_available_from_redis(
        self,
        mode: str,
        model_name: Optional[str],
        excluded_credentials: Optional[set[str]] = None,
    ) -> Optional[Tuple[str, Dict[str, Any]]]:
        """
        Redis 快速路径：随机取候选凭证，跳过冷却中的，返回 (filename, credential_data)。
        失败或池为空时返回 None，由调用方降级到 MySQL。

        routing_mode:
        - "normal": 随机选择
        - "unstable": 基于 preview 成功率加权随机选择
        """
        try:
            excluded = set(excluded_credentials or ())
            # 选择候选池
            is_preview_model = model_name and "preview" in model_name.lower()
            required_tiers = (
                required_tiers_for_geminicli_model(model_name)
                if mode == "geminicli"
                else None
            )

            if required_tiers:
                tier_members = set()
                for tier in required_tiers:
                    tier_members |= await self._redis.smembers(self._rk_tier(mode, tier))
                if is_preview_model:
                    tier_members &= await self._redis.smembers(self._rk_preview(mode))
                if not tier_members:
                    log.debug(
                        f"[Redis MISS] mode={mode} model={model_name}: "
                        f"no candidates for tiers={required_tiers}, fallback to MySQL"
                    )
                    return None
                candidates = random.sample(list(tier_members), min(len(tier_members), 10))
            elif mode == "geminicli" and is_preview_model:
                pool_key = self._rk_preview(mode)
            else:
                pool_key = self._rk_avail(mode)

            if not required_tiers:
                pool_size = await self._redis.scard(pool_key)
                if pool_size == 0:
                    log.debug(f"[Redis MISS] mode={mode} pool_key={pool_key}: pool empty, fallback to MySQL")
                    return None

                # 一次取多个随机成员，减少 round-trip
                sample_size = min(pool_size, 10)
                candidates = await self._redis.srandmember(pool_key, sample_size)
                if not candidates:
                    return None

            candidates = [candidate for candidate in candidates if candidate not in excluded]
            if not candidates:
                return None

            # 过滤冷却中的凭证（先过滤再排序，避免无效计算）
            available_candidates = []
            if model_name:
                escaped = self._escape_model_name(model_name)
                # 用 pipeline 批量检查冷却
                cd_pipe = self._redis.pipeline()
                for filename in candidates:
                    cd_key = self._rk_cd(mode, filename, escaped)
                    cd_pipe.exists(cd_key)
                cd_results = await cd_pipe.execute()

                for filename, in_cooldown in zip(candidates, cd_results):
                    if not in_cooldown:
                        available_candidates.append(filename)

                if not available_candidates:
                    log.debug(f"[Redis MISS] mode={mode} model={model_name}: all {len(candidates)} candidates in cooldown, fallback to MySQL")
                    return None
            else:
                available_candidates = list(candidates)

            # ---- 排序策略 ----
            from config import get_routing_mode_sync
            routing_mode = get_routing_mode_sync()

            if routing_mode == "unstable" and model_name and mode == "geminicli":
                # 非稳定期模式：基于 preview 成功率加权随机
                from src.usage_stats import get_preview_success_rates
                success_rates = await get_preview_success_rates(available_candidates, mode)

                WEIGHT_FLOOR = 0.1  # 保底权重，防止凭证饿死

                if is_preview_model:
                    # Preview 请求：成功率高 → 权重大
                    weights = [max(success_rates.get(f, 0.5), WEIGHT_FLOOR) for f in available_candidates]
                else:
                    # 非 Preview 请求：成功率低 → 权重大（负载更轻）
                    weights = [max(1.0 - success_rates.get(f, 0.5), WEIGHT_FLOOR) for f in available_candidates]

                # 加权随机排序：生成不重复排列
                ordered = []
                remaining = list(available_candidates)
                remaining_weights = list(weights)
                while remaining:
                    chosen = random.choices(remaining, weights=remaining_weights, k=1)[0]
                    ordered.append(chosen)
                    idx = remaining.index(chosen)
                    remaining.pop(idx)
                    remaining_weights.pop(idx)

                log.debug(f"[Redis UNSTABLE] mode={mode} model={model_name} "
                          f"rates={{{', '.join(f'{f[:12]}:{success_rates.get(f, 0.5):.0%}' for f in ordered)}}} "
                          f"-> {ordered[0][:20]}")
            else:
                # 正常模式：shuffle 随机
                random.shuffle(available_candidates)

                # 非 preview 模型的 preview 偏好处理（正常模式保留原有逻辑）
                if mode == "geminicli" and model_name and not is_preview_model:
                    preview_pool_key = self._rk_preview(mode)
                    preview_members = await self._redis.smembers(preview_pool_key)
                    non_preview = [f for f in available_candidates if f not in preview_members]
                    preview_only = [f for f in available_candidates if f in preview_members]
                    ordered = non_preview + preview_only
                else:
                    ordered = available_candidates

            # 返回第一个能获取到凭证数据的候选
            for filename in ordered:
                from config import is_smart_429_protection_enabled
                if mode == "geminicli" and is_smart_429_protection_enabled():
                    state = await self.get_credential_state(filename, mode)
                    if state.get("health_status", "healthy") != "healthy":
                        continue
                credential_data = await self.get_credential(filename, mode)
                if credential_data:
                    log.debug(f"[Redis HIT] mode={mode} model={model_name} -> {filename}")
                    return filename, credential_data

            return None
        except Exception as e:
            log.warning(f"Redis get_next_available error: {e}")
            return None

    # ============ 凭证查询方法 ============

    async def get_next_available_credential(
        self,
        mode: str = "geminicli",
        model_name: Optional[str] = None,
        excluded_credentials: Optional[set[str]] = None,
    ) -> Optional[Tuple[str, Dict[str, Any]]]:
        """
        随机获取一个可用凭证（负载均衡）
        - 未禁用
        - 如果提供了 model_name，还会检查模型级冷却和preview状态
        - 随机选择
        - 开启 Redis 时优先走快速路径
        """
        self._ensure_initialized()

        from config import is_smart_429_protection_enabled
        smart_enabled = is_smart_429_protection_enabled()
        health_enabled = mode == "geminicli" and smart_enabled
        excluded = set(excluded_credentials or ()) if smart_enabled else set()

        # Redis 快速路径
        if self._redis_enabled:
            result = await self._get_next_available_from_redis(mode, model_name, excluded)
            if result is not None:
                return result
            # result 为 None: 池为空或所有候选都在冷却中，降级到 MySQL

        try:
            table_name = self._get_table_name(mode)
            async with self._pool.acquire() as conn:
                async with conn.cursor() as cur:
                    current_time = time.time()

                    if mode == "geminicli":
                        required_tiers = required_tiers_for_geminicli_model(model_name)
                        tier_clause = ""
                        query_params: List[Any] = [self._server_name]
                        if required_tiers:
                            placeholders = ", ".join("%s" for _ in required_tiers)
                            tier_clause = f" AND tier IN ({placeholders})"
                            query_params.extend(required_tiers)
                        health_clause = " AND COALESCE(health_status, 'healthy') = 'healthy'" if health_enabled else ""
                        await cur.execute(f"""
                            SELECT filename, credential_data, model_cooldowns, preview, tier
                            FROM {table_name}
                            WHERE server_name = %s AND disabled = 0
                            {health_clause}
                            {tier_clause}
                            ORDER BY RAND()
                        """, tuple(query_params))
                        rows = await cur.fetchall()

                        if not model_name:
                            available_rows = [row for row in rows if row[0] not in excluded]
                            if available_rows:
                                filename, credential_json, _, _, _ = available_rows[0]
                                credential_data = json.loads(credential_json)
                                return filename, credential_data
                            return None

                        is_preview_model = "preview" in model_name.lower()

                        non_preview_creds = []
                        preview_creds = []

                        for filename, credential_json, model_cooldowns_json, preview, tier in rows:
                            if filename in excluded:
                                continue
                            if required_tiers and (tier or default_tier_for_mode(mode)) not in required_tiers:
                                continue
                            model_cooldowns = json.loads(model_cooldowns_json or '{}')

                            model_cooldown = model_cooldowns.get(model_name)
                            if model_cooldown is None or current_time >= model_cooldown:
                                if preview:
                                    preview_creds.append((filename, credential_json))
                                else:
                                    non_preview_creds.append((filename, credential_json))

                        if is_preview_model:
                            if preview_creds:
                                filename, credential_json = preview_creds[0]
                                return filename, json.loads(credential_json)
                        else:
                            if non_preview_creds:
                                filename, credential_json = non_preview_creds[0]
                                return filename, json.loads(credential_json)
                            elif preview_creds:
                                filename, credential_json = preview_creds[0]
                                return filename, json.loads(credential_json)

                        return None
                    else:
                        # antigravity 模式
                        await cur.execute(f"""
                            SELECT filename, credential_data, model_cooldowns
                            FROM {table_name}
                            WHERE server_name = %s AND disabled = 0
                            ORDER BY RAND()
                        """, (self._server_name,))
                        rows = await cur.fetchall()

                        if not model_name:
                            available_rows = [row for row in rows if row[0] not in excluded]
                            if available_rows:
                                filename, credential_json, _ = available_rows[0]
                                return filename, json.loads(credential_json)
                            return None

                        for filename, credential_json, model_cooldowns_json in rows:
                            if filename in excluded:
                                continue
                            model_cooldowns = json.loads(model_cooldowns_json or '{}')

                            model_cooldown = model_cooldowns.get(model_name)
                            if model_cooldown is None or current_time >= model_cooldown:
                                return filename, json.loads(credential_json)

                        return None

        except Exception as e:
            log.error(f"Error getting next available credential (mode={mode}, model_name={model_name}): {e}")
            return None

    async def get_available_credentials_list(self, mode: str = "geminicli") -> List[str]:
        """
        获取所有可用凭证列表
        - 未禁用
        - 按轮换顺序排序
        """
        self._ensure_initialized()

        try:
            table_name = self._get_table_name(mode)
            async with self._pool.acquire() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(f"""
                        SELECT filename
                        FROM {table_name}
                        WHERE server_name = %s AND disabled = 0
                        ORDER BY rotation_order ASC
                    """, (self._server_name,))
                    rows = await cur.fetchall()
                    return [row[0] for row in rows]

        except Exception as e:
            log.error(f"Error getting available credentials list (mode={mode}): {e}")
            return []

    async def check_smart_429_capability(self) -> tuple[bool, Optional[str]]:
        required = {
            "health_status", "quarantine_reason", "probe_stage", "next_probe_at",
            "last_health_check_at", "health_check_started_at", "health_state_version",
        }
        try:
            self._ensure_initialized()
            async with self._pool.acquire() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS "
                        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gcli_credentials'"
                    )
                    columns = {row[0] for row in await cur.fetchall()}
                    missing = sorted(required - columns)
                    if missing:
                        return False, f"missing_health_fields:{','.join(missing)}"
                    await cur.execute(
                        "UPDATE gcli_credentials SET health_state_version = "
                        "COALESCE(health_state_version, 0) WHERE 1 = 0"
                    )
            return True, None
        except Exception as exc:
            return False, f"health_fields_unavailable:{exc}"

    # ============ StorageBackend 协议方法 ============

    async def store_credential(self, filename: str, credential_data: Dict[str, Any], mode: str = "geminicli") -> bool:
        """存储或更新凭证"""
        self._ensure_initialized()

        filename = os.path.basename(filename)

        try:
            table_name = self._get_table_name(mode)
            current_ts = time.time()

            async with self._pool.acquire() as conn:
                async with conn.cursor() as cur:
                    # 检查凭证是否存在
                    await cur.execute(f"""
                        SELECT id FROM {table_name}
                        WHERE server_name = %s AND filename = %s
                    """, (self._server_name, filename))
                    existing = await cur.fetchone()

                    if existing:
                        # 更新现有凭证（保留状态）
                        await cur.execute(f"""
                            UPDATE {table_name}
                            SET credential_data = %s, updated_at = %s
                            WHERE server_name = %s AND filename = %s
                        """, (json.dumps(credential_data), current_ts,
                              self._server_name, filename))
                    else:
                        # 获取下一个 rotation_order
                        await cur.execute(f"""
                            SELECT COALESCE(MAX(rotation_order), -1) + 1
                            FROM {table_name}
                            WHERE server_name = %s
                        """, (self._server_name,))
                        row = await cur.fetchone()
                        next_order = row[0]

                        if mode == "geminicli":
                            await cur.execute(f"""
                                INSERT INTO {table_name}
                                (server_name, filename, credential_data, disabled,
                                 error_codes, error_messages, last_success,
                                 model_cooldowns, preview, rotation_order,
                                 call_count, created_at, updated_at, tier)
                                VALUES (%s, %s, %s, 0, '[]', '[]', %s, '{{}}', 1, %s, 0, %s, %s, %s)
                            """, (self._server_name, filename, json.dumps(credential_data),
                                  current_ts, next_order, current_ts, current_ts, default_tier_for_mode(mode)))
                        else:
                            await cur.execute(f"""
                                INSERT INTO {table_name}
                                (server_name, filename, credential_data, disabled,
                                 error_codes, error_messages, last_success,
                                 model_cooldowns, rotation_order,
                                 call_count, created_at, updated_at, tier)
                                VALUES (%s, %s, %s, 0, '[]', '[]', %s, '{{}}', %s, 0, %s, %s, %s)
                            """, (self._server_name, filename, json.dumps(credential_data),
                                  current_ts, next_order, current_ts, current_ts, default_tier_for_mode(mode)))

                await conn.commit()
                log.debug(f"Stored credential: {filename} (mode={mode})")

                # Redis: 新增凭证到可用池（新凭证默认 disabled=0, preview=1）
                if not existing:
                    await self._redis_add_cred(
                        mode,
                        filename,
                        tier=default_tier_for_mode(mode),
                        preview=True,
                    )

                return True

        except Exception as e:
            log.error(f"Error storing credential {filename}: {e}")
            return False

    async def get_credential(self, filename: str, mode: str = "geminicli") -> Optional[Dict[str, Any]]:
        """获取凭证数据"""
        self._ensure_initialized()

        filename = os.path.basename(filename)

        try:
            table_name = self._get_table_name(mode)
            async with self._pool.acquire() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(f"""
                        SELECT credential_data FROM {table_name}
                        WHERE server_name = %s AND filename = %s
                    """, (self._server_name, filename))
                    row = await cur.fetchone()
                    if row:
                        return json.loads(row[0])
                    return None

        except Exception as e:
            log.error(f"Error getting credential {filename}: {e}")
            return None

    async def list_credentials(self, mode: str = "geminicli") -> List[str]:
        """列出所有凭证文件名（包括禁用的）"""
        self._ensure_initialized()

        try:
            table_name = self._get_table_name(mode)
            async with self._pool.acquire() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(f"""
                        SELECT filename FROM {table_name}
                        WHERE server_name = %s
                        ORDER BY rotation_order
                    """, (self._server_name,))
                    rows = await cur.fetchall()
                    return [row[0] for row in rows]

        except Exception as e:
            log.error(f"Error listing credentials: {e}")
            return []

    async def delete_credential(self, filename: str, mode: str = "geminicli") -> bool:
        """删除凭证"""
        self._ensure_initialized()

        filename = os.path.basename(filename)

        try:
            table_name = self._get_table_name(mode)
            async with self._pool.acquire() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(f"""
                        DELETE FROM {table_name}
                        WHERE server_name = %s AND filename = %s
                    """, (self._server_name, filename))
                    deleted_count = cur.rowcount

                await conn.commit()

                if deleted_count > 0:
                    log.debug(f"Deleted {deleted_count} credential(s): {filename} (mode={mode})")
                    # Redis: 从池中移除
                    await self._redis_remove_cred(mode, filename)
                    return True
                else:
                    log.warning(f"No credential found to delete: {filename} (mode={mode})")
                    return False

        except Exception as e:
            log.error(f"Error deleting credential {filename}: {e}")
            return False

    # ============ 状态管理 ============

    async def update_credential_state(self, filename: str, state_updates: Dict[str, Any], mode: str = "geminicli") -> bool:
        """更新凭证状态"""
        self._ensure_initialized()

        filename = os.path.basename(filename)

        try:
            table_name = self._get_table_name(mode)

            # 构建动态 SQL
            set_clauses = []
            values = []

            for key, value in state_updates.items():
                if key in self.STATE_FIELDS:
                    # antigravity 表没有 preview 列
                    if key == "preview" and mode != "geminicli":
                        continue
                    if key.startswith("tier_raw_") and mode != "geminicli":
                        continue
                    if key in ("error_codes", "error_messages", "model_cooldowns"):
                        set_clauses.append(f"{key} = %s")
                        values.append(json.dumps(value))
                    else:
                        set_clauses.append(f"{key} = %s")
                        values.append(value)

            if not set_clauses:
                return True

            set_clauses.append("updated_at = %s")
            values.append(time.time())
            values.extend([self._server_name, filename])

            async with self._pool.acquire() as conn:
                async with conn.cursor() as cur:
                    sql = f"""
                        UPDATE {table_name}
                        SET {', '.join(set_clauses)}
                        WHERE server_name = %s AND filename = %s
                    """
                    await cur.execute(sql, values)
                    updated_count = cur.rowcount

                await conn.commit()

                # Redis: 同步 disabled/tier/preview/cooldown 变更
                if updated_count > 0 and self._redis_enabled:
                    if any(key in state_updates for key in ("disabled", "tier", "preview")):
                        disabled = False
                        tier = default_tier_for_mode(mode)
                        preview = True
                        if mode == "geminicli":
                            async with self._pool.acquire() as conn2:
                                async with conn2.cursor() as cur2:
                                    await cur2.execute(f"""
                                        SELECT disabled, tier, preview FROM {table_name}
                                        WHERE server_name = %s AND filename = %s
                                    """, (self._server_name, filename))
                                    row = await cur2.fetchone()
                                    if row:
                                        disabled = bool(row[0])
                                        tier = row[1] or default_tier_for_mode(mode)
                                        preview = bool(row[2])
                        else:
                            async with self._pool.acquire() as conn2:
                                async with conn2.cursor() as cur2:
                                    await cur2.execute(f"""
                                        SELECT disabled, tier FROM {table_name}
                                        WHERE server_name = %s AND filename = %s
                                    """, (self._server_name, filename))
                                    row = await cur2.fetchone()
                                    if row:
                                        disabled = bool(row[0])
                                        tier = row[1] or default_tier_for_mode(mode)
                        await self._redis_sync_cred(
                            mode,
                            filename,
                            disabled=disabled,
                            tier=tier,
                            preview=preview,
                        )
                    if "model_cooldowns" in state_updates:
                        # 冷却整体覆盖，重建所有 TTL key
                        cooldowns = state_updates["model_cooldowns"]
                        if isinstance(cooldowns, dict):
                            current_time = time.time()
                            for mn, cd_until in cooldowns.items():
                                if isinstance(cd_until, (int, float)) and cd_until > current_time:
                                    await self._redis_set_cooldown(mode, filename, mn, cd_until)

                return updated_count > 0

        except Exception as e:
            log.error(f"Error updating credential state {filename}: {e}")
            return False

    async def get_credential_state(self, filename: str, mode: str = "geminicli") -> Dict[str, Any]:
        """获取凭证状态（不包含error_messages）"""
        self._ensure_initialized()

        filename = os.path.basename(filename)

        try:
            table_name = self._get_table_name(mode)
            async with self._pool.acquire() as conn:
                async with conn.cursor() as cur:
                    if mode == "geminicli":
                        await cur.execute(f"""
                            SELECT disabled, error_codes, last_success,
                                   user_email, model_cooldowns, preview, tier,
                                   tier_raw_id, tier_raw_name, tier_detected_at,
                                   health_status, quarantine_reason, probe_stage, next_probe_at,
                                   last_health_check_at, health_check_started_at, health_state_version
                            FROM {table_name}
                            WHERE server_name = %s AND filename = %s
                        """, (self._server_name, filename))
                        row = await cur.fetchone()

                        if row:
                            return {
                                "disabled": bool(row[0]),
                                "error_codes": json.loads(row[1] or '[]'),
                                "last_success": row[2] or time.time(),
                                "user_email": row[3],
                                "model_cooldowns": json.loads(row[4] or '{}'),
                                "preview": bool(row[5]) if row[5] is not None else True,
                                "tier": row[6] if row[6] is not None else "unknown",
                                "tier_raw_id": row[7],
                                "tier_raw_name": row[8],
                                "tier_detected_at": row[9],
                                "health_status": row[10] or "healthy",
                                "quarantine_reason": row[11],
                                "probe_stage": row[12] or 0,
                                "next_probe_at": row[13],
                                "last_health_check_at": row[14],
                                "health_check_started_at": row[15],
                                "health_state_version": row[16] or 0,
                            }

                        return {
                            "disabled": False, "error_codes": [],
                            "last_success": time.time(), "user_email": None,
                            "model_cooldowns": {}, "preview": True,
                            "tier": "unknown",
                            "tier_raw_id": None,
                            "tier_raw_name": None,
                            "tier_detected_at": None,
                            "health_status": "healthy",
                            "quarantine_reason": None,
                            "probe_stage": 0,
                            "next_probe_at": None,
                            "last_health_check_at": None,
                            "health_check_started_at": None,
                            "health_state_version": 0,
                        }
                    else:
                        await cur.execute(f"""
                            SELECT disabled, error_codes, last_success,
                                   user_email, model_cooldowns, tier
                            FROM {table_name}
                            WHERE server_name = %s AND filename = %s
                        """, (self._server_name, filename))
                        row = await cur.fetchone()

                        if row:
                            return {
                                "disabled": bool(row[0]),
                                "error_codes": json.loads(row[1] or '[]'),
                                "last_success": row[2] or time.time(),
                                "user_email": row[3],
                                "model_cooldowns": json.loads(row[4] or '{}'),
                                "tier": row[5] if row[5] is not None else "pro",
                            }

                        return {
                            "disabled": False, "error_codes": [],
                            "last_success": time.time(), "user_email": None,
                            "model_cooldowns": {},
                            "tier": "pro",
                        }

        except Exception as e:
            log.error(f"Error getting credential state {filename}: {e}")
            return {}

    async def get_all_credential_states(self, mode: str = "geminicli") -> Dict[str, Dict[str, Any]]:
        """获取所有凭证状态（不包含error_messages）"""
        self._ensure_initialized()

        try:
            table_name = self._get_table_name(mode)
            async with self._pool.acquire() as conn:
                async with conn.cursor() as cur:
                    if mode == "geminicli":
                        await cur.execute(f"""
                            SELECT filename, disabled, error_codes, last_success,
                                   user_email, model_cooldowns, preview, tier,
                                   tier_raw_id, tier_raw_name, tier_detected_at,
                                   health_status, quarantine_reason, probe_stage, next_probe_at,
                                   last_health_check_at, health_check_started_at, health_state_version
                            FROM {table_name}
                            WHERE server_name = %s
                        """, (self._server_name,))
                    else:
                        await cur.execute(f"""
                            SELECT filename, disabled, error_codes, last_success,
                                   user_email, model_cooldowns, tier
                            FROM {table_name}
                            WHERE server_name = %s
                        """, (self._server_name,))

                    rows = await cur.fetchall()
                    states = {}
                    current_time = time.time()

                    for row in rows:
                        filename = row[0]
                        error_codes_json = row[2] or '[]'
                        model_cooldowns_json = row[5] or '{}'
                        model_cooldowns = json.loads(model_cooldowns_json)

                        # 自动过滤掉已过期的模型CD
                        if model_cooldowns:
                            model_cooldowns = {
                                k: v for k, v in model_cooldowns.items()
                                if v > current_time
                            }

                        state = {
                            "disabled": bool(row[1]),
                            "error_codes": json.loads(error_codes_json),
                            "last_success": row[3] or time.time(),
                            "user_email": row[4],
                            "model_cooldowns": model_cooldowns,
                        }

                        if mode == "geminicli":
                            state["preview"] = bool(row[6]) if row[6] is not None else True
                            state["tier"] = row[7] if row[7] is not None else "unknown"
                            state["tier_raw_id"] = row[8]
                            state["tier_raw_name"] = row[9]
                            state["tier_detected_at"] = row[10]
                            state["health_status"] = row[11] or "healthy"
                            state["quarantine_reason"] = row[12]
                            state["probe_stage"] = row[13] or 0
                            state["next_probe_at"] = row[14]
                            state["last_health_check_at"] = row[15]
                            state["health_check_started_at"] = row[16]
                            state["health_state_version"] = row[17] or 0
                        else:
                            state["tier"] = row[6] if row[6] is not None else "pro"

                        states[filename] = state

                    return states

        except Exception as e:
            log.error(f"Error getting all credential states: {e}")
            return {}

    # ============ 摘要/去重 ============

    async def get_credentials_summary(
        self,
        offset: int = 0,
        limit: Optional[int] = None,
        status_filter: str = "all",
        mode: str = "geminicli",
        error_code_filter: Optional[str] = None,
        cooldown_filter: Optional[str] = None,
        preview_filter: Optional[str] = None,
        tier_filter: Optional[str] = None
    ) -> Dict[str, Any]:
        """获取凭证的摘要信息（支持分页和状态筛选）"""
        self._ensure_initialized()

        try:
            table_name = self._get_table_name(mode)

            async with self._pool.acquire() as conn:
                async with conn.cursor() as cur:
                    # 全局统计
                    global_stats = {"total": 0, "normal": 0, "disabled": 0}
                    await cur.execute(f"""
                        SELECT disabled, COUNT(*) FROM {table_name}
                        WHERE server_name = %s
                        GROUP BY disabled
                    """, (self._server_name,))
                    stats_rows = await cur.fetchall()
                    for disabled, count in stats_rows:
                        global_stats["total"] += count
                        if disabled:
                            global_stats["disabled"] = count
                        else:
                            global_stats["normal"] = count

                    # 构建WHERE子句
                    where_clauses = ["server_name = %s"]
                    params = [self._server_name]

                    if status_filter == "enabled":
                        where_clauses.append("disabled = 0")
                    elif status_filter == "disabled":
                        where_clauses.append("disabled = 1")

                    filter_value = None
                    filter_int = None
                    if error_code_filter and str(error_code_filter).strip().lower() != "all":
                        filter_value = str(error_code_filter).strip()
                        try:
                            filter_int = int(filter_value)
                        except ValueError:
                            filter_int = None

                    where_clause = "WHERE " + " AND ".join(where_clauses)

                    if mode == "geminicli":
                        query = f"""
                            SELECT filename, disabled, error_codes, last_success,
                                   user_email, rotation_order, model_cooldowns, preview, tier,
                                   tier_raw_id, tier_raw_name, tier_detected_at,
                                   health_status, quarantine_reason, probe_stage, next_probe_at,
                                   last_health_check_at, health_check_started_at, health_state_version
                            FROM {table_name}
                            {where_clause}
                            ORDER BY rotation_order
                        """
                    else:
                        query = f"""
                            SELECT filename, disabled, error_codes, last_success,
                                   user_email, rotation_order, model_cooldowns, tier
                            FROM {table_name}
                            {where_clause}
                            ORDER BY rotation_order
                        """

                    await cur.execute(query, params)
                    all_rows = await cur.fetchall()

                    current_time = time.time()
                    all_summaries = []

                    for row in all_rows:
                        filename = row[0]
                        error_codes_json = row[2] or '[]'
                        model_cooldowns_json = row[6] or '{}'
                        model_cooldowns = json.loads(model_cooldowns_json)

                        active_cooldowns = {}
                        if model_cooldowns:
                            active_cooldowns = {
                                k: v for k, v in model_cooldowns.items()
                                if v > current_time
                            }

                        error_codes = json.loads(error_codes_json)
                        if filter_value:
                            match = False
                            for code in error_codes:
                                if code == filter_value or code == filter_int:
                                    match = True
                                    break
                                if isinstance(code, str) and filter_int is not None:
                                    try:
                                        if int(code) == filter_int:
                                            match = True
                                            break
                                    except ValueError:
                                        pass
                            if not match:
                                continue

                        summary = {
                            "filename": filename,
                            "disabled": bool(row[1]),
                            "error_codes": error_codes,
                            "last_success": row[3],
                            "user_email": row[4],
                            "rotation_order": row[5],
                            "model_cooldowns": active_cooldowns,
                        }

                        if mode == "geminicli":
                            summary["preview"] = bool(row[7]) if row[7] is not None else True
                            summary["tier"] = row[8] if row[8] is not None else "unknown"
                            summary["tier_raw_id"] = row[9]
                            summary["tier_raw_name"] = row[10]
                            summary["tier_detected_at"] = row[11]
                            summary["health_status"] = row[12] or "healthy"
                            summary["quarantine_reason"] = row[13]
                            summary["probe_stage"] = row[14] or 0
                            summary["next_probe_at"] = row[15]
                            summary["last_health_check_at"] = row[16]
                            summary["health_check_started_at"] = row[17]
                            summary["health_state_version"] = row[18] or 0
                        else:
                            summary["tier"] = row[7] if row[7] is not None else "pro"

                        # preview 筛选
                        if mode == "geminicli" and preview_filter:
                            preview_value = summary.get("preview", True)
                            if preview_filter == "preview" and not preview_value:
                                continue
                            elif preview_filter == "no_preview" and preview_value:
                                continue

                        # tier 筛选
                        if tier_filter and tier_filter in valid_tiers_for_mode(mode):
                            if summary["tier"] != tier_filter:
                                continue

                        # 冷却筛选
                        if cooldown_filter == "in_cooldown":
                            if active_cooldowns:
                                all_summaries.append(summary)
                        elif cooldown_filter == "no_cooldown":
                            if not active_cooldowns:
                                all_summaries.append(summary)
                        else:
                            all_summaries.append(summary)

                    # 分页
                    total_count = len(all_summaries)
                    if limit is not None:
                        summaries = all_summaries[offset:offset + limit]
                    else:
                        summaries = all_summaries[offset:]

                    return {
                        "items": summaries,
                        "total": total_count,
                        "offset": offset,
                        "limit": limit,
                        "stats": global_stats,
                    }

        except Exception as e:
            log.error(f"Error getting credentials summary: {e}")
            return {
                "items": [], "total": 0, "offset": offset,
                "limit": limit, "stats": {"total": 0, "normal": 0, "disabled": 0},
            }

    async def get_duplicate_credentials_by_email(self, mode: str = "geminicli") -> Dict[str, Any]:
        """获取按邮箱分组的重复凭证信息"""
        self._ensure_initialized()

        try:
            table_name = self._get_table_name(mode)
            async with self._pool.acquire() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(f"""
                        SELECT filename, user_email
                        FROM {table_name}
                        WHERE server_name = %s
                        ORDER BY filename
                    """, (self._server_name,))
                    docs = await cur.fetchall()

            email_to_files = {}
            no_email_files = []

            for filename, user_email in docs:
                if user_email:
                    if user_email not in email_to_files:
                        email_to_files[user_email] = []
                    email_to_files[user_email].append(filename)
                else:
                    no_email_files.append(filename)

            duplicate_groups = []
            total_duplicate_count = 0

            for email, files in email_to_files.items():
                if len(files) > 1:
                    duplicate_groups.append({
                        "email": email,
                        "kept_file": files[0],
                        "duplicate_files": files[1:],
                        "duplicate_count": len(files) - 1,
                    })
                    total_duplicate_count += len(files) - 1

            return {
                "email_groups": email_to_files,
                "duplicate_groups": duplicate_groups,
                "duplicate_count": total_duplicate_count,
                "no_email_files": no_email_files,
                "no_email_count": len(no_email_files),
                "unique_email_count": len(email_to_files),
                "total_count": len(docs),
            }

        except Exception as e:
            log.error(f"Error getting duplicate credentials by email: {e}")
            return {
                "email_groups": {}, "duplicate_groups": [],
                "duplicate_count": 0, "no_email_files": [],
                "no_email_count": 0, "unique_email_count": 0, "total_count": 0,
            }

    # ============ 配置管理（内存缓存）============

    async def set_config(self, key: str, value: Any) -> bool:
        """设置配置（写入数据库 + 更新内存缓存）"""
        self._ensure_initialized()

        try:
            async with self._pool.acquire() as conn:
                async with conn.cursor() as cur:
                    await cur.execute("""
                        INSERT INTO gcli_config (server_name, `key`, value, updated_at)
                        VALUES (%s, %s, %s, %s)
                        ON DUPLICATE KEY UPDATE
                            value = VALUES(value),
                            updated_at = VALUES(updated_at)
                    """, (self._server_name, key, json.dumps(value), time.time()))
                await conn.commit()

            self._config_cache[key] = value
            return True

        except Exception as e:
            log.error(f"Error setting config {key}: {e}")
            return False

    async def reload_config_cache(self):
        """重新加载配置缓存"""
        self._ensure_initialized()
        self._config_loaded = False
        await self._load_config_cache()
        log.info("Config cache reloaded from database")

    async def get_config(self, key: str, default: Any = None) -> Any:
        """获取配置（从内存缓存）"""
        self._ensure_initialized()
        return self._config_cache.get(key, default)

    async def get_all_config(self) -> Dict[str, Any]:
        """获取所有配置（从内存缓存）"""
        self._ensure_initialized()
        return self._config_cache.copy()

    async def delete_config(self, key: str) -> bool:
        """删除配置"""
        self._ensure_initialized()

        try:
            async with self._pool.acquire() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        "DELETE FROM gcli_config WHERE server_name = %s AND `key` = %s",
                        (self._server_name, key)
                    )
                await conn.commit()

            self._config_cache.pop(key, None)
            return True

        except Exception as e:
            log.error(f"Error deleting config {key}: {e}")
            return False

    # ============ 错误信息 ============

    async def get_credential_errors(self, filename: str, mode: str = "geminicli") -> Dict[str, Any]:
        """获取凭证的错误信息（包含 error_codes 和 error_messages）"""
        self._ensure_initialized()

        filename = os.path.basename(filename)

        try:
            table_name = self._get_table_name(mode)
            async with self._pool.acquire() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(f"""
                        SELECT error_codes, error_messages FROM {table_name}
                        WHERE server_name = %s AND filename = %s
                    """, (self._server_name, filename))
                    row = await cur.fetchone()

                    if row:
                        return {
                            "filename": filename,
                            "error_codes": json.loads(row[0] or '[]'),
                            "error_messages": json.loads(row[1] or '[]'),
                        }

            return {"filename": filename, "error_codes": [], "error_messages": []}

        except Exception as e:
            log.error(f"Error getting credential errors {filename}: {e}")
            return {"filename": filename, "error_codes": [], "error_messages": [], "error": str(e)}

    # ============ 模型级冷却管理 ============

    async def set_model_cooldown(
        self,
        filename: str,
        model_name: str,
        cooldown_until: Optional[float],
        mode: str = "geminicli"
    ) -> bool:
        """设置特定模型的冷却时间"""
        self._ensure_initialized()

        filename = os.path.basename(filename)

        try:
            table_name = self._get_table_name(mode)
            async with self._pool.acquire() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(f"""
                        SELECT model_cooldowns FROM {table_name}
                        WHERE server_name = %s AND filename = %s
                    """, (self._server_name, filename))
                    row = await cur.fetchone()

                    if not row:
                        log.warning(f"Credential {filename} not found")
                        return False

                    model_cooldowns = json.loads(row[0] or '{}')

                    if cooldown_until is None:
                        model_cooldowns.pop(model_name, None)
                    else:
                        model_cooldowns[model_name] = cooldown_until

                    await cur.execute(f"""
                        UPDATE {table_name}
                        SET model_cooldowns = %s, updated_at = %s
                        WHERE server_name = %s AND filename = %s
                    """, (json.dumps(model_cooldowns), time.time(),
                          self._server_name, filename))

                await conn.commit()
                log.debug(f"Set model cooldown: {filename}, model_name={model_name}, cooldown_until={cooldown_until}")

                # Redis: 同步冷却 TTL
                if cooldown_until is not None:
                    await self._redis_set_cooldown(mode, filename, model_name, cooldown_until)
                else:
                    await self._redis_clear_cooldown(mode, filename, model_name)

                return True

        except Exception as e:
            log.error(f"Error setting model cooldown for {filename}: {e}")
            return False

    async def record_success(
        self,
        filename: str,
        model_name: Optional[str] = None,
        mode: str = "geminicli"
    ) -> None:
        """
        成功调用后的条件写入：
        - 只有当前 error_codes 非空时才清除错误并写 last_success
        - 只有当前存在该模型的冷却键时才清除
        """
        self._ensure_initialized()
        filename = os.path.basename(filename)

        try:
            table_name = self._get_table_name(mode)
            current_ts = time.time()

            async with self._pool.acquire() as conn:
                async with conn.cursor() as cur:
                    # 条件写入：只有 error_codes 非空时才触发
                    await cur.execute(f"""
                        UPDATE {table_name}
                        SET last_success = %s,
                            error_codes = '[]',
                            error_messages = '{{}}',
                            updated_at = %s
                        WHERE server_name = %s AND filename = %s
                          AND (error_codes IS NOT NULL AND error_codes != '[]' AND error_codes != '')
                    """, (current_ts, current_ts, self._server_name, filename))

                    # 条件删除模型冷却
                    if model_name:
                        await cur.execute(f"""
                            SELECT model_cooldowns FROM {table_name}
                            WHERE server_name = %s AND filename = %s
                        """, (self._server_name, filename))
                        row = await cur.fetchone()
                        if row:
                            cooldowns = json.loads(row[0] or '{}')
                            if model_name in cooldowns:
                                cooldowns.pop(model_name)
                                await cur.execute(f"""
                                    UPDATE {table_name}
                                    SET model_cooldowns = %s, updated_at = %s
                                    WHERE server_name = %s AND filename = %s
                                """, (json.dumps(cooldowns), current_ts,
                                      self._server_name, filename))

                await conn.commit()

                # Redis: 清除模型冷却 TTL key
                if model_name:
                    await self._redis_clear_cooldown(mode, filename, model_name)

        except Exception as e:
            log.error(f"Error recording success for {filename}: {e}")
