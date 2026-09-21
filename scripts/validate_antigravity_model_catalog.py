"""Run a credential-safe live validation of the Antigravity model catalog.

The source SQLite database is opened read-only. One enabled Pro credential is
copied to an automatically deleted temporary SQLite database, and the
candidate service is started against that temporary database only. The script
never prints credential identifiers, account metadata, or tokens; model output
is limited to a short reply preview needed for semantic availability checks.
"""

from __future__ import annotations

import argparse
import asyncio
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import os
import re
import secrets
import sqlite3
import subprocess
import sys
import tempfile
import time
import unicodedata
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

VALIDATION_FILENAME = "live-validation.json"
EXPECTED_REPLY = "测试成功"
TEST_PROMPT = "这是模型可用性测试。请只回复以下四个汉字，不要添加解释或其他内容：测试成功"

FAMILY_PREFERENCES: tuple[tuple[str, tuple[str, ...]], ...] = (
    (
        "gemini-3.8-flash",
        (
            "gemini-3.8-flash-medium",
            "gemini-3.8-flash-high",
            "gemini-3.8-flash-low",
        ),
    ),
    (
        "gemini-3.7-flash",
        (
            "gemini-3.7-flash-medium",
            "gemini-3.7-flash-high",
            "gemini-3.7-flash-low",
        ),
    ),
    (
        "gemini-3.6-flash",
        (
            "gemini-3.6-flash-medium",
            "gemini-3.6-flash-high",
            "gemini-3.6-flash-low",
        ),
    ),
    ("gemini-3.1-pro", ("gemini-3.1-pro-high", "gemini-3.1-pro-low")),
    ("claude-sonnet-4-6", ("claude-sonnet-4-6",)),
    ("claude-opus-4-6", ("claude-opus-4-6-thinking",)),
    ("gpt-oss-120b", ("gpt-oss-120b-medium",)),
)


def _read_enabled_pro_credential(source_db: Path) -> tuple[str, dict[str, Any]]:
    source_uri = source_db.resolve().as_uri() + "?mode=ro"
    with sqlite3.connect(source_uri, uri=True) as database:
        row = database.execute(
            """
            SELECT filename, credential_data
            FROM antigravity_credentials
            WHERE COALESCE(disabled, 0) = 0
              AND COALESCE(permanent_disabled, 0) = 0
              AND LOWER(COALESCE(tier, 'unknown')) = 'pro'
              AND json_valid(credential_data)
            ORDER BY rotation_order, id
            LIMIT 1
            """
        ).fetchone()
    if row is None:
        raise RuntimeError("No enabled Antigravity Pro credential is available")
    filename = str(row[0])
    credential = json.loads(row[1])
    if not isinstance(credential, dict):
        raise RuntimeError("Selected credential payload is invalid")
    if not any(credential.get(key) for key in ("refresh_token", "access_token", "token")):
        raise RuntimeError("Selected credential has no usable token")
    return filename, credential


def _read_live_passwords(source_db: Path) -> tuple[str, str]:
    """Read API/panel passwords without logging or returning unrelated config."""
    source_uri = source_db.resolve().as_uri() + "?mode=ro"
    with sqlite3.connect(source_uri, uri=True) as database:
        rows = database.execute(
            "SELECT key, value FROM config WHERE key IN (?, ?, ?)",
            ("api_password", "panel_password", "password"),
        ).fetchall()
    values: dict[str, Any] = {}
    for key, raw_value in rows:
        try:
            values[str(key)] = json.loads(raw_value)
        except (TypeError, ValueError):
            values[str(key)] = raw_value
    fallback = str(values.get("password") or "pwd")
    return (
        str(values.get("api_password") or fallback),
        str(values.get("panel_password") or fallback),
    )


