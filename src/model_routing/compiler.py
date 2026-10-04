"""Strict table compilation and symbolic legacy namespace protection."""

from collections import deque
from collections.abc import Mapping
from functools import lru_cache
import unicodedata

from .policy import (PROVEN_SOURCE_DIGESTS, REVIEWED_CONTEXT_SOURCE_DIGESTS, SUFFIXES, build_policy_snapshot, digest, entry_alias, map_ag_claude, map_ag_gemini,
                     parameter_actions, strip_prefix, strip_suffixes, thinking_settings)
from .types import (CHANNELS, CompileResult, CompiledChannel, ParsedRouteTable,
                    RouteRow, TargetProfile, ValidationIssue)


def _issue(channel, row, field, reason, related=()):
    return ValidationIssue(channel, row, field, reason, tuple(related))


def _valid_name(value):
    return (isinstance(value, str) and bool(value)
            and not any(ch.isspace() or unicodedata.category(ch).startswith("C") for ch in value)
            and value not in (".", "..")
            and not any(ch in value for ch in "/\\:*?[]#%"))


def parse_route_table(raw_value):
    """The persisted value and PUT body are both exactly {routes: [...]}.

    Invalid, attributable rows remain channel issues at their original indexes;
    an unidentifiable channel or top-level fault prevents both channels from
    treating corrupt state as an empty configuration.
    """
    if not isinstance(raw_value, Mapping):
        return ParsedRouteTable(issues=(_issue(None, None, None, "INVALID_STRUCTURE"),), global_error=True)
    issues, rows = [], []
    if set(raw_value) - {"routes"}:
        issues.append(_issue(None, None, None, "UNKNOWN_FIELD"))
    raw_rows = raw_value.get("routes")
    if "routes" not in raw_value or not isinstance(raw_rows, (list, tuple)):
        issues.append(_issue(None, None, "routes", "INVALID_STRUCTURE"))
        return ParsedRouteTable(issues=tuple(issues), global_error=True)
    global_error = bool(issues)
    for index, raw in enumerate(raw_rows):
        if not isinstance(raw, Mapping):
            issues.append(_issue(None, index, None, "INVALID_STRUCTURE"))
            global_error = True
            continue
        channel = raw.get("channel")
        if channel not in CHANNELS:
            reason = "INVALID_STRUCTURE" if "channel" not in raw else "INVALID_FIELD_TYPE" if not isinstance(channel, str) else "UNSUPPORTED_CHANNEL"
            issues.append(_issue(None, index, "channel", reason))
            global_error = True
            continue
        before = len(issues)
        if set(raw) - {"channel", "public_name", "upstream_name", "enabled"}:
            issues.append(_issue(channel, index, None, "UNKNOWN_FIELD"))
        for field in ("public_name", "upstream_name", "enabled"):
            if field not in raw:
                issues.append(_issue(channel, index, field, "INVALID_STRUCTURE"))
            elif (field == "enabled" and type(raw[field]) is not bool) or (field != "enabled" and not isinstance(raw[field], str)):
                issues.append(_issue(channel, index, field, "INVALID_FIELD_TYPE"))
            elif field != "enabled" and not _valid_name(raw[field]):
                issues.append(_issue(channel, index, field, "INVALID_NAME"))
        public = raw.get("public_name")
        if isinstance(public, str) and channel == "geminicli" and any(public.endswith(suffix) for suffix in SUFFIXES):
            issues.append(_issue(channel, index, "public_name", "RESERVED_SUFFIX"))
        if len(issues) == before:
            rows.append(RouteRow(channel, raw["public_name"], raw["upstream_name"], raw["enabled"], index))
    return ParsedRouteTable(tuple(rows), tuple(issues), global_error)


