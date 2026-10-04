"""Explicit, immutable legacy rules. Dynamic model listing is not policy."""

import hashlib
import json
import ast
from pathlib import Path
from collections.abc import Mapping
from functools import lru_cache

from src.antigravity_models import (ANTIGRAVITY_MODEL_ALIASES,
                                    ANTIGRAVITY_NATIVE_MODEL_IDS, PUBLIC_ANTIGRAVITY_MODEL_IDS,
                                    is_retired_antigravity_opus_model, resolve_antigravity_opus_model)
from src.geminicli_models import GEMINI_38_FLASH_MODEL, GEMINI_38_FLASH_THINKING_LEVELS
from .types import CONTRACT_VERSION, RoutingPolicySnapshot, thaw

PREFIXES = ("假流式/", "抗截断/", "流式抗截断/")
SUFFIXES = ("-maxthinking", "-nothinking", "-minimal", "-medium", "-search", "-think", "-high", "-max", "-low")
CLI_BASES = ("gemini-2.5-pro", "gemini-2.5-flash", "gemini-3-flash-preview",
             "gemini-3.1-pro-preview", "gemini-3.1-flash-lite", "gemini-3.5-flash",
             "gemini-3.5-flash-preview", GEMINI_38_FLASH_MODEL)
CLI_ALIASES = {"gemini-3.5-flash-preview": "gemini-3-flash"}
CLI_ALIAS_SUFFIXES = ("", "-minimal", "-low", "-medium", "-high", "-search", "-minimal-search",
                      "-low-search", "-medium-search", "-high-search")
EXACT_AG_MODELS = frozenset(("gemini-3-flash", "gemini-3-flash-agent", "gemini-3.1-pro-low",
    "gemini-pro-agent", "gemini-3.1-flash-lite", "gemini-3.1-flash-image", "gemini-3.5-flash-low",
    "gemini-3.5-flash-extra-low", "gemini-3.5-flash-high", "gemini-2.5-pro", "gemini-2.5-flash",
    "gemini-2.5-flash-lite", "gemini-2.5-flash-thinking", "tab_flash_lite_preview",
    "tab_jump_flash_lite_preview", "gpt-oss-120b-medium", "chat_20706", "chat_23310"))

_SOURCE_SELECTORS = {
    "src/utils.py": ("get_base_model_from_feature_model", "normalize_geminicli_model_alias", "normalize_antigravity_model_alias", "get_available_models", "GEMINICLI_MODEL_ALIASES", "GEMINICLI_MODEL_ALIAS_SUFFIXES", "BASE_MODELS"),
    "src/converter/gemini_fix.py": None,
    "src/converter/antigravity_fix.py": None,
    "src/converter/openai2gemini.py": None,
    "src/converter/anthropic2gemini.py": None,
    "src/converter/utils.py": None,
    "src/converter/thoughtSignature_fix.py": None,
    "src/antigravity_models.py": None, "src/geminicli_models.py": None,
    "src/models.py": None,
    "src/model_routing/__init__.py": ("check_route_dispatch",),
}
PROVEN_SOURCE_DIGESTS = {
    "src/utils.py": "1b29b9d6ac09b30157972d06561c3c50235619005fa4dc27ba9bdfd4748c0492",
    "src/converter/gemini_fix.py": "f5f6b44682ee80b2df38ade5a552e9e30043ef06d216dcc9ae0a88ae16387318",
    "src/converter/antigravity_fix.py": "7b95c5d721e7abf93507682a0c82746c904d059f6a80b3ca4a603f4b657e97ba",
    "src/converter/openai2gemini.py": "2d3b56714dddb86d74acf2ff96aae8020d4c7f7d44dac8b649e1958fa304369f",
    "src/converter/anthropic2gemini.py": "c0166a60768165d6d2efdfccd6e398a277dd7902e4056e060a9a74b51c2c6ff4",
    "src/converter/utils.py": "6f3491fe7a95302734ad31b90fa52551a7132cd151191cea1f9ece5f07863dab",
    "src/converter/thoughtSignature_fix.py": "2591fca1e8bfd959b764148cf74636cf85e1f17df63d0c03e8adcdf7c0ca3840",
    "src/antigravity_models.py": "f080954b7ddb0024c54fa1f8096fc32669038aced0b3af5ab0ff2753c0e063ea",
    "src/geminicli_models.py": "3128ad421b943730c5a8032dd448048530bc89600c3a1cb3bda889138c4048c2",
    "src/models.py": "01f40fce3cf3ecccb0e36fb393fbf7bb9fbc421276289d64775aa1384c3f9681",
    "src/model_routing/__init__.py": "3543b4693a36a1098850b8bc928887694ed59a6deb7d3dfd0339de01f55a77b6",
}

