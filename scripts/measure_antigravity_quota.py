"""Measure Antigravity quota consumption with matched Gemini-native workloads.

The runner targets an already running gcli2api instance.  It reads the source
SQLite database in read-only mode, never prints credential identifiers or
secrets, and stores only model IDs, aggregate usage metadata, quota fractions,
HTTP status codes, and hashes/lengths of generated text.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import sqlite3
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

from scripts.validate_antigravity_model_catalog import (  # noqa: E402
    _read_enabled_pro_credential,
    _read_live_passwords,
)


FLASH_MODEL = "gemini-3.8-flash-high"
PRO_MODEL = "gemini-3.1-pro-high"
TARGET_INPUT_TOKENS = 10_000
TARGET_OUTPUT_TOKENS = 2_000
FORMAL_REQUESTS = 10
MAX_CALIBRATIONS = 2
MAX_SUPPLEMENTS = 3
PARITY_LIMIT_PERCENT = 2.0
STAGE_TIMEOUT_SECONDS = 60 * 60
RESET_GUARD_SECONDS = 30 * 60

COMMON_WORDS = (
    "amber", "baker", "calm", "delta", "ember", "forest", "garden", "harbor",
    "island", "jungle", "kernel", "lemon", "maple", "north", "ocean", "paper",
    "quiet", "river", "silver", "table", "unity", "violet", "water", "yellow",
)


class MeasurementError(RuntimeError):
    pass


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_now() -> str:
    return utc_now().isoformat().replace("+00:00", "Z")


def percent_difference(left: int | float, right: int | float) -> float:
    """Return symmetric percent difference, treating two zeroes as equal."""
    average = (float(left) + float(right)) / 2.0
    if average == 0:
        return 0.0
    return abs(float(left) - float(right)) / average * 100.0


def output_tokens(usage: dict[str, int]) -> int:
    return usage["candidatesTokenCount"] + usage["thoughtsTokenCount"]


def aggregate_usage(records: list[dict[str, Any]]) -> dict[str, int]:
    fields = (
        "promptTokenCount",
        "cachedContentTokenCount",
        "candidatesTokenCount",
        "thoughtsTokenCount",
        "totalTokenCount",
    )
    totals = {field: 0 for field in fields}
    for record in records:
        usage = record["usage"]
        for field in fields:
            totals[field] += int(usage.get(field, 0) or 0)
    totals["outputTokenCount"] = (
        totals["candidatesTokenCount"] + totals["thoughtsTokenCount"]
    )
    return totals


def parse_usage_payload(payload: Any) -> tuple[dict[str, int], str, str, int]:
    if not isinstance(payload, dict) or payload.get("error"):
        raise MeasurementError("HTTP 200 response contains an error payload")
    usage = payload.get("usageMetadata")
    if not isinstance(usage, dict):
        raise MeasurementError("HTTP 200 response is missing usageMetadata")

    parsed = {
        "promptTokenCount": int(usage.get("promptTokenCount", 0) or 0),
        "cachedContentTokenCount": int(usage.get("cachedContentTokenCount", 0) or 0),
        "candidatesTokenCount": int(usage.get("candidatesTokenCount", 0) or 0),
        "thoughtsTokenCount": int(usage.get("thoughtsTokenCount", 0) or 0),
        "totalTokenCount": int(usage.get("totalTokenCount", 0) or 0),
    }
    if parsed["promptTokenCount"] <= 0 or output_tokens(parsed) <= 0:
        raise MeasurementError("usageMetadata does not contain positive input/output counts")

    candidates = payload.get("candidates")
    if not isinstance(candidates, list) or not candidates or not isinstance(candidates[0], dict):
        raise MeasurementError("HTTP 200 response contains no candidate")
    candidate = candidates[0]
    finish_reason = str(candidate.get("finishReason") or "")
    content = candidate.get("content")
    parts = content.get("parts", []) if isinstance(content, dict) else []
    visible_text = "".join(
        str(part.get("text") or "")
        for part in parts
        if isinstance(part, dict) and not part.get("thought")
    ).strip()
    if not visible_text:
        raise MeasurementError("HTTP 200 response contains no visible text")
    normalized = " ".join(visible_text.split()).casefold()
    if "is no longer available" in normalized and "please switch to" in normalized:
        raise MeasurementError("HTTP 200 response is an unavailable-model notice")
    digest = hashlib.sha256(visible_text.encode("utf-8")).hexdigest()[:16]
    return parsed, finish_reason, digest, len(visible_text)


def _seeded_words(count: int, salt: str, namespace: str) -> str:
    seed_bytes = hashlib.sha256(f"{namespace}:{salt}".encode("utf-8")).digest()
    generator = random.Random(int.from_bytes(seed_bytes[:8], "big"))
    return " ".join(generator.choice(COMMON_WORDS) for _ in range(max(1, count)))


def build_native_payload(
    *, filler_words: int, output_words_count: int, salt: str
) -> tuple[dict[str, Any], dict[str, int]]:
    filler = _seeded_words(filler_words, salt, "input")
    blueprint = _seeded_words(output_words_count, salt, "output")
    system_text = (
        "This is a quota measurement. Copy the text between OUTPUT_BEGIN and "
        "OUTPUT_END exactly once. Output only that copied text, with no heading, "
        "analysis, explanation, summary, or code fence."
    )
    user_text = (
        f"REQUEST_SALT {salt}\n"
        f"REFERENCE_CORPUS_BEGIN\n{filler}\nREFERENCE_CORPUS_END\n"
        f"OUTPUT_BEGIN\n{blueprint}\nOUTPUT_END"
    )
    payload = {
        "systemInstruction": {"parts": [{"text": system_text}]},
        "contents": [{"role": "user", "parts": [{"text": user_text}]}],
        "generationConfig": {"temperature": 0, "maxOutputTokens": 4096},
    }
    return payload, {
        "filler_words": filler_words,
        "output_words": output_words_count,
        "input_characters": len(system_text) + len(user_text),
        "blueprint_characters": len(blueprint),
    }


def adjust_workload(
    settings: dict[str, int],
    usage: dict[str, int],
    *,
    desired_input: int = TARGET_INPUT_TOKENS,
    desired_output: int = TARGET_OUTPUT_TOKENS,
) -> dict[str, int]:
    current_input = max(usage["promptTokenCount"], 1)
    current_output = max(output_tokens(usage), 1)
    current_total_words = settings["filler_words"] + settings["output_words"]
    next_output_words = round(settings["output_words"] * desired_output / current_output)
    next_total_words = round(current_total_words * desired_input / current_input)
    next_output_words = min(max(next_output_words, 32), 8_000)
    next_filler_words = min(max(next_total_words - next_output_words, 32), 30_000)
    return {
        "filler_words": next_filler_words,
        "output_words": next_output_words,
    }


def _safe_error(response: httpx.Response) -> dict[str, Any]:
    result: dict[str, Any] = {"status": response.status_code}
    try:
        payload = response.json()
    except ValueError:
        return result
    error = payload.get("error") if isinstance(payload, dict) else None
    if isinstance(error, dict):
        result.update(
            {
                "error_code": error.get("code"),
                "error_status": error.get("status"),
                "error_type": error.get("type"),
            }
        )
    return result


def _retry_after_seconds(response: httpx.Response) -> float:
    raw = response.headers.get("retry-after")
    if not raw:
        return 0.0
    try:
        return max(float(raw), 0.0)
    except ValueError:
        return 0.0


def execute_valid_request(
    client: httpx.Client,
    *,
    api_headers: dict[str, str],
    model: str,
    payload: dict[str, Any],
    label: str,
    stage_deadline: float,
    attempt_events: list[dict[str, Any]],
    sleep_fn=time.sleep,
) -> dict[str, Any]:
    consecutive_retryable = 0
    attempt_number = 0
    while True:
        if time.monotonic() >= stage_deadline:
            raise MeasurementError(f"{model} stage exceeded 60 minutes")
        attempt_number += 1
        started = time.monotonic()
        response = client.post(
            f"/antigravity/v1beta/models/{model}:generateContent",
            headers=api_headers,
            json=payload,
        )
        elapsed_ms = round((time.monotonic() - started) * 1000)
        event = {
            "timestamp": iso_now(),
            "model": model,
            "label": label,
            "attempt": attempt_number,
            "status": response.status_code,
            "elapsed_ms": elapsed_ms,
        }
        attempt_events.append(event)

        if response.status_code in (429, 503):
            consecutive_retryable += 1
            event["retryable"] = True
            event.update(_safe_error(response))
            base_wait = 60.0 if consecutive_retryable >= 2 else 10.0
            wait_seconds = max(base_wait, _retry_after_seconds(response))
            event["wait_seconds"] = wait_seconds
            print(
                f"[{iso_now()}] {model} {label}: HTTP {response.status_code}; "
                f"retry in {wait_seconds:.0f}s",
                flush=True,
            )
            sleep_fn(wait_seconds)
            continue

        if not 200 <= response.status_code < 300:
            event.update(_safe_error(response))
            raise MeasurementError(
                f"{model} {label} stopped on non-retryable HTTP {response.status_code}"
            )

        consecutive_retryable = 0
        try:
            response_payload = response.json()
        except ValueError as exc:
            raise MeasurementError(f"{model} {label} returned non-JSON HTTP 200") from exc
        usage, finish_reason, digest, visible_chars = parse_usage_payload(response_payload)
        return {
            "timestamp": event["timestamp"],
            "model": model,
            "label": label,
            "status": response.status_code,
            "elapsed_ms": elapsed_ms,
            "attempts": attempt_number,
            "finish_reason": finish_reason,
            "visible_text_sha256_16": digest,
            "visible_characters": visible_chars,
            "usage": usage,
        }


def _read_enabled_pro_count(source_db: Path) -> int:
    source_uri = source_db.resolve().as_uri() + "?mode=ro"
    with sqlite3.connect(source_uri, uri=True) as database:
        row = database.execute(
            """
            SELECT COUNT(*) FROM antigravity_credentials
            WHERE COALESCE(disabled, 0) = 0
              AND COALESCE(permanent_disabled, 0) = 0
              AND LOWER(COALESCE(tier, 'unknown')) = 'pro'
            """
        ).fetchone()
    return int(row[0] if row else 0)


def read_logical_total(
    client: httpx.Client, panel_headers: dict[str, str]
) -> int:
    response = client.get(
        "/creds/stats-today",
        params={"mode": "antigravity"},
        headers=panel_headers,
    )
    response.raise_for_status()
    payload = response.json()
    return int(payload.get("total_count", 0) or 0)


def fetch_quota_snapshot(
    client: httpx.Client,
    *,
    panel_headers: dict[str, str],
    quota_filename: str,
    target_model: str,
) -> dict[str, Any]:
    response = client.get(
        f"/creds/quota/{quote(quota_filename, safe='')}",
        params={"mode": "antigravity"},
        headers=panel_headers,
    )
    response.raise_for_status()
    payload = response.json()
    models = payload.get("models") if isinstance(payload, dict) else None
    if not isinstance(models, dict) or target_model not in models:
        raise MeasurementError(f"Quota response is missing {target_model}")
    target = models[target_model]
    if not isinstance(target, dict) or target.get("remaining") is None:
        raise MeasurementError(f"Quota response has no remaining fraction for {target_model}")
    family_prefix = "gemini-3.8-flash" if target_model == FLASH_MODEL else "gemini-3.1-pro"
    family = {
        model_id: {
            "remaining": info.get("remaining"),
            "resetTimeRaw": info.get("resetTimeRaw"),
        }
        for model_id, info in models.items()
        if model_id.startswith(family_prefix) and isinstance(info, dict)
    }
    return {
        "timestamp": iso_now(),
        "model": target_model,
        "remaining": float(target["remaining"]),
        "resetTimeRaw": target.get("resetTimeRaw"),
        "family": family,
    }


def stable_quota_baseline(
    client: httpx.Client,
    *,
    panel_headers: dict[str, str],
    quota_filename: str,
    target_model: str,
    sleep_fn=time.sleep,
) -> list[dict[str, Any]]:
    snapshots: list[dict[str, Any]] = []
    # Upstream quota accounting is eventually consistent and can continue
    # moving after the requested five-minute settlement window.  Observe for
    # up to another five minutes instead of accepting a moving baseline.
    max_samples = 41
    sample_interval_seconds = 15
    for index in range(max_samples):
        snapshots.append(
            fetch_quota_snapshot(
                client,
                panel_headers=panel_headers,
                quota_filename=quota_filename,
                target_model=target_model,
            )
        )
        if len(snapshots) >= 3:
            recent = [item["remaining"] for item in snapshots[-3:]]
            if recent[0] == recent[1] == recent[2]:
                return snapshots[-3:]
        if index < max_samples - 1:
            sleep_fn(sample_interval_seconds)
    raise MeasurementError(f"Quota for {target_model} did not stabilize")


def validate_reset_guard(snapshot: dict[str, Any], guard_seconds: int) -> None:
    raw = snapshot.get("resetTimeRaw")
    if not raw:
        raise MeasurementError("Quota resetTimeRaw is unavailable")
    try:
        reset_at = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError as exc:
        raise MeasurementError("Quota resetTimeRaw is invalid") from exc
    remaining = (reset_at - utc_now()).total_seconds()
    if remaining <= guard_seconds:
        raise MeasurementError(
            f"Quota resets in {max(remaining, 0) / 60:.1f} minutes; "
            "wait for reset before starting"
        )


def delayed_quota_snapshots(
    client: httpx.Client,
    *,
    panel_headers: dict[str, str],
    quota_filename: str,
    target_model: str,
    sleep_fn=time.sleep,
    monotonic_fn=time.monotonic,
) -> list[dict[str, Any]]:
    started = monotonic_fn()
    result: list[dict[str, Any]] = []
    for offset in (0, 60, 180, 300):
        remaining_wait = started + offset - monotonic_fn()
        if remaining_wait > 0:
            sleep_fn(remaining_wait)
        snapshot = fetch_quota_snapshot(
            client,
            panel_headers=panel_headers,
            quota_filename=quota_filename,
            target_model=target_model,
        )
        snapshot["offset_seconds"] = offset
        result.append(snapshot)
        print(
            f"[{iso_now()}] {target_model} quota T+{offset}s: "
            f"{snapshot['remaining']:.8f}",
            flush=True,
        )
    if len(result) >= 2 and result[-1]["remaining"] != result[-2]["remaining"]:
        remaining_wait = started + 600 - monotonic_fn()
        if remaining_wait > 0:
            sleep_fn(remaining_wait)
        snapshot = fetch_quota_snapshot(
            client,
            panel_headers=panel_headers,
            quota_filename=quota_filename,
            target_model=target_model,
        )
        snapshot["offset_seconds"] = 600
        result.append(snapshot)
        print(
            f"[{iso_now()}] {target_model} quota T+600s: "
            f"{snapshot['remaining']:.8f}",
            flush=True,
        )
    return result


def calibrate_model(
    client: httpx.Client,
    *,
    api_headers: dict[str, str],
    model: str,
    attempt_events: list[dict[str, Any]],
) -> tuple[dict[str, int], list[dict[str, Any]], dict[str, int]]:
    settings = {"filler_words": 7_000, "output_words": 1_850}
    records: list[dict[str, Any]] = []
    deadline = time.monotonic() + STAGE_TIMEOUT_SECONDS
    for index in range(MAX_CALIBRATIONS):
        salt = f"calibration-{model}-{index}-{time.time_ns()}"
        payload, workload = build_native_payload(
            filler_words=settings["filler_words"],
            output_words_count=settings["output_words"],
            salt=salt,
        )
        record = execute_valid_request(
            client,
            api_headers=api_headers,
            model=model,
            payload=payload,
            label=f"calibration-{index + 1}",
            stage_deadline=deadline,
            attempt_events=attempt_events,
        )
        record["workload"] = workload
        records.append(record)
        usage = record["usage"]
        print(
            f"[{iso_now()}] {model} calibration {index + 1}: "
            f"input={usage['promptTokenCount']} output={output_tokens(usage)} "
            f"(visible={usage['candidatesTokenCount']} thoughts={usage['thoughtsTokenCount']})",
            flush=True,
        )
        settings = adjust_workload(settings, usage)
    return settings, records, records[-1]["usage"]


def _settings_for_targets(
    base_settings: dict[str, int],
    calibration_usage: dict[str, int],
    desired_input: int,
    desired_output: int,
) -> dict[str, int]:
    return adjust_workload(
        base_settings,
        calibration_usage,
        desired_input=max(desired_input, 32),
        desired_output=max(desired_output, 32),
    )


def run_formal_requests(
    client: httpx.Client,
    *,
    api_headers: dict[str, str],
    model: str,
    base_settings: dict[str, int],
    calibration_usage: dict[str, int],
    attempt_events: list[dict[str, Any]],
    match_totals: dict[str, int] | None = None,
    adaptive_from_index: int = 7,
) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    deadline = time.monotonic() + STAGE_TIMEOUT_SECONDS
    for index in range(FORMAL_REQUESTS):
        settings = base_settings
        if match_totals is not None and index >= adaptive_from_index:
            totals = aggregate_usage(records)
            calls_left = FORMAL_REQUESTS - index
            desired_input = max(
                32, round((match_totals["promptTokenCount"] - totals["promptTokenCount"]) / calls_left)
            )
            desired_output = max(
                32, round((match_totals["outputTokenCount"] - totals["outputTokenCount"]) / calls_left)
            )
            settings = _settings_for_targets(
                base_settings,
                calibration_usage,
                desired_input,
                desired_output,
            )
        salt = f"formal-{model}-{index}-{time.time_ns()}"
        payload, workload = build_native_payload(
            filler_words=settings["filler_words"],
            output_words_count=settings["output_words"],
            salt=salt,
        )
        record = execute_valid_request(
            client,
            api_headers=api_headers,
            model=model,
            payload=payload,
            label=f"formal-{index + 1}",
            stage_deadline=deadline,
            attempt_events=attempt_events,
        )
        record["workload"] = workload
        records.append(record)
        usage = record["usage"]
        print(
            f"[{iso_now()}] {model} formal {index + 1}/{FORMAL_REQUESTS}: "
            f"input={usage['promptTokenCount']} output={output_tokens(usage)}",
            flush=True,
        )
        if index < FORMAL_REQUESTS - 1:
            time.sleep(2)
    return records


def supplement_pro_if_needed(
    client: httpx.Client,
    *,
    api_headers: dict[str, str],
    base_settings: dict[str, int],
    calibration_usage: dict[str, int],
    flash_totals: dict[str, int],
    pro_records: list[dict[str, Any]],
    attempt_events: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], bool, str | None]:
    supplements: list[dict[str, Any]] = []
    deadline = time.monotonic() + STAGE_TIMEOUT_SECONDS
    for index in range(MAX_SUPPLEMENTS + 1):
        pro_totals = aggregate_usage(pro_records + supplements)
        input_diff = percent_difference(
            flash_totals["promptTokenCount"], pro_totals["promptTokenCount"]
        )
        output_diff = percent_difference(
            flash_totals["outputTokenCount"], pro_totals["outputTokenCount"]
        )
        if input_diff <= PARITY_LIMIT_PERCENT and output_diff <= PARITY_LIMIT_PERCENT:
            return supplements, True, None
        if (
            pro_totals["promptTokenCount"] > flash_totals["promptTokenCount"] * 1.02
            or pro_totals["outputTokenCount"] > flash_totals["outputTokenCount"] * 1.02
        ):
            return supplements, False, "Pro totals exceeded Flash by more than 2%"
        if index == MAX_SUPPLEMENTS:
            break

        input_gap = max(flash_totals["promptTokenCount"] - pro_totals["promptTokenCount"], 32)
        output_gap = max(flash_totals["outputTokenCount"] - pro_totals["outputTokenCount"], 32)
        settings = _settings_for_targets(
            base_settings,
            calibration_usage,
            min(input_gap, TARGET_INPUT_TOKENS),
            min(output_gap, TARGET_OUTPUT_TOKENS),
        )
        salt = f"supplement-{PRO_MODEL}-{index}-{time.time_ns()}"
        payload, workload = build_native_payload(
            filler_words=settings["filler_words"],
            output_words_count=settings["output_words"],
            salt=salt,
        )
        record = execute_valid_request(
            client,
            api_headers=api_headers,
            model=PRO_MODEL,
            payload=payload,
            label=f"supplement-{index + 1}",
            stage_deadline=deadline,
            attempt_events=attempt_events,
        )
        record["workload"] = workload
        supplements.append(record)
        usage = record["usage"]
        print(
            f"[{iso_now()}] {PRO_MODEL} supplement {index + 1}: "
            f"input={usage['promptTokenCount']} output={output_tokens(usage)}",
            flush=True,
        )
    return supplements, False, "Token totals did not converge within 3 supplements"


def _quota_consumption(
    baseline: list[dict[str, Any]], delayed: list[dict[str, Any]]
) -> dict[str, Any]:
    before = baseline[-1]["remaining"]
    t5 = next((item for item in delayed if item["offset_seconds"] == 300), delayed[-1])
    final = delayed[-1]
    delta_t5 = before - t5["remaining"]
    delta_final = before - final["remaining"]
    return {
        "before_remaining": before,
        "t5_remaining": t5["remaining"],
        "final_remaining": final["remaining"],
        "t5_consumed_fraction": delta_t5,
        "t5_consumed_percentage_points": delta_t5 * 100,
        "final_consumed_fraction": delta_final,
        "final_consumed_percentage_points": delta_final * 100,
        "below_upstream_resolution": delta_t5 == 0,
    }


def build_summary(report: dict[str, Any]) -> dict[str, Any]:
    flash_records = report["flash"]["formal"]
    pro_records = report["pro"]["formal"] + report["pro"]["supplements"]
    flash_totals = aggregate_usage(flash_records)
    pro_totals = aggregate_usage(pro_records)
    input_difference = percent_difference(
        flash_totals["promptTokenCount"], pro_totals["promptTokenCount"]
    )
    output_difference = percent_difference(
        flash_totals["outputTokenCount"], pro_totals["outputTokenCount"]
    )
    return {
        "flash_totals": flash_totals,
        "pro_totals": pro_totals,
        "input_difference_percent": input_difference,
        "output_difference_percent": output_difference,
        "input_parity_passed": input_difference <= PARITY_LIMIT_PERCENT,
        "output_parity_passed": output_difference <= PARITY_LIMIT_PERCENT,
        "flash_quota": _quota_consumption(
            report["flash"]["quota_baseline"], report["flash"]["quota_after"]
        ),
        "pro_quota": _quota_consumption(
            report["pro"]["quota_baseline"], report["pro"]["quota_after"]
        ),
    }


def render_markdown(report: dict[str, Any]) -> str:
    summary = report["summary"]
    lines = [
        "# Antigravity quota benchmark",
        "",
        f"- Started: {report['started_at']}",
        f"- Finished: {report['finished_at']}",
        f"- External traffic detected: {report['external_traffic_detected']}",
        "",
        "## Token parity",
        "",
        "| Model | Requests | Input | Visible output | Thoughts | Total output |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for key, label in (("flash", FLASH_MODEL), ("pro", PRO_MODEL)):
        totals = summary[f"{key}_totals"]
        request_count = len(report[key]["formal"]) + len(report[key].get("supplements", []))
        lines.append(
            f"| `{label}` | {request_count} | {totals['promptTokenCount']} | "
            f"{totals['candidatesTokenCount']} | {totals['thoughtsTokenCount']} | "
            f"{totals['outputTokenCount']} |"
        )
    lines.extend(
        [
            "",
            f"- Input difference: {summary['input_difference_percent']:.4f}%",
            f"- Output difference: {summary['output_difference_percent']:.4f}%",
            "",
            "## Quota snapshots",
            "",
            "| Model | Before | T+5 min | Consumed percentage points |",
            "|---|---:|---:|---:|",
        ]
    )
    for key, label in (("flash", FLASH_MODEL), ("pro", PRO_MODEL)):
        quota = summary[f"{key}_quota"]
        lines.append(
            f"| `{label}` | {quota['before_remaining']:.8f} | "
            f"{quota['t5_remaining']:.8f} | "
            f"{quota['t5_consumed_percentage_points']:.8f} |"
        )
        if quota["below_upstream_resolution"]:
            lines.append(
                f"\n`{label}`: consumption was below the upstream quota display resolution."
            )
    lines.extend(
        [
            "",
            "## Retry events",
            "",
            f"- Total API attempts: {len(report['attempt_events'])}",
            f"- HTTP 429/503 retries: {sum(1 for event in report['attempt_events'] if event.get('retryable'))}",
        ]
    )
    return "\n".join(lines) + "\n"


def run(args: argparse.Namespace) -> tuple[dict[str, Any], Path]:
    source_db = args.source_db.resolve()
    pro_count = _read_enabled_pro_count(source_db)
    if pro_count != 1:
        raise MeasurementError(f"Expected exactly one enabled Pro credential; found {pro_count}")
    quota_filename, credential = _read_enabled_pro_credential(source_db)
    credential.clear()
    api_password, panel_password = _read_live_passwords(source_db)
    api_headers = {"Authorization": f"Bearer {api_password}"}
    panel_headers = {"Authorization": f"Bearer {panel_password}"}

    report: dict[str, Any] = {
        "schema": 1,
        "started_at": iso_now(),
        "base_url": args.live_url,
        "models": [FLASH_MODEL, PRO_MODEL],
        "attempt_events": [],
        "flash": {"calibration": [], "formal": [], "supplements": []},
        "pro": {"calibration": [], "formal": [], "supplements": []},
    }

    with httpx.Client(
        base_url=args.live_url.rstrip("/"), timeout=600.0, trust_env=False
    ) as client:
        health = client.head("/keepalive")
        if health.status_code != 200:
            raise MeasurementError(f"Live service health check returned {health.status_code}")
        stats_before = read_logical_total(client, panel_headers)

        initial_flash = fetch_quota_snapshot(
            client,
            panel_headers=panel_headers,
            quota_filename=quota_filename,
            target_model=FLASH_MODEL,
        )
        initial_pro = fetch_quota_snapshot(
            client,
            panel_headers=panel_headers,
            quota_filename=quota_filename,
            target_model=PRO_MODEL,
        )
        validate_reset_guard(initial_flash, args.reset_guard_minutes * 60)
        validate_reset_guard(initial_pro, args.reset_guard_minutes * 60)

        if args.resume_calibration_state:
            state = json.loads(args.resume_calibration_state.read_text(encoding="utf-8"))
            flash_state = state.get("flash", {})
            pro_state = state.get("pro", {})
            flash_settings = {
                key: int(flash_state["settings"][key])
                for key in ("filler_words", "output_words")
            }
            pro_settings = {
                key: int(pro_state["settings"][key])
                for key in ("filler_words", "output_words")
            }
            flash_calibration_usage = {
                key: int(flash_state["usage"].get(key, 0) or 0)
                for key in (
                    "promptTokenCount",
                    "cachedContentTokenCount",
                    "candidatesTokenCount",
                    "thoughtsTokenCount",
                    "totalTokenCount",
                )
            }
            pro_calibration_usage = {
                key: int(pro_state["usage"].get(key, 0) or 0)
                for key in (
                    "promptTokenCount",
                    "cachedContentTokenCount",
                    "candidatesTokenCount",
                    "thoughtsTokenCount",
                    "totalTokenCount",
                )
            }
            report["resumed_after_calibration"] = True
            report["excluded_prebaseline_samples"] = state.get(
                "excluded_prebaseline_samples", []
            )
            report["flash"]["settings"] = flash_settings
            report["pro"]["settings"] = pro_settings
            print(
                f"[{iso_now()}] resuming from previously completed calibration",
                flush=True,
            )
        else:
            print(f"[{iso_now()}] calibrating {FLASH_MODEL}", flush=True)
            flash_settings, flash_calibration, flash_calibration_usage = calibrate_model(
                client,
                api_headers=api_headers,
                model=FLASH_MODEL,
                attempt_events=report["attempt_events"],
            )
            report["flash"]["calibration"] = flash_calibration
            report["flash"]["settings"] = flash_settings

            print(f"[{iso_now()}] calibrating {PRO_MODEL}", flush=True)
            pro_settings, pro_calibration, pro_calibration_usage = calibrate_model(
                client,
                api_headers=api_headers,
                model=PRO_MODEL,
                attempt_events=report["attempt_events"],
            )
            report["pro"]["calibration"] = pro_calibration
            report["pro"]["settings"] = pro_settings

            print(
                f"[{iso_now()}] calibration complete; waiting {args.calibration_wait_seconds}s",
                flush=True,
            )
            time.sleep(args.calibration_wait_seconds)

        flash_baseline = stable_quota_baseline(
            client,
            panel_headers=panel_headers,
            quota_filename=quota_filename,
            target_model=FLASH_MODEL,
        )
        validate_reset_guard(flash_baseline[-1], args.reset_guard_minutes * 60)
        report["flash"]["quota_baseline"] = flash_baseline
        print(f"[{iso_now()}] starting 10 Flash requests", flush=True)
        flash_formal = run_formal_requests(
            client,
            api_headers=api_headers,
            model=FLASH_MODEL,
            base_settings=flash_settings,
            calibration_usage=flash_calibration_usage,
            attempt_events=report["attempt_events"],
            match_totals={
                "promptTokenCount": TARGET_INPUT_TOKENS * FORMAL_REQUESTS,
                "outputTokenCount": TARGET_OUTPUT_TOKENS * FORMAL_REQUESTS,
            },
            adaptive_from_index=0,
        )
        report["flash"]["formal"] = flash_formal
        flash_totals = aggregate_usage(flash_formal)
        report["flash"]["quota_after"] = delayed_quota_snapshots(
            client,
            panel_headers=panel_headers,
            quota_filename=quota_filename,
            target_model=FLASH_MODEL,
        )

        pro_baseline = stable_quota_baseline(
            client,
            panel_headers=panel_headers,
            quota_filename=quota_filename,
            target_model=PRO_MODEL,
        )
        validate_reset_guard(pro_baseline[-1], args.reset_guard_minutes * 60)
        report["pro"]["quota_baseline"] = pro_baseline
        print(f"[{iso_now()}] starting 10 Pro requests", flush=True)
        pro_formal = run_formal_requests(
            client,
            api_headers=api_headers,
            model=PRO_MODEL,
            base_settings=pro_settings,
            calibration_usage=pro_calibration_usage,
            attempt_events=report["attempt_events"],
            match_totals=flash_totals,
            adaptive_from_index=0,
        )
        report["pro"]["formal"] = pro_formal
        supplements, comparable, reason = supplement_pro_if_needed(
            client,
            api_headers=api_headers,
            base_settings=pro_settings,
            calibration_usage=pro_calibration_usage,
            flash_totals=flash_totals,
            pro_records=pro_formal,
            attempt_events=report["attempt_events"],
        )
        report["pro"]["supplements"] = supplements
        report["comparable_before_quota"] = comparable
        report["comparison_issue"] = reason
        report["pro"]["quota_after"] = delayed_quota_snapshots(
            client,
            panel_headers=panel_headers,
            quota_filename=quota_filename,
            target_model=PRO_MODEL,
        )

        stats_after = read_logical_total(client, panel_headers)
        report["stats_total_before"] = stats_before
        report["stats_total_after"] = stats_after
        report["stats_total_delta"] = stats_after - stats_before
        report["issued_attempt_count"] = len(report["attempt_events"])
        report["external_traffic_detected"] = (
            report["stats_total_delta"] != report["issued_attempt_count"]
        )

    report["finished_at"] = iso_now()
    report["summary"] = build_summary(report)

    output_dir = args.output_dir
    if output_dir is None:
        output_dir = Path(tempfile.gettempdir()) / (
            "gcli2api-quota-benchmark-" + utc_now().strftime("%Y%m%d-%H%M%S")
        )
    output_dir.mkdir(parents=True, exist_ok=False)
    json_path = output_dir / "report.json"
    markdown_path = output_dir / "report.md"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    markdown_path.write_text(render_markdown(report), encoding="utf-8")
    return report, output_dir


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-db", type=Path, required=True)
    parser.add_argument("--live-url", default="http://127.0.0.1:7861")
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument(
        "--resume-calibration-state",
        type=Path,
        help="Resume from a redacted calibration settings/usage JSON file",
    )
    parser.add_argument("--calibration-wait-seconds", type=int, default=300)
    parser.add_argument("--reset-guard-minutes", type=int, default=30)
    args = parser.parse_args()
    if args.calibration_wait_seconds < 0:
        parser.error("--calibration-wait-seconds must be non-negative")
    if args.reset_guard_minutes < 10:
        parser.error("--reset-guard-minutes must be at least 10")
    try:
        report, output_dir = run(args)
    except (MeasurementError, httpx.HTTPError) as exc:
        print(f"MEASUREMENT_FAILED: {exc}", file=sys.stderr, flush=True)
        return 1
    summary = report["summary"]
    print(
        json.dumps(
            {
                "output_dir": str(output_dir),
                "input_difference_percent": summary["input_difference_percent"],
                "output_difference_percent": summary["output_difference_percent"],
                "input_parity_passed": summary["input_parity_passed"],
                "output_parity_passed": summary["output_parity_passed"],
                "external_traffic_detected": report["external_traffic_detected"],
            },
            ensure_ascii=False,
            indent=2,
        ),
        flush=True,
    )
    return 0 if (
        summary["input_parity_passed"]
        and summary["output_parity_passed"]
        and not report["external_traffic_detected"]
    ) else 2


if __name__ == "__main__":
    raise SystemExit(main())