def _possible_dispatches(channel, name, policy):
    """Exact finite result partition of the legacy dispatch selector.

    The only body-dependent selector is .upper() compared to HIGH or
    MINIMAL/EXTRA-LOW. The partitions below cover every string and non-string
    (the latter's protected error is retained by the normalizer profile).
    This is a selector proof, not a list of budget samples.
    """
    name = entry_alias(channel, name, policy)
    if channel == "geminicli":
        return frozenset((strip_suffixes(name, policy),))
    lower = name.lower()
    if "image" in lower:
        return frozenset(("gemini-3.1-flash-image",))
    if "gemini" not in lower:
        return frozenset((map_ag_claude(name),))
    budget, level = thinking_settings(name, policy)
    levels = (None, "HIGH", "LOW", "MINIMAL", "EXTRA-LOW") if budget is None and level is None else (level,)
    return frozenset(map_ag_claude(map_ag_gemini(name, candidate, budget, policy)) for candidate in levels)


@lru_cache(maxsize=1)
def _proof_reference_policy():
    return build_policy_snapshot()


def _supported_policy(channel, policy):
    baseline = _proof_reference_policy()
    if policy.proof_version != baseline.proof_version:
        return False
    relevant = ("src/utils.py", "src/converter/gemini_fix.py", "src/converter/openai2gemini.py",
                "src/converter/anthropic2gemini.py", "src/converter/utils.py", "src/models.py", "src/model_routing/__init__.py",
                "src/converter/thoughtSignature_fix.py",
                "src/geminicli_models.py" if channel == "geminicli" else "src/antigravity_models.py")
    if channel == "antigravity":
        relevant += ("src/converter/antigravity_fix.py",)
    if any(policy.static_rules.get("source_digests", {}).get(key) not in
           {PROVEN_SOURCE_DIGESTS[key], *( (REVIEWED_CONTEXT_SOURCE_DIGESTS[key],) if key in REVIEWED_CONTEXT_SOURCE_DIGESTS else () )}
           for key in relevant):
        return False
    # Parameter/code families are frozen; alias/native data may evolve and is
    # re-proved. Unknown chain or parameter operators fail closed.
    if policy.chains.get(channel) != baseline.chains[channel]:
        return False
    for key in ("parameter_rules", "converter_rules", "precedence", "proof_engine", "cli38", "cli38_levels"):
        if policy.static_rules.get(key) != baseline.static_rules[key]:
            return False
    tokens = policy.static_rules.get("suffixes", ())
    if channel == "geminicli" and any(not _valid_name(name) or any(name.endswith(token) for token in tokens)
                                      for name in policy.static_rules.get("cli_aliases", {})):
        # The suffix-free-root DFA theorem does not cover alias keys inside
        # another base's token language. A new grammar needs a new proof.
        return False
    return (tuple(tokens) == tuple(baseline.static_rules["suffixes"])
            and tuple(policy.parameter_classes) == tuple(baseline.parameter_classes))


def _target_profile(channel, target, policy):
    if channel == "geminicli" and any(target.endswith(suffix) for suffix in policy.static_rules["suffixes"]):
        return None, "AMBIGUOUS_TARGET_NAME"
    possible = _possible_dispatches(channel, target, policy)
    if possible != frozenset((target,)):
        return None, "UNSTABLE_TARGET_DISPATCH"
    actions = parameter_actions(channel, target, policy)
    base = strip_suffixes(target, policy)
    known_cli = target in policy.static_rules["cli_bases"] or target in policy.static_rules["cli_aliases"].values()
    levels = () if not known_cli else ("low", "medium", "high") if base == policy.static_rules["cli38"] else (
        ("max", "high", "medium", "low", "minimal") if "gemini-2.5" in base else (
        ("high", "medium", "low", "minimal") if "gemini-3" in base and "flash" in base else
        ("high", "low") if "gemini-3" in base and "pro" in base else ()))
    capabilities = {"search": channel == "geminicli" and known_cli and ("gemini-2.5" in base or "gemini-3" in base),
                    "thinking_suffixes": levels if channel == "geminicli" else (),
                    "image": channel == "antigravity" and "image" in target.lower(),
                    "availability_verified": False}
    proofs = {protocol: {"dispatch": target, "all_parameter_classes": policy.parameter_classes,
                         "expressions": "input references; name override; conditional normalizer operators",
                         "proof_version": policy.proof_version}
              for protocol in ("gemini", "openai", "claude")}
    return TargetProfile(target, actions, proofs, capabilities), None


