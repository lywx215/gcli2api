"""Version-family permissions with independently evidenced native routes."""
import copy
import json
import math
import time

MODELS = tuple(f"claude-opus-5-5-{tier}" for tier in ("low", "medium", "high"))
OPUS_46 = "claude-opus-4-6-thinking"
ROUTES = (*MODELS, OPUS_46)
FAMILIES = ("claude-opus-5-5", "claude-opus-4-6")
VALID_FOR = RECHECK = 12 * 3600
PAUSE = 24 * 3600
QUERY_RETRY = 15 * 60


def access_model(model):
    if not isinstance(model, str):
        return None
    from src.utils import normalize_antigravity_model_alias
    name = normalize_antigravity_model_alias(model.strip().lower()).rsplit("/", 1)[-1].strip()
    if name in ROUTES:
        return name
    if name in ("claude-opus-5-5", "claude-opus-5-5-thinking"):
        return MODELS[1]
    if name in ("claude-opus-4-6", "claude-opus-4.6", "claude-opus-4.6-thinking"):
        return OPUS_46
    return None


def access_family(model):
    if model in FAMILIES:
        return model
    native = access_model(model)
    return FAMILIES[0] if native in MODELS else (FAMILIES[1] if native == OPUS_46 else None)


def _finite_number(value):
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(value)
    except (OverflowError, ValueError):
        return False


def _validate(entries, allowed):
    if not isinstance(entries, dict):
        raise ValueError("invalid_model_access_state")
    for key, entry in entries.items():
        if key not in allowed or not isinstance(entry, dict):
            raise ValueError("invalid_model_access_state")
        if entry.get("state") not in ("supported", "unavailable", "unknown"):
            raise ValueError("invalid_model_access_state")
        if type(entry.get("revision")) is not int or entry["revision"] < 1:
            raise ValueError("invalid_model_access_state")
        for field in ("checked_at", "last_attempt_at", "blocked_until", "next_check_at"):
            if field in entry and not _finite_number(entry[field]):
                raise ValueError("invalid_model_access_state")


def _projection(state):
    result = {}
    for model in MODELS:
        family = state["families"].get(access_family(model), {})
        route = state["routes"].get(model, {})
        entry = family if family.get("state") != "supported" else route
        if entry:
            result[model] = copy.deepcopy(entry)
    return result


def project(state):
    state["models"] = _projection(state)
    return state


def decode(value):
    value = json.loads(value) if isinstance(value, str) else value
    if value is None:
        value = {}
    if not isinstance(value, dict):
        raise ValueError("invalid_model_access_state")
    result = copy.deepcopy(value)
    models = result.setdefault("models", {})
    _validate(models, MODELS)
    lease = result.get("lease")
    if lease is not None and (not isinstance(lease, dict) or not isinstance(lease.get("id"), str)
            or not _finite_number(lease.get("until"))):
        raise ValueError("invalid_model_access_lease")
    if result.get("schema_version") == 2:
        _validate(result.get("families"), FAMILIES)
        _validate(result.get("routes"), ROUTES)
        if models != _projection(result):
            # A legacy writer changed the compatibility projection. Its write is
            # not new family evidence, so fail closed until a fresh observation.
            result["families"] = {}
            result["routes"] = {}
            result.pop("lease", None)
        return project(result)
    if result.get("schema_version") not in (None, 1):
        raise ValueError("invalid_model_access_state")
    result.update(schema_version=2, families={}, routes={})
    # Only a complete, consistent legacy observation is safe to promote.
    entries = [models.get(model) for model in MODELS]
    if all(entries):
        comparison = ("state", "checked_at", "blocked_until", "next_check_at", "reason")
        if all(tuple(entry.get(k) for k in comparison) == tuple(entries[0].get(k) for k in comparison)
               for entry in entries):
            result["families"][FAMILIES[0]] = copy.deepcopy(entries[0])
            result["routes"] = copy.deepcopy(models)
    return project(result)


def _fresh(entry, now):
    return (entry.get("state") == "supported" and entry.get("checked_at", 0) <= now
            and now < entry.get("checked_at", 0) + VALID_FOR)


def eligible(state, model, now=None):
    now = time.time() if now is None else now
    state = decode(state)
    native = access_model(model)
    return bool(native and _fresh(state["families"].get(access_family(native), {}), now)
                and _fresh(state["routes"].get(native, {}), now))


