"""
GeminiCli API Client - Handles all communication with GeminiCli API.
This module is used by both OpenAI compatibility layer and native Gemini endpoints.
GeminiCli API 客户端 - 处理与 GeminiCli API 的所有通信
"""

import sys
from pathlib import Path

# 添加项目根目录到Python路径（用于直接运行测试）
if __name__ == "__main__":
    project_root = Path(__file__).resolve().parent.parent.parent
    if str(project_root) not in sys.path:
        sys.path.insert(0, str(project_root))

import asyncio
import json
import time
from typing import Any, Dict, Optional, Callable, Tuple

from fastapi import Response
from config import (
    get_code_assist_endpoint,
    get_auto_ban_error_codes,
    is_smart_429_protection_enabled,
    is_geminicli_capacity_fast_fail_enabled,
)
from log import log
from src.log_safety import credential_log_id, safe_exception, safe_text

from src.credential_manager import credential_manager
from src.httpx_client import stream_post_async, post_async
from src.streaming_latency import (
    StreamFailure,
    StreamLatencyConfig,
    StreamPhase,
    StreamRequestTrace,
    current_stream_trace,
)
from src.subscription_tiers import required_tiers_for_geminicli_model

# 导入共同的基础功能
from src.api.utils import (
    handle_error_with_retry,
    get_retry_config,
    record_api_call_success,
    record_api_call_error,
    parse_and_log_cooldown,
    build_error_response,
    debug_log,
    smart_retry_delay,
)
from src.smart_429 import (
    Upstream429Kind,
    classify_upstream_429,
    model_capacity_guard,
    smart_429_service,
)
from src.utils import get_geminicli_user_agent


def _build_no_available_credential_response(model_name: Optional[str]) -> Response:
    """Return a specific 503 when a Tier-restricted model has no eligible credential."""
    if required_tiers_for_geminicli_model(model_name):
        return build_error_response(
            "无支持 gemini-3.5-flash 的可用 Code Assist Standard/Enterprise 凭证",
            503,
        )
    return build_error_response("当前无可用凭证", 503)


async def _build_smart_pool_response(model_name: Optional[str]) -> Response:
    if not is_smart_429_protection_enabled():
        return _build_no_available_credential_response(model_name)
    states = await credential_manager.get_creds_status()
    enabled = {
        filename: state for filename, state in states.items()
        if not state.get("disabled") and not state.get("permanent_disabled")
    }
    if enabled and all(state.get("health_status", "healthy") != "healthy" for state in enabled.values()):
        return Response(
            content=json.dumps({"error": {"code": "credential_pool_quarantined", "type": "credential_pool_quarantined", "message": "Credential pool is temporarily quarantined"}}),
            status_code=503,
            media_type="application/json",
        )
    healthy_names = {
        filename for filename, state in enabled.items()
        if state.get("health_status", "healthy") == "healthy"
    }
    retry_after = smart_429_service.all_capacity_cooling_retry_after(
        "geminicli", model_name or "", healthy_names
    )
    if retry_after:
        await asyncio.sleep(min(8, retry_after))
        retry_after = smart_429_service.all_capacity_cooling_retry_after(
            "geminicli", model_name or "", healthy_names
        ) or 1
        return Response(
            content=json.dumps({"error": {"code": "upstream_capacity_exhausted", "type": "upstream_capacity_exhausted", "message": "Upstream capacity is temporarily exhausted"}}),
            status_code=503,
            media_type="application/json",
            headers={"Retry-After": str(retry_after)},
        )
    return _build_no_available_credential_response(model_name)


def _capacity_breaker_response(
    model_name: str, *, fast_fail_enabled: Optional[bool] = None
) -> Optional[Response]:
    fast_fail_enabled = (
        is_geminicli_capacity_fast_fail_enabled()
        if fast_fail_enabled is None
        else fast_fail_enabled
    )
    retry_after = (
        model_capacity_guard.admission_retry_after(
            "geminicli", model_name, enabled=fast_fail_enabled
        )
        if fast_fail_enabled
        else 0
    )
    if not retry_after and is_smart_429_protection_enabled():
        retry_after = smart_429_service.capacity_admission_retry_after(
            "geminicli", model_name
        )
    if not retry_after:
        return None
    return _capacity_retry_response(retry_after)


def _capacity_retry_response(retry_after: int) -> Response:
    return Response(
        content=json.dumps({"error": {"code": "upstream_capacity_exhausted", "type": "upstream_capacity_exhausted", "message": "Upstream capacity is temporarily exhausted"}}),
        status_code=503,
        media_type="application/json",
        headers={"Retry-After": str(retry_after)},
    )


def _upstream_capacity_response(cooldown_until: float) -> Response:
    import time

    retry_after = max(1, int(cooldown_until - time.time() + 0.999))
    return _capacity_retry_response(retry_after)


def _debug_log_final_response(tag: str, response) -> None:
    """调试模式下只记录最终状态；响应正文可能包含上游敏感信息。"""
    try:
        status = getattr(response, 'status_code', 'N/A')
        debug_log(f"[{tag}] 最终返回客户端 -> HTTP {status}", level="info")
    except Exception as e:
        debug_log(f"[{tag}] 记录最终响应失败: {safe_exception(e)}", level="warning")


# ==================== 全局凭证管理器 ====================

# 使用全局单例 credential_manager，自动初始化


# ==================== 请求准备 ====================


