"""
配置路由模块 - 处理 /config/* 相关的HTTP请求
"""

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse

import config
from log import log
from src.keeplive import keepalive_service
from src.models import ConfigSaveRequest
from src.storage_adapter import get_storage_adapter
from src.utils import verify_panel_token
from .utils import get_env_locked_keys


# 创建路由器
router = APIRouter(prefix="/config", tags=["config"])


@router.get("/debug-storage")
async def debug_storage():
    """调试端点（无需认证）- 用于排查 storage engine 加载问题"""
    import os
    import traceback
    result = {
        "status": "ok",
        "timestamp": str(__import__('datetime').datetime.now()),
        "env": {
            "MYSQL_URI": "有" if os.getenv("MYSQL_URI") else "无",
            "GCLI_SERVER_NAME": os.getenv("GCLI_SERVER_NAME", "(空)"),
            "MONGODB_URI": "有" if os.getenv("MONGODB_URI") else "无",
        },
        "adapter": {},
        "servers_query": {},
    }
    
    try:
        from src.storage_adapter import _storage_adapter
        result["adapter"]["exists"] = _storage_adapter is not None
        if _storage_adapter:
            result["adapter"]["initialized"] = _storage_adapter._initialized
            if _storage_adapter._initialized:
                result["adapter"]["backend_type"] = _storage_adapter.get_backend_type()
        else:
            result["adapter"]["initialized"] = False
    except Exception as e:
        result["adapter"]["error"] = str(e)
    
    try:
        servers = await _get_servers_list()
        result["servers_query"]["count"] = len(servers)
        result["servers_query"]["names"] = [s["name"] for s in servers[:5]]
    except Exception as e:
        result["servers_query"]["error"] = str(e)
        result["servers_query"]["traceback"] = traceback.format_exc()
    
    return JSONResponse(content=result)

@router.get("/system-status")
async def get_system_status(token: str = Depends(verify_panel_token)):
    """获取系统状态（Redis 缓存状态），仅显示本服务器的内容"""
    import os
    from src.smart_429 import smart_429_service
    result = {
        "redis": {"enabled": False},
        "smart_429": smart_429_service.status(),
    }

    try:
        from src.storage_adapter import _storage_adapter
        if _storage_adapter and _storage_adapter._initialized:
            backend = _storage_adapter._backend
            if hasattr(backend, '_redis_enabled'):
                result["redis"]["enabled"] = backend._redis_enabled
                if backend._redis_enabled and backend._redis:
                    try:
                        # 获取本服务器的 server_name
                        server_name = getattr(backend, '_server_name', 'default')
                        result["redis"]["server_name"] = server_name

                        info = await backend._redis.info("memory")
                        result["redis"]["memory_used_mb"] = round(info.get("used_memory", 0) / 1024 / 1024, 2)

                        # 使用正确的 key 格式（包含 server_name）查询本服务器的池大小
                        gcli_avail = await backend._redis.scard(f"gcli:{server_name}:avail:geminicli")
                        gcli_preview = await backend._redis.scard(f"gcli:{server_name}:preview:geminicli")
                        anti_avail = await backend._redis.scard(f"gcli:{server_name}:avail:antigravity")
                        result["redis"]["pools"] = {
                            "geminicli_avail": gcli_avail,
                            "geminicli_preview": gcli_preview,
                            "antigravity_avail": anti_avail,
                        }

                        # 使用 SCAN 统计本服务器的 key 数量（而非 dbsize 统计所有 key）
                        cursor, count = 0, 0
                        while True:
                            cursor, keys = await backend._redis.scan(cursor, match=f"gcli:{server_name}:*", count=1000)
                            count += len(keys)
                            if cursor == 0:
                                break
                        result["redis"]["total_keys"] = count
                    except Exception as e:
                        result["redis"]["error"] = str(e)
                else:
                    result["redis"]["note"] = "REDIS_URL 未设置或连接失败"
    except Exception as e:
        result["redis"]["error"] = str(e)

    return JSONResponse(content=result)