# Every substring consumed by name/parameter selection, separately in raw and
# lowercase form. q retains a boundary prefix, including across repeated tokens.
_PATTERNS = ("-nothinking", "-maxthinking", "-high", "-medium", "-low", "-minimal", "-max", "-search",
             "think", "pro", "gemini-3", "gemini-2.5", "flash", "claude", "image", "gpt-oss")
_PREFIXES = frozenset(pattern[:i] for pattern in _PATTERNS for i in range(len(pattern) + 1))


@lru_cache(maxsize=32768)
def _dfa_step(state, text):
    mask, q = state
    for ch in text:
        value = q + ch
        for index, pattern in enumerate(_PATTERNS):
            if value.endswith(pattern):
                mask |= 1 << index
        q = max((prefix for prefix in _PREFIXES if value.endswith(prefix)), key=len)
    return mask, q


def _cli_closure_equal(public, target, policy):
    """Prove equality over T* by exhaustive reachable DFA fixed point.

    Nine suffix tokens are suffix-free. A reserved-free public/target base has
    exactly the language base.T* under the real stripping loop. Substring masks
    plus the longest pattern-prefix suffix retain every name predicate; the
    finite alias-language prefix state retains the earlier alias exceptions.
    Each state has a witness only for evaluating its symbolic normal form; no
    maximum word length or fuzz count is used as a proof boundary.
    """
    tokens = policy.static_rules["suffixes"]
    if any(a != b and a.endswith(b) for a in tokens for b in tokens):
        return False, 0
    rewritten = policy.static_rules["cli_aliases"].get(public, public)
    stems = (public, rewritten, target)
    initial = tuple(_dfa_step((0, ""), text) for stem in stems for text in (stem, stem.lower()))
    accepted_alias_tails = tuple(policy.static_rules["cli_alias_suffixes"])
    root = initial + ("",)
    queue = deque(((root, ""),))
    seen = {root}
    while queue:
        state, tail = queue.popleft()
        old_name = entry_alias("geminicli", public + tail, policy)
        new_name = target + tail
        if (strip_suffixes(old_name, policy) != target or
                parameter_actions("geminicli", old_name, policy) != parameter_actions("geminicli", new_name, policy)):
            return False, len(seen)
        for token in tokens:
            updated = tuple(_dfa_step(state[index], token if index % 2 == 0 else token.lower()) for index in range(6))
            alias_state = state[-1]
            if alias_state is not None:
                candidate = alias_state + token
                alias_state = candidate if any(item.startswith(candidate) for item in accepted_alias_tails) else None
            updated += (alias_state,)
            if updated not in seen:
                seen.add(updated)
                queue.append((updated, tail + token))
    return True, len(seen)


def _protected_equal(channel, public, target, policy):
    if channel == "geminicli":
        return _cli_closure_equal(public, target, policy)
    old_name = entry_alias(channel, public, policy)
    return (_possible_dispatches(channel, public, policy) == frozenset((target,))
            and parameter_actions(channel, old_name, policy) == parameter_actions(channel, target, policy)), 1


