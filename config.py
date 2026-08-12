"""
Configuration constants for the Geminicli2api proxy server.
Centralizes all configuration to avoid duplication across modules.

- 启动时加载一次配置到内存
- 修改配置时调用 reload_config() 重新从数据库加载
"""

import math
import os
from typing import Any, Optional

# 全局配置缓存
_config_cache: dict[str, Any] = {}
_config_initialized = False

# 调试模式同步缓存（热路径使用，避免 async 开销）
_debug_mode_cache: bool = False

# 流式 TTFT 诊断同步缓存（独立于 DEBUG_MODE）
_stream_diagnostics_enabled_cache: bool = False

# GeminiCLI model-capacity fast-fail cache (independent from SMART 429)
_geminicli_capacity_fast_fail_enabled_cache: bool = False

# GeminiCLI streaming response-header hedge cache
_geminicli_stream_header_hedge_enabled_cache: bool = False
_geminicli_stream_header_hedge_sample_rate_cache: float = 0.05
_geminicli_stream_header_hedge_daily_budget_cache: int = 10

# Request-level streaming/network settings. Values are loaded from storage at
# startup and refreshed only when it is safe for the current worker topology.
_stream_latency_runtime_cache: dict[str, Any] = {}

# 轮巡模式同步缓存（热路径使用）
_routing_mode_cache: str = "normal"

# SMART 429 hot-path caches. Fail-safe defaults keep the feature disabled.
_smart_429_enabled_cache: bool = False
_smart_429_max_attempts_cache: int = 3
_smart_429_retry_base_interval_cache: float = 0.5
_smart_429_runtime_blocked_reason: Optional[str] = None

# Client Configuration

# 需要自动封禁的错误码 (默认值，可通过环境变量或配置覆盖)
AUTO_BAN_ERROR_CODES = [403]

# ====================== 环境变量映射表 ======================
# 统一维护环境变量名和配置键名的映射关系
# 格式: "环境变量名": "配置键名"
ENV_MAPPINGS = {
    "CODE_ASSIST_ENDPOINT": "code_assist_endpoint",
    "CREDENTIALS_DIR": "credentials_dir",
    "PROXY": "proxy",
    "OAUTH_PROXY_URL": "oauth_proxy_url",
    "GOOGLEAPIS_PROXY_URL": "googleapis_proxy_url",
    "RESOURCE_MANAGER_API_URL": "resource_manager_api_url",
    "SERVICE_USAGE_API_URL": "service_usage_api_url",
    "ANTIGRAVITY_API_URL": "antigravity_api_url",
    "AUTO_BAN": "auto_ban_enabled",
    "AUTO_BAN_ERROR_CODES": "auto_ban_error_codes",
    "RETRY_429_MAX_RETRIES": "retry_429_max_retries",
    "RETRY_429_ENABLED": "retry_429_enabled",
    "RETRY_429_INTERVAL": "retry_429_interval",
    "SMART_429_PROTECTION_ENABLED": "smart_429_protection_enabled",
    "SMART_429_MAX_ATTEMPTS": "smart_429_max_attempts",
    "SMART_429_RETRY_BASE_INTERVAL": "smart_429_retry_base_interval",
    "ANTI_TRUNCATION_MAX_ATTEMPTS": "anti_truncation_max_attempts",
    "COMPATIBILITY_MODE": "compatibility_mode_enabled",
    "RETURN_THOUGHTS_TO_FRONTEND": "return_thoughts_to_frontend",
    "ANTIGRAVITY_STREAM2NOSTREAM": "antigravity_stream2nostream",
    "ANTIGRAVITY_SWITCH_CREDENTIAL": "antigravity_switch_credential_enabled",
    "HOST": "host",
    "PORT": "port",
    "API_PASSWORD": "api_password",
    "PANEL_PASSWORD": "panel_password",
    "PASSWORD": "password",
    "KEEPALIVE_URL": "keepalive_url",
    "KEEPALIVE_INTERVAL": "keepalive_interval",
    "DEBUG_MODE": "debug_mode",
    "STREAM_DIAGNOSTICS_ENABLED": "stream_diagnostics_enabled",
    "GEMINICLI_CAPACITY_FAST_FAIL_ENABLED": "geminicli_capacity_fast_fail_enabled",
    "GEMINICLI_STREAM_HEADER_HEDGE_ENABLED": "geminicli_stream_header_hedge_enabled",
    "GEMINICLI_STREAM_HEADER_HEDGE_SAMPLE_RATE": "geminicli_stream_header_hedge_sample_rate",
    "GEMINICLI_STREAM_HEADER_HEDGE_DAILY_BUDGET": "geminicli_stream_header_hedge_daily_budget",
    "STREAM_LATENCY_GUARD_ENABLED": "stream_latency_guard_enabled",
    "CREDENTIAL_ACQUIRE_TIMEOUT": "credential_acquire_timeout",
    "OAUTH_REFRESH_TIMEOUT": "oauth_refresh_timeout",
    "UPSTREAM_POOL_TIMEOUT": "upstream_pool_timeout",
    "UPSTREAM_CONNECT_TIMEOUT": "upstream_connect_timeout",
    "UPSTREAM_WRITE_TIMEOUT": "upstream_write_timeout",
    "UPSTREAM_RESPONSE_HEADER_TIMEOUT": "upstream_response_header_timeout",
    "UPSTREAM_FIRST_EVENT_TIMEOUT": "upstream_first_event_timeout",
    "STREAM_FIRST_CONTENT_TIMEOUT": "stream_first_content_timeout",
    "UPSTREAM_STREAM_IDLE_TIMEOUT": "upstream_stream_idle_timeout",
    "STREAM_TRANSPORT_MAX_ATTEMPTS": "stream_transport_max_attempts",
    "NONSTREAM_TRANSPORT_MAX_ATTEMPTS": "nonstream_transport_max_attempts",
    "STREAM_PERF_LOG_SAMPLE_RATE": "stream_perf_log_sample_rate",
    "UPSTREAM_HTTP2_ENABLED": "upstream_http2_enabled",
    "UPSTREAM_HTTP2_CLIENT_MAX_AGE": "upstream_http2_client_max_age",
    "GEMINICLI_STREAM_HEADER_HEDGE_DELAY": "geminicli_stream_header_hedge_delay",
    "GEMINICLI_STREAM_HEADER_HEDGE_MAX_INFLIGHT": "geminicli_stream_header_hedge_max_inflight",
    "ROUTING_MODE": "routing_mode",
}