@router.get("/get")
async def get_config(token: str = Depends(verify_panel_token)):
    """获取当前配置"""
    try:


        # 读取当前配置（包括环境变量和TOML文件中的配置）
        current_config = {}

        # 基础配置
        current_config["code_assist_endpoint"] = await config.get_code_assist_endpoint()
        current_config["credentials_dir"] = await config.get_credentials_dir()
        current_config["proxy"] = await config.get_proxy_config() or ""

        # 代理端点配置
        current_config["oauth_proxy_url"] = await config.get_oauth_proxy_url()
        current_config["googleapis_proxy_url"] = await config.get_googleapis_proxy_url()
        current_config["resource_manager_api_url"] = await config.get_resource_manager_api_url()
        current_config["service_usage_api_url"] = await config.get_service_usage_api_url()
        current_config["antigravity_api_url"] = await config.get_antigravity_api_url()

        # 自动封禁配置
        current_config["auto_ban_enabled"] = await config.get_auto_ban_enabled()
        current_config["auto_ban_error_codes"] = await config.get_auto_ban_error_codes()

        # 429重试配置
        current_config["retry_429_max_retries"] = await config.get_retry_429_max_retries()
        current_config["retry_429_enabled"] = await config.get_retry_429_enabled()
        current_config["retry_429_interval"] = await config.get_retry_429_interval()
        current_config["smart_429_protection_enabled"] = await config.get_smart_429_protection_enabled()
        current_config["smart_429_max_attempts"] = await config.get_smart_429_max_attempts()
        current_config["smart_429_retry_base_interval"] = await config.get_smart_429_retry_base_interval()
        # 抗截断配置
        current_config["anti_truncation_max_attempts"] = await config.get_anti_truncation_max_attempts()

        # 兼容性配置
        current_config["compatibility_mode_enabled"] = await config.get_compatibility_mode_enabled()

        # 思维链返回配置
        current_config["return_thoughts_to_frontend"] = await config.get_return_thoughts_to_frontend()

        # Antigravity流式转非流式配置
        current_config["antigravity_stream2nostream"] = await config.get_antigravity_stream2nostream()
        current_config["antigravity_switch_credential_enabled"] = await config.get_antigravity_switch_credential_enabled()

        # 调试模式
        current_config["debug_mode"] = await config.get_debug_mode()

        # 轮巡模式
        current_config["routing_mode"] = await config.get_routing_mode()

        # 保活配置
        current_config["keepalive_url"] = await config.get_keepalive_url()
        current_config["keepalive_interval"] = await config.get_keepalive_interval()

        # 服务器配置
        current_config["host"] = await config.get_server_host()
        current_config["port"] = await config.get_server_port()
        current_config["api_password"] = await config.get_api_password()
        current_config["panel_password"] = await config.get_panel_password()
        current_config["password"] = await config.get_server_password()

        # 从存储系统读取配置
        storage_adapter = await get_storage_adapter()
        storage_config = await storage_adapter.get_all_config()

        # 获取环境变量锁定的配置键
        env_locked_keys = get_env_locked_keys()

        # 合并存储系统配置（不覆盖环境变量）
        for key, value in storage_config.items():
            if key not in env_locked_keys:
                current_config[key] = value

        return JSONResponse(content={"config": current_config, "env_locked": list(env_locked_keys)})

    except Exception as e:
        log.error(f"获取配置失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/save")
