"""
认证API模块
"""

import asyncio
import socket
import threading
import time
import hashlib
import hmac
import secrets
from datetime import timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Dict, Optional
from urllib.parse import parse_qs, urlparse

from config import get_config_value, get_antigravity_api_url, get_code_assist_endpoint
from log import log

from .google_oauth_api import (
    Credentials,
    Flow,
    enable_required_apis,
    fetch_project_id_and_tier,
    fetch_geminicli_subscription_info,
    get_user_projects,
    select_default_project,
)
from .storage_adapter import get_storage_adapter
from .utils import (
    ANTIGRAVITY_CLIENT_ID,
    ANTIGRAVITY_CLIENT_SECRET,
    ANTIGRAVITY_SCOPES,
    ANTIGRAVITY_USER_AGENT,
    CALLBACK_HOST,
    CLIENT_ID,
    CLIENT_SECRET,
    SCOPES,
    TOKEN_URL,
    get_geminicli_user_agent,
)
from .subscription_tiers import (
    GeminiCliSubscriptionInfo,
    default_tier_for_mode,
)


async def get_callback_port():
    """获取OAuth回调端口"""
    return int(await get_config_value("oauth_callback_port", "11451", "OAUTH_CALLBACK_PORT"))


async def _detect_geminicli_subscription(
    credentials: Credentials, project_id: Optional[str]
) -> GeminiCliSubscriptionInfo:
    return await fetch_geminicli_subscription_info(
        access_token=credentials.access_token,
        user_agent=get_geminicli_user_agent(""),
        api_base_url=await get_code_assist_endpoint(),
        project_id=project_id,
        antigravity_api_base_url=await get_antigravity_api_url(),
        antigravity_user_agent=ANTIGRAVITY_USER_AGENT,
    )


def _subscription_response_fields(info: GeminiCliSubscriptionInfo) -> Dict[str, Any]:
    return {
        "subscription_tier": info.tier,
        "tier_raw_id": info.raw_tier_id,
        "tier_raw_name": info.raw_tier_name,
        "tier_detected_at": info.detected_at,
        "tier_detection_status": info.status,
    }


def _prepare_credentials_data(credentials: Credentials, project_id: str, mode: str = "geminicli", subscription_tier: str = None) -> Dict[str, Any]:
    """准备凭证数据字典（统一函数）"""
    if mode == "antigravity":
        creds_data = {
            "client_id": ANTIGRAVITY_CLIENT_ID,
            "client_secret": ANTIGRAVITY_CLIENT_SECRET,
            "token": credentials.access_token,
            "refresh_token": credentials.refresh_token,
            "scopes": ANTIGRAVITY_SCOPES,
            "token_uri": TOKEN_URL,
            "project_id": project_id,
        }
    else:
        creds_data = {
            "client_id": CLIENT_ID,
            "client_secret": CLIENT_SECRET,
            "token": credentials.access_token,
            "refresh_token": credentials.refresh_token,
            "scopes": SCOPES,
            "token_uri": TOKEN_URL,
            "project_id": project_id,
        }

    if credentials.expires_at:
        if credentials.expires_at.tzinfo is None:
            expiry_utc = credentials.expires_at.replace(tzinfo=timezone.utc)
        else:
            expiry_utc = credentials.expires_at
        creds_data["expiry"] = expiry_utc.isoformat()

    return creds_data


# Process-local ownership and expiry; panel tokens are never stored in flow state.
auth_flows = {}
MAX_AUTH_FLOWS = 20
AUTH_FLOW_TTL = 600
DEFAULT_PROJECT_ID = "gemini-pro-1751713012-07fc4dfd"
_SESSION_SECRET = secrets.token_bytes(32)
_flows_lock = threading.RLock()
_FLOW_ERROR = "认证流程无效或已过期，请重新获取认证链接"
_COMPLETE_ERROR = "认证未完成，请重新获取认证链接"