STREAM_LATENCY_CONFIG_SPECS: dict[str, dict[str, Any]] = {
    "stream_latency_guard_enabled": {
        "env": "STREAM_LATENCY_GUARD_ENABLED", "default": True, "type": "bool"
    },
    "credential_acquire_timeout": {
        "env": "CREDENTIAL_ACQUIRE_TIMEOUT", "default": 10.0, "type": "float", "min": 0.01, "ui_min": 1.0, "max": 60.0
    },
    "oauth_refresh_timeout": {
        "env": "OAUTH_REFRESH_TIMEOUT", "default": 20.0, "type": "float", "min": 0.01, "ui_min": 1.0, "max": 60.0
    },
    "upstream_pool_timeout": {
        "env": "UPSTREAM_POOL_TIMEOUT", "default": 5.0, "type": "float", "min": 0.01, "ui_min": 1.0, "max": 60.0
    },
    "upstream_connect_timeout": {
        "env": "UPSTREAM_CONNECT_TIMEOUT", "default": 10.0, "type": "float", "min": 0.01, "ui_min": 1.0, "max": 60.0
    },
    "upstream_write_timeout": {
        "env": "UPSTREAM_WRITE_TIMEOUT", "default": 30.0, "type": "float", "min": 0.01, "ui_min": 1.0, "max": 120.0
    },
    "upstream_response_header_timeout": {
        "env": "UPSTREAM_RESPONSE_HEADER_TIMEOUT", "default": 30.0, "type": "float", "min": 0.01, "ui_min": 1.0, "max": 300.0
    },
    "upstream_first_event_timeout": {
        "env": "UPSTREAM_FIRST_EVENT_TIMEOUT", "default": 45.0, "type": "float", "min": 0.01, "ui_min": 1.0, "max": 300.0
    },
    "stream_first_content_timeout": {
        "env": "STREAM_FIRST_CONTENT_TIMEOUT", "default": 75.0, "type": "float", "min": 0.01, "ui_min": 1.0, "max": 600.0
    },
    "upstream_stream_idle_timeout": {
        "env": "UPSTREAM_STREAM_IDLE_TIMEOUT", "default": 90.0, "type": "float", "min": 0.01, "ui_min": 5.0, "max": 600.0
    },
    "stream_transport_max_attempts": {
        "env": "STREAM_TRANSPORT_MAX_ATTEMPTS", "default": 2, "type": "int", "min": 1, "max": 5
    },
    "nonstream_transport_max_attempts": {
        "env": "NONSTREAM_TRANSPORT_MAX_ATTEMPTS", "default": 2, "type": "int", "min": 1, "max": 5
    },
    "stream_perf_log_sample_rate": {
        "env": "STREAM_PERF_LOG_SAMPLE_RATE", "default": 0.01, "type": "float", "min": 0.0, "max": 1.0
    },
    "upstream_http2_enabled": {
        "env": "UPSTREAM_HTTP2_ENABLED", "default": False, "type": "bool", "restart": True
    },
    "upstream_http2_client_max_age": {
        "env": "UPSTREAM_HTTP2_CLIENT_MAX_AGE", "default": 2700.0, "type": "float", "min": 0.0, "max": 86400.0, "restart": True
    },
    "geminicli_stream_header_hedge_delay": {
        "env": "GEMINICLI_STREAM_HEADER_HEDGE_DELAY", "default": 15.0, "type": "float", "min": 0.01, "ui_min": 0.1, "max": 300.0
    },
    "geminicli_stream_header_hedge_max_inflight": {
        "env": "GEMINICLI_STREAM_HEADER_HEDGE_MAX_INFLIGHT", "default": 20, "type": "int", "min": 1, "max": 100
    },
}


