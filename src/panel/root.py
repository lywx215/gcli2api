"""根路由模块 - 处理控制面板主页。"""

import html
import json

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse

from log import log
from src.embed_policy import frame_ancestors_policy, get_embed_policy
from src.versioning import get_asset_version
from .utils import is_mobile_user_agent


# 创建路由器
router = APIRouter(tags=["root"])


@router.get("/", response_class=HTMLResponse)
async def serve_control_panel(request: Request):
    """提供统一控制面板"""
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