def _session_key(user_session):
    if not isinstance(user_session, str) or not user_session:
        return None
    return hmac.new(_SESSION_SECRET, user_session.encode("utf-8"), hashlib.sha256).hexdigest()


def _live_flow(state, data):
    return (
        auth_flows.get(state) is data
        # TTL gates entry into persistence. Once accepted, let that single
        # commit finish before replacement/expiry can invalidate its result.
        and (data.get("persisting") or 0 <= time.time() - data["created_at"] < AUTH_FLOW_TTL)
    )


def _cleanup_auth_flow_server(state):
    with _flows_lock:
        data = auth_flows.pop(state, None)
    if data and data.get("server"):
        try:
            async_shutdown_server(data["server"], data.get("callback_port"))
        except Exception:
            log.warning("OAuth回调服务器清理失败")


def cleanup_expired_flows():
    with _flows_lock:
        for state, data in list(auth_flows.items()):
            if not _live_flow(state, data):
                _cleanup_auth_flow_server(state)


def cleanup_auth_flows_for_memory():
    with _flows_lock:
        cleanup_expired_flows()
        oldest = sorted(
            (state for state, data in auth_flows.items() if not data.get("persisting")),
            key=lambda state: auth_flows[state]["created_at"],
        )
        for state in oldest[:max(0, len(auth_flows) - 10)]:
            _cleanup_auth_flow_server(state)
        return len(auth_flows)


def _select_auth_flow(user_session, mode, state=None, project_id=None):
    owner = _session_key(user_session)
    with _flows_lock:
        cleanup_expired_flows()
        if owner is None or mode not in ("geminicli", "antigravity"):
            return None, None
        candidates = [(state, auth_flows.get(state))] if state else list(auth_flows.items())
        for candidate, data in candidates:
            if (data and data.get("session_key") == owner and data.get("mode") == mode
                    and _live_flow(candidate, data)
                    and (not project_id or data.get("project_id") == project_id
                         or data.get("auto_project_detection"))):
                return candidate, data
    return None, None


def _accept_callback(state, code, callback_port):
    with _flows_lock:
        cleanup_expired_flows()
        data = auth_flows.get(state)
        if (not data or not code or not _live_flow(state, data)
                or data.get("callback_port") != callback_port
                or data.get("exchange_started") or data.get("code")):
            return False
        data["code"] = code
        data["completed"] = True
        return True


async def find_available_port(start_port: int = None) -> int:
    """动态查找可用端口"""
    if start_port is None:
        start_port = await get_callback_port()

    # 首先尝试默认端口
    for port in range(start_port, start_port + 100):  # 尝试100个端口
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                s.bind(("0.0.0.0", port))
                log.info(f"找到可用端口: {port}")
                return port
        except OSError:
            continue

    # 如果都不可用，让系统自动分配端口
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("0.0.0.0", 0))
            port = s.getsockname()[1]
            log.info(f"系统分配可用端口: {port}")
            return port
    except OSError as e:
        log.error("OAuth操作失败")
        raise RuntimeError("无法找到可用端口")


def create_callback_server(port: int) -> HTTPServer:
    """创建指定端口的回调服务器，优化快速关闭"""
    try:
        # 服务器监听0.0.0.0
        server = HTTPServer(("0.0.0.0", port), AuthCallbackHandler)

        # 设置socket选项以支持快速关闭
        server.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        # 设置较短的超时时间
        server.timeout = 1.0

        log.info(f"创建OAuth回调服务器，监听端口: {port}")
        return server
    except OSError as e:
        log.error("OAuth操作失败")
        raise