# ====================== 配置系统 ======================

async def init_config():
    """初始化配置缓存（启动时调用一次）"""
    global _config_cache, _config_initialized, _debug_mode_cache, _routing_mode_cache
    global _stream_diagnostics_enabled_cache, _geminicli_capacity_fast_fail_enabled_cache
    global _geminicli_stream_header_hedge_enabled_cache
    global _geminicli_stream_header_hedge_sample_rate_cache
    global _geminicli_stream_header_hedge_daily_budget_cache
    global _stream_latency_runtime_cache
    global _smart_429_enabled_cache, _smart_429_max_attempts_cache, _smart_429_retry_base_interval_cache

    if _config_initialized:
        return

    try:
        from src.storage_adapter import get_storage_adapter
        storage_adapter = await get_storage_adapter()
        _config_cache = await storage_adapter.get_all_config()
        _config_initialized = True
    except Exception:
        # 初始化失败时使用空缓存
        _config_cache = {}
        _config_initialized = True

    # 刷新同步缓存
    _debug_mode_cache = await get_debug_mode()
    _stream_diagnostics_enabled_cache = await get_stream_diagnostics_enabled()
    _geminicli_capacity_fast_fail_enabled_cache = (
        await get_geminicli_capacity_fast_fail_enabled()
    )
    _geminicli_stream_header_hedge_enabled_cache = (
        await get_geminicli_stream_header_hedge_enabled()
    )
    _geminicli_stream_header_hedge_sample_rate_cache = (
        await get_geminicli_stream_header_hedge_sample_rate()
    )
    _geminicli_stream_header_hedge_daily_budget_cache = (
        await get_geminicli_stream_header_hedge_daily_budget()
    )
    _stream_latency_runtime_cache = await get_stream_latency_config()
    _routing_mode_cache = await get_routing_mode()
    _smart_429_enabled_cache = await get_smart_429_protection_enabled()
    _smart_429_max_attempts_cache = await get_smart_429_max_attempts()
    _smart_429_retry_base_interval_cache = await get_smart_429_retry_base_interval()


async def reload_config(
    *,
    reload_stream_diagnostics: bool = True,
    reload_capacity_fast_fail: bool = True,
    reload_stream_header_hedge: bool = True,
    reload_stream_latency: bool = True,
    reload_http_transport: bool = False,
):
    """重新加载配置（修改配置后调用）"""
    global _config_cache, _config_initialized, _debug_mode_cache, _routing_mode_cache
    global _stream_diagnostics_enabled_cache, _geminicli_capacity_fast_fail_enabled_cache
    global _geminicli_stream_header_hedge_enabled_cache
    global _geminicli_stream_header_hedge_sample_rate_cache
    global _geminicli_stream_header_hedge_daily_budget_cache
    global _stream_latency_runtime_cache
    global _smart_429_enabled_cache, _smart_429_max_attempts_cache, _smart_429_retry_base_interval_cache

    try:
        from src.storage_adapter import get_storage_adapter
        storage_adapter = await get_storage_adapter()

        # 如果后端支持 reload_config_cache，调用它
        if hasattr(storage_adapter._backend, 'reload_config_cache'):
            await storage_adapter._backend.reload_config_cache()

        # 重新加载配置缓存
        _config_cache = await storage_adapter.get_all_config()
        _config_initialized = True
    except Exception:
        pass

    # 刷新同步缓存
    _debug_mode_cache = await get_debug_mode()
    if reload_stream_diagnostics:
        _stream_diagnostics_enabled_cache = await get_stream_diagnostics_enabled()
    if reload_capacity_fast_fail:
        _geminicli_capacity_fast_fail_enabled_cache = (
            await get_geminicli_capacity_fast_fail_enabled()
        )
    if reload_stream_header_hedge:
        _geminicli_stream_header_hedge_enabled_cache = (
            await get_geminicli_stream_header_hedge_enabled()
        )
        _geminicli_stream_header_hedge_sample_rate_cache = (
            await get_geminicli_stream_header_hedge_sample_rate()
        )
        _geminicli_stream_header_hedge_daily_budget_cache = (
            await get_geminicli_stream_header_hedge_daily_budget()
        )
    if reload_stream_latency:
        updated_stream_settings = await get_stream_latency_config()
        if not reload_http_transport and _stream_latency_runtime_cache:
            for key, spec in STREAM_LATENCY_CONFIG_SPECS.items():
                if spec.get("restart"):
                    updated_stream_settings[key] = _stream_latency_runtime_cache.get(
                        key, spec["default"]
                    )
        _stream_latency_runtime_cache = updated_stream_settings
    _routing_mode_cache = await get_routing_mode()
    _smart_429_enabled_cache = await get_smart_429_protection_enabled()
    _smart_429_max_attempts_cache = await get_smart_429_max_attempts()
    _smart_429_retry_base_interval_cache = await get_smart_429_retry_base_interval()


