#!/usr/bin/env python3
"""Run real, non-streaming generation checks against every base model."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import subprocess
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from time import perf_counter
from typing import Any

import httpx

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from src.utils import BASE_MODELS  # noqa: E402

FEATURE_PREFIXES = ("假流式/", "流式抗截断/")
TEST_PROMPT = (
    "This is an automated live-server model test. "
    "Reply with exactly MODEL_TEST_OK and no other text."
)


@dataclass
class ModelResult:
    mode: str
    model: str
    outcome: str
    http_status: int | None
    elapsed_ms: int
    request_id: str | None = None
    response_model: str | None = None
    content_preview: str | None = None
    content_sha256: str | None = None
    error: str | None = None


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _git_sha() -> str | None:
    try:
        return subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=PROJECT_ROOT,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None


def _extract_generated_content(payload: Any) -> str:
    if not isinstance(payload, dict):
        raise ValueError("response body is not a JSON object")
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        raise ValueError("response has no choices")
    first = choices[0]
    if not isinstance(first, dict):
        raise ValueError("response choice is not an object")
    message = first.get("message")
    if not isinstance(message, dict):
        raise ValueError("response choice has no message")
    content = message.get("content")
    if isinstance(content, str) and content.strip():
        return content.strip()
    if isinstance(content, list) and content:
        serialized = json.dumps(content, ensure_ascii=False, sort_keys=True)
        if serialized.strip():
            return serialized
    raise ValueError("response contains no generated content")


def _base_antigravity_models(payload: Any) -> list[str]:
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
        raise ValueError("Antigravity model list has an invalid response shape")
    models: list[str] = []
    for item in payload["data"]:
        if not isinstance(item, dict):
            continue
        model = item.get("id")
        if not isinstance(model, str) or not model:
            continue
        if model.startswith(FEATURE_PREFIXES):
            continue
        if model not in models:
            models.append(model)
    return models


async def _discover_antigravity_models(client: httpx.AsyncClient, api_key: str) -> list[str]:
    response = await client.get(
        "/antigravity/v1/models",
        headers={"Authorization": f"Bearer {api_key}"},
    )
    response.raise_for_status()
    return _base_antigravity_models(response.json())


async def _test_model(
    client: httpx.AsyncClient,
    api_key: str,
    mode: str,
    model: str,
) -> ModelResult:
    route = "/v1/chat/completions" if mode == "geminicli" else "/antigravity/v1/chat/completions"
    started = perf_counter()
    try:
        response = await client.post(
            route,
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": model,
                "messages": [{"role": "user", "content": TEST_PROMPT}],
                "stream": False,
                "temperature": 0,
                "max_tokens": 16,
            },
        )
        elapsed_ms = round((perf_counter() - started) * 1000)
        request_id = response.headers.get("x-request-id")
        if not 200 <= response.status_code < 300:
            error_text = response.text.replace("\n", " ").strip()[:300]
            return ModelResult(
                mode=mode,
                model=model,
                outcome="failed",
                http_status=response.status_code,
                elapsed_ms=elapsed_ms,
                request_id=request_id,
                error=error_text or f"HTTP {response.status_code}",
            )
        try:
            payload = response.json()
            content = _extract_generated_content(payload)
        except (json.JSONDecodeError, ValueError) as exc:
            return ModelResult(
                mode=mode,
                model=model,
                outcome="failed",
                http_status=response.status_code,
                elapsed_ms=elapsed_ms,
                request_id=request_id,
                error=str(exc),
            )
        return ModelResult(
            mode=mode,
            model=model,
            outcome="passed",
            http_status=response.status_code,
            elapsed_ms=elapsed_ms,
            request_id=request_id,
            response_model=payload.get("model"),
            content_preview=content[:120],
            content_sha256=hashlib.sha256(content.encode("utf-8")).hexdigest(),
        )
    except httpx.TimeoutException:
        return ModelResult(
            mode=mode,
            model=model,
            outcome="failed",
            http_status=None,
            elapsed_ms=round((perf_counter() - started) * 1000),
            error="request timed out",
        )
    except httpx.HTTPError as exc:
        return ModelResult(
            mode=mode,
            model=model,
            outcome="failed",
            http_status=None,
            elapsed_ms=round((perf_counter() - started) * 1000),
            error=f"{type(exc).__name__}: {exc}",
        )


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Test every base model through real server generation requests."
    )
    parser.add_argument(
        "--base-url",
        default=os.getenv("GCLI2API_TEST_BASE_URL", "http://127.0.0.1:7861"),
    )
    parser.add_argument(
        "--mode",
        choices=("all", "geminicli", "antigravity"),
        default="all",
        help="Default 'all' is the required release/server-test scope.",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=float(os.getenv("GCLI2API_TEST_TIMEOUT", "180")),
        help="Per-model request timeout in seconds.",
    )
    parser.add_argument(
        "--report-dir",
        type=Path,
        default=PROJECT_ROOT / ".test-results",
    )
    return parser.parse_args()


async def _run(args: argparse.Namespace) -> int:
    api_key = (
        os.getenv("GCLI2API_TEST_API_KEY") or os.getenv("API_PASSWORD") or os.getenv("PASSWORD")
    )
    if not api_key:
        print(
            "ERROR: set GCLI2API_TEST_API_KEY (preferred), API_PASSWORD, or PASSWORD",
            file=sys.stderr,
        )
        return 2

    modes = ["geminicli", "antigravity"] if args.mode == "all" else [args.mode]
    started_at = _utc_now()
    results: list[ModelResult] = []
    blocked_modes: dict[str, str] = {}
    inventories: dict[str, list[str]] = {}

    timeout = httpx.Timeout(args.timeout)
    async with httpx.AsyncClient(
        base_url=args.base_url.rstrip("/"),
        timeout=timeout,
        follow_redirects=False,
        trust_env=False,
    ) as client:
        try:
            keepalive = await client.head("/keepalive")
            keepalive.raise_for_status()
        except httpx.HTTPError as exc:
            print(f"ERROR: server preflight failed: {exc}", file=sys.stderr)
            return 2

        for mode in modes:
            if mode == "geminicli":
                models = list(BASE_MODELS)
            else:
                try:
                    models = await _discover_antigravity_models(client, api_key)
                except (httpx.HTTPError, ValueError) as exc:
                    blocked_modes[mode] = f"model discovery failed: {exc}"
                    inventories[mode] = []
                    continue
            inventories[mode] = models
            if not models:
                blocked_modes[mode] = "no base models discovered; verify credentials"
                continue
            for model in models:
                print(f"[RUN ] {mode:12} {model}", flush=True)
                result = await _test_model(client, api_key, mode, model)
                results.append(result)
                print(
                    f"[{result.outcome.upper():5}] {mode:12} {model} "
                    f"HTTP={result.http_status or '-'} {result.elapsed_ms}ms",
                    flush=True,
                )

    passed = sum(item.outcome == "passed" for item in results)
    failed = sum(item.outcome != "passed" for item in results)
    report = {
        "schema_version": 1,
        "test_type": "real-server-all-base-models",
        "started_at": started_at,
        "finished_at": _utc_now(),
        "git_sha": _git_sha(),
        "base_url": args.base_url,
        "requested_mode": args.mode,
        "timeout_seconds": args.timeout,
        "inventories": inventories,
        "blocked_modes": blocked_modes,
        "summary": {
            "total": len(results),
            "passed": passed,
            "failed": failed,
            "blocked_mode_count": len(blocked_modes),
            "overall": "passed" if failed == 0 and not blocked_modes else "failed",
        },
        "results": [asdict(item) for item in results],
    }
    args.report_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    report_path = args.report_dir / f"real-server-models-{timestamp}.json"
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    print()
    print(
        f"SUMMARY total={len(results)} passed={passed} failed={failed} "
        f"blocked_modes={len(blocked_modes)}"
    )
    for mode, reason in blocked_modes.items():
        print(f"BLOCKED {mode}: {reason}")
    print(f"REPORT {report_path}")
    return 0 if report["summary"]["overall"] == "passed" else 1


def main() -> int:
    return asyncio.run(_run(_parse_args()))


if __name__ == "__main__":
    raise SystemExit(main())
