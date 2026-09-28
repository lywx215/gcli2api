"""Passive, allowlisted Antigravity error evidence. Never retain upstream text."""
import json
import math
import time
from contextlib import contextmanager
from collections import Counter

from src.antigravity_quota import group_for, timestamp, duration
from src.diagnostics.runtime import active_server

REASONS = {"QUOTA_EXHAUSTED", "MODEL_CAPACITY_EXHAUSTED", "NO_CAPACITY_AVAILABLE",
           "RATE_LIMIT_EXCEEDED", "RESOURCE_EXHAUSTED", "RATE_LIMITED"}


def evidence(status, body, headers=None):
    try:
        payload = json.loads(body)
    except (TypeError, ValueError):
        payload = {}
    from src.smart_429 import classify_upstream_429
    classification = classify_upstream_429(payload, mode="antigravity")
    result = {"httpStatus": status, "classification": classification.kind.value, "reasons": []}
    error = payload.get("error", {}) if isinstance(payload, dict) else {}
    details = error.get("details") if isinstance(error, dict) else None
    for detail in details if isinstance(details, list) else []:
        if not isinstance(detail, dict):
            continue
        reason = detail.get("reason")
        if isinstance(reason, str) and reason in REASONS:
            result["reasons"].append(reason)
        metadata = detail.get("metadata", {})
        if isinstance(metadata, dict):
            reset = timestamp(metadata.get("quotaResetTimeStamp"))
            if reset is not None:
                result["quotaResetTimestamp"] = reset
            delay = duration(metadata.get("quotaResetDelay"))
            if delay is not None and math.isfinite(delay) and delay >= 0:
                result["quotaResetDelaySeconds"] = delay
        delay = duration(detail.get("retryDelay"))
        if delay is not None and math.isfinite(delay):
            result["retryDelaySeconds"] = delay
    retry = (headers or {}).get("retry-after")
    try:
        seconds = float(retry)
        if math.isfinite(seconds) and seconds >= 0:
            result["retryAfterSeconds"] = seconds
    except (ValueError, TypeError):
        try:
            from email.utils import parsedate_to_datetime
            stamp = parsedate_to_datetime(retry).timestamp()
            if math.isfinite(stamp):
                result["retryAfterTimestamp"] = stamp
        except (TypeError, ValueError, AttributeError, OverflowError):
            pass
    return result


def safe_error(status, body):
    return json.dumps(evidence(status, body), separators=(",", ":"))


_inflight = Counter()


def model_label(value):
    # Request model is untrusted input; only bounded canonical-looking IDs enter logs.
    import re
    value = str(value or "").rsplit("/", 1)[-1]
    return value if re.fullmatch(r"(?:gemini|claude|gpt-oss)-[a-zA-Z0-9._-]{1,100}", value) else "unknown"


def requested_model(value):
    server = active_server()
    if server:
        server.antigravity_requested_model = model_label(value)


@contextmanager
def dispatch_scope(attempt, model):
    key = model_label(model)
    _inflight[key] += 1
    attempt.quota_concurrency = _inflight[key]
    try:
        yield
    finally:
        _inflight[key] -= 1
        if not _inflight[key]:
            del _inflight[key]


def _emit(attempt, model, phase, data):
    # Extend the existing gated application diagnostics, without mutating the
    # frozen public cross-service ai-proxy-diagnostics/1 contract or sequence.
    try:
        from log import log
        server = active_server()
        if server and server.debug():
            record = {"event": "antigravity.quota", "phase": phase,
                      "requestId": server.request_id, "traceId": server.context['traceId'],
                      "attemptId": attempt.id, "attemptNo": attempt.number,
                      "instanceId": server.rt.resource['instanceId'], "bootId": server.rt.resource['bootId'],
                      "credentialRef": attempt.credential, "credentialRefScope": "boot",
                      "executionModel": model_label(model),
                      "requestedModel": getattr(server, "antigravity_requested_model", "unknown"),
                      "cooldownGroup": group_for(model_label(model)),
                      "concurrentAtDispatch": getattr(attempt, "quota_concurrency", None),
                      "elapsedMs": round((time.perf_counter() - attempt.started) * 1000, 3), **data}
            log.debug("[ANTIGRAVITY DIAG] " + json.dumps(record, separators=(",", ":"), allow_nan=False))
    except Exception:
        pass  # Observations cannot change model request behavior.


def emit_error(attempt, model, status, body, headers, admission):
    try:
        detail = evidence(status, body, headers)
    except Exception:
        detail = {"httpStatus": status, "classification": "indeterminate", "reasons": []}
    _emit(attempt, model, "upstream_error", {**detail,
        "admittedRevision": (admission or {}).get("revision"), "quotaSnapshot": "unknown"})


def emit_admission(attempt, model, admission):
    _emit(attempt, model, "admission", {"allowed": admission is not None,
        "admittedRevision": (admission or {}).get("revision"),
        "groupState": (admission or {}).get("state", "unknown"),
        "cooldownUntil": (admission or {}).get("cooldownUntil"),
        "quotaObservedAt": (admission or {}).get("quotaObservedAt")})


def emit_retry(attempt, model, retry, wait, changed=None):
    _emit(attempt, model, "retry", {"retry": bool(retry), "waitSeconds": wait,
                                    "credentialChanged": changed})