def _get_cached_config(key: str, default: Any = None) -> Any:
    """从内存缓存获取配置（同步）"""
    return _config_cache.get(key, default)


def _normalize_stream_latency_value(key: str, value: Any) -> Any:
    spec = STREAM_LATENCY_CONFIG_SPECS[key]
    default = spec["default"]
    value_type = spec["type"]
    try:
        if value_type == "bool":
            if isinstance(value, bool):
                return value
            if isinstance(value, str):
                normalized = value.strip().lower()
                if normalized in {"true", "1", "yes", "on"}:
                    return True
                if normalized in {"false", "0", "no", "off"}:
                    return False
            raise ValueError
        if isinstance(value, bool):
            raise ValueError
        parsed = int(value) if value_type == "int" else float(value)
        if isinstance(parsed, float) and not math.isfinite(parsed):
            raise ValueError
        if parsed < spec["min"] or parsed > spec["max"]:
            raise ValueError
        return parsed
    except (TypeError, ValueError, OverflowError):
        return default


async def get_stream_latency_config() -> dict[str, Any]:
    """Return desired stream/network settings with environment precedence."""
    values: dict[str, Any] = {}
    for key, spec in STREAM_LATENCY_CONFIG_SPECS.items():
        raw = await get_config_value(key, spec["default"], spec["env"])
        values[key] = _normalize_stream_latency_value(key, raw)
    return values


def get_stream_latency_runtime_config() -> dict[str, Any]:
    """Return the current worker's immutable-source settings for new requests."""
    values = {
        key: _stream_latency_runtime_cache.get(key, spec["default"])
        for key, spec in STREAM_LATENCY_CONFIG_SPECS.items()
    }
    # Explicit environment settings always win, including false/zero values.
    for key, spec in STREAM_LATENCY_CONFIG_SPECS.items():
        raw = os.getenv(spec["env"])
        if raw is not None:
            values[key] = _normalize_stream_latency_value(key, raw)
    return values


async def get_config_value(key: str, default: Any = None, env_var: Optional[str] = None) -> Any:
    """Get configuration value with priority: ENV > Storage > default."""
    # 确保配置已初始化
    if not _config_initialized:
        await init_config()

    # Priority 1: Environment variable
    if env_var and os.getenv(env_var):
        return os.getenv(env_var)

    # Priority 2: Memory cache
    value = _get_cached_config(key)
    if value is not None:
        return value

    return default


# Configuration getters - all async
async def get_proxy_config():
    """Get proxy configuration."""
    proxy_url = await get_config_value("proxy", env_var="PROXY")
    return proxy_url if proxy_url else None


async def get_auto_ban_enabled() -> bool:
    """Get auto ban enabled setting."""
    env_value = os.getenv("AUTO_BAN")
    if env_value:
        return env_value.lower() in ("true", "1", "yes", "on")

    return bool(await get_config_value("auto_ban_enabled", False))


async def get_auto_ban_error_codes() -> list:
    """
    Get auto ban error codes.

    Environment variable: AUTO_BAN_ERROR_CODES (comma-separated, e.g., "400,403")
    Database config key: auto_ban_error_codes
    Default: [400, 403]
    """
    env_value = os.getenv("AUTO_BAN_ERROR_CODES")
    if env_value:
        try:
            return [int(code.strip()) for code in env_value.split(",") if code.strip()]
        except ValueError:
            pass

    codes = await get_config_value("auto_ban_error_codes")
    if codes and isinstance(codes, list):
        return codes
    return AUTO_BAN_ERROR_CODES