class AuthCallbackHandler(BaseHTTPRequestHandler):
    """OAuth回调处理器"""

    def do_GET(self):
        query_components = parse_qs(urlparse(self.path).query)
        code = query_components.get("code", [None])[0]
        state = query_components.get("state", [None])[0]

        valid = len(query_components.get("state", [])) == 1 and len(query_components.get("code", [])) == 1
        if valid and _accept_callback(state, code, self.server.server_port):
            self.send_response(200)
            self.send_header("Content-type", "text/html")
            self.end_headers()
            # 成功页面
            self.wfile.write(
                b'<!DOCTYPE html><html lang="en" class="notranslate" translate="no">'
                b'<head><meta name="google" content="notranslate"></head><body>'
                b'<h1>OAuth authentication successful!</h1>'
                b"<p>You can close this window. Please return to the original page "
                b"and click 'Get Credentials' button.</p></body></html>"
            )
        else:
            self.send_response(400)
            self.send_header("Content-type", "text/html")
            self.end_headers()
            self.wfile.write(
                b'<!DOCTYPE html><html lang="en" class="notranslate" translate="no">'
                b'<head><meta name="google" content="notranslate"></head><body>'
                b"<h1>Authentication failed.</h1><p>Please try again.</p>"
                b"</body></html>"
            )

    def log_message(self, format, *args):
        # 减少日志噪音
        pass


async def create_auth_url(
    project_id: Optional[str] = None, user_session: str = None, mode: str = "geminicli"
) -> Dict[str, Any]:
    owner = _session_key(user_session)
    if owner is None or mode not in ("geminicli", "antigravity"):
        return {"success": False, "error": _FLOW_ERROR}
    callback_server = None
    server_started = False
    try:
        # Port lookup may yield; replacement and publication below must not.
        callback_port = await find_available_port()
        callback_url = f"http://{CALLBACK_HOST}:{callback_port}"
        with _flows_lock:
            cleanup_expired_flows()
            for old_state, data in list(auth_flows.items()):
                if data.get("session_key") == owner and data.get("mode") == mode:
                    if data.get("persisting"):
                        return {"success": False, "error": "认证正在保存中，请等待当前请求完成"}
                    _cleanup_auth_flow_server(old_state)
            while len(auth_flows) >= MAX_AUTH_FLOWS:
                removable = [key for key, data in auth_flows.items() if not data.get("persisting")]
                if not removable:
                    return {"success": False, "error": "认证服务忙，请稍后重试"}
                _cleanup_auth_flow_server(min(removable, key=lambda key: auth_flows[key]["created_at"]))
            flow = Flow(
                client_id=ANTIGRAVITY_CLIENT_ID if mode == "antigravity" else CLIENT_ID,
                client_secret=ANTIGRAVITY_CLIENT_SECRET if mode == "antigravity" else CLIENT_SECRET,
                scopes=ANTIGRAVITY_SCOPES if mode == "antigravity" else SCOPES,
                redirect_uri=callback_url,
            )
            state = secrets.token_urlsafe(32)
            auth_url = flow.get_auth_url(state=state)
            callback_server = create_callback_server(callback_port)
            server_thread = threading.Thread(target=callback_server.serve_forever, daemon=True)
            server_thread.start()
            server_started = True
            auth_flows[state] = {
                "flow": flow, "project_id": project_id, "session_key": owner,
                "callback_port": callback_port, "callback_url": callback_url,
                "server": callback_server, "server_thread": server_thread,
                "code": None, "completed": False, "created_at": time.time(),
                "auto_project_detection": project_id is None, "mode": mode,
                "completion_lock": threading.Lock(), "exchange_started": False,
            }
        log.info("OAuth流程已创建")
        return {
            "auth_url": auth_url, "state": state, "callback_port": callback_port,
            "success": True, "auto_project_detection": project_id is None,
            "detected_project_id": project_id,
        }
    except Exception:
        if callback_server:
            try:
                if server_started:
                    async_shutdown_server(callback_server, callback_port)
                else:
                    callback_server.server_close()
            except Exception:
                log.warning("OAuth回调服务器清理失败")
        log.error("创建OAuth流程失败")
        return {"success": False, "error": "创建OAuth流程失败，请重试"}