async def prepare_request_headers_and_payload(
    payload: dict, credential_data: dict, target_url: str
):
    """
    从凭证数据准备请求头和最终payload

    Args:
        payload: 原始请求payload
        credential_data: 凭证数据字典
        target_url: 目标URL

    Returns:
        元组: (headers, final_payload, target_url)

    Raises:
        Exception: 如果凭证中缺少必要字段
    """
    token = credential_data.get("token") or credential_data.get("access_token", "")
    if not token:
        raise Exception("凭证中没有找到有效的访问令牌（token或access_token字段）")

    source_request = payload.get("request", {})

    # 内部API使用Bearer Token和项目ID
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "User-Agent": get_geminicli_user_agent(payload.get("model", "")),
    }
    project_id = credential_data.get("project_id", "")
    if not project_id:
        raise Exception("项目ID不存在于凭证数据中")
    final_payload = {
        "model": payload.get("model"),
        "project": project_id,
        "request": source_request,
    }

    return headers, final_payload, target_url


def _is_retryable_status(status_code: int, disable_error_codes: list[int]) -> bool:
    """统一判断是否属于可重试状态码。"""
    return status_code in (429, 500, 503) or status_code in disable_error_codes


def _decode_error_payload(error_text: str) -> Dict[str, Any]:
    try:
        value = json.loads(error_text)
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def _status_retry_reason(
    status_code: int, classification: Optional[Upstream429Kind] = None
) -> str:
    if classification == Upstream429Kind.MODEL_CAPACITY_EXHAUSTED:
        return "model_capacity"
    if status_code == 429:
        return "rate_limit"
    if status_code in (500, 503):
        return "server_error"
    return f"http_{status_code}"


async def _apply_smart_429_state(
    filename: str,
    credential_data: Dict[str, Any],
    model_name: str,
    error_text: str,
) -> tuple[Upstream429Kind, Optional[float]]:
    """Synchronously persist the decision state before any credential prefetch."""
    classification = classify_upstream_429(_decode_error_payload(error_text), mode="geminicli")
    if classification.kind == Upstream429Kind.MODEL_CAPACITY_EXHAUSTED:
        cooldown_until = smart_429_service.capacity_cooldown_until(
            "geminicli", model_name, filename
        )
        return classification.kind, cooldown_until
    if classification.kind == Upstream429Kind.RISK_CHECK_REQUIRED:
        await smart_429_service.mark_checking(filename)
        smart_429_service.schedule_verification(filename, credential_data)
    return classification.kind, None


async def _switch_credential_for_retry(
    *,
    next_cred_task: Optional[asyncio.Task],
    retry_interval: float,
    refresh_credential_fast: Callable[[], Any],
    apply_cred_result: Callable[[Tuple[str, Dict[str, Any]]], bool],
    log_prefix: str,
) -> Tuple[bool, Optional[asyncio.Task]]:
    """优先使用预热凭证，失败后退回同步刷新。"""
    smart_enabled = is_smart_429_protection_enabled()
    if smart_enabled:
        await asyncio.sleep(retry_interval)

    if next_cred_task is not None:
        try:
            cred_result = await next_cred_task
            next_cred_task = None
            if cred_result and apply_cred_result(cred_result):
                if not smart_enabled:
                    await asyncio.sleep(retry_interval)
                return True, next_cred_task
        except Exception as e:
            log.warning(f"{log_prefix} 预热凭证任务失败: {safe_exception(e)}")
            next_cred_task = None

    if not smart_enabled:
        await asyncio.sleep(retry_interval)
    if await refresh_credential_fast():
        return True, next_cred_task

    return False, next_cred_task


# ==================== 新的流式和非流式请求函数 ====================


