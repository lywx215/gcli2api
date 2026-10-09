"""
凭证管理器
"""

import asyncio
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from log import log

from src.google_oauth_api import Credentials
from src.storage_adapter import get_storage_adapter
from src.antigravity_import_limits import import_write_slot

def _credential_label(name, mode):
    if mode != "antigravity":
        return name
    from src.diagnostics.runtime import active_server
    server = active_server()
    return server.rt.credential(name) if server else "[credential]"


def _fire_and_forget_cb(task: asyncio.Task):
    """回调：消费 fire-and-forget 任务的异常，防止任务对象泄漏"""
    if task.cancelled():
        return
    exc = task.exception()
    if exc:
        log.warning(f"[FireAndForget] 任务异常: {exc}")


class CredentialStorageError(RuntimeError):
    """Safe error exposed by Antigravity import entry points."""

    code = "credential_store_failed"

    def __init__(self):
        super().__init__("凭证存储失败，请稍后重试")


class CredentialManager:
    """
    统一凭证管理器
    所有存储操作通过storage_adapter进行
    """

    def __init__(self):
        # 核心状态
        self._initialized = False
        self._storage_adapter = None

        # 并发控制（简化）
        # 后端数据库自行处理并发，credential_manager 不再使用本地锁

    async def _ensure_initialized(self):
        """确保管理器已初始化（内部使用）"""
        if not self._initialized or self._storage_adapter is None:
            await self.initialize()

    async def initialize(self):
        """初始化凭证管理器"""
        if self._initialized and self._storage_adapter is not None:
            return

        # 初始化统一存储适配器
        self._storage_adapter = await get_storage_adapter()
        self._initialized = True
        backend = self._storage_adapter._backend
        if not getattr(backend, "model_access_storage_ready", False) and callable(getattr(backend, "model_access_initialize", None)):
            try:
                await backend.model_access_initialize()
            except Exception:
                backend.model_access_storage_ready = False
                log.warning("[ANTIGRAVITY] model access storage unavailable")

    async def close(self):
        """清理资源"""
        log.debug("Closing credential manager...")
        self._initialized = False
        log.debug("Credential manager closed")

    async def get_valid_credential(self, mode="geminicli", model_name=None, excluded_credentials=None):
        from src.antigravity_model_access import access_model
        if mode == "antigravity" and access_model(model_name):
            await self._ensure_initialized()
            from src.antigravity_access_runtime import model_access_service
            return await model_access_service.select(self, model_name, excluded_credentials)
        return await self._get_valid_credential_unchecked(mode, model_name, excluded_credentials)

    async def _get_valid_credential_unchecked(
        self,
        mode: str = "geminicli",
        model_name: Optional[str] = None,
        excluded_credentials: Optional[set[str]] = None,
    ) -> Optional[Tuple[str, Dict[str, Any]]]:
        """
        获取有效的凭证 - 随机负载均衡版
        每次随机选择一个可用的凭证（未禁用、未冷却、符合preview要求）
        如果刷新失败会自动禁用失效凭证并重试获取下一个可用凭证

        Args:
            mode: 凭证模式 ("geminicli" 或 "antigravity")
            model_name: 完整模型名，用于模型级冷却检查和preview筛选
                       - geminicli: 完整模型名
                                   - 包含 "preview" 的模型只能使用 preview=True 的凭证
                                   - 不包含 "preview" 的模型优先使用 preview=False 的凭证
                       - antigravity: 完整模型名（如 "gemini-2.0-flash-exp"）
        """
        await self._ensure_initialized()

        # 最多重试3次
        max_retries = 3
        from config import is_smart_429_protection_enabled
        excluded = (
            set(excluded_credentials or ())
            if mode == "antigravity" or is_smart_429_protection_enabled()
            else set()
        )
        for attempt in range(max_retries):
            try:
                result = await self._storage_adapter._backend.get_next_available_credential(
                    mode=mode, model_name=model_name, excluded_credentials=excluded,
                )
            except Exception as exc:
                if mode != "antigravity":
                    raise
                log.warning(f"[ANTIGRAVITY] selection unavailable: {type(exc).__name__}")
                return None

            # 如果没有可用凭证，直接返回None
            if not result:
                if attempt == 0:
                    log.warning(f"没有可用凭证 (mode={mode}, model_name={model_name})")
                return None

            filename, credential_data = result

            # Token 刷新检查
            if await self._should_refresh_token(credential_data):
                log.debug(f"Token需要刷新 - 文件: {_credential_label(filename, mode)} (mode={mode})")
                refreshed_data = await self._refresh_token(credential_data, filename, mode=mode)
                if refreshed_data:
                    # 刷新成功，返回凭证
                    credential_data = refreshed_data
                    log.debug(f"Token刷新成功: {_credential_label(filename, mode)} (mode={mode})")
                    return filename, credential_data
                else:
                    # 刷新失败（_refresh_token内部已自动禁用失效凭证）
                    log.warning(f"Token刷新失败，尝试获取下一个凭证: {_credential_label(filename, mode)} (mode={mode}, attempt={attempt+1}/{max_retries})")
                    # 继续循环，尝试获取下一个可用凭证
                    excluded.add(filename)
                    continue
            else:
                # Token有效，直接返回
                return filename, credential_data

        # 重试次数用尽
        log.error(f"重试{max_retries}次后仍无可用凭证 (mode={mode}, model_name={model_name})")
        return None

    async def model_access_generation_result(self, filename, admission, model, status):
        from src.antigravity_model_access import access_model
        target = access_model(model)
        if target and admission and status in (200, 404):
            backend = self._storage_adapter._backend
            try:
                return await backend.model_access_observe(filename, admission.get("model_access_snapshot"),
                    model=target, success=status == 200,
                    reason="generation_succeeded" if status == 200 else "generation_404")
            except Exception:
                log.warning("[ANTIGRAVITY] model access result persistence unavailable")
                return False
        return False

    async def quota_disable(self, filename, generation, expected_version=None):
        await self._ensure_initialized()
        return await self._storage_adapter._backend.quota_disable(filename, generation, expected_version)

    async def quota_admit(self, filename, model, generation=None, version=None, purpose="business"):
        await self._ensure_initialized()
        try:
            return await self._storage_adapter._backend.quota_admit(filename, model, purpose, generation, version)
        except Exception as exc:
            log.warning(f"[ANTIGRAVITY] admission unavailable: {type(exc).__name__}")
            return None

    async def add_credential(self, credential_name: str, credential_data: Dict[str, Any]):
        """
        新增或更新一个凭证
        存储层会自动处理轮换顺序
        """
        await self._ensure_initialized()
        await self._storage_adapter.store_credential(credential_name, credential_data)
        log.info(f"Credential added/updated: {credential_name}")

    async def add_antigravity_credential(self, credential_name: str, credential_data: Dict[str, Any], *, initial_state=None):
        """
        新增或更新一个Antigravity凭证
        存储层会自动处理轮换顺序
        """
        try:
            await self._ensure_initialized()
            async with import_write_slot():
                stored = await self._storage_adapter.import_antigravity_credential(
                    credential_name, credential_data, initial_state=initial_state
                )
        except Exception:
            raise CredentialStorageError() from None
        if not stored:
            raise CredentialStorageError()
        log.info("Antigravity credential added/updated")

    async def add_antigravity_credential_with_receipt(self, credential_name: str, credential_data: Dict[str, Any], *, initial_state=None):
        """Save an upload and return only its own committed storage identity."""
        try:
            await self._ensure_initialized()
            async with import_write_slot():
                receipt = await self._storage_adapter.import_antigravity_credential_with_receipt(
                    credential_name, credential_data, initial_state=initial_state)
        except Exception:
            raise CredentialStorageError() from None
        if receipt is None:
            raise CredentialStorageError()
        log.info("Antigravity credential added/updated")
        return receipt

    async def quota_current_credential(self, filename, generation):
        await self._ensure_initialized()
        return await self._storage_adapter.quota_current_credential(filename, generation)

    async def quota_refresh_credential(self, filename, generation, credential_data, expected_version=None, state_updates=None):
        await self._ensure_initialized()
        return await self._storage_adapter.quota_refresh_credential(filename, generation,
            credential_data, expected_version=expected_version, state_updates=state_updates)

    async def remove_credential(self, credential_name: str, mode: str = "geminicli") -> bool:
        """删除一个凭证"""
        await self._ensure_initialized()
        try:
            if mode == "geminicli":
                state = await self._storage_adapter.get_credential_state(credential_name, mode=mode)
                await self._storage_adapter.update_credential_state(
                    credential_name,
                    {"health_state_version": int(state.get("health_state_version", 0) or 0) + 1},
                    mode=mode,
                )
            await self._storage_adapter.delete_credential(credential_name, mode=mode)
            log.info(f"Credential removed: {_credential_label(credential_name, mode)} (mode={mode})")
            return True
        except Exception as e:
            log.error(f"Error removing credential {_credential_label(credential_name, mode)}: {type(e).__name__ if mode == "antigravity" else str(e)}")
            return False

    async def update_credential_state(self, credential_name: str, state_updates: Dict[str, Any], mode: str = "geminicli"):
        """更新凭证状态"""
        log.debug(f"[CredMgr] update_credential_state 开始: credential_name={_credential_label(credential_name, mode)}, state_updates={state_updates if mode != "antigravity" else "[state update]"}, mode={mode}")
        log.debug(f"[CredMgr] 调用 _ensure_initialized...")
        await self._ensure_initialized()
        if (
            mode == "geminicli"
            and "permanent_disabled" in state_updates
            and "health_state_version" not in state_updates
        ):
            current = await self._storage_adapter.get_credential_state(credential_name, mode=mode)
            state_updates = dict(state_updates)
            state_updates["health_state_version"] = int(current.get("health_state_version", 0) or 0) + 1
        log.debug(f"[CredMgr] _ensure_initialized 完成")
        try:
            log.debug(f"[CredMgr] 调用 storage_adapter.update_credential_state...")
            success = await self._storage_adapter.update_credential_state(
                credential_name, state_updates, mode=mode
            )
            log.debug(f"[CredMgr] storage_adapter.update_credential_state 返回: {success}")
            if success:
                log.debug(f"Updated credential state: {_credential_label(credential_name, mode)} (mode={mode})")
            else:
                log.warning(f"Failed to update credential state: {_credential_label(credential_name, mode)} (mode={mode})")
            return success
        except Exception as e:
            log.error(f"Error updating credential state {_credential_label(credential_name, mode)}: {type(e).__name__ if mode == "antigravity" else str(e)}")
            return False

    async def set_cred_disabled(self, credential_name: str, disabled: bool, mode: str = "geminicli"):
        """设置凭证的启用/禁用状态"""
        try:
            log.info(f"[CredMgr] set_cred_disabled 开始: credential_name={_credential_label(credential_name, mode)}, disabled={disabled}, mode={mode}")
            updates = {"disabled": disabled}
            if not disabled:
                updates["permanent_disabled"] = False
            if mode == "geminicli":
                await self._ensure_initialized()
                state = await self._storage_adapter.get_credential_state(credential_name, mode=mode)
                updates["health_state_version"] = int(state.get("health_state_version", 0) or 0) + 1
                if not disabled:
                    updates.update(
                        health_status="healthy",
                        quarantine_reason=None,
                        probe_stage=0,
                        next_probe_at=None,
                    )
            success = await self.update_credential_state(
                credential_name, updates, mode=mode
            )
            log.info(f"[CredMgr] update_credential_state 返回: success={success}")
            if success:
                action = "disabled" if disabled else "enabled"
                log.info(f"Credential {action}: {_credential_label(credential_name, mode)} (mode={mode})")
            else:
                log.warning(f"[CredMgr] 设置禁用状态失败: credential_name={_credential_label(credential_name, mode)}, disabled={disabled}")
            return success
        except Exception as e:
            log.error(f"Error setting credential disabled state {_credential_label(credential_name, mode)}: {type(e).__name__ if mode == "antigravity" else str(e)}")
            return False

    async def get_creds_status(self) -> Dict[str, Dict[str, Any]]:
        """获取所有凭证的状态"""
        await self._ensure_initialized()
        try:
            return await self._storage_adapter.get_all_credential_states()
        except Exception as e:
            log.error(f"Error getting credential statuses: {e}")
            return {}

    async def get_creds_summary(self) -> List[Dict[str, Any]]:
        """
        获取所有凭证的摘要信息（轻量级，不包含完整凭证数据）
        使用后端的高性能查询
        """
        await self._ensure_initialized()
        try:
            return await self._storage_adapter._backend.get_credentials_summary()
        except Exception as e:
            log.error(f"Error getting credentials summary: {e}")
            return []

    async def get_or_fetch_user_email(self, credential_name: str, mode: str = "geminicli") -> Optional[str]:
        """获取或获取用户邮箱地址"""
        try:
            # 确保已初始化
            await self._ensure_initialized()
            
            # 从状态中获取缓存的邮箱
            state = await self._storage_adapter.get_credential_state(credential_name, mode=mode)
            cached_email = state.get("user_email") if state else None

            if cached_email:
                return cached_email

            quota_snapshot = (await self._storage_adapter._backend.quota_credential_fence(credential_name)
                              if mode == "antigravity" else None)
            quota_version = (quota_snapshot or {}).get("_quota_credential_version")
            # 如果没有缓存，从凭证数据获取
            credential_data = await self._storage_adapter.get_credential(credential_name, mode=mode)
            if not credential_data:
                return None

            # 创建凭证对象并自动刷新 token
            from .google_oauth_api import Credentials, get_user_email

            credentials = Credentials.from_dict(credential_data)
            if not credentials:
                return None

            # 自动刷新 token（如果需要）
            token_refreshed = await credentials.refresh_if_needed()

            # 如果 token 被刷新了，更新存储
            if token_refreshed:
                log.info(f"Token已自动刷新: {_credential_label(credential_name, mode)} (mode={mode})")
                updated_data = credentials.to_dict()
                if mode == "antigravity":
                    saved = await self._storage_adapter._backend.quota_refresh_credential(
                        credential_name, (quota_snapshot or {}).get("quota_credential_generation"),
                        updated_data, expected_version=quota_version)
                    if not saved:
                        return None
                    from src.storage.antigravity_quota import credential_version
                    quota_version = credential_version(updated_data)
                else:
                    await self._storage_adapter.store_credential(credential_name, updated_data, mode=mode)

            # 获取邮箱
            email = await get_user_email(credentials)

            if email:
                # 缓存邮箱地址
                if mode == "antigravity":
                    saved = await self._storage_adapter._backend.quota_refresh_credential(
                        credential_name, (quota_snapshot or {}).get("quota_credential_generation"), None,
                        expected_version=quota_version, state_updates={"user_email": email})
                    if not saved:
                        return None
                else:
                    await self._storage_adapter.update_credential_state(
                        credential_name, {"user_email": email}, mode=mode
                    )
                return email

            return None

        except Exception as e:
            log.error(f"Error fetching user email for {_credential_label(credential_name, mode)}: {type(e).__name__ if mode == "antigravity" else str(e)}")
            return None

    async def record_api_call_result(
        self,
        credential_name: str,
        success: bool,
        error_code: Optional[int] = None,
        cooldown_until: Optional[float] = None,
        mode: str = "geminicli",
        model_name: Optional[str] = None,
        error_message: Optional[str] = None,
        admission: Optional[dict] = None,
    ):
        """
        记录API调用结果

        Args:
            credential_name: 凭证名称
            success: 是否成功
            error_code: 错误码（如果失败）
            cooldown_until: 冷却截止时间戳（Unix时间戳，针对429 QUOTA_EXHAUSTED）
            mode: 凭证模式 ("geminicli" 或 "antigravity")
            model_name: 模型名（用于设置模型级冷却）
            error_message: 错误信息（如果失败）
        """
        await self._ensure_initialized()
        if mode == "antigravity" and admission is not None:
            from src.diagnostics.antigravity import safe_error
            try:
                return await self._storage_adapter._backend.quota_record_result(
                    credential_name, admission, model_name, success, error_code, cooldown_until,
                    safe_error(error_code, error_message) if not success else None,
                )
            except Exception as exc:
                from src.router.model_api_errors import ModelApiErrorException, make_model_api_error, ErrorOrigin, ErrorKind
                log.warning(f"[ANTIGRAVITY] settlement unavailable: {type(exc).__name__}")
                raise ModelApiErrorException(make_model_api_error(origin=ErrorOrigin.LOCAL, kind=ErrorKind.HTTP, status=503)) from None
        try:
            if success:
            # 条件写入：仅当凭证有错误状态或模型冷却时才写 DB，零内存缓存
            # fire-and-forget，不阻塞请求链路
                task = asyncio.create_task(
                    self._storage_adapter._backend.record_success(
                        credential_name, model_name=model_name, mode=mode
                    )
                )
                task.add_done_callback(_fire_and_forget_cb)

            elif error_code:
                # 记录错误码和错误信息
                error_messages = {}
                if error_message:
                    error_messages[str(error_code)] = error_message

                if hasattr(self._storage_adapter._backend, "record_failure"):
                    await self._storage_adapter._backend.record_failure(
                        credential_name,
                        error_code,
                        error_message=error_message,
                        mode=mode,
                        model_name=model_name,
                    )
                else:
                    state_updates = {
                        "error_codes": [error_code],
                        "error_messages": error_messages,
                    }
                    await self.update_credential_state(credential_name, state_updates, mode=mode)

                # 设置模型级冷却
                if cooldown_until is not None and model_name:
                    if hasattr(self._storage_adapter._backend, 'set_model_cooldown'):
                        await self._storage_adapter._backend.set_model_cooldown(
                            credential_name, model_name, cooldown_until, mode=mode
                        )
                        log.info(
                            f"设置模型级冷却: {_credential_label(credential_name, mode)}, model_name={model_name}, "
                            f"冷却至: {datetime.fromtimestamp(cooldown_until, timezone.utc).isoformat()}"
                        )

        except Exception as e:
            log.error(f"Error recording API call result for {_credential_label(credential_name, mode)}: {type(e).__name__ if mode == "antigravity" else str(e)}")

    async def _should_refresh_token(self, credential_data: Dict[str, Any]) -> bool:
        """检查token是否需要刷新"""
        try:
            # 如果没有access_token或过期时间，需要刷新
            if not credential_data.get("access_token") and not credential_data.get("token"):
                log.debug("没有access_token，需要刷新")
                return True

            expiry_str = credential_data.get("expiry")
            if not expiry_str:
                log.debug("没有过期时间，需要刷新")
                return True

            # 解析过期时间
            try:
                if isinstance(expiry_str, str):
                    if "+" in expiry_str:
                        file_expiry = datetime.fromisoformat(expiry_str)
                    elif expiry_str.endswith("Z"):
                        file_expiry = datetime.fromisoformat(expiry_str.replace("Z", "+00:00"))
                    else:
                        file_expiry = datetime.fromisoformat(expiry_str)
                else:
                    log.debug("过期时间格式无效，需要刷新")
                    return True

                # 确保时区信息
                if file_expiry.tzinfo is None:
                    file_expiry = file_expiry.replace(tzinfo=timezone.utc)

                # 检查是否还有至少5分钟有效期
                now = datetime.now(timezone.utc)
                time_left = (file_expiry - now).total_seconds()

                log.debug(
                    f"Token时间检查: "
                    f"当前UTC时间={now.isoformat()}, "
                    f"过期时间={file_expiry.isoformat()}, "
                    f"剩余时间={int(time_left/60)}分{int(time_left%60)}秒"
                )

                if time_left > 300:  # 5分钟缓冲
                    return False
                else:
                    log.debug(f"Token即将过期（剩余{int(time_left/60)}分钟），需要刷新")
                    return True

            except Exception as e:
                log.warning(f"解析过期时间失败: {e}，需要刷新")
                return True

        except Exception as e:
            log.error(f"检查token过期时出错: {e}")
            return True

    async def _refresh_token(
        self, credential_data: Dict[str, Any], filename: str, mode: str = "geminicli",
        *, deadline=None, atomic=None
    ) -> Optional[Dict[str, Any]]:
        """刷新token并更新存储"""
        if mode == "antigravity" and deadline is None:
            from src.antigravity_directory_runtime import work_deadline, atomic_registry
            deadline = work_deadline.get()
            if deadline is not None and atomic is None:
                atomic = atomic_registry.run
        await self._ensure_initialized()
        async def fenced(operation):
            if mode == "antigravity" and atomic is not None:
                return await atomic(operation, deadline=deadline, phase="credential_cas")
            return await operation()
        try:
            # 创建Credentials对象
            creds = Credentials.from_dict(credential_data)

            # 检查是否可以刷新
            if not creds.refresh_token:
                log.error(f"没有refresh_token，无法刷新: {_credential_label(filename, mode)} (mode={mode})")
                # 自动禁用没有refresh_token的凭证
                try:
                    disabled_ok = (await fenced(lambda: self.quota_disable(filename, credential_data.get("_quota_generation"), credential_data.get("_quota_credential_version"))) if mode == "antigravity" else await self.update_credential_state(filename, {"disabled": True}, mode=mode))
                    if disabled_ok:
                        log.warning(f"凭证已自动禁用（缺少refresh_token）: {_credential_label(filename, mode)}")
                    else:
                        log.info("缺少refresh_token的旧凭证未执行禁用：身份或内容已变化")
                except Exception as e:
                    if mode == "antigravity" and deadline is not None:
                        from src.antigravity_directory_runtime import QuotaWorkError
                        if isinstance(e, QuotaWorkError):
                            raise
                    log.error(f"禁用凭证失败 {_credential_label(filename, mode)}: {type(e).__name__ if mode == "antigravity" else str(e)}")
                return None

            # 刷新token
            log.debug(f"正在刷新token: {_credential_label(filename, mode)} (mode={mode})")
            if mode == "antigravity" and deadline is not None:
                from src.antigravity_directory_runtime import remaining, QuotaWorkError
                try:
                    async with asyncio.timeout(min(15.0, remaining(deadline, "oauth"))):
                        await creds.refresh()
                except TimeoutError:
                    raise QuotaWorkError("quota_timeout", "oauth") from None
            else:
                await creds.refresh()

            # 更新凭证数据
            if creds.access_token:
                credential_data["access_token"] = creds.access_token
                # 保持兼容性
                credential_data["token"] = creds.access_token

            if creds.expires_at:
                credential_data["expiry"] = creds.expires_at.isoformat()

            # 保存到存储
            if mode == "antigravity":
                saved = await fenced(lambda: self._storage_adapter._backend.quota_refresh_credential(
                    filename, credential_data.get("_quota_generation"), credential_data,
                    expected_version=credential_data.get("_quota_credential_version"),
                ))
                if not saved:
                    # A concurrent refresh may already have won the CAS. Reuse
                    # the authoritative fresh token without writing the old data.
                    current = await self._storage_adapter._backend.quota_current_credential(
                        filename, credential_data.get("_quota_generation"))
                    if current and (current.get("access_token") or current.get("token")) and not await self._should_refresh_token(current):
                        return current
                    return None
            else:
                await self._storage_adapter.store_credential(filename, credential_data, mode=mode)
            if mode == "antigravity":
                from src.storage.antigravity_quota import credential_version
                credential_data["_quota_credential_version"] = credential_version({k: v for k, v in credential_data.items() if not k.startswith("_quota_")})
            log.info(f"Token刷新成功并已保存: {_credential_label(filename, mode)} (mode={mode})")

            return credential_data

        except Exception as e:
            if mode == "antigravity" and deadline is not None:
                from src.antigravity_directory_runtime import QuotaWorkError
                if isinstance(e, QuotaWorkError):
                    raise
            error_msg = str(e)
            log.error(f"Token刷新失败 {_credential_label(filename, mode)} (mode={mode}): {type(e).__name__ if mode == "antigravity" else error_msg}")

            # 尝试提取HTTP状态码（TokenError可能携带status_code属性）
            status_code = None
            if hasattr(e, 'status_code'):
                status_code = e.status_code

            # 检查是否是凭证永久失效的错误（只有明确的400/403等才判定为永久失效）
            is_permanent_failure = self._is_permanent_refresh_failure(error_msg, status_code)

            if is_permanent_failure:
                log.warning(f"检测到凭证永久失效 (HTTP {status_code}): {_credential_label(filename, mode)}")
                # 记录失效状态
                if mode != "antigravity":
                    await self.record_api_call_result(filename, False, status_code or 400, mode=mode)

                # 禁用失效凭证
                try:
                    # 直接禁用该凭证（随机选择机制会自动跳过它）
                    disabled_ok = (await fenced(lambda: self.quota_disable(filename, credential_data.get("_quota_generation"), credential_data.get("_quota_credential_version"))) if mode == "antigravity" else await self.update_credential_state(filename, {"disabled": True}, mode=mode))
                    if disabled_ok:
                        log.warning(f"永久失效凭证已禁用: {_credential_label(filename, mode)}")
                    else:
                        log.warning("永久失效凭证禁用失败，将由上层逻辑继续处理")
                except Exception as e2:
                    if mode == "antigravity" and deadline is not None:
                        from src.antigravity_directory_runtime import QuotaWorkError
                        if isinstance(e2, QuotaWorkError):
                            raise
                    log.error(f"禁用永久失效凭证时出错 {_credential_label(filename, mode)}: {type(e2).__name__ if mode == "antigravity" else str(e2)}")
            else:
                # 网络错误或其他临时性错误，不封禁凭证
                log.warning(f"Token刷新失败但非永久性错误 (HTTP {status_code})，不封禁凭证: {_credential_label(filename, mode)}")

            return None

    def _is_permanent_refresh_failure(self, error_msg: str, status_code: Optional[int] = None) -> bool:
        """
        判断是否是凭证永久失效的错误

        Args:
            error_msg: 错误信息
            status_code: HTTP状态码（如果有）

        Returns:
            True表示凭证永久失效应封禁，False表示临时错误不应封禁
        """
        # 优先使用HTTP状态码判断
        if status_code is not None:
            # 400/401/403 明确表示凭证有问题，应该封禁
            if status_code in [400, 401, 403]:
                log.debug(f"检测到客户端错误状态码 {status_code}，判定为永久失效")
                return True
            # 500/502/503/504 是服务器错误，不应封禁凭证
            elif status_code in [500, 502, 503, 504]:
                log.debug(f"检测到服务器错误状态码 {status_code}，不应封禁凭证")
                return False
            # 429 (限流) 不应封禁凭证
            elif status_code == 429:
                log.debug("检测到限流错误 429，不应封禁凭证")
                return False

        # 如果没有状态码，回退到错误信息匹配（谨慎判断）
        # 只有明确的凭证失效错误才判定为永久失效
        permanent_error_patterns = [
            "invalid_grant",
            "refresh_token_expired",
            "invalid_refresh_token",
            "unauthorized_client",
            "access_denied",
        ]

        error_msg_lower = error_msg.lower()
        for pattern in permanent_error_patterns:
            if pattern.lower() in error_msg_lower:
                log.debug(f"错误信息匹配到永久失效模式: {pattern}")
                return True

        # 默认认为是临时错误（如网络问题），不应封禁凭证
        log.debug("未匹配到明确的永久失效模式，判定为临时错误")
        return False

class _CredentialManagerSingleton:
    """单例包装器，支持懒加载和自动初始化"""

    _instance: Optional[CredentialManager] = None
    _lock = None

    def __init__(self):
        self._manager = None

    async def _get_or_create(self) -> CredentialManager:
        """获取或创建单例实例（线程安全）"""
        if self._instance is None:
            # 简单的实例创建（异步环境下一般不需要复杂的锁）
            if self._instance is None:
                self._instance = CredentialManager()
                await self._instance.initialize()
                log.debug("CredentialManager singleton initialized")

        return self._instance

    def __getattr__(self, name):
        """代理所有方法调用到真实的 CredentialManager 实例"""
        async def _async_wrapper(*args, **kwargs):
            manager = await self._get_or_create()
            method = getattr(manager, name)
            return await method(*args, **kwargs)

        return _async_wrapper


# 全局单例实例 - 直接导入即可使用
credential_manager = _CredentialManagerSingleton()