def wait_for_callback_sync(state: str, timeout: int = 300) -> Optional[str]:
    started = time.time()
    while time.time() - started < timeout:
        with _flows_lock:
            cleanup_expired_flows()
            data = auth_flows.get(state)
            if not data:
                return None
            if data.get("code"):
                return data["code"]
        time.sleep(0.5)
    return None


async def complete_auth_flow(project_id=None, user_session=None, mode="geminicli"):
    return await asyncio_complete_auth_flow(project_id, user_session, mode)


async def asyncio_complete_auth_flow(project_id=None, user_session=None, mode="geminicli"):
    state, data = _select_auth_flow(user_session, mode, project_id=project_id)
    if data is None:
        return {"success": False, "error": _FLOW_ERROR}
    return await _complete_selected_flow(state, data, project_id, mode)


async def complete_auth_flow_from_callback_url(
    callback_url: str, project_id=None, mode="geminicli", user_session=None
):
    try:
        parsed = urlparse(callback_url)
        params = parse_qs(parsed.query)
        if (parsed.scheme not in ("http", "https")
                or len(params.get("state", [])) != 1 or len(params.get("code", [])) != 1):
            return {"success": False, "error": "回调URL缺少必要参数 (state 或 code)"}
        state, data = _select_auth_flow(user_session, mode, state=params["state"][0])
        if data is None:
            return {"success": False, "error": _FLOW_ERROR}
        expected = urlparse(data["callback_url"])
        if (parsed.scheme != expected.scheme or parsed.hostname != expected.hostname
                or parsed.port != expected.port or (parsed.path or "/") != (expected.path or "/")
                or parsed.username is not None or parsed.password is not None or parsed.fragment):
            return {"success": False, "error": _FLOW_ERROR}
        return await _complete_selected_flow(
            state, data, project_id, mode, callback_code=params["code"][0]
        )
    except Exception:
        log.error("回调URL认证失败")
        return {"success": False, "error": _COMPLETE_ERROR}


async def _complete_selected_flow(state, flow_data, project_id, mode, callback_code=None):
    # Nonblocking lock covers exchange, project selection and persistence.
    lock = flow_data["completion_lock"]
    if not lock.acquire(blocking=False):
        return {"success": False, "error": "认证正在处理中，请等待当前请求完成"}
    try:
        if not _live_flow(state, flow_data):
            return {"success": False, "error": _FLOW_ERROR}
        if callback_code:
            with _flows_lock:
                existing_code = flow_data.get("code")
                if existing_code and existing_code != callback_code:
                    return {"success": False, "error": _FLOW_ERROR}
                flow_data["code"] = callback_code
                flow_data["completed"] = True
        for _ in range(60):
            if flow_data.get("code"):
                break
            await asyncio.sleep(1)
            if not _live_flow(state, flow_data):
                return {"success": False, "error": _FLOW_ERROR}
        if not flow_data.get("code"):
            return {"success": False, "error": "等待OAuth回调超时，请确保完成了浏览器中的认证并看到成功页面"}
        credentials = flow_data.get("credentials")
        if credentials is None:
            if flow_data["exchange_started"]:
                return {"success": False, "error": _COMPLETE_ERROR}
            # Mark before awaiting: an unknown outcome must never redeem again.
            flow_data["exchange_started"] = True
            credentials = await flow_data["flow"].exchange_code(flow_data["code"])
            flow_data["credentials"] = credentials
        if not _live_flow(state, flow_data):
            return {"success": False, "error": _FLOW_ERROR}
        if project_id is None:
            project_id = flow_data.get("project_id")
        finisher = _finish_callback_url if callback_code else _finish_callback
        result = await finisher(state, flow_data, credentials, project_id, mode)
        # Project selection is the only resumable intermediate result.
        if not (result.get("requires_project_selection") or result.get("requires_manual_project_id")):
            _cleanup_auth_flow_server(state)
        return result
    except asyncio.CancelledError:
        _cleanup_auth_flow_server(state)
        raise
    except Exception:
        _cleanup_auth_flow_server(state)
        log.error("OAuth认证未完成")
        return {"success": False, "error": _COMPLETE_ERROR}
    finally:
        if not _live_flow(state, flow_data):
            _cleanup_auth_flow_server(state)
        lock.release()