async def get_retry_429_max_retries() -> int:
    """Get max retries for 429 errors."""
    env_value = os.getenv("RETRY_429_MAX_RETRIES")
    if env_value:
        try:
            return int(env_value)
        except ValueError:
            pass

    return int(await get_config_value("retry_429_max_retries", 5))


async def get_retry_429_enabled() -> bool:
    """Get 429 retry enabled setting."""
    env_value = os.getenv("RETRY_429_ENABLED")
    if env_value:
        return env_value.lower() in ("true", "1", "yes", "on")

    return bool(await get_config_value("retry_429_enabled", True))


async def get_retry_429_interval() -> float:
    """Get 429 retry interval in seconds."""
    env_value = os.getenv("RETRY_429_INTERVAL")
    if env_value:
        try:
            return float(env_value)
        except ValueError:
            pass

    return float(await get_config_value("retry_429_interval", 1))


async def get_smart_429_protection_enabled() -> bool:
    """Return the requested SMART 429 state; invalid values fail closed."""
    raw = os.getenv("SMART_429_PROTECTION_ENABLED")
    if raw is None:
        raw = await get_config_value("smart_429_protection_enabled", False)
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, (int, float)):
        return raw == 1
    if isinstance(raw, str):
        normalized = raw.strip().lower()
        if normalized in ("true", "1", "yes", "on"):
            return True
        if normalized in ("false", "0", "no", "off", ""):
            return False
    return False


async def get_smart_429_max_attempts() -> int:
    raw = os.getenv("SMART_429_MAX_ATTEMPTS")
    if raw is None:
        raw = await get_config_value("smart_429_max_attempts", 3)
    try:
        return max(1, min(5, int(raw)))
    except (TypeError, ValueError):
        return 3


async def get_smart_429_retry_base_interval() -> float:
    raw = os.getenv("SMART_429_RETRY_BASE_INTERVAL")
    if raw is None:
        raw = await get_config_value("smart_429_retry_base_interval", 0.5)
    try:
        return max(0.1, min(5.0, float(raw)))
    except (TypeError, ValueError):
        return 0.5


def is_smart_429_protection_enabled() -> bool:
    """Synchronous hot-path check. Multi-worker mode is unsupported in v1."""
    try:
        workers = int(os.getenv("WORKERS", "1"))
    except ValueError:
        workers = 1
    return _smart_429_enabled_cache and workers == 1 and _smart_429_runtime_blocked_reason is None


def set_smart_429_runtime_blocked_reason(reason: Optional[str]) -> None:
    global _smart_429_runtime_blocked_reason
    _smart_429_runtime_blocked_reason = reason


def get_smart_429_config_sync() -> dict[str, Any]:
    return {
        "enabled": is_smart_429_protection_enabled(),
        "requested_enabled": _smart_429_enabled_cache,
        "blocked_reason": (
            "multi_instance_unsupported"
            if _smart_429_enabled_cache and workers_not_supported()
            else _smart_429_runtime_blocked_reason
        ),
        "max_attempts": _smart_429_max_attempts_cache,
        "retry_base_interval": _smart_429_retry_base_interval_cache,
    }


def workers_not_supported() -> bool:
    try:
        return int(os.getenv("WORKERS", "1")) != 1
    except ValueError:
        return False


async def get_anti_truncation_max_attempts() -> int:
    """
    Get maximum attempts for anti-truncation continuation.

    Environment variable: ANTI_TRUNCATION_MAX_ATTEMPTS
    Database config key: anti_truncation_max_attempts
    Default: 3
    """
    env_value = os.getenv("ANTI_TRUNCATION_MAX_ATTEMPTS")
    if env_value:
        try:
            return int(env_value)
        except ValueError:
            pass

    return int(await get_config_value("anti_truncation_max_attempts", 3))


# Server Configuration
async def get_server_host() -> str:
    """
    Get server host setting.

    Environment variable: HOST
    Database config key: host
    Default: 0.0.0.0
    """
    return str(await get_config_value("host", "0.0.0.0", "HOST"))


async def get_server_port() -> int:
    """
    Get server port setting.

    Environment variable: PORT
    Database config key: port
    Default: 7861
    """
    env_value = os.getenv("PORT")
    if env_value:
        try:
            return int(env_value)
        except ValueError:
            pass

    return int(await get_config_value("port", 7861))