async def stream_request(
    body: Dict[str, Any],
    native: bool = False,
    headers: Optional[Dict[str, str]] = None,
):
    """
    流式请求函数

    Args:
        body: 请求体
        native: 是否返回原生bytes流，False则返回str流
        headers: 额外的请求头

    Yields:
        Response对象（错误时）或 bytes流/str流（成功时）
    """
    trace = current_stream_trace() or StreamRequestTrace(
        model=body.get("model", ""), protocol="gemini"
    )
    latency_config = StreamLatencyConfig.from_env()

    # 获取有效凭证
    model_name = body.get("model", "")
    trace.model = trace.model or model_name
    capacity_fast_fail = is_geminicli_capacity_fast_fail_enabled()
    breaker_response = _capacity_breaker_response(
        model_name, fast_fail_enabled=capacity_fast_fail
    )
    if breaker_response is not None:
        raise StreamFailure.from_response(
            breaker_response,
            stage="credential_capacity",
            request_id=trace.request_id,
        )

    # 1. 获取有效凭证
    credential_started = time.perf_counter()
    trace.phase = StreamPhase.SELECTING_CREDENTIAL
    try:
        async with asyncio.timeout(
            min(latency_config.credential_acquire_timeout, trace.remaining_first_content())
        ):
            cred_result = await credential_manager.get_valid_credential(
                mode="geminicli", model_name=model_name
            )
    except TimeoutError as exc:
        trace.duration("credential", credential_started)
        raise StreamFailure(
            "Credential acquisition timed out",
            stage="credential",
            status_code=504,
            retryable=False,
            request_id=trace.request_id,
        ) from exc
    trace.duration("credential", credential_started)

    if not cred_result:
        err = await _build_smart_pool_response(model_name)
        _debug_log_final_response("GEMINICLI STREAM", err)
        raise StreamFailure.from_response(
            err,
            stage="credential",
            request_id=trace.request_id,
        )

    current_file, credential_data = cred_result
    trace.set_credential(current_file)

    # 2. 构建URL和请求头
    try:
        auth_headers, final_payload, target_url = await prepare_request_headers_and_payload(
            body, credential_data,
            f"{await get_code_assist_endpoint()}/v1internal:streamGenerateContent?alt=sse"
        )

        # 合并自定义headers
        if headers:
            auth_headers.update(headers)

    except Exception as e:
        log.error(f"准备请求失败: {safe_exception(e)}")
        err = build_error_response("准备请求失败", 500)
        _debug_log_final_response("GEMINICLI STREAM", err)
        raise StreamFailure.from_response(
            err,
            stage="preparing",
            request_id=trace.request_id,
        ) from e

    # 3. 调用stream_post_async进行请求
    retry_config = await get_retry_config()
    max_retries = retry_config["max_retries"]
    retry_interval = retry_config["retry_interval"]

    DISABLE_ERROR_CODES = await get_auto_ban_error_codes()  # 禁用凭证的错误码
    next_cred_task = None  # 预热的下一个凭证任务
    excluded_credentials: set[str] = set()
    transport_failures = 0
    status_failures = 0
    capacity_failures = 0

    # 内部函数：快速更新凭证(只更新token和project_id,避免重建整个请求)
    async def refresh_credential_fast():
        nonlocal current_file, credential_data, auth_headers, final_payload
        cred_result = await credential_manager.get_valid_credential(
            mode="geminicli", model_name=model_name,
            excluded_credentials=excluded_credentials,
        )
        if not cred_result:
            return None
        current_file, credential_data = cred_result
        try:
            # 只更新token和project_id,不重建整个headers和payload
            token = credential_data.get("token") or credential_data.get("access_token", "")
            project_id = credential_data.get("project_id", "")
            if not token or not project_id:
                return None

            # 直接更新现有的headers和payload
            auth_headers["Authorization"] = f"Bearer {token}"
            final_payload["project"] = project_id
            return True
        except Exception:
            return None

    def apply_cred_result(cred_result: Tuple[str, Dict[str, Any]]) -> bool:
        nonlocal current_file, credential_data, auth_headers, final_payload
        current_file, credential_data = cred_result
        token = credential_data.get("token") or credential_data.get("access_token", "")
        project_id = credential_data.get("project_id", "")
        if not token or not project_id:
            return False
        auth_headers["Authorization"] = f"Bearer {token}"
        final_payload["project"] = project_id
        return True

    max_total_retries = max_retries + latency_config.transport_max_attempts - 1
    for attempt in range(max_total_retries + 1):
        upstream_started = False
        need_retry = False  # 标记是否需要重试
        trace.begin_attempt(current_file)

        try:
            async for chunk in stream_post_async(
                url=target_url,
                body=final_payload,
                native=native,
                headers=auth_headers,
            ):
                # 判断是否是Response对象
                if isinstance(chunk, Response):
                    status_code = chunk.status_code
                    # 缓存错误解析结果,避免重复decode
                    error_body = None
                    try:
                        error_body = chunk.body.decode('utf-8') if isinstance(chunk.body, bytes) else str(chunk.body)
                    except Exception:
                        error_body = ""

                    # 如果错误码是429、503或者在禁用码当中，做好记录后进行重试
                    if _is_retryable_status(status_code, DISABLE_ERROR_CODES):
                        classification = (
                            classify_upstream_429(
                                _decode_error_payload(error_body or ""),
                                mode="geminicli",
                            ).kind
                            if status_code == 429
                            else None
                        )
                        retry_reason = _status_retry_reason(status_code, classification)
                        trace.record_failure(
                            stage="upstream_status",
                            error_type=retry_reason,
                            status_code=status_code,
                            retryable=True,
                        )
                        log.warning(
                            f"[GEMINICLI STREAM] 流式请求失败 "
                            f"(status={status_code}, reason={retry_reason}), "
                            f"credential={credential_log_id(current_file)}, "
                            f"upstream={safe_text(error_body, limit=240) or 'empty'}"
                        )

                        # 解析冷却时间
                        cooldown_until = None
                        if (status_code == 429 or status_code == 503) and error_body:
                            try:
                                cooldown_until = await parse_and_log_cooldown(error_body, mode="geminicli")
                            except Exception:
                                pass

                        smart_cooldown = None
                        if status_code == 429 and is_smart_429_protection_enabled():
                            if not (
                                capacity_fast_fail
                                and classification
                                == Upstream429Kind.MODEL_CAPACITY_EXHAUSTED
                            ):
                                _, smart_cooldown = await _apply_smart_429_state(
                                    current_file,
                                    credential_data,
                                    model_name,
                                    error_body or "",
                                )
                                if smart_cooldown is not None:
                                    cooldown_until = smart_cooldown

                        is_capacity = (
                            classification == Upstream429Kind.MODEL_CAPACITY_EXHAUSTED
                        )
                        fast_retry_after = 0
                        if is_capacity and capacity_fast_fail:
                            capacity_failures += 1
                            fast_retry_after = model_capacity_guard.record_failure(
                                "geminicli",
                                model_name,
                                enabled=capacity_fast_fail,
                            )

                        # 快速失败模式下模型容量是上游全局状态，不污染凭证状态。
                        if not is_capacity or not capacity_fast_fail:
                            await record_api_call_error(
                                credential_manager, current_file, status_code,
                                cooldown_until, mode="geminicli", model_name=model_name,
                                error_message=error_body
                            )

                        excluded_credentials.add(current_file)
                        fast_capacity_terminal = (
                            is_capacity
                            and capacity_fast_fail
                            and capacity_failures >= 2
                        )
                        if (
                            next_cred_task is None
                            and status_failures < max_retries
                            and not fast_capacity_terminal
                        ):
                            next_cred_task = asyncio.create_task(
                                credential_manager.get_valid_credential(
                                    mode="geminicli", model_name=model_name,
                                    excluded_credentials=excluded_credentials,
                                )
                            )

                        # 检查是否应该重试
                        if is_capacity and capacity_fast_fail:
                            should_retry = (
                                retry_config["retry_enabled"]
                                and capacity_failures == 1
                                and status_failures < max_retries
                            )
                        else:
                            should_retry = await handle_error_with_retry(
                                credential_manager,
                                status_code,
                                current_file,
                                retry_config["retry_enabled"],
                                status_failures,
                                max_retries,
                                retry_interval,
                                mode="geminicli",
                            )

                        if should_retry and status_failures < max_retries:
                            status_failures += 1
                            trace.record_retry(
                                "status",
                                retry_reason,
                                capacity=is_capacity,
                            )
                            need_retry = True
                            break  # 跳出内层循环，准备重试
                        else:
                            # 不重试，返回固定429错误以便下游重试
                            log.error(f"[GEMINICLI STREAM] 达到最大重试次数或不应重试，返回429错误")
                            err = (
                                _capacity_retry_response(
                                    fast_retry_after
                                    or (
                                        max(
                                            1,
                                            int(smart_cooldown - time.time() + 0.999),
                                        )
                                        if smart_cooldown is not None
                                        else 1
                                    )
                                )
                                if is_capacity
                                else build_error_response("Server is busy, please retry later", 503)
                            )
                            _debug_log_final_response("GEMINICLI STREAM", err)
                            raise StreamFailure.from_response(
                                err,
                                stage="upstream_status",
                                request_id=trace.request_id,
                            )
                    elif status_code == 404 and "preview" in model_name.lower():
                        # 特殊处理：preview模型返回404，说明该凭证不支持preview模型
                        log.warning(
                            "[GEMINICLI STREAM] Preview模型404错误，"
                            f"credential={credential_log_id(current_file)}"
                        )
                        trace.record_failure(
                            stage="upstream_status",
                            error_type="http_404",
                            status_code=404,
                            retryable=status_failures < max_retries,
                        )

                        # 不再因为单次 404 自动关闭 preview。
                        # Preview ON 是用户/配置行为，404 仅记录错误并交给重试/冷却逻辑处理。

                        # 记录404错误
                        await record_api_call_error(
                            credential_manager, current_file, status_code,
                            None, mode="geminicli", model_name=model_name,
                            error_message=error_body
                        )

                        # 预热下一个凭证（会自动跳过preview=False的凭证）
                        excluded_credentials.add(current_file)
                        if next_cred_task is None and status_failures < max_retries:
                            next_cred_task = asyncio.create_task(
                                credential_manager.get_valid_credential(
                                    mode="geminicli", model_name=model_name,
                                    excluded_credentials=excluded_credentials,
                                )
                            )

                        # 触发重试
                        if status_failures < max_retries:
                            status_failures += 1
                            trace.record_retry("status", "http_404")
                            need_retry = True
                            break
                        else:
                            log.error(f"[GEMINICLI STREAM] 达到最大重试次数，返回404错误")
                            _debug_log_final_response("GEMINICLI STREAM", chunk)
                            raise StreamFailure.from_response(
                                chunk,
                                stage="upstream_status",
                                request_id=trace.request_id,
                            )
                    else:
                        # 错误码不在禁用码当中，直接返回，无需重试
                        log.error(
                            f"[GEMINICLI STREAM] 非重试错误 "
                            f"(status={status_code}), "
                            f"credential={credential_log_id(current_file)}, "
                            f"upstream={safe_text(error_body, limit=240) or 'empty'}"
                        )
                        trace.record_failure(
                            stage="upstream_status",
                            error_type=f"http_{status_code}",
                            status_code=status_code,
                            retryable=False,
                        )
                        await record_api_call_error(
                            credential_manager, current_file, status_code,
                            None, mode="geminicli", model_name=model_name,
                            error_message=error_body
                        )
                        _debug_log_final_response("GEMINICLI STREAM", chunk)
                        raise StreamFailure.from_response(
                            chunk,
                            stage="upstream_status",
                            request_id=trace.request_id,
                        )
                else:
                    # 不是Response，说明是真流，直接yield返回
                    # 空行不是有效上游事件，不能作为禁止重试的边界。
                    if not chunk or not chunk.strip():
                        yield chunk
                        continue
                    trace.mark_upstream_event()
                    # 只在第一个有效事件时记录成功
                    if not upstream_started:
                        await record_api_call_success(
                            credential_manager, current_file, mode="geminicli", model_name=model_name
                        )
                        if is_smart_429_protection_enabled():
                            smart_429_service.record_success("geminicli", model_name, current_file)
                        if capacity_fast_fail:
                            model_capacity_guard.record_success(
                                "geminicli",
                                model_name,
                                enabled=capacity_fast_fail,
                            )
                        upstream_started = True
                        trace.set_credential(current_file)
                        trace.duration_since_mark("first_upstream_event", "waiting_first_event")
                        trace.mark("first_upstream_at", phase=StreamPhase.UPSTREAM_STARTED)
                        log.debug(f"[GEMINICLI STREAM] 开始接收流式响应，模型: {model_name}")

                    yield chunk

            # 流式请求完成，检查结果
            if upstream_started:
                log.debug(f"[GEMINICLI STREAM] 流式响应完成，模型: {model_name}")
                return

            # 统一处理重试
            if need_retry:
                log.info(
                    f"[GEMINICLI STREAM] 状态码重试 "
                    f"(attempt {status_failures + 1}/{max_retries + 1})..."
                )

                switched, next_cred_task = await _switch_credential_for_retry(
                    next_cred_task=next_cred_task,
                    retry_interval=(
                        smart_retry_delay(max(0, status_failures - 1), retry_interval)
                        if retry_config.get("smart_429")
                        else retry_interval
                    ),
                    refresh_credential_fast=refresh_credential_fast,
                    apply_cred_result=apply_cred_result,
                    log_prefix="[GEMINICLI STREAM]",
                )
                if not switched:
                    log.error("[GEMINICLI STREAM] 重试时无可用凭证或刷新失败")
                    err = await _build_smart_pool_response(model_name)
                    _debug_log_final_response("GEMINICLI STREAM", err)
                    raise StreamFailure.from_response(
                        err,
                        stage="credential",
                        request_id=trace.request_id,
                    )
                continue  # 重试

        except asyncio.CancelledError:
            raise
        except StreamFailure as e:
            log.error(
                f"[GEMINICLI STREAM] 流阶段失败: stage={e.stage}, "
                f"status={e.status_code}, credential={credential_log_id(current_file)}"
            )
            if upstream_started:
                e.retryable = False
                e.request_id = e.request_id or trace.request_id
                raise
            transport_failures += 1
            excluded_credentials.add(current_file)
            trace.retry_reason = e.stage
            if (
                latency_config.guard_enabled
                and e.retryable
                and transport_failures < latency_config.transport_max_attempts
                and attempt < max_total_retries
                and trace.remaining_first_content() > 0
            ):
                switched = await refresh_credential_fast()
                if switched:
                    trace.record_retry("transport", e.stage)
                    log.info(
                        f"[GEMINICLI STREAM] {e.stage} 后立即切换凭证重试 "
                        f"({transport_failures + 1}/{latency_config.transport_max_attempts})"
                    )
                    continue
            e.request_id = e.request_id or trace.request_id
            raise
        except Exception as e:
            log.error(
                f"[GEMINICLI STREAM] 流式请求异常: {safe_exception(e)}, "
                f"credential={credential_log_id(current_file)}"
            )
            if upstream_started:
                raise StreamFailure(
                    "Upstream stream was interrupted",
                    stage="streaming",
                    status_code=502,
                    retryable=False,
                    request_id=trace.request_id,
                ) from e
            transport_failures += 1
            excluded_credentials.add(current_file)
            trace.retry_reason = type(e).__name__
            if (
                latency_config.guard_enabled
                and transport_failures < latency_config.transport_max_attempts
                and attempt < max_total_retries
                and trace.remaining_first_content() > 0
                and await refresh_credential_fast()
            ):
                trace.record_retry("transport", type(e).__name__)
                continue
            trace.record_failure(
                stage="transport",
                error_type=type(e).__name__,
                status_code=502,
                retryable=False,
            )
            raise StreamFailure(
                "Unable to start upstream stream",
                stage="transport",
                status_code=502,
                retryable=False,
                request_id=trace.request_id,
            ) from e

    # 所有重试均已耗尽（for循环正常结束），返回固定429错误以便下游重试
    log.error("[GEMINICLI STREAM] 所有重试均失败")
    err = build_error_response("Server is busy, please retry later", 503)
    _debug_log_final_response("GEMINICLI STREAM", err)
    raise StreamFailure.from_response(
        err,
        stage="upstream_status",
        request_id=trace.request_id,
    )