async def _finish_callback(state, flow_data, credentials, project_id, mode):
    # 检查凭证模式
    cred_mode = flow_data.get("mode", "geminicli") if flow_data.get("mode") else mode
    if cred_mode == "antigravity":
        log.info("Antigravity模式：从API获取project_id...")
        # 使用API获取project_id
        antigravity_url = await get_antigravity_api_url()
        project_id, subscription_tier = await fetch_project_id_and_tier(
            credentials.access_token,
            ANTIGRAVITY_USER_AGENT,
            antigravity_url
        )
        if project_id:
            log.info(f"成功从API获取project_id: {project_id}, tier: {subscription_tier}")
        else:
            project_id = DEFAULT_PROJECT_ID
            log.warning(f"无法从API获取project_id，使用默认project_id: {project_id}")

        # 保存antigravity凭证
        email_result = {}
        if not _live_flow(state, flow_data):
            return {"success": False, "error": _FLOW_ERROR}
        saved_filename = await _save_flow_credentials(state, flow_data, credentials, project_id, mode="antigravity", subscription_tier=subscription_tier, email_result=email_result)

        # 准备返回的凭证数据
        creds_data = _prepare_credentials_data(credentials, project_id, mode="antigravity", subscription_tier=subscription_tier)

        # 清理使用过的流程
        _cleanup_auth_flow_server(state)

        log.info("Antigravity OAuth认证成功，凭证已保存")
        return {
            "success": True,
            "credentials": creds_data,
            "file_path": saved_filename,
            "auto_detected_project": False,
            "mode": "antigravity",
            **email_result,
        }

    # 如果需要自动检测项目ID且没有提供项目ID（标准模式）
    subscription_tier = None
    if flow_data.get("auto_project_detection", False) and not project_id:
        log.info("标准模式：优先通过 loadCodeAssist 获取企业 project_id...")
        try:
            code_assist_url = await get_code_assist_endpoint()
            detected_project_id, subscription_tier = await fetch_project_id_and_tier(
                credentials.access_token,
                get_geminicli_user_agent(""),
                code_assist_url,
            )
            if detected_project_id:
                project_id = detected_project_id
                flow_data["project_id"] = project_id
                log.info(f"成功从 loadCodeAssist 获取 project_id: {project_id}, tier: {subscription_tier}")
        except Exception as e:
            log.warning("OAuth操作失败")

        if not project_id:
            log.info("标准模式：通过项目列表获取project_id...")
            user_projects = await get_user_projects(credentials)

            if user_projects:
                # 如果只有一个项目，自动使用
                if len(user_projects) == 1:
                    # Google API returns projectId in camelCase
                    project_id = user_projects[0].get("projectId")
                    if project_id:
                        flow_data["project_id"] = project_id
                        log.info(f"自动选择唯一项目: {project_id}")
                        # 自动启用必需的API服务
                        log.info("正在自动启用必需的API服务...")
                        await enable_required_apis(credentials, project_id)
                # 如果有多个项目，尝试选择默认项目
                else:
                    project_id = await select_default_project(user_projects)
                    if project_id:
                        flow_data["project_id"] = project_id
                        log.info(f"自动选择默认项目: {project_id}")
                        # 自动启用必需的API服务
                        log.info("正在自动启用必需的API服务...")
                        await enable_required_apis(credentials, project_id)
                    else:
                        # 返回项目列表让用户选择
                        return {
                            "success": False,
                            "error": "请从以下项目中选择一个",
                            "requires_project_selection": True,
                            "available_projects": [
                                {
                                    # Google API returns projectId in camelCase
                                    "project_id": p.get("projectId"),
                                    "name": p.get("displayName") or p.get("projectId"),
                                    "projectNumber": p.get("projectNumber"),
                                }
                                for p in user_projects
                            ],
                        }
            else:
                # 如果无法获取项目列表，使用默认project_id
                project_id = DEFAULT_PROJECT_ID
                flow_data["project_id"] = project_id
                log.warning(f"无法获取项目列表，使用默认project_id: {project_id}")
    elif project_id:
        # 如果已经有项目ID（手动提供或环境检测），也尝试启用API服务
        log.info("正在为已提供的项目ID自动启用必需的API服务...")
        await enable_required_apis(credentials, project_id)

    # 如果仍然没有项目ID，返回错误
    if not project_id:
        project_id = DEFAULT_PROJECT_ID
        flow_data["project_id"] = project_id
        log.warning(f"仍未获取到project_id，使用默认project_id: {project_id}")

    # 保存凭证
    subscription_info = await _detect_geminicli_subscription(
        credentials, project_id
    )
    subscription_tier = subscription_info.tier
    if not _live_flow(state, flow_data):
        return {"success": False, "error": _FLOW_ERROR}
    saved_filename = await _save_flow_credentials(
        state, flow_data, credentials, project_id, subscription_tier=subscription_tier,
        subscription_info=subscription_info,
    )

    # 准备返回的凭证数据
    creds_data = _prepare_credentials_data(credentials, project_id, mode="geminicli", subscription_tier=subscription_tier)

    # 清理使用过的流程
    _cleanup_auth_flow_server(state)

    log.info("OAuth认证成功，凭证已保存")
    return {
        "success": True,
        "credentials": creds_data,
        "file_path": saved_filename,
        "auto_detected_project": flow_data.get("auto_project_detection", False),
        **_subscription_response_fields(subscription_info),
    }