async def save_config(request: ConfigSaveRequest, token: str = Depends(verify_panel_token)):
    """保存配置"""
    try:

        new_config = request.config

        if "smart_429_protection_enabled" in new_config:
            if not isinstance(new_config["smart_429_protection_enabled"], bool):
                raise HTTPException(status_code=400, detail="SMART 429 protection switch must be boolean")
        if "smart_429_max_attempts" in new_config:
            value = new_config["smart_429_max_attempts"]
            if not isinstance(value, int) or isinstance(value, bool) or not 1 <= value <= 5:
                raise HTTPException(status_code=400, detail="SMART 429 attempts must be an integer from 1 to 5")
        if "smart_429_retry_base_interval" in new_config:
            try:
                value = float(new_config["smart_429_retry_base_interval"])
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail="SMART 429 retry interval must be numeric")
            if not 0.1 <= value <= 5:
                raise HTTPException(status_code=400, detail="SMART 429 retry interval must be from 0.1 to 5 seconds")
            new_config["smart_429_retry_base_interval"] = value

        log.debug(f"收到的配置数据: {list(new_config.keys())}")
        log.debug(f"收到的password值: {new_config.get('password', 'NOT_FOUND')}")

        # 验证配置项
        if "retry_429_max_retries" in new_config:
            if (
                not isinstance(new_config["retry_429_max_retries"], int)
                or new_config["retry_429_max_retries"] < 0
            ):
                raise HTTPException(status_code=400, detail="最大429重试次数必须是大于等于0的整数")

        if "retry_429_enabled" in new_config:
            if not isinstance(new_config["retry_429_enabled"], bool):
                raise HTTPException(status_code=400, detail="429重试开关必须是布尔值")

        # 验证新的配置项
        if "retry_429_interval" in new_config:
            try:
                interval = float(new_config["retry_429_interval"])
                if interval < 0.01 or interval > 10:
                    raise HTTPException(status_code=400, detail="429重试间隔必须在0.01-10秒之间")
            except (ValueError, TypeError):
                raise HTTPException(status_code=400, detail="429重试间隔必须是有效的数字")

        if "anti_truncation_max_attempts" in new_config:
            if (
                not isinstance(new_config["anti_truncation_max_attempts"], int)
                or new_config["anti_truncation_max_attempts"] < 1
                or new_config["anti_truncation_max_attempts"] > 10
            ):
                raise HTTPException(
                    status_code=400, detail="抗截断最大重试次数必须是1-10之间的整数"
                )

        if "compatibility_mode_enabled" in new_config:
            if not isinstance(new_config["compatibility_mode_enabled"], bool):
                raise HTTPException(status_code=400, detail="兼容性模式开关必须是布尔值")

        if "return_thoughts_to_frontend" in new_config:
            if not isinstance(new_config["return_thoughts_to_frontend"], bool):
                raise HTTPException(status_code=400, detail="思维链返回开关必须是布尔值")

        if "antigravity_stream2nostream" in new_config:
            if not isinstance(new_config["antigravity_stream2nostream"], bool):
                raise HTTPException(status_code=400, detail="Antigravity流式转非流式开关必须是布尔值")

        if "antigravity_switch_credential_enabled" in new_config:
            if not isinstance(new_config["antigravity_switch_credential_enabled"], bool):
                raise HTTPException(status_code=400, detail="Antigravity切换凭证开关必须是布尔值")

        if "debug_mode" in new_config:
            if not isinstance(new_config["debug_mode"], bool):
                raise HTTPException(status_code=400, detail="调试模式开关必须是布尔值")

        # 验证保活配置
        if "keepalive_url" in new_config:
            if not isinstance(new_config["keepalive_url"], str):
                raise HTTPException(status_code=400, detail="保活URL必须是字符串")

        if "keepalive_interval" in new_config:
            try:
                interval = int(new_config["keepalive_interval"])
                if interval < 5 or interval > 86400:
                    raise HTTPException(status_code=400, detail="保活间隔必须在 5-86400 秒之间")
                new_config["keepalive_interval"] = interval
            except (ValueError, TypeError):
                raise HTTPException(status_code=400, detail="保活间隔必须是有效整数")
        # 验证服务器配置
        if "host" in new_config:
            if not isinstance(new_config["host"], str) or not new_config["host"].strip():
                raise HTTPException(status_code=400, detail="服务器主机地址不能为空")

        if "port" in new_config:
            if (
                not isinstance(new_config["port"], int)
                or new_config["port"] < 1
                or new_config["port"] > 65535
            ):
                raise HTTPException(status_code=400, detail="端口号必须是1-65535之间的整数")

        if "api_password" in new_config:
            if not isinstance(new_config["api_password"], str):
                raise HTTPException(status_code=400, detail="API访问密码必须是字符串")

        if "panel_password" in new_config:
            if not isinstance(new_config["panel_password"], str):
                raise HTTPException(status_code=400, detail="控制面板密码必须是字符串")

        if "password" in new_config:
            if not isinstance(new_config["password"], str):
                raise HTTPException(status_code=400, detail="访问密码必须是字符串")

        # 获取环境变量锁定的配置键
        env_locked_keys = get_env_locked_keys()

        # 直接使用存储适配器保存配置
        storage_adapter = await get_storage_adapter()
        for key, value in new_config.items():
            if key not in env_locked_keys:
                await storage_adapter.set_config(key, value)
                if key in ("password", "api_password", "panel_password"):
                    log.debug(f"设置{key}字段为: {value}")

        # 重新加载配置缓存（关键！）
        await config.reload_config()
        from src.smart_429 import smart_429_service
        await smart_429_service.reconfigure()

        # 如果保活相关配置发生变化，立即重启保活服务
        keepalive_keys = {"keepalive_url", "keepalive_interval"}
        if keepalive_keys & set(new_config.keys()):
            try:
                await keepalive_service.restart()
            except Exception as e:
                log.warning(f"重启保活服务失败: {e}")

        # 验证保存后的结果
        test_api_password = await config.get_api_password()
        test_panel_password = await config.get_panel_password()
        test_password = await config.get_server_password()
        log.debug(f"保存后立即读取的API密码: {test_api_password}")
        log.debug(f"保存后立即读取的面板密码: {test_panel_password}")
        log.debug(f"保存后立即读取的通用密码: {test_password}")

        # 构建响应消息
        response_data = {
            "message": "配置保存成功",
            "saved_config": {k: v for k, v in new_config.items() if k not in env_locked_keys},
            "smart_429": smart_429_service.status(),
        }

        return JSONResponse(content=response_data)

    except HTTPException:
        raise
    except Exception as e:
        log.error(f"保存配置失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/storage-engine")