async def _create_temporary_sqlite(directory: Path, credential: dict[str, Any]) -> None:
    from src.storage.sqlite_manager import SQLiteManager

    previous_directory = os.environ.get("CREDENTIALS_DIR")
    os.environ["CREDENTIALS_DIR"] = str(directory)
    manager = SQLiteManager()
    try:
        await manager.initialize()
        if not await manager.store_credential(
            VALIDATION_FILENAME, credential, mode="antigravity"
        ):
            raise RuntimeError("Failed to create temporary credential record")
        if not await manager.update_credential_state(
            VALIDATION_FILENAME,
            {"tier": "pro", "disabled": 0, "permanent_disabled": 0},
            mode="antigravity",
        ):
            raise RuntimeError("Failed to initialize temporary credential state")
    finally:
        await manager.close()
        if previous_directory is None:
            os.environ.pop("CREDENTIALS_DIR", None)
        else:
            os.environ["CREDENTIALS_DIR"] = previous_directory


def _candidate_environment(
    directory: Path, port: int, validation_password: str
) -> dict[str, str]:
    environment = os.environ.copy()
    environment.update(
        {
            "CREDENTIALS_DIR": str(directory),
            "HOST": "127.0.0.1",
            "PORT": str(port),
            "WORKERS": "1",
            "API_PASSWORD": validation_password,
            "PANEL_PASSWORD": validation_password,
            "POSTGRESQL_URI": "",
            "MONGODB_URI": "",
            "MYSQL_URI": "",
            "GCLI_SERVER_NAME": "",
            "REDIS_URL": "",
            "KEEPALIVE_URL": "",
        }
    )
    return environment


def _wait_until_ready(client: httpx.Client, deadline_seconds: float = 30.0) -> None:
    deadline = time.monotonic() + deadline_seconds
    while time.monotonic() < deadline:
        try:
            response = client.head("/keepalive")
            if response.status_code == 200:
                return
        except httpx.HTTPError:
            pass
        time.sleep(0.25)
    raise RuntimeError("Candidate service did not become ready")


def _choose_family_models(
    public_model_ids: set[str], requested_families: set[str]
) -> list[tuple[str, str]]:
    selected: list[tuple[str, str]] = []
    missing: list[str] = []
    for family, preferences in FAMILY_PREFERENCES:
        if requested_families and family not in requested_families:
            continue
        model_id = next((item for item in preferences if item in public_model_ids), None)
        if model_id is None:
            missing.append(family)
        else:
            selected.append((family, model_id))
    if missing:
        raise RuntimeError("Live public list is missing families: " + ", ".join(missing))
    return selected


def _safe_error_metadata(response: httpx.Response) -> dict[str, Any]:
    """Extract stable error labels without returning upstream message text."""
    try:
        payload = response.json()
    except ValueError:
        return {"error_code": None, "error_status": None, "error_type": None}
    error = payload.get("error") if isinstance(payload, dict) else None
    if not isinstance(error, dict):
        return {"error_code": None, "error_status": None, "error_type": None}
    return {
        "error_code": error.get("code"),
        "error_status": error.get("status"),
        "error_type": error.get("type"),
    }


def _is_expected_reply(reply: str) -> bool:
    normalized = unicodedata.normalize("NFKC", reply or "")
    normalized = re.sub(r"\s+", "", normalized)
    normalized = normalized.strip("\"'“”‘’「」『』。.!！")
    return normalized == EXPECTED_REPLY


def _safe_reply_preview(reply: str, limit: int = 240) -> str:
    preview = re.sub(r"\s+", " ", reply or "").strip()
    if not preview:
        return "（空回复）"
    return preview if len(preview) <= limit else preview[:limit] + "…"