async def get_api_password() -> str:
    """
    Get API password setting for chat endpoints.

    Environment variable: API_PASSWORD
    Database config key: api_password
    Default: Uses PASSWORD env var for compatibility, otherwise 'pwd'
    """
    # 优先使用 API_PASSWORD，如果没有则使用通用 PASSWORD 保证兼容性
    api_password = await get_config_value("api_password", None, "API_PASSWORD")
    if api_password is not None:
        return str(api_password)

    # 兼容性：使用通用密码
    return str(await get_config_value("password", "pwd", "PASSWORD"))


async def get_panel_password() -> str:
    """
    Get panel password setting for web interface.

    Environment variable: PANEL_PASSWORD
    Database config key: panel_password
    Default: Uses PASSWORD env var for compatibility, otherwise 'pwd'
    """
    # 优先使用 PANEL_PASSWORD，如果没有则使用通用 PASSWORD 保证兼容性
    panel_password = await get_config_value("panel_password", None, "PANEL_PASSWORD")
    if panel_password is not None:
        return str(panel_password)

    # 兼容性：使用通用密码
    return str(await get_config_value("password", "pwd", "PASSWORD"))


async def get_server_password() -> str:
    """
    Get server password setting (deprecated, use get_api_password or get_panel_password).

    Environment variable: PASSWORD
    Database config key: password
    Default: pwd
    """
    return str(await get_config_value("password", "pwd", "PASSWORD"))


async def get_credentials_dir() -> str:
    """
    Get credentials directory setting.

    Environment variable: CREDENTIALS_DIR
    Database config key: credentials_dir
    Default: ./creds
    """
    return str(await get_config_value("credentials_dir", "./creds", "CREDENTIALS_DIR"))


async def get_code_assist_endpoint() -> str:
    """
    Get Code Assist endpoint setting.

    Environment variable: CODE_ASSIST_ENDPOINT
    Database config key: code_assist_endpoint
    Default: https://cloudcode-pa.googleapis.com
    """
    return str(
        await get_config_value(
            "code_assist_endpoint", "https://cloudcode-pa.googleapis.com", "CODE_ASSIST_ENDPOINT"
        )
    )


async def get_compatibility_mode_enabled() -> bool:
    """
    Get compatibility mode setting.

    兼容性模式：启用后所有system消息全部转换成user，停用system_instructions。
    该选项可能会降低模型理解能力，但是能避免流式空回的情况。

    Environment variable: COMPATIBILITY_MODE
    Database config key: compatibility_mode_enabled
    Default: False
    """
    env_value = os.getenv("COMPATIBILITY_MODE")
    if env_value:
        return env_value.lower() in ("true", "1", "yes", "on")

    return bool(await get_config_value("compatibility_mode_enabled", False))


async def get_return_thoughts_to_frontend() -> bool:
    """
    Get return thoughts to frontend setting.

    控制是否将思维链返回到前端。
    启用后，思维链会在响应中返回；禁用后，思维链会在响应中被过滤掉。

    Environment variable: RETURN_THOUGHTS_TO_FRONTEND
    Database config key: return_thoughts_to_frontend
    Default: True
    """
    env_value = os.getenv("RETURN_THOUGHTS_TO_FRONTEND")
    if env_value:
        return env_value.lower() in ("true", "1", "yes", "on")

    return bool(await get_config_value("return_thoughts_to_frontend", True))


async def get_antigravity_stream2nostream() -> bool:
    """
    Get use stream for non-stream setting.

    控制antigravity非流式请求是否使用流式API并收集为完整响应。
    启用后，非流式请求将在后端使用流式API，然后收集所有块后再返回完整响应。

    Environment variable: ANTIGRAVITY_STREAM2NOSTREAM
    Database config key: antigravity_stream2nostream
    Default: True
    """
    env_value = os.getenv("ANTIGRAVITY_STREAM2NOSTREAM")
    if env_value:
        return env_value.lower() in ("true", "1", "yes", "on")

    return bool(await get_config_value("antigravity_stream2nostream", True))


async def get_antigravity_switch_credential_enabled() -> bool:
    """
    Get antigravity switch credential setting.

    控制antigravity在重试时是否切换凭证。
    禁用时会持续使用当前凭证，直到该凭证对当前模型进入CD或被禁用。

    Environment variable: ANTIGRAVITY_SWITCH_CREDENTIAL
    Database config key: antigravity_switch_credential_enabled
    Default: False
    """
    env_value = os.getenv("ANTIGRAVITY_SWITCH_CREDENTIAL")
    if env_value:
        return env_value.lower() in ("true", "1", "yes", "on")

    return bool(await get_config_value("antigravity_switch_credential_enabled", False))


