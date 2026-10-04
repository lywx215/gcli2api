"""Pure resolver and parameter profiles for the real legacy dispatch chains."""

from collections.abc import Mapping
import re

from src.antigravity_models import resolve_antigravity_opus_model
from src.router.model_api_errors import ErrorOrigin, error_from_http_status
from .policy import entry_alias, map_ag_claude, map_ag_gemini, parameter_actions, strip_prefix, strip_suffixes, thinking_settings
from .projection import generation_parameters
from .types import ResolutionOutcome, TargetProfile, thaw


def _safe_error(status=400):
    return error_from_http_status(status, origin=ErrorOrigin.LOCAL)


def _image_parameters(name, gc, projection):
    image = gc.get("imageConfig") or gc.get("image_config") or {}
    if image:
        image = image.copy()
    else:
        size = projection.fields["size"]["value"]
        if size:
            match = re.match(r"^(\d+)\s*[xX*×]\s*(\d+)$", size.strip())
            image = {}
            if match:
                width,height = int(match.group(1)),int(match.group(2))
                if width>0 and height>0:
                    ratios=((1,1),(2,3),(3,2),(3,4),(4,3),(4,5),(5,4),(9,16),(16,9),(21,9))
                    w,h=min(ratios,key=lambda ratio:abs(width/height-ratio[0]/ratio[1]))
                    image={"aspectRatio":f"{w}:{h}","imageSize":"1K" if max(width,height)<=1280 else "2K" if max(width,height)<=2560 else "4K"}
        else:
            lower=name.lower()
            image={}
            for suffix,ratio in (("-21x9","21:9"),("-16x9","16:9"),("-9x16","9:16"),("-4x3","4:3"),("-3x4","3:4"),("-1x1","1:1")):
                if suffix in lower:
                    image["aspectRatio"]=ratio
                    break
            if "-4k" in lower or "-2k" in lower:
                image["imageSize"]="4K" if "-4k" in lower else "2K"
    return {"candidateCount":1,"imageConfig":thaw(image)}


def _normalize_parameters(channel, name, gc, projection, features, policy):
    gc = thaw(gc)
    budget, level = thinking_settings(name, policy)
    if channel == "antigravity" and "image" in name.lower():
        return "gemini-3.1-flash-image", {"image": parameter_actions(channel, name, policy),
                                          "generation_config":_image_parameters(name,gc,projection),
                                          "add_google_search":False}
    if budget is None and level is None:
        thinking = gc.get("thinkingConfig", {})
        budget = thinking.get("thinkingBudget")
        level = thinking.get("thinkingLevel")
    lower = name.lower()
    dispatch = name
    if channel == "geminicli":
        cli38 = strip_suffixes(name, policy) == policy.static_rules["cli38"]
        if cli38:
            if "-minimal" in name or "-nothinking" in name:
                return strip_suffixes(name, policy), {"error": _safe_error()}
            if level is not None:
                if str(level).lower() not in policy.static_rules["cli38_levels"]:
                    return strip_suffixes(name, policy), {"error": _safe_error()}
                level, budget = str(level).upper(), None
            elif budget is not None:
                return strip_suffixes(name, policy), {"error": _safe_error()}
        if "think" in name or "pro" in lower or budget is not None or level is not None:
            thinking = gc.setdefault("thinkingConfig", {})
            if budget is not None:
                thinking["thinkingBudget"] = budget
                thinking.pop("thinkingLevel", None)
            elif level is not None:
                thinking["thinkingLevel"] = level
                thinking.pop("thinkingBudget", None)
            client = generation_parameters(projection).get("thinkingConfig", {}).get("includeThoughts")
            if client is not None:
                include = client
            else:
                base = strip_suffixes(name, policy)
                include = features.return_thoughts if "pro" in base else (
                    features.return_thoughts if level is not None else False) if "3-flash" in base or cli38 else (
                    False if budget is None or budget == 0 else features.return_thoughts)
            thinking["includeThoughts"] = include
        dispatch = strip_suffixes(name, policy)
        if gc or projection.fields.get("generation_other_fields"):
            gc["maxOutputTokens"] = 64000
            if not cli38:
                gc["topK"] = 64
        if cli38:
            for key in ("temperature", "topP", "topK", "candidateCount"):
                gc.pop(key, None)
    else:
        thinking_name = "think" in lower
        if "gemini" in lower:
            dispatch = map_ag_gemini(name, level, budget, policy)
            if "gemini-3" in lower:
                thinking = gc.setdefault("thinkingConfig", {})
                thinking.pop("thinkingBudget", None)
                thinking.pop("thinkingLevel", None)
                thinking["includeThoughts"] = features.return_thoughts
            elif thinking_name:
                thinking = gc.setdefault("thinkingConfig", {})
                thinking["thinkingBudget"] = 1024
                thinking.pop("thinkingLevel", None)
                thinking["includeThoughts"] = features.return_thoughts
        else:
            if thinking_name:
                thinking = gc.setdefault("thinkingConfig", {})
                thinking["thinkingBudget"] = 1024
                thinking.pop("thinkingLevel", None)
                thinking["includeThoughts"] = features.return_thoughts
            if "claude" in lower and "opus" in lower and resolve_antigravity_opus_model(name).startswith("claude-opus-5-5-"):
                thinking = gc.setdefault("thinkingConfig", {})
                thinking.pop("thinkingBudget", None)
                thinking.pop("thinkingLevel", None)
                thinking["includeThoughts"] = features.return_thoughts
            if "claude" in lower and projection.tools.get("has_tool_calls"):
                gc.pop("thinkingConfig", None)
        dispatch = map_ag_claude(dispatch)
        for key in ("presencePenalty", "frequencyPenalty", "stopSequences"):
            gc.pop(key, None)
        if gc or projection.fields.get("generation_other_fields"):
            if "gpt-oss" in dispatch.lower():
                requested = gc.get("maxOutputTokens")
                if not isinstance(requested, (int, float)) or isinstance(requested, bool):
                    requested = 8192
                gc["maxOutputTokens"] = min(max(int(requested), 1), 8192)
                gc.pop("topK", None)
                gc.pop("thinkingConfig", None)
            else:
                gc["maxOutputTokens"], gc["topK"] = 64000, 64
    return dispatch, {"generation_config": gc, "name_budget": budget, "name_level": level,
                      "add_google_search": channel == "geminicli" and "-search" in name,
                      "parameter_actions": parameter_actions(channel, name, policy)}