async def get_storage_engine(token: str = Depends(verify_panel_token)):
    """获取当前存储引擎信息"""
    import os
    log.info("[storage-engine] 端点被调用")
    try:
        mysql_uri = os.getenv("MYSQL_URI", "")
        gcli_server_name = os.getenv("GCLI_SERVER_NAME", "")
        log.info(f"[storage-engine] MYSQL_URI={'有' if mysql_uri else '无'}, GCLI_SERVER_NAME={gcli_server_name or '(空)'}")

        # 从全局适配器读取（绝不主动初始化，避免 lock 死锁）
        backend_type = "unknown"
        try:
            from src.storage_adapter import _storage_adapter
            adapter_ready = _storage_adapter and _storage_adapter._initialized
            log.info(f"[storage-engine] adapter={_storage_adapter is not None}, initialized={adapter_ready}")
            if adapter_ready:
                backend_type = _storage_adapter.get_backend_type()
            else:
                # 适配器尚未就绪，从环境变量推断
                if mysql_uri and gcli_server_name:
                    backend_type = "mysql"
                elif os.getenv("MONGODB_URI"):
                    backend_type = "mongodb"
                else:
                    backend_type = "sqlite"
        except Exception as e:
            log.warning(f"[storage-engine] 读取适配器异常: {e}")

        log.info(f"[storage-engine] backend_type={backend_type}")

        # 获取 servers 列表（非关键，失败返回空）
        servers = []
        try:
            log.info("[storage-engine] 开始获取 servers 列表...")
            servers = await _get_servers_list()
            log.info(f"[storage-engine] 获取到 {len(servers)} 个服务器")
        except Exception as e:
            log.warning(f"[storage-engine] servers 列表获取失败: {e}")

        result = {
            "current_engine": backend_type,
            "mysql_available": bool(mysql_uri),
            "mysql_configured": bool(mysql_uri and gcli_server_name),
            "server_name": gcli_server_name or "",
            "servers": servers,
        }
        log.info(f"[storage-engine] 返回结果: engine={backend_type}, servers={len(servers)}")
        return JSONResponse(content=result)
    except Exception as e:
        log.error(f"[storage-engine] 端点异常: {e}")
        raise HTTPException(status_code=500, detail=str(e))