async def non_stream_request(
    body: Dict[str, Any],
    headers: Optional[Dict[str, str]] = None,
) -> Response:
    """
    非流式请求函数

    Args:
        body: 请求体
        native: 保留参数以保持接口一致性（实际未使用）
        headers: 额外的请求头

    Returns:
        Response对象
    """
    # 获取有效凭证
    model_name = body.get("model", "")
    capacity_fast_fail = is_geminicli_capacity_fast_fail_enabled()
    breaker_response = _capacity_breaker_response(
        model_name, fast_fail_enabled=capacity_fast_fail
    )
    if breaker_response is not None:
        return breaker_response

    # 1. 获取有效凭证
    cred_result = await credential_manager.get_valid_credential(
        mode="geminicli", model_name=model_name
    )

    if not cred_result:
        err = await _build_smart_pool_response(model_name)
        _debug_log_final_response("NON-STREAM", err)
        return err

    current_file, credential_data = cred_result

    # 2. 构建URL和请求头
    try:
        auth_headers, final_payload, target_url = await prepare_request_headers_and_payload(
            body, credential_data,
            f"{await get_code_assist_endpoint()}/v1internal:generateContent"
        )

        # 合并自定义headers
        if headers:
            auth_headers.update(headers)

    except Exception as e:
        log.error(f"准备请求失败: {safe_exception(e)}")
        err = build_error_response("准备请求失败", 500)
        _debug_log_final_response("NON-STREAM", err)
        return err

    # 3. 调用post_async进行请求
    retry_config = await get_retry_config()
    max_retries = retry_config["max_retries"]
    retry_interval = retry_config["retry_interval"]

    DISABLE_ERROR_CODES = await get_auto_ban_error_codes()  # 禁用凭证的错误码
    last_error_response = None  # 记录最后一次的错误响应
    next_cred_task = None  # 预热的下一个凭证任务
    excluded_credentials: set[str] = set()
    capacity_failures = 0

    # 内部函数：快速更新凭证(只更新token和project_id,避免重建整个请求)
    async def refresh_credential_fast():
        nonlocal current_file, credential_data, auth_headers, final_payload
        cred_result = await credential_manager.get_valid_credential(
            mode="geminicli", model_name=model_name,
            excluded_credentials=excluded_credentials,
        )
        if not cred_result:
            return None
        current_file, credential_data = cred_result
        try:
            # 只更新token和project_id,不重建整个headers和payload
            token = credential_data.get("token") or credential_data.get("access_token", "")
            project_id = credential_data.get("project_id", "")
            if not token or not project_id:
                return None

            # 直接更新现有的headers和payload
            auth_headers["Authorization"] = f"Bearer {token}"
            final_payload["project"] = project_id
            return True
        except Exception:
            return None

    def apply_cred_result(cred_result: Tuple[str, Dict[str, Any]]) -> bool:
        nonlocal current_file, credential_data, auth_headers, final_payload
        current_file, credential_data = cred_result
        token = credential_data.get("token") or credential_data.get("access_token", "")
        project_id = credential_data.get("project_id", "")
        if not token or not project_id:
            return False
        auth_headers["Authorization"] = f"Bearer {token}"
        final_payload["project"] = project_id
        return True

    for attempt in range(max_retries + 1):
        try:
            response = await post_async(
                url=target_url,
                json=final_payload,
                headers=auth_headers,
                timeout=300.0
            )

            status_code = response.status_code

            # 成功
            if status_code == 200:
                await record_api_call_success(
                    credential_manager, current_file, mode="geminicli", model_name=model_name
                )
                if is_smart_429_protection_enabled():
                    smart_429_service.record_success("geminicli", model_name, current_file)
                if capacity_fast_fail:
                    model_capacity_guard.record_success(
                        "geminicli",
                        model_name,
                        enabled=capacity_fast_fail,
                    )
                # 创建响应头,移除压缩相关的header避免重复解压
                response_headers = dict(response.headers)
                response_headers.pop('content-encoding', None)
                response_headers.pop('content-length', None)

                return Response(
                    content=response.content,
                    status_code=200,
                    headers=response_headers
                )

            # 失败 - 记录最后一次错误
            # 创建响应头,移除压缩相关的header避免重复解压
            error_headers = dict(response.headers)
            error_headers.pop('content-encoding', None)
            error_headers.pop('content-length', None)

            last_error_response = Response(
                content=response.content,
                status_code=status_code,
                headers=error_headers
            )

            # 判断是否需要重试
            # 缓存错误文本,避免重复解析
            error_text = ""
            try:
                error_text = response.text
            except Exception:
                pass

            # 统一处理所有需要重试的错误码（429、503、禁用码）
            if _is_retryable_status(status_code, DISABLE_ERROR_CODES):
                classification = (
                    classify_upstream_429(
                        _decode_error_payload(error_text), mode="geminicli"
                    ).kind
                    if status_code == 429
                    else None
                )
                retry_reason = _status_retry_reason(status_code, classification)
                log.warning(
                    f"[NON-STREAM] 非流式请求失败 "
                    f"(status={status_code}, reason={retry_reason}), "
                    f"credential={credential_log_id(current_file)}, "
                    f"upstream={safe_text(error_text, limit=240) or 'empty'}"
                )

                # 解析冷却时间
                cooldown_until = None
                if (status_code == 429 or status_code == 503) and error_text:
                    try:
                        cooldown_until = await parse_and_log_cooldown(error_text, mode="geminicli")
                    except Exception:
                        pass

                is_capacity = (
                    classification == Upstream429Kind.MODEL_CAPACITY_EXHAUSTED
                )
                smart_error_recorded = False
                smart_cooldown = None
                if status_code == 429 and is_smart_429_protection_enabled():
                    if not (capacity_fast_fail and is_capacity):
                        _, smart_cooldown = await _apply_smart_429_state(
                            current_file, credential_data, model_name, error_text
                        )
                        if smart_cooldown is not None:
                            cooldown_until = smart_cooldown
                        await record_api_call_error(
                            credential_manager,
                            current_file,
                            status_code,
                            cooldown_until,
                            mode="geminicli",
                            model_name=model_name,
                            error_message=error_text,
                        )
                        smart_error_recorded = True
                    excluded_credentials.add(current_file)

                excluded_credentials.add(current_file)
                fast_retry_after = 0
                if is_capacity and capacity_fast_fail:
                    capacity_failures += 1
                    fast_retry_after = model_capacity_guard.record_failure(
                        "geminicli",
                        model_name,
                        enabled=capacity_fast_fail,
                    )

                # 并行预热下一个凭证,不阻塞当前处理
                fast_capacity_terminal = (
                    is_capacity and capacity_fast_fail and capacity_failures >= 2
                )
                if (
                    next_cred_task is None
                    and attempt < max_retries
                    and not fast_capacity_terminal
                ):
                    next_cred_task = asyncio.create_task(
                        credential_manager.get_valid_credential(
                            mode="geminicli", model_name=model_name,
                            excluded_credentials=excluded_credentials,
                        )
                    )

                # 记录错误并切换凭证
                if (
                    not smart_error_recorded
                    and (not is_capacity or not capacity_fast_fail)
                ):
                    await record_api_call_error(
                        credential_manager, current_file, status_code,
                        cooldown_until, mode="geminicli", model_name=model_name,
                        error_message=error_text
                    )
                    excluded_credentials.add(current_file)

                # 检查是否应该重试（会自动处理禁用逻辑）
                if is_capacity and capacity_fast_fail:
                    should_retry = (
                        retry_config["retry_enabled"]
                        and capacity_failures == 1
                        and attempt < max_retries
                    )
                else:
                    should_retry = await handle_error_with_retry(
                        credential_manager, status_code, current_file,
                        retry_config["retry_enabled"], attempt, max_retries, retry_interval,
                        mode="geminicli"
                    )

                if should_retry and attempt < max_retries:
                    # 重新获取凭证并重试
                    log.info(f"[NON-STREAM] 重试请求 (attempt {attempt + 2}/{max_retries + 1})...")

                    switched, next_cred_task = await _switch_credential_for_retry(
                        next_cred_task=next_cred_task,
                        retry_interval=(smart_retry_delay(attempt, retry_interval) if retry_config.get("smart_429") else retry_interval),
                        refresh_credential_fast=refresh_credential_fast,
                        apply_cred_result=apply_cred_result,
                        log_prefix="[NON-STREAM]",
                    )
                    if not switched:
                        log.error("[NON-STREAM] 重试时无可用凭证或刷新失败")
                        err = await _build_smart_pool_response(model_name)
                        _debug_log_final_response("NON-STREAM", err)
                        return err
                    continue  # 重试
                else:
                    # 不重试，返回固定429错误以便下游重试
                    log.error(f"[NON-STREAM] 达到最大重试次数或不应重试，返回429错误")
                    err = (
                        _capacity_retry_response(
                            fast_retry_after
                            or (
                                max(1, int(smart_cooldown - time.time() + 0.999))
                                if smart_cooldown is not None
                                else 1
                            )
                        )
                        if is_capacity
                        else build_error_response("Server is busy, please retry later", 503)
                    )
                    _debug_log_final_response("NON-STREAM", err)
                    return err
            elif status_code == 404 and "preview" in model_name.lower():
                # 特殊处理：preview模型返回404，说明该凭证不支持preview模型
                log.warning(
                    "[NON-STREAM] Preview模型404错误，"
                    f"credential={credential_log_id(current_file)}"
                )

                # 不再因为单次 404 自动关闭 preview。
                # Preview ON 是用户/配置行为，404 仅记录错误并交给重试/冷却逻辑处理。

                # 记录404错误
                await record_api_call_error(
                    credential_manager, current_file, status_code,
                    None, mode="geminicli", model_name=model_name,
                    error_message=error_text
                )

                # 预热下一个凭证（会自动跳过preview=False的凭证）
                excluded_credentials.add(current_file)
                if next_cred_task is None and attempt < max_retries:
                    next_cred_task = asyncio.create_task(
                        credential_manager.get_valid_credential(
                            mode="geminicli", model_name=model_name,
                            excluded_credentials=excluded_credentials,
                        )
                    )

                # 触发重试
                if attempt < max_retries:
                    log.info(f"[NON-STREAM] 重试请求 (attempt {attempt + 2}/{max_retries + 1})...")

                    switched, next_cred_task = await _switch_credential_for_retry(
                        next_cred_task=next_cred_task,
                        retry_interval=(smart_retry_delay(attempt, retry_interval) if retry_config.get("smart_429") else retry_interval),
                        refresh_credential_fast=refresh_credential_fast,
                        apply_cred_result=apply_cred_result,
                        log_prefix="[NON-STREAM]",
                    )
                    if not switched:
                        log.error("[NON-STREAM] 重试时无可用凭证或刷新失败")
                        err = await _build_smart_pool_response(model_name)
                        _debug_log_final_response("NON-STREAM", err)
                        return err
                    continue  # 重试
                else:
                    log.error(f"[NON-STREAM] 达到最大重试次数，返回404错误")
                    _debug_log_final_response("NON-STREAM", last_error_response)
                    return last_error_response
            else:
                # 错误码不在重试范围内，直接返回
                log.error(
                    f"[NON-STREAM] 非重试错误 (status={status_code}), "
                    f"credential={credential_log_id(current_file)}, "
                    f"upstream={safe_text(error_text, limit=240) or 'empty'}"
                )
                await record_api_call_error(
                    credential_manager, current_file, status_code,
                    None, mode="geminicli", model_name=model_name,
                    error_message=error_text
                )
                _debug_log_final_response("NON-STREAM", last_error_response)
                return last_error_response

        except Exception as e:
            log.error(
                f"非流式请求异常: {safe_exception(e)}, "
                f"credential={credential_log_id(current_file)}"
            )
            if attempt < max_retries:
                log.info(f"[NON-STREAM] 异常后重试 (attempt {attempt + 2}/{max_retries + 1})...")
                await asyncio.sleep(retry_interval)
                continue
            else:
                # 所有重试都失败，返回固定429错误以便下游重试
                log.error(
                    f"[NON-STREAM] 所有重试均失败，最后异常: {safe_exception(e)}"
                )
                err = build_error_response("Server is busy, please retry later", 503)
                _debug_log_final_response("NON-STREAM", err)
                return err

    # 所有重试都失败，返回固定429错误以便下游重试
    log.error("[NON-STREAM] 所有重试均失败")
    err = build_error_response("Server is busy, please retry later", 503)
    _debug_log_final_response("NON-STREAM", err)
    return err