def _test_model(
    base_url: str,
    headers: dict[str, str],
    family: str,
    model_id: str,
) -> dict[str, Any]:
    started_at = time.monotonic()
    with httpx.Client(base_url=base_url, timeout=180.0, trust_env=False) as client:
        response = client.post(
            "/antigravity/v1/chat/completions",
            headers=headers,
            json={
                "model": model_id,
                "messages": [{"role": "user", "content": TEST_PROMPT}],
                "max_tokens": 256,
                "stream": False,
            },
        )
    elapsed_ms = round((time.monotonic() - started_at) * 1000)
    result: dict[str, Any] = {
        "family": family,
        "model": model_id,
        "status": response.status_code,
        "elapsed_ms": elapsed_ms,
        "ok": False,
    }
    if response.status_code < 200 or response.status_code >= 300:
        result.update(_safe_error_metadata(response))
        return result

    try:
        payload = response.json()
    except ValueError:
        result["reply"] = "（非 JSON 响应）"
        return result
    choices = payload.get("choices", []) if isinstance(payload, dict) else []
    content = ""
    reasoning_content = ""
    if choices and isinstance(choices[0], dict):
        message = choices[0].get("message", {})
        if isinstance(message, dict):
            content = message.get("content") or ""
            reasoning_content = message.get("reasoning_content") or ""
    reply = str(content).strip()
    result.update(
        {
            "content_chars": len(reply),
            "reasoning_chars": len(str(reasoning_content).strip()),
            "reply": _safe_reply_preview(reply),
            "ok": _is_expected_reply(reply),
        }
    )
    return result


