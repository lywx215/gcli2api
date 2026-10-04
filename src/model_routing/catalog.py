"""Catalog projection after the existing static/upstream filtering stage."""

from copy import deepcopy

from .policy import strip_prefix, strip_suffixes
from .types import ModelApiProtocol


def _catalog_id(item):
    if isinstance(item, str):
        return item
    if not isinstance(item, dict):
        return None
    name = item.get("id", item.get("name"))
    return name.removeprefix("models/") if isinstance(name, str) else None


def _public_item(name, base, protocol):
    if protocol == ModelApiProtocol.GEMINI:
        return {"name": "models/" + name, "baseModelId": base, "version": "001",
                "displayName": name, "description": "Public model " + base,
                "supportedGenerationMethods": ["generateContent", "streamGenerateContent"]}
    if protocol == ModelApiProtocol.CLAUDE:
        return {"id": name, "type": "model", "display_name": name}
    return {"id": name, "object": "model", "owned_by": "google"}


def _public_variants(row, profile, channel):
    suffixes = [""]
    if channel == "geminicli":
        thinking = tuple("-" + value for value in profile.capabilities.get("thinking_suffixes", ()))
        suffixes.extend(thinking)
        if profile.capabilities.get("search"):
            suffixes.append("-search")
            suffixes.extend(value + "-search" for value in thinking)
    # Match the existing advertised prefixes; the fourth accepted prefix is
    # routable but has never been an extra advertised catalog variant.
    return tuple(prefix + row.public_name + suffix for suffix in suffixes for prefix in ("", "假流式/", "抗截断/"))


def project_catalog(channel, protocol, source_catalog, compiled_channel, policy_snapshot, feature_snapshot):
    if compiled_channel.channel != channel or compiled_channel.policy_digest != policy_snapshot.digest:
        raise ValueError("Model routing policy mismatch.")
    active = tuple(row for row in compiled_channel.rows if row.enabled)
    if not active:
        # Preserve every existing field, timestamp, ordering and duplicate in
        # the empty-table legacy path rather than regenerating a catalog.
        return deepcopy(source_catalog)
    protocol = ModelApiProtocol(protocol)
    targets = {row.upstream_name for row in active}
    publics = {row.public_name for row in active}
    result, seen = [], set()
    for item in source_catalog:
        name = _catalog_id(item)
        if name is None:
            result.append(deepcopy(item))
            continue
        base, _ = strip_prefix(name, policy_snapshot)
        if channel == "geminicli":
            base = strip_suffixes(base, policy_snapshot)
        # AG independent suffixed IDs remain independent. Only exact IDs and
        # accepted feature prefixes belong to a hidden/taken-over space.
        if base in targets or base in publics:
            continue
        if name not in seen:
            result.append(deepcopy(item))
            seen.add(name)
    for row in active:
        for name in _public_variants(row, compiled_channel.profiles[row.public_name], channel):
            if name not in seen:
                result.append(_public_item(name, row.public_name, protocol))
                seen.add(name)
    return result
