"""
版本信息路由模块 - 处理 /version/* 相关的HTTP请求
"""

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from log import log
from src.versioning import load_version_metadata


# 创建路由器
router = APIRouter(prefix="/version", tags=["version"])


@router.get("/info")
async def get_version_info(check_update: bool = False):
    """
    获取当前版本信息 - 从version.txt读取
    可选参数 check_update: 是否检查GitHub上的最新版本
    """
    try:
        version_data = load_version_metadata()
        if version_data["version"] == "unknown":
            return JSONResponse({
                "success": False,
                "error": "无法确定当前版本"
            })

        response_data = {
            "success": True,
            "version": version_data.get('version', 'unknown'),
            "full_hash": version_data.get('full_hash', ''),
            "message": version_data.get('message', ''),
            "date": version_data.get('date', '')
        }

        # 如果需要检查更新
        if check_update:
            try:
                from src.httpx_client import get_async

                # 直接获取GitHub上的version.txt文件
                github_version_url = "https://raw.githubusercontent.com/su-kaka/gcli2api/refs/heads/master/version.txt"

                # 使用统一的httpx客户端
                resp = await get_async(github_version_url, timeout=10.0)

                if resp.status_code == 200:
                    # 解析远程version.txt
                    remote_version_data = {}
                    for line in resp.text.strip().split('\n'):
                        line = line.strip()
                        if '=' in line:
                            key, value = line.split('=', 1)
                            remote_version_data[key] = value

                    latest_hash = remote_version_data.get('full_hash', '')
                    latest_short_hash = remote_version_data.get('short_hash', '')
                    current_hash = response_data.get('full_hash', '')

                    has_update = (current_hash != latest_hash) if current_hash and latest_hash else None

                    response_data['check_update'] = True
                    response_data['has_update'] = has_update
                    response_data['latest_version'] = latest_short_hash
                    response_data['latest_hash'] = latest_hash
                    response_data['latest_message'] = remote_version_data.get('message', '')
                    response_data['latest_date'] = remote_version_data.get('date', '')
                else:
                    # GitHub获取失败，但不影响基本版本信息
                    response_data['check_update'] = False
                    response_data['update_error'] = f"GitHub返回错误: {resp.status_code}"

            except Exception as e:
                log.debug(f"检查更新失败: {e}")
                response_data['check_update'] = False
                response_data['update_error'] = str(e)

        return JSONResponse(response_data)

    except Exception as e:
        log.error(f"获取版本信息失败: {e}")
        return JSONResponse({
            "success": False,
            "error": str(e)
        })