def _validate_live_service(
    base_url: str,
    api_password: str,
    panel_password: str,
    quota_filename: str,
    requested_families: set[str],
    all_models: bool,
    all_public_models: bool,
    workers: int,
) -> dict[str, Any]:
    api_headers = {"Authorization": f"Bearer {api_password}"}
    panel_headers = {"Authorization": f"Bearer {panel_password}"}
    stats_before: dict[str, Any] = {}
    with httpx.Client(base_url=base_url, timeout=120.0, trust_env=False) as client:
        _wait_until_ready(client)

        stats_response = client.get(
            "/creds/stats-today",
            params={"mode": "antigravity"},
            headers=panel_headers,
        )
        if stats_response.status_code == 200:
            candidate_stats = stats_response.json()
            if isinstance(candidate_stats, dict):
                stats_before = candidate_stats

        quota_response = client.get(
            f"/creds/quota/{quote(quota_filename, safe='')}",
            params={"mode": "antigravity"},
            headers=panel_headers,
        )
        quota_response.raise_for_status()
        quota_payload = quota_response.json()
        quota_models = quota_payload.get("models", {})
        if not quota_payload.get("success") or not isinstance(quota_models, dict):
            raise RuntimeError("Live quota discovery did not return a model map")
        if not any(info.get("public") is False for info in quota_models.values()):
            raise RuntimeError("Live quota response did not preserve internal models")

        models_response = client.get(
            "/antigravity/v1/models", headers=api_headers
        )
        models_response.raise_for_status()
        model_payload = models_response.json()
        public_model_ids = {
            item.get("id")
            for item in model_payload.get("data", [])
            if isinstance(item, dict) and isinstance(item.get("id"), str)
        }
        if all_models or all_public_models:
            selected_models = [
                (
                    str(info.get("family") or model_id),
                    str(info.get("testModel") or model_id),
                )
                for model_id, info in quota_models.items()
                if isinstance(info, dict)
                and (all_models or info.get("public") is True)
            ]
            selected_models.sort(
                key=lambda item: (
                    not bool(quota_models.get(item[1], {}).get("public")),
                    item[1],
                )
            )
        else:
            selected_models = _choose_family_models(
                public_model_ids, requested_families
            )

    indexed_results: dict[int, dict[str, Any]] = {}
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {
            executor.submit(
                _test_model, base_url, api_headers, family, model_id
            ): index
            for index, (family, model_id) in enumerate(selected_models)
        }
        for future in as_completed(futures):
            index = futures[future]
            family, model_id = selected_models[index]
            try:
                indexed_results[index] = future.result()
            except Exception as exc:
                indexed_results[index] = {
                    "family": family,
                    "model": model_id,
                    "status": None,
                    "error_type": type(exc).__name__,
                    "ok": False,
                }
    results = [indexed_results[index] for index in range(len(selected_models))]

    stats_after: dict[str, Any] = {}
    with httpx.Client(base_url=base_url, timeout=30.0, trust_env=False) as client:
        stats_response = client.get(
            "/creds/stats-today",
            params={"mode": "antigravity"},
            headers=panel_headers,
        )
        if stats_response.status_code == 200:
            candidate_stats = stats_response.json()
            if isinstance(candidate_stats, dict):
                stats_after = candidate_stats
    stats_before_total = int(stats_before.get("total_count") or 0)
    stats_after_total = int(stats_after.get("total_count") or 0)
    stats_before_success = int(stats_before.get("success_count") or 0)
    stats_after_success = int(stats_after.get("success_count") or 0)
    stats_before_failure = int(stats_before.get("failure_count") or 0)
    stats_after_failure = int(stats_after.get("failure_count") or 0)

    return {
        "advertised_model_count": len(public_model_ids),
        "public_base_model_count": sum(
            not model_id.startswith(("假流式/", "抗截断/"))
            for model_id in public_model_ids
        ),
        "raw_quota_model_count": len(quota_models),
        "tested_model_count": len(selected_models),
        "worker_count": workers,
        "expected_reply": EXPECTED_REPLY,
        "stats_total_before": stats_before_total,
        "stats_total_after": stats_after_total,
        "stats_total_delta": stats_after_total - stats_before_total,
        "stats_success_delta": stats_after_success - stats_before_success,
        "stats_failure_delta": stats_after_failure - stats_before_failure,
        "results": results,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-db", type=Path, required=True)
    parser.add_argument("--port", type=int, default=7862)
    parser.add_argument(
        "--live-url",
        help=(
            "Probe an already running gcli2api instance and write normal usage "
            "statistics there instead of starting an isolated candidate"
        ),
    )
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument(
        "--family",
        action="append",
        choices=[family for family, _ in FAMILY_PREFERENCES],
        default=[],
        help="Validate only the selected family; may be repeated",
    )
    selection.add_argument(
        "--all-models",
        action="store_true",
        help="Test every raw model returned by live quota discovery",
    )
    selection.add_argument(
        "--all-public-models",
        action="store_true",
        help="Test every public base model returned by live quota discovery",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=6,
        help="Number of concurrent model probes (1-12, default: 6)",
    )
    args = parser.parse_args()
    if not 1 <= args.workers <= 12:
        parser.error("--workers must be between 1 and 12")

    source_filename, credential = _read_enabled_pro_credential(args.source_db)
    if args.live_url:
        api_password, panel_password = _read_live_passwords(args.source_db)
        credential.clear()
        report = _validate_live_service(
            args.live_url.rstrip("/"),
            api_password,
            panel_password,
            source_filename,
            set(args.family),
            args.all_models,
            args.all_public_models,
            args.workers,
        )
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0 if all(item["ok"] for item in report["results"]) else 1

    validation_password = secrets.token_urlsafe(24)
    with tempfile.TemporaryDirectory(prefix="gcli2api-antigravity-live-") as temp_name:
        temporary_directory = Path(temp_name)
        asyncio.run(_create_temporary_sqlite(temporary_directory, credential))
        credential.clear()

        creation_flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        process = subprocess.Popen(
            [sys.executable, "web.py"],
            cwd=REPOSITORY_ROOT,
            env=_candidate_environment(
                temporary_directory, args.port, validation_password
            ),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=creation_flags,
        )
        try:
            report = _validate_live_service(
                f"http://127.0.0.1:{args.port}",
                validation_password,
                validation_password,
                VALIDATION_FILENAME,
                set(args.family),
                args.all_models,
                args.all_public_models,
                args.workers,
            )
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)

    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if all(item["ok"] for item in report["results"]) else 1


if __name__ == "__main__":
    raise SystemExit(main())
