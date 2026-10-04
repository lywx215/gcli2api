"""Body-free projections of the fields consumed by the six legacy chains."""

from collections.abc import Mapping
from typing import Any

from .types import FeatureSnapshot, ModelApiProtocol, RequestProjection


def json_type(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, str):
        return "string"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, Mapping):
        return "object"
    if isinstance(value, (list, tuple)):
        return "array"
    return "invalid"


def _opaque(value, path):
    """Preserve an opaque value's type/truthiness without storing its contents."""
    if isinstance(value, Mapping):
        return {"$routing_symbol": path} if value else {}
    if isinstance(value, (tuple, list)):
        return [{"$routing_symbol": path}] if value else []
    return value


def _thinking(value, path):
    if not isinstance(value, Mapping):
        return _opaque(value, path)
    allowed = ("type", "budget_tokens") if path == "thinking" else ("thinkingBudget", "thinkingLevel", "includeThoughts")
    result = {key: _opaque(value[key], path + "." + key) for key in allowed if key in value}
    if set(value) - set(allowed):
        result["$unconsumed_fields"] = True
    return result


def _field(source: Mapping, key: str, path: str) -> dict:
    value = source.get(key)
    projected = _opaque(value, path)
    if key in ("thinking", "thinkingConfig"):
        projected = _thinking(value, path)
    elif key in ("stop", "stop_sequences", "stopSequences", "responseModalities") and isinstance(value, (list, tuple)):
        projected = [_opaque(item, path + "[]") for item in value]
    elif key in ("imageConfig", "image_config") and isinstance(value, Mapping):
        projected = {name: _opaque(item, path + "." + name) for name, item in value.items() if name in ("aspectRatio", "imageSize")}
        if set(value) - {"aspectRatio", "imageSize"}:
            projected["$unconsumed_fields"] = True
    return {"present": key in source, "type": json_type(value),
            "value": projected,
            "symbol": ("input", path)}


def _content_shape(raw: Mapping, protocol: ModelApiProtocol) -> dict:
    """Retain structural predicates, never text, signatures, tools or images."""
    entries = raw.get("contents" if protocol == ModelApiProtocol.GEMINI else "messages")
    shape = []
    has_calls = False
    has_images = False
    if isinstance(entries, (list, tuple)):
        for entry in entries:
            if not isinstance(entry, Mapping):
                shape.append({"type": json_type(entry)})
                continue
            blocks = entry.get("parts" if protocol == ModelApiProtocol.GEMINI else "content")
            parts = []
            if isinstance(blocks, (list, tuple)):
                for block in blocks:
                    if not isinstance(block, Mapping):
                        parts.append({"type": json_type(block)})
                        continue
                    kind = block.get("type")
                    call = ("functionCall" in block or "function_call" in block
                            or kind == "tool_use")
                    image = ("inlineData" in block or "inline_data" in block
                             or kind in ("image", "image_url"))
                    has_calls |= call
                    has_images |= image
                    text = block.get("text")
                    parts.append({"type": "object", "call": call, "image": image,
                                  "text_type": json_type(text),
                                  "text_empty": text in (None, "", {}, []),
                                  "text_whitespace": isinstance(text, str) and not text.strip(),
                                  "signature": "thoughtSignature" in block or "thought_signature" in block,
                                  "thought": "thought" in block})
            has_calls |= bool(entry.get("tool_calls"))
            shape.append({"type": "object", "role": entry.get("role") if entry.get("role") in ("user", "model", "assistant", "system", "tool", "function") else "other",
                          "parts_type": json_type(blocks), "parts": parts})
    return {"entries_type": json_type(entries), "entries": shape,
            "has_tool_calls": has_calls, "has_images": has_images}


