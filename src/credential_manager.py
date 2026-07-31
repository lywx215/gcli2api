"""
凭证管理器
"""

import asyncio
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from log import log
from src.log_safety import credential_log_id, safe_exception

from src.google_oauth_api import Credentials
from src.storage_adapter import get_storage_adapter
from src.streaming_latency import (
    StreamLatencyConfig,
    StreamPhase,
    current_stream_trace,
)


def _fire_and_forget_cb(task: asyncio.Task):
    """回调：消费 fire-and-forget 任务的异常，防止任务对象泄漏"""
    if task.cancelled():
        return
    exc = task.exception()
    if exc:
        log.warning(f"[FireAndForget] 任务异常: {exc}")


class CredentialManager:
    """
    统一凭证管理器
    所有存储操作通过storage_adapter进行
    """

    def __init__(self):
        # 核心状态
        self._initialized = False
        self._storage_adapter = None
        self._init_lock = asyncio.Lock()
        self._refresh_lock = asyncio.Lock()
        self._refresh_tasks: Dict[Tuple[str, str], asyncio.Task] = {}

    async def _ensure_initialized(self):
        """确保管理器已初始化（内部使用）"""
        if not self._initialized or self._storage_adapter is None:
            await self.initialize()

    async def initialize(self):
        """初始化凭证管理器"""
        if self._initialized and self._storage_adapter is not None:
            return
        async with self._init_lock:
            if self._initialized and self._storage_adapter is not None:
                return
            adapter = await get_storage_adapter()
            self._storage_adapter = adapter
            self._initialized = True

    async def close(self):
        """清理资源"""
        log.debug("Closing credential manager...")
        async with self._refresh_lock:
            tasks = list(self._refresh_tasks.values())
            self._refresh_tasks.clear()
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._initialized = False
        log.debug("Credential manager closed")

    async def get_valid_credential(
        self,
        mode: str = "geminicli",
        model_name: Optional[str] = None,
        excluded_credentials: Optional[set[str]] = None,
    ) -> Optional[Tuple[str, Dict[str, Any]]]:
        """
        获取有效的凭证 - 随机负载均衡版
        每次随机选择一个可用的凭证（未禁用、未冷却、符合preview要求）
        刷新失败会排除当前凭证；仅明确永久失效时禁用，并尝试下一个可用凭证

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
        excluded = set(excluded_credentials or ())
        for attempt in range(max_retries):
            result = await self._storage_adapter._backend.get_next_available_credential(
                mode=mode,
                model_name=model_name,
                excluded_credentials=excluded,
            )

            # 如果没有可用凭证，直接返回None
            if not result:
                if attempt == 0:
                    log.warning(f"没有可用凭证 (mode={mode}, model_name={model_name})")
                return None

            filename, credential_data = result

            seconds_left = self._token_seconds_left(credential_data)
            if seconds_left <= 60:
                log.debug(f"Token需要同步刷新: credential={credential_log_id(filename)} (mode={mode})")
                refreshed_data = await self._wait_for_refresh(credential_data, filename, mode=mode)
                if refreshed_data:
                    # 刷新成功，返回凭证
                    credential_data = refreshed_data
                    log.debug(f"Token刷新成功: credential={credential_log_id(filename)} (mode={mode})")
                    return filename, credential_data
                else:
                    # 刷新失败（_refresh_token内部已自动禁用失效凭证）
                    log.warning(f"Token刷新失败，尝试获取下一个凭证: credential={credential_log_id(filename)} (mode={mode}, attempt={attempt+1}/{max_retries})")
                    # 继续循环，尝试获取下一个可用凭证
                    excluded.add(filename)
                    continue
            if seconds_left <= 600:
                await self._ensure_refresh_task(credential_data, filename, mode=mode)
            return filename, credential_data

        # 重试次数用尽
        log.error(f"重试{max_retries}次后仍无可用凭证 (mode={mode}, model_name={model_name})")
        return None

    async def add_credential(self, credential_name: str, credential_data: Dict[str, Any]):
        """
        新增或更新一个凭证
        存储层会自动处理轮换顺序
        """
        await self._ensure_initialized()
        await self._storage_adapter.store_credential(credential_name, credential_data)
        log.info(f"Credential added/updated: {credential_log_id(credential_name)}")

    async def add_antigravity_credential(self, credential_name: str, credential_data: Dict[str, Any]):
        """
        新增或更新一个Antigravity凭证
        存储层会自动处理轮换顺序
        """
        await self._ensure_initialized()
        await self._storage_adapter.store_credential(credential_name, credential_data, mode="antigravity")
        log.info(f"Antigravity credential added/updated: {credential_log_id(credential_name)}")

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
            log.info(f"Credential removed: {credential_log_id(credential_name)} (mode={mode})")
            return True
        except Exception as e:
            log.error(f"Error removing credential {credential_log_id(credential_name)}: {safe_exception(e)}")
            return False

    async def update_credential_state(self, credential_name: str, state_updates: Dict[str, Any], mode: str = "geminicli"):
        """更新凭证状态"""
        log.debug(f"[CredMgr] update_credential_state: credential={credential_log_id(credential_name)}, fields={list(state_updates)}, mode={mode}")
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
                log.debug(f"Updated credential state: {credential_log_id(credential_name)} (mode={mode})")
            else:
                log.warning(f"Failed to update credential state: {credential_log_id(credential_name)} (mode={mode})")
            return success
        except Exception as e:
            log.error(f"Error updating credential state {credential_log_id(credential_name)}: {safe_exception(e)}")
            return False

    async def set_cred_disabled(self, credential_name: str, disabled: bool, mode: str = "geminicli"):
        """设置凭证的启用/禁用状态"""
        try:
            log.info(f"[CredMgr] set_cred_disabled: credential={credential_log_id(credential_name)}, disabled={disabled}, mode={mode}")
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
                log.info(f"Credential {action}: {credential_log_id(credential_name)} (mode={mode})")
            else:
                log.warning(f"[CredMgr] 设置禁用状态失败: credential={credential_log_id(credential_name)}, disabled={disabled}")
            return success
        except Exception as e:
            log.error(f"Error setting credential disabled state {credential_log_id(credential_name)}: {safe_exception(e)}")
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
                log.info(f"Token已自动刷新: credential={credential_log_id(credential_name)} (mode={mode})")
                updated_data = credentials.to_dict()
                await self._storage_adapter.store_credential(credential_name, updated_data, mode=mode)

            # 获取邮箱
            email = await get_user_email(credentials)

            if email:
                # 缓存邮箱地址
                await self._storage_adapter.update_credential_state(
                    credential_name, {"user_email": email}, mode=mode
                )
                return email

            return None

        except Exception as e:
            log.error(f"Error fetching user email for {credential_log_id(credential_name)}: {safe_exception(e)}")
            return None

    async def record_api_call_result(
        self,
        credential_name: str,
        success: bool,
        error_code: Optional[int] = None,
        cooldown_until: Optional[float] = None,
        mode: str = "geminicli",
        model_name: Optional[str] = None,
        error_message: Optional[str] = None
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
                            f"设置模型级冷却: credential={credential_log_id(credential_name)}, model_name={model_name}, "
                            f"冷却至: {datetime.fromtimestamp(cooldown_until, timezone.utc).isoformat()}"
                        )

        except Exception as e:
            log.error(f"Error recording API call result for {credential_log_id(credential_name)}: {safe_exception(e)}")

    def _token_seconds_left(self, credential_data: Dict[str, Any]) -> float:
        """Return remaining token lifetime; malformed/missing data requires refresh."""
        if not credential_data.get("access_token") and not credential_data.get("token"):
            return float("-inf")
        expiry_str = credential_data.get("expiry")
        if not isinstance(expiry_str, str) or not expiry_str:
            return float("-inf")
        try:
            if expiry_str.endswith("Z"):
                expiry = datetime.fromisoformat(expiry_str.replace("Z", "+00:00"))
            else:
                expiry = datetime.fromisoformat(expiry_str)
            if expiry.tzinfo is None:
                expiry = expiry.replace(tzinfo=timezone.utc)
            return (expiry - datetime.now(timezone.utc)).total_seconds()
        except (TypeError, ValueError):
            return float("-inf")

    async def _ensure_refresh_task(
        self,
        credential_data: Dict[str, Any],
        filename: str,
        *,
        mode: str,
    ) -> asyncio.Task:
        """Return the single in-flight refresh for a credential, creating it once."""
        key = (mode, filename)
        async with self._refresh_lock:
            task = self._refresh_tasks.get(key)
            if task is None or task.done():
                task = asyncio.create_task(
                    self._refresh_token(dict(credential_data), filename, mode=mode)
                )
                self._refresh_tasks[key] = task

                def _cleanup(done: asyncio.Task, *, task_key=key) -> None:
                    _fire_and_forget_cb(done)
                    if self._refresh_tasks.get(task_key) is done:
                        self._refresh_tasks.pop(task_key, None)

                task.add_done_callback(_cleanup)
            return task

    async def _wait_for_refresh(
        self,
        credential_data: Dict[str, Any],
        filename: str,
        *,
        mode: str,
    ) -> Optional[Dict[str, Any]]:
        task = await self._ensure_refresh_task(credential_data, filename, mode=mode)
        timeout = StreamLatencyConfig.from_env().oauth_refresh_timeout
        trace = current_stream_trace()
        started_at = time.perf_counter()
        if trace:
            trace.phase = StreamPhase.REFRESHING_TOKEN
        try:
            return await asyncio.wait_for(asyncio.shield(task), timeout=timeout)
        except TimeoutError:
            log.warning(
                f"Token刷新等待超时，不禁用凭证: credential={credential_log_id(filename)} (mode={mode}, timeout={timeout}s)"
            )
            return None
        finally:
            if trace:
                trace.duration("oauth_refresh", started_at)

    async def _refresh_token(
        self, credential_data: Dict[str, Any], filename: str, mode: str = "geminicli"
    ) -> Optional[Dict[str, Any]]:
        """刷新token并更新存储"""
        await self._ensure_initialized()
        try:
            # 创建Credentials对象
            creds = Credentials.from_dict(credential_data)

            # 检查是否可以刷新
            if not creds.refresh_token:
                log.error(f"没有refresh_token，无法刷新: credential={credential_log_id(filename)} (mode={mode})")
                # 缺少 refresh_token 只在当前请求排除；不把不完整配置误判为
                # OAuth 服务明确确认的永久失效。
                return None

            # 刷新token
            log.debug(f"正在刷新token: credential={credential_log_id(filename)} (mode={mode})")
            await creds.refresh()

            # 更新凭证数据
            if creds.access_token:
                credential_data["access_token"] = creds.access_token
                # 保持兼容性
                credential_data["token"] = creds.access_token

            if creds.expires_at:
                credential_data["expiry"] = creds.expires_at.isoformat()

            # 保存到存储
            await self._storage_adapter.store_credential(filename, credential_data, mode=mode)
            log.info(f"Token刷新成功并已保存: credential={credential_log_id(filename)} (mode={mode})")

            return credential_data

        except Exception as e:
            error_msg = str(e)
            log.error(f"Token刷新失败 credential={credential_log_id(filename)} (mode={mode}): {safe_exception(e)}")

            # 尝试提取HTTP状态码（TokenError可能携带status_code属性）
            status_code = None
            if hasattr(e, 'status_code'):
                status_code = e.status_code

            # 只有明确的 invalid_grant、401、403 才判定为永久失效。
            is_permanent_failure = self._is_permanent_refresh_failure(error_msg, status_code)

            if is_permanent_failure:
                log.warning(f"检测到凭证永久失效 (HTTP {status_code}): credential={credential_log_id(filename)}")
                # 记录失效状态
                if status_code:
                    await self.record_api_call_result(filename, False, status_code, mode=mode)
                else:
                    await self.record_api_call_result(filename, False, 400, mode=mode)

                # 禁用失效凭证
                try:
                    # 直接禁用该凭证（随机选择机制会自动跳过它）
                    disabled_ok = await self.update_credential_state(filename, {"disabled": True}, mode=mode)
                    if disabled_ok:
                        log.warning(f"永久失效凭证已禁用: credential={credential_log_id(filename)}")
                    else:
                        log.warning("永久失效凭证禁用失败，将由上层逻辑继续处理")
                except Exception as e2:
                    log.error(f"禁用永久失效凭证时出错 {credential_log_id(filename)}: {safe_exception(e2)}")
            else:
                # 网络错误或其他临时性错误，不封禁凭证
                log.warning(f"Token刷新失败但非永久性错误 (HTTP {status_code})，不封禁凭证: credential={credential_log_id(filename)}")

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
        error_msg_lower = error_msg.lower()
        if "invalid_grant" in error_msg_lower:
            log.debug("错误信息明确包含 invalid_grant，判定为永久失效")
            return True
        if status_code in (401, 403):
            log.debug(f"检测到凭证错误状态码 {status_code}，判定为永久失效")
            return True

        # 400（但非 invalid_grant）、429、5xx、超时和网络错误均视为临时错误。
        log.debug(f"未匹配到明确永久失效证据 (HTTP {status_code})，判定为临时错误")
        return False


class _CredentialManagerSingleton:
    """单例包装器，支持懒加载和自动初始化"""

    _instance: Optional[CredentialManager] = None

    def __init__(self):
        self._manager = None
        self._init_lock = asyncio.Lock()

    async def _get_or_create(self) -> CredentialManager:
        """获取或创建单例实例（线程安全）"""
        if self._instance is None:
            async with self._init_lock:
                if self._instance is None:
                    candidate = CredentialManager()
                    await candidate.initialize()
                    self._instance = candidate
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