async def _finish_callback_url(state, flow_data, credentials, project_id, mode):
    # 检查凭证模式
    cred_mode = flow_data.get("mode", "geminicli") if flow_data.get("mode") else mode
    if cred_mode == "antigravity":
        log.info("Antigravity模式（从回调URL）：从API获取project_id...")
        # 使用API获取project_id
        antigravity_url = await get_antigravity_api_url()
        project_id, subscription_tier = await fetch_project_id_and_tier(
            credentials.access_token,
            ANTIGRAVITY_USER_AGENT,
            antigravity_url
        )
        if project_id:
            log.info(f"成功从API获取project_id: {project_id}, tier: {subscription_tier}")
        else:
            project_id = DEFAULT_PROJECT_ID
            log.warning(f"无法从API获取project_id，使用默认project_id: {project_id}")

        # 保存antigravity凭证
        email_result = {}
        if not _live_flow(state, flow_data):
            return {"success": False, "error": _FLOW_ERROR}
        saved_filename = await _save_flow_credentials(state, flow_data, credentials, project_id, mode="antigravity", subscription_tier=subscription_tier, email_result=email_result)

        # 准备返回的凭证数据
        creds_data = _prepare_credentials_data(credentials, project_id, mode="antigravity", subscription_tier=subscription_tier)

        # 清理使用过的流程
        _cleanup_auth_flow_server(state)

        log.info("从回调URL完成Antigravity OAuth认证成功，凭证已保存")
        return {
            "success": True,
            "credentials": creds_data,
            "file_path": saved_filename,
            "auto_detected_project": False,
            "mode": "antigravity",
            **email_result,
        }

    # 标准模式的项目ID处理逻辑
    detected_project_id = None
    auto_detected = False
    subscription_tier = None

    if not project_id:
        try:
            log.info("标准模式：优先通过 loadCodeAssist 获取project_id...")
            code_assist_url = await get_code_assist_endpoint()
            detected_project_id, subscription_tier = await fetch_project_id_and_tier(
                credentials.access_token,
                get_geminicli_user_agent(""),
                code_assist_url,
            )
            if detected_project_id:
                auto_detected = True
                log.info(f"成功从 loadCodeAssist 获取 project_id: {detected_project_id}, tier: {subscription_tier}")
        except Exception as e:
            log.warning("OAuth操作失败")

        if not detected_project_id:
            # 通过项目列表获取项目ID
            try:
                log.info("标准模式：通过项目列表获取project_id...")
                projects = await get_user_projects(credentials)
                if projects:
                    if len(projects) == 1:
                        # 只有一个项目，自动使用
                        # Google API returns projectId in camelCase
                        detected_project_id = projects[0]["projectId"]
                        auto_detected = True
                        log.info(f"自动检测到唯一项目ID: {detected_project_id}")
                    else:
                        # 多个项目，自动选择第一个
                        # Google API returns projectId in camelCase
                        detected_project_id = projects[0]["projectId"]
                        auto_detected = True
                        log.info(
                            f"检测到{len(projects)}个项目，自动选择第一个: {detected_project_id}"
                        )
                        log.debug(f"其他可用项目: {[p['projectId'] for p in projects[1:]]}")
                else:
                    # 没有项目访问权限，使用默认project_id
                    detected_project_id = DEFAULT_PROJECT_ID
                    auto_detected = False
                    log.warning(f"未检测到可访问项目，使用默认project_id: {detected_project_id}")
            except Exception as e:
                log.warning("OAuth操作失败")
                detected_project_id = DEFAULT_PROJECT_ID
                auto_detected = False
    else:
        detected_project_id = project_id

    # 启用必需的API服务
    if detected_project_id:
        try:
            log.info(f"正在为项目 {detected_project_id} 启用必需的API服务...")
            await enable_required_apis(credentials, detected_project_id)

        except Exception as e:
            log.warning("OAuth操作失败")

    # 保存凭证
    subscription_info = await _detect_geminicli_subscription(
        credentials, detected_project_id
    )
    subscription_tier = subscription_info.tier
    if not _live_flow(state, flow_data):
        return {"success": False, "error": _FLOW_ERROR}
    saved_filename = await _save_flow_credentials(
        state, flow_data, credentials, detected_project_id, subscription_tier=subscription_tier,
        subscription_info=subscription_info,
    )

    # 准备返回的凭证数据
    creds_data = _prepare_credentials_data(credentials, detected_project_id, mode="geminicli", subscription_tier=subscription_tier)

    # 清理使用过的流程
    _cleanup_auth_flow_server(state)

    log.info("从回调URL完成OAuth认证成功，凭证已保存")
    return {
        "success": True,
        "credentials": creds_data,
        "file_path": saved_filename,
        "auto_detected_project": auto_detected,
        **_subscription_response_fields(subscription_info),
    }