def project_request(channel, protocol, requested_model, raw_request, feature_snapshot):
    """Project a model_to_dict result; no global configuration is consulted.

    Values are retained only for generation parameters. Message bodies, schemas,
    image bytes, tool arguments and authentication fields never enter a snapshot.
    Presence and JSON types remain distinct, including explicit null in extra
    fields and false/zero values.
    """
    if channel not in ("geminicli", "antigravity"):
        raise ValueError("Unsupported model routing channel.")
    protocol = ModelApiProtocol(protocol)
    if not isinstance(feature_snapshot, FeatureSnapshot):
        raise TypeError("A feature snapshot is required.")
    raw = raw_request if isinstance(raw_request, Mapping) else {}
    keys = (("size",) if protocol == ModelApiProtocol.GEMINI else
            ("temperature", "top_p", "top_k", "max_tokens", "max_completion_tokens", "stop",
             "frequency_penalty", "presence_penalty", "n", "seed", "size") if protocol == ModelApiProtocol.OPENAI else
            ("temperature", "top_p", "top_k", "max_tokens", "stop_sequences", "thinking", "size"))
    fields = {key: _field(raw, key, key) for key in keys}
    gc = raw.get("generationConfig") if protocol == ModelApiProtocol.GEMINI else None
    fields["generationConfig"] = {"present": protocol == ModelApiProtocol.GEMINI and "generationConfig" in raw, "type": json_type(gc)}
    if isinstance(gc, Mapping):
        # Do not retain responseSchema or arbitrary data in generationConfig.
        allowed = ("temperature", "topP", "topK", "maxOutputTokens", "stopSequences",
                   "candidateCount", "seed", "frequencyPenalty", "presencePenalty",
                   "thinkingConfig", "responseModalities", "imageConfig", "image_config", "responseMimeType")
        fields["generation_config"] = {key: _field(gc, key, "generationConfig." + key)["value"] for key in allowed if key in gc}
        fields["generation_fields"] = {key: _field(gc, key, "generationConfig." + key) for key in allowed}
        fields["generation_other_fields"] = bool(set(gc) - set(allowed))
    else:
        fields["generation_config"] = _opaque(gc, "generationConfig")
        fields["generation_other_fields"] = False
    # response_format schemas must not be retained; only the selected operation.
    rf = raw.get("response_format") if protocol == ModelApiProtocol.OPENAI else None
    schema_container = rf.get("json_schema") if isinstance(rf, Mapping) else None
    schema_contains = ("schema" in schema_container) if isinstance(schema_container, (Mapping, list, tuple, str)) else False
    fields["response_format"] = {"present": "response_format" in raw, "type": json_type(rf),
                                 "format_type": _opaque(rf.get("type"), "response_format.type") if isinstance(rf, Mapping) else None,
                                 "json_schema_type": json_type(rf.get("json_schema")) if isinstance(rf, Mapping) else None,
                                 "json_schema_present": "json_schema" in rf if isinstance(rf, Mapping) else False,
                                 "schema_present": schema_contains,
                                 "truthy": bool(rf)}
    shape = _content_shape(raw, protocol)
    tools_value = raw.get("tools")
    google_search = False
    google_search_truthy = False
    if isinstance(tools_value, (list, tuple)):
        google_search = any(isinstance(tool, Mapping) and "googleSearch" in tool for tool in tools_value)
        google_search_truthy = any(isinstance(tool, Mapping) and bool(tool.get("googleSearch")) for tool in tools_value)
    tools = {"present": "tools" in raw, "type": json_type(tools_value),
             "truthy": bool(tools_value), "google_search": google_search, "google_search_truthy": google_search_truthy,
             "has_tool_calls": shape["has_tool_calls"],
             "content_shape": shape,
             "tool_choice_present": "tool_choice" in raw,
             "tool_choice_type": json_type(raw.get("tool_choice"))}
    return RequestProjection(protocol, fields, tools,
                             {"has_images": shape["has_images"], "size": fields["size"]})


def generation_parameters(projection: RequestProjection) -> dict:
    """The converter's generationConfig before channel normalization."""
    fields = projection.fields
    from .types import thaw
    if projection.protocol == ModelApiProtocol.GEMINI:
        value = thaw(fields.get("generation_config"))
        if value and not isinstance(value, dict):
            raise TypeError("Invalid generation configuration.")
        return (value or {}).copy()
    value = lambda key: thaw(fields[key]["value"])
    present = lambda key: fields[key]["present"]
    if projection.protocol == ModelApiProtocol.OPENAI:
        gc = {}
        for key, out in (("temperature", "temperature"), ("top_p", "topP"), ("top_k", "topK"),
                         ("frequency_penalty", "frequencyPenalty"), ("presence_penalty", "presencePenalty"),
                         ("n", "candidateCount"), ("seed", "seed")):
            if present(key):
                gc[out] = value(key)
        if present("max_tokens") or present("max_completion_tokens"):
            gc["maxOutputTokens"] = value("max_completion_tokens") or value("max_tokens")
        if present("stop"):
            stop = value("stop")
            gc["stopSequences"] = [stop] if isinstance(stop, str) else stop
        rf = fields["response_format"]
        if rf["truthy"]:
            if rf["type"] != "object":
                raise TypeError("Invalid response format.")
            if rf["format_type"] == "json_schema" and rf["json_schema_present"] and rf["json_schema_type"] in ("null", "boolean", "number"):
                raise TypeError("Invalid response schema container.")
            if rf["format_type"] == "json_schema" and rf["schema_present"] and rf["json_schema_type"] != "object":
                raise TypeError("Invalid response schema container.")
            if rf["format_type"] == "json_object" or rf["format_type"] == "json_schema" and rf["schema_present"]:
                gc["responseMimeType"] = "application/json"
                if rf["format_type"] == "json_schema":
                    gc["responseSchema"] = {"$routing_symbol": "response_format.json_schema.schema"}
            elif rf["format_type"] == "text":
                gc["responseMimeType"] = "text/plain"
        return gc
    gc = {"topP": 1, "candidateCount": 1,
          "stopSequences": ["<|user|>", "<|bot|>", "<|context_request|>", "<|endoftext|>", "<|end_of_turn|>"],
          "temperature": 0.4 if value("temperature") is None else value("temperature")}
    for key, out in (("top_p", "topP"), ("top_k", "topK"), ("max_tokens", "maxOutputTokens")):
        if value(key) is not None:
            gc[out] = value(key)
    thinking = value("thinking")
    plan = False
    if thinking and isinstance(thinking, Mapping):
        if thinking.get("type") == "enabled":
            plan = True
            budget = thinking.get("budget_tokens")
            gc["thinkingConfig"] = {"thinkingBudget": 48000 if budget is None else budget, "includeThoughts": True}
        elif thinking.get("type") == "disabled":
            gc["thinkingConfig"] = {"includeThoughts": False}
    stops = value("stop_sequences")
    if isinstance(stops, (list, tuple)) and stops:
        gc["stopSequences"] += [str(s) for s in stops]
    elif plan:
        gc["stopSequences"] = []
    return gc