# D1004 baseline above retains Opus 5.5 route depth and retired-name guards.
# Reviewed integration candidate: keyword-only context defaults to
# None, snapshots replace only config reads, and explicit dispatch is checked
# without rewriting the normalized model. No implicit acceptance of new source.
REVIEWED_CONTEXT_SOURCE_DIGESTS = {
    "src/converter/gemini_fix.py": "684926a87312ff06474b59be0c7eab9c69e3c2379a4b93d9f5c638efb44fcdd2",
    "src/converter/antigravity_fix.py": "b7ec433a8b21717f4941eb6de96638b08f9f30cf0553a1a25a8a9c50362aaa64",
    "src/converter/openai2gemini.py": "9458041ad12d284f9eb61a2c3e4416855f5d3f37e3f4e52845d086761a69e13c",
    "src/converter/anthropic2gemini.py": "d07dafed54e9836f3cbc4d4cdca46a7dd10ad284fd5aa6c78cd949a61e3a3902",
    "src/converter/utils.py": "7d800927426cd8b6c4bc71fcb8d0bf17b956b384d433bcf5026314977825c09d",
    "src/model_routing/__init__.py": "aff6c6cc32c5e3f185574fc380a376ab034436b74de084eceb102bcfb0981c03",
}


@lru_cache(maxsize=1)
def _source_digests():
    """Read only installed Python source, never configuration or application data.

    AST fingerprints ignore line numbers/formatting yet detect actual legacy
    code changes. Cache the installed-source fingerprint once per process;
    source upgrades require a process restart, not an in-place hot edit.
    No source module is executed. The proof engine separately
    refuses source it has not proven, rather than silently updating a hash.
    """
    root = Path(__file__).resolve().parents[2]
    result = {}
    for relative, names in _SOURCE_SELECTORS.items():
        tree = ast.parse((root / relative).read_text(encoding="utf-8"))
        selected = tree.body if names is None else [node for node in tree.body if
            getattr(node, "name", None) in names or isinstance(node, (ast.Assign, ast.AnnAssign)) and
            any(isinstance(target, ast.Name) and target.id in names for target in
                getattr(node, "targets", (getattr(node, "target", None),)))]
        result[relative] = hashlib.sha256(ast.dump(ast.Module(selected, type_ignores=[]), include_attributes=False).encode()).hexdigest()
    return result


