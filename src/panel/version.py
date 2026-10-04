"""
版本信息路由模块 - 处理 /version/* 相关的HTTP请求
"""

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from log import log
from src.versioning import load_panel_version_metadata


# 创建路由器
router = APIRouter(prefix="/version", tags=["version"])


@router.get("/info")
async def get_version_info(check_update: bool = False):
    """
    获取当前运行分支版本。保留旧 check_update 参数，不再查询远程更新。
    """
    try:
        version_data = load_panel_version_metadata()
        if version_data.get("display_version", "unknown") == "unknown":
            return JSONResponse({
                "success": False,
                "error": "无法确定当前版本"
            }, headers={"Cache-Control": "no-store"})

        response_data = {
            "success": True,
            "version": version_data.get('version', 'unknown'),
            "full_hash": version_data.get('full_hash', ''),
            "message": version_data.get('message', ''),
            "date": version_data.get('date', ''),
            "display_version": version_data.get('display_version', version_data.get('version', 'unknown')),
            "source_ref": version_data.get('source_ref', ''),
            "commit_date": version_data.get('commit_date', '')
        }

        if check_update:
            response_data['check_update'] = False
            response_data['update_error'] = '更新检查已停用'

        return JSONResponse(response_data, headers={"Cache-Control": "no-store"})

    except Exception as e:
        log.error(f"获取版本信息失败: {e}")
        return JSONResponse({
            "success": False,
            "error": str(e)
        }, headers={"Cache-Control": "no-store"})