async def _get_servers_list() -> list:
    """从 servers 表获取服务器列表（弱关联，表不存在时返回空）"""
    import os
    import asyncio
    mysql_uri = os.getenv("MYSQL_URI", "")
    if not mysql_uri:
        return []

    try:
        import aiomysql
    except ImportError:
        log.debug("aiomysql 未安装，跳过 servers 列表获取")
        return []

    async def _query():
        from urllib.parse import urlparse
        parsed = urlparse(mysql_uri)
        conn = await aiomysql.connect(
            host=parsed.hostname or "127.0.0.1",
            port=parsed.port or 3306,
            user=parsed.username or "root",
            password=parsed.password or "",
            db=parsed.path.lstrip("/") or "gcli2api",
            connect_timeout=5,
        )
        try:
            async with conn.cursor() as cur:
                await cur.execute(
                    "SELECT name, url, status FROM servers ORDER BY id"
                )
                rows = await cur.fetchall()
                return [
                    {"name": r[0], "url": r[1], "status": r[2]}
                    for r in rows
                ]
        finally:
            conn.ensure_closed()

    try:
        return await asyncio.wait_for(_query(), timeout=8)
    except Exception as e:
        log.debug(f"获取 servers 列表失败: {e}")
        return []


@router.post("/storage-engine/preview")
async def preview_migration(request: dict, token: str = Depends(verify_panel_token)):
    """预览迁移数据（显示源引擎中的数据量）"""
    try:
        storage_adapter = await get_storage_adapter()
        source_backend = storage_adapter._backend

        # 统计当前引擎中的数据
        gcli_creds = await source_backend.list_credentials(mode="geminicli")
        antigravity_creds = await source_backend.list_credentials(mode="antigravity")
        all_config = await source_backend.get_all_config()

        return JSONResponse(content={
            "source_engine": storage_adapter.get_backend_type(),
            "data": {
                "gcli_credentials": len(gcli_creds),
                "antigravity_credentials": len(antigravity_creds),
                "config": len(all_config) if all_config else 0,
                "total": len(gcli_creds) + len(antigravity_creds) + (len(all_config) if all_config else 0),
            }
        })
    except Exception as e:
        log.error(f"预览迁移数据失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/storage-engine/switch")