# ==================== 测试代码 ====================

if __name__ == "__main__":
    """
    测试代码：演示API返回的流式和非流式数据格式
    运行方式: python src/api/geminicli.py
    """
    print("=" * 80)
    print("GeminiCli API 测试")
    print("=" * 80)

    # 测试请求体
    test_body = {
        "model": "gemini-2.5-flash",
        "request": {
            "contents": [
                {
                    "role": "user",
                    "parts": [{"text": "Hello, tell me a joke in one sentence."}]
                }
            ]
        }
    }

    async def test_stream_request():
        """测试流式请求"""
        print("\n" + "=" * 80)
        print("【测试1】流式请求 (stream_request with native=False)")
        print("=" * 80)
        print(f"请求体: {json.dumps(test_body, indent=2, ensure_ascii=False)}\n")

        print("流式响应数据 (每个chunk):")
        print("-" * 80)

        chunk_count = 0
        async for chunk in stream_request(body=test_body, native=False):
            chunk_count += 1
            if isinstance(chunk, Response):
                # 错误响应
                print(f"\n❌ 错误响应:")
                print(f"  状态码: {chunk.status_code}")
                print(f"  Content-Type: {chunk.headers.get('content-type', 'N/A')}")
                try:
                    content = chunk.body.decode('utf-8') if isinstance(chunk.body, bytes) else str(chunk.body)
                    print(f"  内容: {content}")
                except Exception as e:
                    print(f"  内容解析失败: {e}")
            else:
                # 正常的流式数据块 (str类型)
                print(f"\nChunk #{chunk_count}:")
                print(f"  类型: {type(chunk).__name__}")
                print(f"  长度: {len(chunk) if hasattr(chunk, '__len__') else 'N/A'}")
                print(f"  内容预览: {repr(chunk[:200] if len(chunk) > 200 else chunk)}")

                # 如果是SSE格式，尝试解析
                if isinstance(chunk, str) and chunk.startswith("data: "):
                    try:
                        data_line = chunk.strip()
                        if data_line.startswith("data: "):
                            json_str = data_line[6:]  # 去掉 "data: " 前缀
                            json_data = json.loads(json_str)
                            print(f"  解析后的JSON: {json.dumps(json_data, indent=4, ensure_ascii=False)}")
                    except Exception as e:
                        print(f"  SSE解析尝试失败: {e}")

        print(f"\n总共收到 {chunk_count} 个chunk")

    async def test_non_stream_request():
        """测试非流式请求"""
        print("\n" + "=" * 80)
        print("【测试2】非流式请求 (non_stream_request)")
        print("=" * 80)
        print(f"请求体: {json.dumps(test_body, indent=2, ensure_ascii=False)}\n")

        response = await non_stream_request(body=test_body)

        print("非流式响应数据:")
        print("-" * 80)
        print(f"状态码: {response.status_code}")
        print(f"Content-Type: {response.headers.get('content-type', 'N/A')}")
        print(f"\n响应头: {dict(response.headers)}\n")

        try:
            content = response.body.decode('utf-8') if isinstance(response.body, bytes) else str(response.body)
            print(f"响应内容 (原始):\n{content}\n")

            # 尝试解析JSON
            try:
                json_data = json.loads(content)
                print(f"响应内容 (格式化JSON):")
                print(json.dumps(json_data, indent=2, ensure_ascii=False))
            except json.JSONDecodeError:
                print("(非JSON格式)")
        except Exception as e:
            print(f"内容解析失败: {e}")

    async def main():
        """主测试函数"""
        try:
            # 测试流式请求
            await test_stream_request()

            # 测试非流式请求
            await test_non_stream_request()

            print("\n" + "=" * 80)
            print("测试完成")
            print("=" * 80)

        except Exception as e:
            print(f"\n❌ 测试过程中出现异常: {e}")
            import traceback

            traceback.print_exc()

    # 运行测试
    asyncio.run(main())


