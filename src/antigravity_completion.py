"""Validate raw Antigravity candidates before collectors/protocol conversion."""
import copy
import json
from src.router.model_api_errors import (
    ErrorKind, ErrorOrigin, ModelApiErrorException, make_model_api_error, parse_model_response,
    error_from_retirement_payload,
)

TERMINALS = frozenset({"STOP", "MAX_TOKENS", "SAFETY", "RECITATION", "OTHER", "LANGUAGE",
    "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "MALFORMED_FUNCTION_CALL", "IMAGE_SAFETY",
    "UNEXPECTED_TOOL_CALL", "IMAGE_PROHIBITED_CONTENT", "NO_IMAGE", "IMAGE_RECITATION",
    "TOO_MANY_TOOL_CALLS", "MISSING_THOUGHT_SIGNATURE"})


# Explicit provider termination errors/filters carry semantics even without a
# body. Empty successful STOP/MAX_TOKENS and thought-only output remain invalid.
CONTENTLESS_TERMINALS = TERMINALS - {"STOP", "MAX_TOKENS"}


def bad_format():
    return ModelApiErrorException(make_model_api_error(origin=ErrorOrigin.UPSTREAM, kind=ErrorKind.BAD_FORMAT))


class Completion:
    def __init__(self):
        self.candidates = {}
        self.blocked = False
        self.terminal_seen = False
        self.usage = {}
        self.ended = False

    def observe(self, payload):
        if not isinstance(payload, dict):
            raise bad_format()
        obj = payload.get("response", payload)
        if not isinstance(obj, dict):
            raise bad_format()
        feedback = obj.get("promptFeedback", {})
        if isinstance(feedback, dict) and feedback.get("blockReason") not in (None, "", "BLOCK_REASON_UNSPECIFIED"):
            self.blocked = self.terminal_seen = True
        usage = obj.get("usageMetadata")
        if isinstance(usage, dict):
            self.usage.update(usage)
        candidates = obj.get("candidates", [])
        if not isinstance(candidates, list):
            raise bad_format()
        indices = set()
        for position, candidate in enumerate(candidates):
            if not isinstance(candidate, dict):
                raise bad_format()
            index = candidate.get("index", position)
            if type(index) is not int or index < 0 or index in indices:
                raise bad_format()
            indices.add(index)
            state = self.candidates.setdefault(index, {"effective": False, "terminal": False, "filtered": False, "thought_seen": False})
            content = candidate.get("content", {})
            if not isinstance(content, dict):
                raise bad_format()
            parts = content.get("parts", [])
            if not isinstance(parts, list):
                raise bad_format()
            for part in parts:
                if not isinstance(part, dict):
                    raise bad_format()
                if part.get("thought"):
                    state["thought_seen"] = True
                    continue
                text = part.get("text")
                tool = part.get("functionCall", part.get("function_call"))
                media = part.get("inlineData", part.get("fileData"))
                if tool is not None and not (isinstance(tool, dict) and isinstance(tool.get("name"), str)
                                             and tool["name"].strip() and isinstance(tool.get("args", {}), dict)):
                    raise bad_format()
                effective = bool(isinstance(text, str) and text.strip())
                effective |= bool(isinstance(tool, dict) and isinstance(tool.get("name"), str)
                                  and tool["name"].strip() and isinstance(tool.get("args", {}), dict))
                effective |= bool(isinstance(media, dict) and any(isinstance(media.get(k), str) and media[k].strip() for k in ("data", "fileUri")))
                effective |= bool(isinstance(part.get("executableCode"), dict) and part["executableCode"].get("code"))
                effective |= bool(isinstance(part.get("codeExecutionResult"), dict) and part["codeExecutionResult"].get("output"))
                state["effective"] |= effective
            reason = candidate.get("finishReason")
            if reason:
                if not isinstance(reason, str) or reason not in TERMINALS:
                    raise bad_format()
                state["terminal"] = self.terminal_seen = True
                state["filtered"] = reason in CONTENTLESS_TERMINALS

    def json(self, raw):
        payload = parse_model_response(raw)
        retirement = error_from_retirement_payload(payload)
        if retirement is not None:
            raise ModelApiErrorException(retirement)
        try:
            self.observe(payload)
        except (TypeError, AttributeError, ValueError):
            raise bad_format() from None
        return payload

    def event(self, raw):
        if isinstance(raw, bytes):
            try:
                raw = raw.decode("utf-8")
            except UnicodeError:
                raise bad_format() from None
        if not isinstance(raw, str):
            raise bad_format()
        lines = [line[5:].lstrip(" ") for line in raw.split("\n") if line.startswith("data:")]
        if not lines:
            return False
        data = "\n".join(lines).strip()
        if data == "[DONE]":
            self.finish()
            return True
        self.json(data)
        return False

    def finish(self):
        if not self.blocked and (not self.candidates or any((not s["effective"] and (not s["filtered"] or s["thought_seen"])) or not s["terminal"] for s in self.candidates.values())):
            raise bad_format()
        self.ended = True


def validate_json(raw):
    completion = Completion()
    payload = completion.json(raw)
    completion.finish()
    return payload


def separate_terminal(raw):
    """Release content immediately, but hold success finish fields until end.

    In particular a provider may put its entire answer and STOP in one frame,
    then keep the HTTP connection open. Holding that answer would stall clients.
    """
    text = raw.decode("utf-8") if isinstance(raw, bytes) else raw
    lines = [line[5:].lstrip(" ") for line in text.split("\n") if line.startswith("data:")]
    if not lines or "\n".join(lines).strip() == "[DONE]":
        return None, raw
    payload = json.loads("\n".join(lines))
    obj = payload.get("response", payload)
    feedback = obj.get("promptFeedback")
    if isinstance(feedback, dict) and feedback.get("blockReason"):
        return None, raw
    early = copy.deepcopy(payload)
    early_obj = early.get("response", early)
    late_candidates = []
    early_candidates = []
    for index, candidate in enumerate(early_obj.get("candidates", [])):
        finish = candidate.pop("finishReason", None)
        if finish:
            late_candidates.append({"index": candidate.get("index", index), "finishReason": finish})
        if any(key != "index" for key in candidate):
            early_candidates.append(candidate)
    if not late_candidates:
        return raw, None
    early_obj["candidates"] = early_candidates
    late = {"candidates": late_candidates}
    if "response" in payload:
        late = {"response": late}
    def encode(value):
        line = "data: " + json.dumps(value, ensure_ascii=False) + "\n\n"
        return line.encode("utf-8") if isinstance(raw, bytes) else line
    has_early = bool(early_candidates) or any(key != "candidates" for key in early_obj)
    return encode(early) if has_early else None, encode(late)


def finalize_terminal_usage(frames, usage):
    """Attach the final upstream usage snapshot to the last actual terminal.

    Converters may snapshot usage from their last finish frame. Do not let the
    delayed finish lose usage which arrived earlier (or after model STOP).
    """
    if not usage:
        return frames
    result = list(frames)
    for i in range(len(result) - 1, -1, -1):
        raw = result[i]
        text = raw.decode("utf-8") if isinstance(raw, bytes) else raw
        data = "\n".join(line[5:].lstrip(" ") for line in text.split("\n") if line.startswith("data:"))
        if not data or data.strip() == "[DONE]":
            continue
        payload = json.loads(data)
        payload.get("response", payload)["usageMetadata"] = usage
        updated = "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"
        result[i] = updated.encode("utf-8") if isinstance(raw, bytes) else updated
        break
    return result
