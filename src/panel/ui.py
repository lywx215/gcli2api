"""Serve the optional, prebuilt UI without making it a startup dependency."""

from __future__ import annotations

import asyncio
import html
import json
from pathlib import Path
import re
from urllib.parse import quote

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from src.embed_policy import frame_ancestors_policy, get_embed_policy


UI_DIST = Path(__file__).resolve().parents[2] / "ui-dist"
_HASHED_ASSET = re.compile(r"-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$")


def service_base(request: Request) -> str:
    """Use only the ASGI server's trusted root_path, never forwarded headers."""
    root = "/".join(part for part in request.scope.get("root_path", "").split("/") if part)
    return "/" + quote(root, safe="/") + "/" if root else "/"


class UIAssets(StaticFiles):
    """Real static-file semantics, with caching only for fingerprinted files."""

    def file_response(self, full_path, stat_result, scope, status_code=200):
        response = super().file_response(full_path, stat_result, scope, status_code)
        response.headers["Cache-Control"] = (
            "public, max-age=31536000, immutable"
            if _HASHED_ASSET.search(Path(full_path).name)
            else "no-cache"
        )
        response.headers["X-Content-Type-Options"] = "nosniff"
        # Windows MIME registry entries must not turn module scripts into text/plain.
        mime = {".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css"}
        if response.status_code != 304 and Path(full_path).suffix in mime:
            response.headers["Content-Type"] = mime[Path(full_path).suffix]
        return response


def install_ui(app: FastAPI, dist_dir: Path = UI_DIST) -> None:
    """Register the HTML endpoint and only the assets subtree, before startup.

    Build before importing the application. A missing tree is supported for legacy
    source installs; adding a build later requires a process restart.
    """
    dist_dir = Path(dist_dir)
    assets = dist_dir / "assets"
    assets_available = assets.is_dir()

    @app.get("/ui", include_in_schema=False)
    async def redirect_ui(request: Request):
        location = service_base(request) + "ui/"
        query = request.scope.get("query_string", b"").decode("latin-1")
        if query:
            location += "?" + query
        return RedirectResponse(location, status_code=307, headers={"Cache-Control": "no-store"})

    @app.get("/ui/", response_class=HTMLResponse, include_in_schema=False)
    async def serve_ui(request: Request):
        policy = await get_embed_policy()
        headers = {
            "Cache-Control": "no-store",
            "Content-Security-Policy": frame_ancestors_policy(policy),
        }
        base = service_base(request)
        try:
            if not assets_available:
                raise FileNotFoundError
            content = await asyncio.to_thread((dist_dir / "index.html").read_text, encoding="utf-8")
            # A mismatched build must not serve an unconfigured client.
            if "__GCLI_EMBED_POLICY__" not in content or "__GCLI_SERVICE_BASE__" not in content:
                raise ValueError("UI metadata placeholders missing")
        except (OSError, UnicodeError, ValueError):
            return HTMLResponse(
                '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
                '<title>新版控制台暂不可用</title></head><body>'
                '<h1>新版控制台暂不可用</h1><p>请先构建匹配此版本的 UI，并重启服务。</p>'
                f'<a href="{html.escape(base + "legacy", quote=True)}">返回旧控制面板</a></body></html>',
                status_code=503,
                headers=headers,
            )
        content = content.replace(
            "__GCLI_EMBED_POLICY__",
            html.escape(json.dumps({"mode": policy.mode, "origins": policy.origins}), quote=True),
        ).replace("__GCLI_SERVICE_BASE__", html.escape(base, quote=True))
        return HTMLResponse(content, headers=headers)

    if assets_available:
        app.mount("/ui/assets", UIAssets(directory=assets, html=False), name="ui-assets")