async def switch_storage_engine(request: dict, token: str = Depends(verify_panel_token)):
    """切换存储引擎并自动迁移数据（SQLite ↔ MySQL）"""
    import os
    try:
        target_engine = request.get("target_engine", "")
        migrate_data = request.get("migrate_data", True)

        if target_engine not in ("sqlite", "mysql"):
            raise HTTPException(status_code=400, detail="目标引擎必须是 'sqlite' 或 'mysql'")

        storage_adapter = await get_storage_adapter()
        current_type = storage_adapter.get_backend_type()

        if current_type == target_engine:
            return JSONResponse(content={
                "message": f"当前已是 {target_engine.upper()} 引擎，无需切换",
                "engine": current_type,
                "migration": None
            })

        # 初始化目标后端
        if target_engine == "mysql":
            mysql_uri = os.getenv("MYSQL_URI", "")
            if not mysql_uri:
                raise HTTPException(status_code=400, detail="未设置 MYSQL_URI 环境变量，无法切换到 MySQL")

            server_name = request.get("server_name", "") or os.getenv("GCLI_SERVER_NAME", "")
            if not server_name:
                raise HTTPException(status_code=400, detail="切换到 MySQL 需要提供 server_name")
            os.environ["GCLI_SERVER_NAME"] = server_name

            try:
                from src.storage.mysql_manager import MySQLManager
                new_backend = MySQLManager()
                await new_backend.initialize()
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"MySQL 初始化失败: {e}")

        elif target_engine == "sqlite":
            try:
                from src.storage.sqlite_manager import SQLiteManager
                new_backend = SQLiteManager()
                await new_backend.initialize()
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"SQLite 初始化失败: {e}")

        # 执行数据迁移
        migration_result = None
        old_backend = storage_adapter._backend

        if migrate_data and old_backend:
            migration_result = await _migrate_between_backends(old_backend, new_backend)

        # 切换后端
        storage_adapter._backend = new_backend
        if old_backend:
            try:
                await old_backend.close()
            except Exception:
                pass

        new_type = storage_adapter.get_backend_type()
        log.info(f"存储引擎已切换: {current_type} → {new_type}")

        msg = f"已从 {current_type.upper()} 切换到 {new_type.upper()}"
        if migration_result:
            total = migration_result.get("total_migrated", 0)
            msg += f"，已迁移 {total} 条数据"

        return JSONResponse(content={
            "message": msg,
            "engine": new_type,
            "migration": migration_result
        })

    except HTTPException:
        raise
    except Exception as e:
        log.error(f"切换存储引擎失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


async def _migrate_between_backends(source, target) -> dict:
    """在两个 StorageBackend 之间迁移所有数据（并发批量）"""
    import asyncio

    result = {
        "gcli_credentials": {"total": 0, "migrated": 0, "errors": []},
        "antigravity_credentials": {"total": 0, "migrated": 0, "errors": []},
        "config": {"total": 0, "migrated": 0, "errors": []},
        "total_migrated": 0,
    }

    # 并发控制（避免连接池耗尽）
    sem = asyncio.Semaphore(10)

    async def _migrate_one_credential(filename, mode, result_key):
        async with sem:
            try:
                cred_data = await source.get_credential(filename, mode=mode)
                state_data = await source.get_credential_state(filename, mode=mode)
                if cred_data:
                    await target.store_credential(filename, cred_data, mode=mode)
                    if state_data:
                        await target.update_credential_state(filename, state_data, mode=mode)
                    result[result_key]["migrated"] += 1
            except Exception as e:
                result[result_key]["errors"].append(f"{filename}: {str(e)}")
                log.warning(f"迁移凭证 {filename} 失败: {e}")

    tasks = []

    # 批量迁移 GCLI 凭证
    try:
        gcli_files = await source.list_credentials(mode="geminicli")
        result["gcli_credentials"]["total"] = len(gcli_files)
        for f in gcli_files:
            tasks.append(_migrate_one_credential(f, "geminicli", "gcli_credentials"))
    except Exception as e:
        log.error(f"列出 GCLI 凭证失败: {e}")

    # 批量迁移 Antigravity 凭证
    try:
        ag_files = await source.list_credentials(mode="antigravity")
        result["antigravity_credentials"]["total"] = len(ag_files)
        for f in ag_files:
            tasks.append(_migrate_one_credential(f, "antigravity", "antigravity_credentials"))
    except Exception as e:
        log.error(f"列出 Antigravity 凭证失败: {e}")

    # 并发执行所有凭证迁移
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)

    # 迁移配置（通常很少，顺序即可）
    try:
        all_config = await source.get_all_config()
        if all_config:
            result["config"]["total"] = len(all_config)
            for key, value in all_config.items():
                try:
                    await target.set_config(key, value)
                    result["config"]["migrated"] += 1
                except Exception as e:
                    result["config"]["errors"].append(f"{key}: {str(e)}")
                    log.warning(f"迁移配置 {key} 失败: {e}")
    except Exception as e:
        log.error(f"获取配置数据失败: {e}")

    result["total_migrated"] = (
        result["gcli_credentials"]["migrated"] +
        result["antigravity_credentials"]["migrated"] +
        result["config"]["migrated"]
    )

    log.info(f"数据迁移完成: GCLI {result['gcli_credentials']['migrated']}/{result['gcli_credentials']['total']}, "
             f"Antigravity {result['antigravity_credentials']['migrated']}/{result['antigravity_credentials']['total']}, "
             f"Config {result['config']['migrated']}/{result['config']['total']}")

    return result
