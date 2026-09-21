"""Run a credential-safe live validation of the Antigravity model catalog.

The source SQLite database is opened read-only. One enabled Pro credential is
copied to an automatically deleted temporary SQLite database, and the
candidate service is started against that temporary database only. The script
never prints credential identifiers, account metadata, tokens, or responses.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import secrets
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

import httpx


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

VALIDATION_FILENAME = "live-validation.json"

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


def _read_enabled_pro_credential(source_db: Path) -> dict[str, Any]:
    source_uri = source_db.resolve().as_uri() + "?mode=ro"
    with sqlite3.connect(source_uri, uri=True) as database:
        row = database.execute(
            """
            SELECT credential_data
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
    credential = json.loads(row[0])
    if not isinstance(credential, dict):
        raise RuntimeError("Selected credential payload is invalid")
    if not any(credential.get(key) for key in ("refresh_token", "access_token", "token")):
        raise RuntimeError("Selected credential has no usable token")
    return credential


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


def _validate_live_service(
    base_url: str, validation_password: str, requested_families: set[str]
) -> dict[str, Any]:
    headers = {"Authorization": f"Bearer {validation_password}"}
    results: list[dict[str, Any]] = []
    with httpx.Client(base_url=base_url, timeout=120.0, trust_env=False) as client:
        _wait_until_ready(client)

        quota_response = client.get(
            f"/creds/quota/{VALIDATION_FILENAME}",
            params={"mode": "antigravity"},
            headers=headers,
        )
        quota_response.raise_for_status()
        quota_payload = quota_response.json()
        quota_models = quota_payload.get("models", {})
        if not quota_payload.get("success") or not isinstance(quota_models, dict):
            raise RuntimeError("Live quota discovery did not return a model map")
        if not any(info.get("public") is False for info in quota_models.values()):
            raise RuntimeError("Live quota response did not preserve internal models")

        models_response = client.get("/antigravity/v1/models", headers=headers)
        models_response.raise_for_status()
        model_payload = models_response.json()
        public_model_ids = {
            item.get("id")
            for item in model_payload.get("data", [])
            if isinstance(item, dict) and isinstance(item.get("id"), str)
        }
        selected_models = _choose_family_models(public_model_ids, requested_families)

        for family, model_id in selected_models:
            started_at = time.monotonic()
            response = client.post(
                "/antigravity/v1/chat/completions",
                headers=headers,
                json={
                    "model": model_id,
                    "messages": [{"role": "user", "content": "仅回复 OK"}],
                    "max_tokens": 8,
                    "stream": False,
                },
            )
            elapsed_ms = round((time.monotonic() - started_at) * 1000)
            if response.status_code < 200 or response.status_code >= 300:
                results.append(
                    {
                        "family": family,
                        "model": model_id,
                        "status": response.status_code,
                        "elapsed_ms": elapsed_ms,
                        "ok": False,
                        **_safe_error_metadata(response),
                    }
                )
                continue
            payload = response.json()
            choices = payload.get("choices", []) if isinstance(payload, dict) else []
            content = ""
            reasoning_content = ""
            if choices and isinstance(choices[0], dict):
                message = choices[0].get("message", {})
                if isinstance(message, dict):
                    content = message.get("content") or ""
                    reasoning_content = message.get("reasoning_content") or ""
            results.append(
                {
                    "family": family,
                    "model": model_id,
                    "status": response.status_code,
                    "elapsed_ms": elapsed_ms,
                    "content_chars": len(str(content).strip()),
                    "reasoning_chars": len(str(reasoning_content).strip()),
                    "ok": bool(
                        str(content).strip() or str(reasoning_content).strip()
                    ),
                }
            )

    return {
        "advertised_model_count": len(public_model_ids),
        "public_base_model_count": sum(
            not model_id.startswith(("假流式/", "抗截断/"))
            for model_id in public_model_ids
        ),
        "raw_quota_model_count": len(quota_models),
        "results": results,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-db", type=Path, required=True)
    parser.add_argument("--port", type=int, default=7862)
    parser.add_argument(
        "--family",
        action="append",
        choices=[family for family, _ in FAMILY_PREFERENCES],
        default=[],
        help="Validate only the selected family; may be repeated",
    )
    args = parser.parse_args()

    credential = _read_enabled_pro_credential(args.source_db)
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
                set(args.family),
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