def check_due(state, model=None, now=None):
    """Schedule exact-route refresh without bypassing family denial/backoff.

    A successful generation refreshes only its native route. Other routes can
    expire before the family does, and must remain eligible for directory checks.
    """
    now = time.time() if now is None else now
    state = decode(state)
    targets = ROUTES if model is None else (access_model(model),)
    for target in targets:
        if target is None:
            continue
        family = state["families"].get(access_family(target), {})
        family_due = family.get("next_check_at", 0) <= now
        if family.get("state") != "supported":
            if family_due:
                return True
            continue
        if family.get("reason") in ("directory_query_failed", "directory_timeout") and not family_due:
            continue
        route = state["routes"].get(target, {})
        if family_due or (route.get("next_check_at", 0) <= now and not _fresh(route, now)):
            return True
    return False


def observe_entry(entries, key, supported, reason, now):
    prior = entries.get(key, {})
    entries[key] = {
        "state": "supported" if supported else "unavailable", "reason": reason,
        "revision": prior.get("revision", 0) + 1, "checked_at": now, "last_attempt_at": now,
        "blocked_until": 0 if supported else now + PAUSE, "next_check_at": now + RECHECK,
    }


def observe(state, model, supported, reason, now):
    """Observe an actual generation route and its version family together."""
    observe_entry(state["families"], access_family(model), supported, reason, now)
    observe_entry(state["routes"], model, supported, reason, now)
    project(state)


def _safe(entry):
    return {k: v for k, v in entry.items() if k in
            ("state", "reason", "checked_at", "last_attempt_at", "blocked_until", "next_check_at")}


def public(state):
    try:
        state = decode(state)
    except (ValueError, TypeError):
        return {model: {"state": "unknown", "reason": "invalid_state"} for model in MODELS}
    result = {}
    for model in MODELS:
        family = state["families"].get(access_family(model), {})
        entry = family if family.get("state") != "supported" else state["routes"].get(model, {})
        result[model] = _safe(entry or {"state": "unknown"})
    return result


def public_families(state):
    try:
        state = decode(state)
    except (ValueError, TypeError):
        return {family: {"state": "unknown", "reason": "invalid_state"} for family in FAMILIES}
    return {family: _safe(state["families"].get(family, {"state": "unknown"})) for family in FAMILIES}


def _status(entry, now):
    if _fresh(entry, now):
        return "supported"
    return "unavailable" if entry.get("state") == "unavailable" else "unknown"


def display_status(entries, tier="any", now=None):
    """Legacy summary helper; exact route entries remain readable."""
    now = time.time() if now is None else now
    statuses = [_status(entries.get(model, {}), now) for model in MODELS]
    if tier in ("low", "medium", "high"):
        return statuses[("low", "medium", "high").index(tier)]
    if tier == "all_tiers":
        return "supported" if all(s == "supported" for s in statuses) else (
            "unavailable" if "unavailable" in statuses else "unknown")
    return "supported" if "supported" in statuses else (
        "unavailable" if all(s == "unavailable" for s in statuses) else "unknown")


def filter_summaries(result, states, *, offset, limit, status="all", tier="any", now=None,
                     family="claude-opus-5-5", family_states=None):
    """Filter version-family evidence before pagination; tier is deprecated."""
    now = time.time() if now is None else now
    family = access_family(family) or FAMILIES[0]
    family_counts = {key: {s: 0 for s in ("supported", "unavailable", "unknown")} for key in FAMILIES}
    counts = {key: {s: 0 for s in ("supported", "unavailable", "unknown")}
              for key in ("any", "all_tiers", "low", "medium", "high")}
    selected = []
    for item in result["items"]:
        entries = states.get(item["filename"], {})
        families = (family_states or {}).get(item["filename"], {})
        classifications = {key: _status(families.get(key, {}), now) for key in FAMILIES}
        for key in family_counts:
            family_counts[key][classifications[key]] += 1
        for key in counts:
            counts[key][classifications[FAMILIES[0]]] += 1
        if status == "all" or classifications[family] == status:
            selected.append({**item, "model_access_state": entries, "model_access_families": families})
    return {**result, "items": selected[offset:offset + limit], "total": len(selected),
            "model_access_summary": {"total": len(result["items"]), "counts": counts,
                                     "family_counts": family_counts, "checked_at": now}}