async def _save_flow_credentials(state, flow_data, *args, **kwargs):
    """Accept one persistence attempt atomically with replacement/TTL cleanup.

    This is a process-local commit boundary, not a storage transaction. New
    starts must wait, and expiry/memory eviction must preserve this flow until
    the completion wrapper reports success or an unknown/failed outcome.
    """
    with _flows_lock:
        if not _live_flow(state, flow_data):
            raise RuntimeError(_FLOW_ERROR)
        flow_data["persisting"] = True
    # AG imports may settle after their waiter is cancelled. Shield the whole
    # save, including its first storage await, and retain admission/lock until
    # it settles. Never treat a disconnected HTTP waiter as a rolled-back save.
    commit = asyncio.create_task(save_credentials(*args, **kwargs))
    try:
        return await asyncio.shield(commit)
    except asyncio.CancelledError:
        while not commit.done():
            try:
                await asyncio.shield(commit)
            except asyncio.CancelledError:
                continue
            except Exception:
                break
        if not commit.cancelled():
            commit.exception()  # Consume a late failure without logging secrets.
        raise


async def save_credentials(
    creds: Credentials,
    project_id: str,
    mode: str = "geminicli",
    subscription_tier: str = None,
    subscription_info: Optional[GeminiCliSubscriptionInfo] = None,
    email_result: Optional[dict] = None,
) -> str:
    """通过统一存储系统保存凭证"""
    # 生成文件名（使用project_id和时间戳）
    timestamp = int(time.time())

    # antigravity模式使用特殊前缀
    if mode == "antigravity":
        filename = f"ag_{project_id}-{timestamp}.json"
    else:
        filename = f"{project_id}-{timestamp}.json"

    # 准备凭证数据
    creds_data = _prepare_credentials_data(creds, project_id, mode, subscription_tier)

    # 通过存储适配器保存
    storage_adapter = await get_storage_adapter()
    if mode == "antigravity":
        from src.antigravity_email_enrichment import email_enrichment_service, import_with_email_receipt
        email_batch = email_enrichment_service.batch()
        try:
            await import_with_email_receipt(storage_adapter, filename, creds_data,
                initial_state={"error_codes": [], "disabled": False, "last_success": time.time(),
                               "user_email": None, "tier": subscription_tier or default_tier_for_mode(mode)},
                email_batch=email_batch)
        finally:
            email_batch.seal()
            if email_result is not None:
                email_result.update(email_enrichment=email_batch.public(), warnings=email_batch.warnings)
        return filename
    credential_existed = (
        await storage_adapter.get_credential(filename, mode=mode) is not None
    )
    success = await storage_adapter.store_credential(filename, creds_data, mode=mode)

    if success:
        # 创建默认状态记录
        try:
            tier_value = subscription_tier or default_tier_for_mode(mode)
            default_state = {
                "error_codes": [],
                "disabled": False,
                "last_success": time.time(),
                "user_email": None,
            }
            if mode == "antigravity":
                default_state["tier"] = tier_value
            elif (
                subscription_info is not None
                and subscription_info.status != "unavailable"
            ):
                default_state.update(subscription_info.state_fields())
            elif not credential_existed:
                default_state["tier"] = default_tier_for_mode(mode)
            await storage_adapter.update_credential_state(filename, default_state, mode=mode)
            log.info(f"凭证和状态已保存到: {filename} (mode={mode})")
        except Exception as e:
            log.warning("OAuth操作失败")

        return filename
    else:
        raise Exception(f"保存凭证失败: {filename}")