def digest(value) -> str:
    return hashlib.sha256(json.dumps(thaw(value), sort_keys=True, ensure_ascii=False,
                                    separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def build_policy_snapshot() -> RoutingPolicySnapshot:
    rules = {"prefixes": PREFIXES, "suffixes": SUFFIXES, "cli_bases": CLI_BASES,
             "cli_aliases": CLI_ALIASES, "cli_alias_suffixes": CLI_ALIAS_SUFFIXES,
             "ag_aliases": ANTIGRAVITY_MODEL_ALIASES, "ag_native": sorted(ANTIGRAVITY_NATIVE_MODEL_IDS),
             "ag_public": PUBLIC_ANTIGRAVITY_MODEL_IDS, "ag_exact": sorted(EXACT_AG_MODELS),
             "cli38": GEMINI_38_FLASH_MODEL, "cli38_levels": GEMINI_38_FLASH_THINKING_LEVELS,
             "precedence": ("ag_image", "ag_pro_high_redirect", "ag_native", "ag_exact", "ag_suffix", "ag_body_level"),
             "parameter_rules": ("cli38_level_over_budget_validate", "cli_other_budget_over_level",
                "name_over_body", "cli_client_include_over_default", "ag_gemini3_include_only",
                "ag_think_budget_1024", "ag_opus_route_depth_include_only", "ag_claude_tool_call_removes_thinking", "gpt_oss_clamp_1_8192",
                "cli_ag_default_nonempty_gc_64000_topk64", "cli38_drop_sampling_count",
                "ag_drop_penalty_stop", "image_client_config_size_name_priority", "clean_then_no_prefill"),
             "converter_rules": ("openai_presence_map", "openai_completion_tokens_truthy_priority",
                "openai_schema_by_target_claude", "claude_generation_defaults_temperature_0.4",
                "claude_enabled_budget_default_48000", "claude_disabled_include_false", "compatibility_system_merge"),
             "proof_engine": "symbolic-profile-and-token-dfa-1", "source_digests": _source_digests()}
    chains = {channel: {protocol: ("prefix", "entry_alias", "converter", "channel_normalizer")
                       for protocol in ("gemini", "openai", "claude")}
              for channel in ("geminicli", "antigravity")}
    classes = ("absent", "null", "boolean", "number_zero", "number_nonzero", "string_valid_level",
               "string_invalid_level", "object", "array", "thinking_enabled", "thinking_disabled",
               "tool_calls_present", "tool_calls_absent", "return_thoughts_boolean", "compatibility_boolean")
    return RoutingPolicySnapshot(CONTRACT_VERSION, digest({"rules": rules, "chains": chains, "classes": classes}),
                                 chains, rules, classes, "symbolic-profile-and-token-dfa-1")


def strip_prefix(name, policy):
    for prefix in policy.static_rules["prefixes"]:
        if name.startswith(prefix):
            return name[len(prefix):], prefix
    return name, ""


def strip_suffixes(name, policy, *, native=False):
    if native and name in policy.static_rules["ag_native"]:
        return name
    result = name
    changed = True
    while changed:
        changed = False
        for suffix in policy.static_rules["suffixes"]:
            if result.endswith(suffix):
                result = result[:-len(suffix)]
                changed = True
    return result


def entry_alias(channel, name, policy):
    if channel == "antigravity":
        return policy.static_rules["ag_aliases"].get(name, name)
    for public, target in policy.static_rules["cli_aliases"].items():
        if name == public:
            return target
        if name.startswith(public + "-"):
            suffix = name[len(public):]
            if suffix in policy.static_rules["cli_alias_suffixes"]:
                return target + suffix
    return name


def thinking_settings(name, policy):
    base = strip_suffixes(name, policy)
    if "-nothinking" in name:
        return (0 if "flash" in base else 128), None
    if "-maxthinking" in name:
        return (None, "HIGH") if "gemini-3" in base else ((24576 if "flash" in base else 32768), None)
    if "gemini-3" in base:
        if "-high" in name:
            return None, "HIGH"
        if "-medium" in name:
            return None, "MEDIUM" if "flash" in base else None
        if "-low" in name:
            return None, "LOW"
        return None, None
    if "gemini-2.5" in base:
        for suffix, budget in (("-max", 24576 if "flash" in base else 32768), ("-high", 16000),
                               ("-medium", 8192), ("-low", 1024), ("-minimal", 0 if "flash" in base else 128)):
            if suffix in name:
                return budget, None
    return None, None


def map_ag_gemini(name, level, budget, policy):
    lower = name.lower()
    if lower == "gemini-3.1-pro-high":
        return "gemini-pro-agent"
    if lower in policy.static_rules["ag_native"]:
        return lower
    base = strip_suffixes(lower, policy, native=True)
    if base in policy.static_rules["ag_exact"]:
        return base
    if "gemini-3.1-pro" in base:
        if "-high" in lower:
            return "gemini-pro-agent"
        if "-low" in lower:
            return "gemini-3.1-pro-low"
    if "gemini-3.5-flash" in base:
        if "-extra-low" in lower or "-minimal" in lower:
            return "gemini-3.5-flash-extra-low"
        if "-low" in lower:
            return "gemini-3.5-flash-low"
        if "-high" in lower:
            return "gemini-3.5-flash-high"
    if "gemini-3-flash" in base:
        return "gemini-3-flash-agent"
    if "gemini-3.1-pro" in base:
        return "gemini-pro-agent" if level and level.upper() == "HIGH" else "gemini-3.1-pro-low"
    if "gemini-3.5-flash" in base:
        if level and level.upper() in ("MINIMAL", "EXTRA-LOW"):
            return "gemini-3.5-flash-extra-low"
        return "gemini-3.5-flash-high" if level and level.upper() == "HIGH" else "gemini-3.5-flash-low"
    return base


def map_ag_claude(name):
    """The Claude keyword stage consumes the preceding Gemini mapper output."""
    lower = name.lower()
    if "claude" not in lower:
        return name
    if "opus" in lower:
        return resolve_antigravity_opus_model(name)
    if "sonnet" in lower:
        return "claude-sonnet-4-6"
    if "haiku" in lower:
        return "gemini-2.5-flash"
    return "claude-sonnet-4-6"


def parameter_actions(channel, name, policy):
    """Symbolic operations valid for every request value, not sample budgets.

    Input references denote arbitrary JSON values with presence/type preserved.
    These descriptors are a normal form for comparing names over all parameter
    classes. Integration still executes the existing content/tool normalizers.
    """
    if channel == "antigravity" and is_retired_antigravity_opus_model(name):
        return {"retired": True, "status": 400}
    lower = name.lower()
    budget, level = thinking_settings(name, policy)
    base = strip_suffixes(name, policy)
    actions = {"thinking_selection": ("name", budget, level) if budget is not None or level is not None else ("input", "thinkingConfig"),
               "converter_tool_schema": "claude" if "claude" in lower else "gemini",
               "tool_schema": "claude" if "claude" in lower else "gemini",
               "signature": "preserve" if "claude" in lower else "skip_for_tool_thought_signature",
               "content_cleanup": "cli" if channel == "geminicli" else "ag",
               "compatibility": ("input", "feature.compatibility_mode")}
    if channel == "geminicli":
        cli38 = base == policy.static_rules["cli38"]
        actions.update({"thinking_enabled_by_name": "think" in name or "pro" in lower,
                        "thinking_priority": "level_then_budget_validate" if cli38 else "budget_then_level",
                        "invalid_name_level": cli38 and ("-minimal" in name or "-nothinking" in name),
                        "includeThoughts": ("client_nonnull_else", "pro" if "pro" in base else "level" if "3-flash" in base or cli38 else "budget_nonzero"),
                        "add_google_search": "-search" in name,
                        "sampling": "drop_temperature_topP_topK_count" if cli38 else "preserve",
                        "limits": "nonempty_gc_64000" if cli38 else "nonempty_gc_64000_64",
                        "no_prefill": cli38,
                        "safety": "lite" if "gemini-2.5-flash-lite" in lower else "default"})
    elif "image" in lower:
        actions = {"image": True, "image_size": "4K" if "-4k" in lower else "2K" if "-2k" in lower else None,
                   "aspect_ratio": next((ratio for suffix, ratio in (("-21x9", "21:9"), ("-16x9", "16:9"), ("-9x16", "9:16"),
                        ("-4x3", "4:3"), ("-3x4", "3:4"), ("-1x1", "1:1")) if suffix in lower), None),
                   "priority": ("input.imageConfig", "input.image_config", "input.size", "name"),
                   "replace_gc": "candidateCount_1_imageConfig", "remove": ("systemInstruction", "tools", "toolConfig")}
    else:
        gemini = "gemini" in lower
        opus = not gemini and "claude" in lower and "opus" in lower
        thinking = "think" in lower
        final_name = name
        if gemini:
            final_name = map_ag_gemini(name, level, budget, policy)
        final_name = map_ag_claude(final_name)
        final_lower = final_name.lower()
        actions["tool_schema"] = "claude" if "claude" in final_lower else "gemini"
        actions["signature"] = "preserve" if "claude" in final_lower else "skip_for_tool_thought_signature"
        actions.update({"ag_gemini": gemini, "ag_gemini3": gemini and "gemini-3" in lower,
                        "ag_thinking": thinking and not opus,
                        "ag_budget": "remove" if opus else 1024 if thinking else "preserve",
                        "ag_opus_route_depth": opus,
                        "claude_tool_call_remove_thinking": not gemini and "claude" in lower,
                        "claude_insert_thought": not gemini and "claude" in lower,
                        "includeThoughts": "feature" if gemini and "gemini-3" in lower or thinking or opus else "preserve",
                        "drop": ("presencePenalty", "frequencyPenalty", "stopSequences"),
                        "limits": "gpt_oss_clamp_1_8192" if "gpt-oss" in final_lower else "nonempty_gc_64000_64",
                        "no_prefill": any(word in final_lower for word in ("opus", "sonnet", "gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.8-flash")),
                        "safety": "none" if "gpt-oss" in final_lower else "lite" if "gemini-2.5-flash-lite" in final_lower else "default"})
    return actions