def legacy_resolution(channel, protocol, requested_model, projection, policy, feature_snapshot):
    public, prefix = strip_prefix(requested_model, policy)
    name = entry_alias(channel, public, policy)
    try:
        dispatch, values = _normalize_parameters(channel, name, generation_parameters(projection), projection, feature_snapshot, policy)
        error = values.get("error")
    except (AttributeError, TypeError, ValueError, OverflowError):
        # Matches protected normalization/conversion failures without retaining
        # raw exceptions or names. Validation of Pydantic input stays in I.
        dispatch, values, error = name, {}, _safe_error(500)
    actions = parameter_actions(channel, name, policy)
    values.update({"prefix": prefix, "normalization_model": name, "normalizer_input_model": name,
                   "fake_streaming": prefix == "假流式/", "anti_truncation": prefix in ("抗截断/", "流式抗截断/")})
    return ResolutionOutcome(requested_model, dispatch, public, values, False,
                             TargetProfile(dispatch, actions), error is None, error)


def resolve(channel, protocol, requested_model, request_projection, compiled_channel, policy_snapshot, feature_snapshot):
    if compiled_channel.channel != channel or compiled_channel.policy_digest != policy_snapshot.digest:
        raise ValueError("Model routing policy mismatch.")
    public, prefix = strip_prefix(requested_model, policy_snapshot)
    active = {row.public_name: row for row in compiled_channel.rows if row.enabled}
    row = active.get(public)
    suffix = ""
    if row is None and channel == "geminicli":
        base = strip_suffixes(public, policy_snapshot)
        row = active.get(base)
        if row is not None:
            suffix = public[len(base):]
    if row is None:
        return legacy_resolution(channel, protocol, requested_model, request_projection, policy_snapshot, feature_snapshot)
    # Public names are opaque. Only a CLI-derived suffix is appended to the
    # target profile; AG exact public names never activate search/effort syntax.
    normalization_model = row.upstream_name + suffix
    try:
        _, values = _normalize_parameters(channel, normalization_model, generation_parameters(request_projection),
                                          request_projection, feature_snapshot, policy_snapshot)
        error = values.get("error")
    except (AttributeError, TypeError, ValueError, OverflowError):
        values, error = {}, _safe_error(500)
    values.update({"prefix": prefix, "normalization_model": normalization_model, "normalizer_input_model": normalization_model,
                   "derived_suffix": suffix, "fake_streaming": prefix == "假流式/",
                   "anti_truncation": prefix in ("抗截断/", "流式抗截断/")})
    return ResolutionOutcome(requested_model, row.upstream_name, row.public_name, values, True,
                             compiled_channel.profiles[row.public_name], error is None, error)