async def get_oauth_proxy_url() -> str:
    """
    Get OAuth proxy URL setting.

    用于Google OAuth2认证的代理URL。

    Environment variable: OAUTH_PROXY_URL
    Database config key: oauth_proxy_url
    Default: https://oauth2.googleapis.com
    """
    return str(
        await get_config_value(
            "oauth_proxy_url", "https://oauth2.googleapis.com", "OAUTH_PROXY_URL"
        )
    )


async def get_googleapis_proxy_url() -> str:
    """
    Get Google APIs proxy URL setting.

    用于Google APIs调用的代理URL。

    Environment variable: GOOGLEAPIS_PROXY_URL
    Database config key: googleapis_proxy_url
    Default: https://www.googleapis.com
    """
    return str(
        await get_config_value(
            "googleapis_proxy_url", "https://www.googleapis.com", "GOOGLEAPIS_PROXY_URL"
        )
    )


async def get_resource_manager_api_url() -> str:
    """
    Get Google Cloud Resource Manager API URL setting.

    用于Google Cloud Resource Manager API的URL。

    Environment variable: RESOURCE_MANAGER_API_URL
    Database config key: resource_manager_api_url
    Default: https://cloudresourcemanager.googleapis.com
    """
    return str(
        await get_config_value(
            "resource_manager_api_url",
            "https://cloudresourcemanager.googleapis.com",
            "RESOURCE_MANAGER_API_URL",
        )
    )


async def get_service_usage_api_url() -> str:
    """
    Get Google Cloud Service Usage API URL setting.

    用于Google Cloud Service Usage API的URL。

    Environment variable: SERVICE_USAGE_API_URL
    Database config key: service_usage_api_url
    Default: https://serviceusage.googleapis.com
    """
    return str(
        await get_config_value(
            "service_usage_api_url", "https://serviceusage.googleapis.com", "SERVICE_USAGE_API_URL"
        )
    )


async def get_antigravity_api_url() -> str:
    """
    Get Antigravity API URL setting.

    用于Google Antigravity API的URL。

    Environment variable: ANTIGRAVITY_API_URL
    Database config key: antigravity_api_url
    Default: https://daily-cloudcode-pa.googleapis.com
    """
    return str(
        await get_config_value(
            "antigravity_api_url",
            "https://daily-cloudcode-pa.googleapis.com",
            "ANTIGRAVITY_API_URL",
        )
    )


async def get_keepalive_url() -> str:
    """
    Get keep-alive URL setting.

    配置后保活服务会定期向该URL发送GET请求。
    留空表示禁用保活服务。

    Environment variable: KEEPALIVE_URL
    Database config key: keepalive_url
    Default: "" (disabled)
    """
    return str(await get_config_value("keepalive_url", "", "KEEPALIVE_URL"))


async def get_keepalive_interval() -> int:
    """
    Get keep-alive interval in seconds.

    保活请求发送间隔（秒）。

    Environment variable: KEEPALIVE_INTERVAL
    Database config key: keepalive_interval
    Default: 60
    """
    env_value = os.getenv("KEEPALIVE_INTERVAL")
    if env_value:
        try:
            return int(env_value)
        except ValueError:
            pass

    return int(await get_config_value("keepalive_interval", 60))


# Debug Mode
async def get_debug_mode() -> bool:
    """
    Get debug mode setting.

    调试模式：启用后输出额外的调试日志信息。
    正常模式下这些日志不会输出，不产生任何性能开销。

    Environment variable: DEBUG_MODE
    Database config key: debug_mode
    Default: False
    """
    env_value = os.getenv("DEBUG_MODE")
    if env_value:
        return env_value.lower() in ("true", "1", "yes", "on")

    return bool(await get_config_value("debug_mode", False))


def is_debug_mode() -> bool:
    """
    同步检查调试模式（零开销，直接读内存缓存）。

    用于热路径中的调试日志判断，避免 async 调用开销。
    缓存在 init_config() 和 reload_config() 时自动刷新。
    """
    return _debug_mode_cache


# Streaming TTFT diagnostics (independent from DEBUG_MODE)
async def get_stream_diagnostics_enabled() -> bool:
    """Return the persisted TTFT diagnostics switch with ENV precedence."""
    env_value = os.getenv("STREAM_DIAGNOSTICS_ENABLED")
    if env_value:
        return env_value.strip().lower() in ("true", "1", "yes", "on")

    value = await get_config_value("stream_diagnostics_enabled", False)
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in ("true", "1", "yes", "on")
    return False


def is_stream_diagnostics_enabled() -> bool:
    """Synchronous hot-path getter; an explicit ENV value always wins."""
    env_value = os.getenv("STREAM_DIAGNOSTICS_ENABLED")
    if env_value:
        return env_value.strip().lower() in ("true", "1", "yes", "on")
    return _stream_diagnostics_enabled_cache