def async_shutdown_server(server, port):
    """异步关闭OAuth回调服务器，避免阻塞主流程"""

    def shutdown_server_async():
        try:
            # 设置一个标志来跟踪关闭状态
            shutdown_completed = threading.Event()

            def do_shutdown():
                try:
                    server.shutdown()
                    server.server_close()
                    shutdown_completed.set()
                    log.info(f"已关闭端口 {port} 的OAuth回调服务器")
                except Exception as e:
                    shutdown_completed.set()
                    log.debug("OAuth操作失败")

            # 在单独线程中执行关闭操作
            shutdown_worker = threading.Thread(target=do_shutdown, daemon=True)
            shutdown_worker.start()

            # 等待最多5秒，如果超时就放弃等待
            if shutdown_completed.wait(timeout=5):
                log.debug(f"端口 {port} 服务器关闭完成")
            else:
                log.warning(f"端口 {port} 服务器关闭超时，但不阻塞主流程")

        except Exception as e:
            log.debug("OAuth操作失败")

    # 在后台线程中关闭服务器，不阻塞主流程
    shutdown_thread = threading.Thread(target=shutdown_server_async, daemon=True)
    shutdown_thread.start()
    log.debug(f"开始异步关闭端口 {port} 的OAuth回调服务器")


def get_auth_status(project_id: str, user_session=None, mode="geminicli") -> Dict[str, Any]:
    state, data = _select_auth_flow(user_session, mode, project_id=project_id)
    if data is None:
        return {"status": "not_found"}
    return {
        "status": "completed" if data["completed"] else "pending",
        "state": state, "created_at": data["created_at"],
    }


async def verify_password(password: str) -> bool:
    """验证密码（面板登录使用）"""
    from config import get_panel_password

    correct_password = await get_panel_password()
    return password == correct_password