def compile_channel(channel, parsed_table, policy_snapshot):
    if channel not in CHANNELS:
        return CompileResult(issues=(_issue(None, None, "channel", "UNSUPPORTED_CHANNEL"),), scope="global")
    inherited = tuple(issue for issue in parsed_table.issues if issue.channel in (None, channel))
    if parsed_table.global_error:
        return CompileResult(issues=inherited or (_issue(None, None, None, "INVALID_STRUCTURE"),), scope="global")
    issues = list(inherited)
    rows = tuple(row for row in parsed_table.valid_rows if row.channel == channel)
    # An empty channel has no target or namespace proof to admit. Keep its
    # real legacy chain available after a source upgrade, but never treat
    # rejected rows or disabled configured targets as an empty channel.
    if (rows or issues) and not _supported_policy(channel, policy_snapshot):
        issues.append(_issue(channel, None, None, "AMBIGUOUS_COMPATIBILITY"))
        return CompileResult(issues=tuple(issues))
    by_public, profiles = {}, {}
    for row in rows:
        previous = by_public.get(row.public_name)
        if previous is not None:
            issues.append(_issue(channel, row.row_index, "public_name", "DUPLICATE_PUBLIC_NAME", (previous.row_index,)))
        else:
            by_public[row.public_name] = row
        # Both enabled and disabled targets are admitted against the same policy.
        profile, reason = _target_profile(channel, row.upstream_name, policy_snapshot)
        if reason:
            issues.append(_issue(channel, row.row_index, "upstream_name", reason))
        else:
            profiles[row.public_name] = profile
    active = tuple(row for row in rows if row.enabled and row.public_name in profiles)
    targets = {row.upstream_name for row in active}
    static = set(policy_snapshot.static_rules["cli_bases"] if channel == "geminicli" else policy_snapshot.static_rules["ag_public"])
    static.update(policy_snapshot.static_rules["cli_aliases"] if channel == "geminicli" else policy_snapshot.static_rules["ag_aliases"])
    if channel == "geminicli":
        static.update(policy_snapshot.static_rules["cli_aliases"].values())
    else:
        static.update(policy_snapshot.static_rules["ag_native"])
        static.update(policy_snapshot.static_rules["ag_exact"])
    for row in active:
        # Opus version names remain protected even when the configured target
        # pool contains only the other version. They cannot disguise an upgrade.
        opus_name = channel == "antigravity" and "claude" in row.public_name.lower() and "opus" in row.public_name.lower()
        direct = row.public_name in static or row.public_name in targets or opus_name
        old_targets = _possible_dispatches(channel, row.public_name, policy_snapshot)
        related = tuple(other.row_index for other in active if other is not row and other.upstream_name in old_targets)
        if direct or old_targets & targets:
            equal, states = _protected_equal(channel, row.public_name, row.upstream_name, policy_snapshot)
            if not equal:
                reason = "INVALID_IDENTITY_ROUTE" if row.public_name == row.upstream_name else "PROTECTED_ENTRY_CAPTURE"
                issues.append(_issue(channel, row.row_index, "public_name", reason, related))
            else:
                profile = profiles[row.public_name]
                proofs = dict(profile.proofs)
                proofs["namespace"] = {"reachable_states": states, "language": "T*" if channel == "geminicli" else "exact_name_and_one_prefix"}
                profiles[row.public_name] = TargetProfile(profile.target, profile.parameter_actions, proofs, profile.capabilities)
    if issues:
        return CompileResult(issues=tuple(issues))
    config_digest = digest({"routes": [{"channel": row.channel, "public_name": row.public_name,
                                       "upstream_name": row.upstream_name, "enabled": row.enabled,
                                       "row_index": row.row_index} for row in parsed_table.valid_rows],
                            "issues": [dict(channel=issue.channel, row=issue.row, reason=issue.reason) for issue in parsed_table.issues]})
    compiled = CompiledChannel(channel, config_digest, policy_snapshot.digest, rows, profiles,
                               tuple(row.public_name for row in rows if row.enabled))
    return CompileResult(compiled)


def validate_table(parsed_table, policy_snapshot):
    results = (compile_channel(channel, parsed_table, policy_snapshot) for channel in CHANNELS)
    issues = []
    for result in results:
        for issue in result.issues:
            if issue not in issues:
                issues.append(issue)
    return tuple(issues)
