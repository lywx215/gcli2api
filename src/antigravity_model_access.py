"""Exact Opus access policy, independent of shared quota and model statistics."""
import copy
import json
import math
import time

MODELS = tuple(f"claude-opus-5-5-{tier}" for tier in ("low", "medium", "high"))
VALID_FOR = RECHECK = 12 * 3600
PAUSE = 24 * 3600
QUERY_RETRY = 15 * 60


def access_model(model):
    if not isinstance(model, str):
        return None
    from src.utils import normalize_antigravity_model_alias
    from src.antigravity_models import resolve_antigravity_opus_model
    name = normalize_antigravity_model_alias(model.strip().lower()).rsplit("/", 1)[-1].strip()
    if name.startswith("claude-opus-5-5"):
        return resolve_antigravity_opus_model(name)
    return None


def decode(value):
    value = json.loads(value) if isinstance(value, str) else value
    if value is None:
        value = {}
    if not isinstance(value, dict):
        raise ValueError("invalid_model_access_state")
    result = copy.deepcopy(value)
    models = result.setdefault("models", {})
    if not isinstance(models, dict):
        raise ValueError("invalid_model_access_state")
    lease = result.get("lease")
    if lease is not None and (not isinstance(lease, dict) or not isinstance(lease.get("id"), str)
            or type(lease.get("until")) not in (int, float) or not math.isfinite(lease["until"])):
        raise ValueError("invalid_model_access_lease")
    for model, entry in models.items():
        if model not in MODELS or not isinstance(entry, dict):
            raise ValueError("invalid_model_access_state")
        if entry.get("state") not in ("supported", "unavailable", "unknown"):
            raise ValueError("invalid_model_access_state")
        if type(entry.get("revision")) is not int or entry["revision"] < 1:
            raise ValueError("invalid_model_access_state")
        for key in ("checked_at", "last_attempt_at", "blocked_until", "next_check_at"):
            if key in entry and (type(entry[key]) not in (int, float) or not math.isfinite(entry[key])):
                raise ValueError("invalid_model_access_state")
    return result


def eligible(state, model, now=None):
    now = time.time() if now is None else now
    entry = state.get("models", {}).get(model, {})
    return (entry.get("state") == "supported" and entry.get("checked_at", 0) <= now
            and now < entry.get("checked_at", 0) + VALID_FOR)


def observe(state, model, supported, reason, now):
    prior = state["models"].get(model, {})
    state["models"][model] = {
        "state": "supported" if supported else "unavailable", "reason": reason,
        "revision": prior.get("revision", 0) + 1, "checked_at": now, "last_attempt_at": now,
        "blocked_until": 0 if supported else now + PAUSE, "next_check_at": now + RECHECK,
    }


def public(state):
    try:
        state = decode(state)
    except (ValueError, TypeError):
        return {model: {"state": "unknown", "reason": "invalid_state"} for model in MODELS}
    return {model: {k: v for k, v in state["models"].get(model, {"state": "unknown"}).items()
                    if k != "revision"} for model in MODELS}