# ==================== Quota / 模型额度查询 ====================


async def fetch_geminicli_quota_info(
    access_token: str,
    project_id: Optional[str] = None,
) -> Dict[str, Any]:
    """获取 GeminiCLI 凭证的每模型剩余额度。

    使用 cloudcode-pa 的 retrieveUserQuota 接口，需要 project_id。
    返回结构与 antigravity 的 fetch_quota_info 兼容：
        {
          "success": True/False,
          "models": {
            "<modelId>": {
              "remaining": 0.85,
              "remainingAmount": "850",
              "resetTime": "12-20 10:30",
              "resetTimeRaw": "2025-12-20T02:30:00Z",
              "tokenType": "..."
            }
          },
          "error": "..." # 失败时
        }
    """
    from datetime import datetime, timedelta

    if not project_id:
        return {
            "success": False,
            "error": "缺少 project_id，无法查询 GeminiCLI 额度",
        }

    user_agent = get_geminicli_user_agent()
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
        "User-Agent": user_agent,
        "Accept-Encoding": "gzip",
    }

    try:
        api_base = await get_code_assist_endpoint()
        url = f"{api_base.rstrip('/')}/v1internal:retrieveUserQuota"
        body = {
            "project": project_id,
        }

        response = await post_async(
            url=url,
            json=body,
            headers=headers,
            timeout=30.0,
        )

        if response.status_code != 200:
            try:
                err_body = response.json()
            except Exception:
                err_body = response.text
            log.warning(f"[GEMINICLI QUOTA] upstream HTTP {response.status_code}")
            # 序列化为 JSON 字符串，前端可解析并格式化展示
            if isinstance(err_body, dict):
                err_str = json.dumps(err_body, ensure_ascii=False)
            else:
                err_str = str(err_body)
            return {
                "success": False,
                "error": f"HTTP {response.status_code}: {err_str}",
                "http_status": response.status_code,
                "error_body": err_body,
            }

        data = response.json()
        log.debug(f"[GEMINICLI QUOTA] Raw response: {json.dumps(data, ensure_ascii=False)[:500]}")

        buckets = data.get("buckets", []) or []
        quota_info: Dict[str, Any] = {}

        for b in buckets:
            model_id = b.get("modelId")
            if not model_id:
                continue
            remaining_fraction = b.get("remainingFraction")
            remaining_amount = b.get("remainingAmount")
            reset_time_raw = b.get("resetTime", "")
            token_type = b.get("tokenType", "")

            # 转换为北京时间
            reset_time_beijing = "N/A"
            if reset_time_raw:
                try:
                    utc_date = datetime.fromisoformat(reset_time_raw.replace("Z", "+00:00"))
                    beijing_date = utc_date + timedelta(hours=8)
                    reset_time_beijing = beijing_date.strftime("%m-%d %H:%M")
                except Exception as e:
                    log.warning(f"[GEMINICLI QUOTA] Failed to parse reset time: {e}")

            entry: Dict[str, Any] = {
                "remaining": remaining_fraction if remaining_fraction is not None else 0,
                "resetTime": reset_time_beijing,
                "resetTimeRaw": reset_time_raw,
                # Quota cards must preserve Google's raw bucket IDs. Client
                # aliases are request-routing concerns and must not merge two
                # independently returned quota buckets into one display name.
                "displayName": model_id,
                "rawModelId": model_id,
                "testModel": model_id,
            }
            if remaining_amount is not None:
                entry["remainingAmount"] = remaining_amount
            if token_type:
                entry["tokenType"] = token_type

            # 同一模型可能有多个 bucket（不同 tokenType），保留剩余比例最低那个
            existing = quota_info.get(model_id)
            if existing is None or entry["remaining"] < existing.get("remaining", 1):
                quota_info[model_id] = entry

        return {
            "success": True,
            "http_status": 200,
            "models": quota_info,
        }

    except Exception as e:
        log.error(f"[GEMINICLI QUOTA] 调用 retrieveUserQuota 失败: {e}")
        return {
            "success": False,
            "error": str(e),
            "http_status": 0,
        }