async def get_geminicli_capacity_fast_fail_enabled() -> bool:
    """Return the model-capacity fast-fail switch with ENV precedence."""
    env_value = os.getenv("GEMINICLI_CAPACITY_FAST_FAIL_ENABLED")
    if env_value:
        return env_value.strip().lower() in ("true", "1", "yes", "on")
    value = await get_config_value("geminicli_capacity_fast_fail_enabled", False)
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in ("true", "1", "yes", "on")
    return False


def is_geminicli_capacity_fast_fail_enabled() -> bool:
    """Synchronous request-snapshot getter for the capacity fast-fail policy."""
    env_value = os.getenv("GEMINICLI_CAPACITY_FAST_FAIL_ENABLED")
    if env_value:
        return env_value.strip().lower() in ("true", "1", "yes", "on")
    return _geminicli_capacity_fast_fail_enabled_cache


async def get_geminicli_stream_header_hedge_enabled() -> bool:
    """Return the streaming response-header hedge switch with ENV precedence."""
    env_value = os.getenv("GEMINICLI_STREAM_HEADER_HEDGE_ENABLED")
    if env_value:
        return env_value.strip().lower() in ("true", "1", "yes", "on")
    value = await get_config_value("geminicli_stream_header_hedge_enabled", False)
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in ("true", "1", "yes", "on")
    return False


def is_geminicli_stream_header_hedge_enabled() -> bool:
    """Synchronous request-snapshot getter for streaming header hedging."""
    env_value = os.getenv("GEMINICLI_STREAM_HEADER_HEDGE_ENABLED")
    if env_value:
        return env_value.strip().lower() in ("true", "1", "yes", "on")
    return _geminicli_stream_header_hedge_enabled_cache


def _clamp_hedge_sample_rate(value: Any, default: float = 0.05) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    return parsed if 0.0 <= parsed <= 1.0 else default


async def get_geminicli_stream_header_hedge_sample_rate() -> float:
    """Return hedge sampling fraction with ENV precedence."""
    env_value = os.getenv("GEMINICLI_STREAM_HEADER_HEDGE_SAMPLE_RATE")
    if env_value is not None:
        return _clamp_hedge_sample_rate(env_value)
    value = await get_config_value(
        "geminicli_stream_header_hedge_sample_rate", 0.05
    )
    return _clamp_hedge_sample_rate(value)


def get_cached_geminicli_stream_header_hedge_sample_rate() -> float:
    env_value = os.getenv("GEMINICLI_STREAM_HEADER_HEDGE_SAMPLE_RATE")
    if env_value is not None:
        return _clamp_hedge_sample_rate(env_value)
    return _geminicli_stream_header_hedge_sample_rate_cache


def _clamp_hedge_daily_budget(value: Any, default: int = 10) -> int:
    if isinstance(value, bool):
        return default
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return parsed if 0 <= parsed <= 1000 else default


async def get_geminicli_stream_header_hedge_daily_budget() -> int:
    """Return daily budget per backup credential/model family."""
    env_value = os.getenv("GEMINICLI_STREAM_HEADER_HEDGE_DAILY_BUDGET")
    if env_value is not None:
        return _clamp_hedge_daily_budget(env_value)
    value = await get_config_value(
        "geminicli_stream_header_hedge_daily_budget", 10
    )
    return _clamp_hedge_daily_budget(value)


def get_cached_geminicli_stream_header_hedge_daily_budget() -> int:
    env_value = os.getenv("GEMINICLI_STREAM_HEADER_HEDGE_DAILY_BUDGET")
    if env_value is not None:
        return _clamp_hedge_daily_budget(env_value)
    return _geminicli_stream_header_hedge_daily_budget_cache


# Routing Mode（轮巡模式）
async def get_routing_mode() -> str:
    """
    获取轮巡模式。

    - "normal": 默认随机轮巡
    - "unstable": 非稳定期模式，基于 preview 成功率加权选择

    Environment variable: ROUTING_MODE
    Database config key: routing_mode
    Default: "normal"
    """
    env_value = os.getenv("ROUTING_MODE")
    if env_value and env_value.lower() in ("normal", "unstable"):
        return env_value.lower()

    value = await get_config_value("routing_mode", "normal")
    if isinstance(value, str) and value.lower() in ("normal", "unstable"):
        return value.lower()
    return "normal"


def get_routing_mode_sync() -> str:
    """同步获取轮巡模式（零开销，直接读内存缓存）。"""
    return _routing_mode_cache
