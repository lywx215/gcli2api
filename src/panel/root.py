"""根路由模块 - 处理控制面板主页。"""

import html
import json

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse

from log import log
from src.embed_policy import frame_ancestors_policy, get_embed_policy
from src.versioning import get_asset_version
from .utils import is_mobile_user_agent
from .ui import service_base


# 创建路由器
router = APIRouter(tags=["root"])


@router.get("/model-routing", response_class=HTMLResponse)
async def serve_model_routing(request: Request):
    """Serve the dedicated editor; its API uses the existing panel login."""
    try:
        with open("front/model_routing.html", "r", encoding="utf-8") as f:
            html_content = f.read()
        embed_policy = await get_embed_policy()
        html_content = html_content.replace(
            "__GCLI2API_ASSET_VERSION__", get_asset_version()
        ).replace(
            "__GCLI_EMBED_POLICY__",
            html.escape(
                json.dumps({"mode": embed_policy.mode, "origins": embed_policy.origins}),
                quote=True,
            ),
        )
        return HTMLResponse(
            content=html_content,
            headers={
                "Cache-Control": "no-store",
                "Content-Security-Policy": frame_ancestors_policy(embed_policy),
            },
        )
    except Exception:
        log.error("加载模型路由页面失败")
        raise HTTPException(status_code=500, detail="服务器内部错误")


def _redirect_panel(request: Request, target: str) -> RedirectResponse:
    location = service_base(request) + target
    query = request.scope.get("query_string", b"").decode("latin-1")
    if query:
        location += "?" + query
    # No fragment is supplied: browsers retain the incoming bookmark fragment.
    return RedirectResponse(location, status_code=307, headers={"Cache-Control": "no-store"})


@router.get("/", include_in_schema=False)
async def redirect_default_panel(request: Request):
    """Use the new console by default without changing existing API paths."""
    return _redirect_panel(request, "ui/")


@router.get("/legacy/", include_in_schema=False)
async def redirect_legacy_panel(request: Request):
    """Relative legacy API and WebSocket URLs require the slash-less entry."""
    return _redirect_panel(request, "legacy")


@router.get("/legacy", response_class=HTMLResponse, include_in_schema=False)
async def serve_control_panel(request: Request):
    """保留原桌面/手机控制面板及其原有接口。"""
    try:
        user_agent = request.headers.get("user-agent", "")
        is_mobile = is_mobile_user_agent(user_agent)

        if is_mobile:
            html_file_path = "front/control_panel_mobile.html"
        else:
            html_file_path = "front/control_panel.html"

        with open(html_file_path, "r", encoding="utf-8") as f:
            html_content = f.read()
        embed_policy = await get_embed_policy()
        html_content = html_content.replace(
            "__GCLI2API_ASSET_VERSION__", get_asset_version()
        )
        html_content = html_content.replace(
            "__GCLI_EMBED_POLICY__",
            html.escape(
                json.dumps(
                    {"mode": embed_policy.mode, "origins": embed_policy.origins}
                ),
                quote=True,
            ),
        )
        return HTMLResponse(
            content=html_content,
            headers={
                "Cache-Control": "no-store",
                "Content-Security-Policy": frame_ancestors_policy(embed_policy),
            },
        )

    except Exception as e:
        log.error(f"加载控制面板页面失败: {e}")
        raise HTTPException(status_code=500, detail="服务器内部错误")
