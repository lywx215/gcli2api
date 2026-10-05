"""Request-local helpers around the existing transport and Completion stack."""

from copy import deepcopy
import json

from src.router.model_api_errors import (
    ErrorKind, ErrorOrigin, ModelApiErrorException, make_model_api_error,
)


def bad_stream():
    return ModelApiErrorException(make_model_api_error(
        origin=ErrorOrigin.UPSTREAM, kind=ErrorKind.BAD_FORMAT
    ))


def dispatch_request_body(body, route_context):
    """Check explicit dispatch; the actual legacy normalizer remains authoritative."""
    if route_context is None:
        return body
    if route_context.channel not in ("geminicli", "antigravity"):
        raise ValueError("Unsupported model routing channel.")
    if route_context.resolution.explicit_target and (
        not route_context.resolution.accepted or body.get("model") != route_context.resolution.dispatch_model
    ):
        raise ModelApiErrorException(make_model_api_error(origin=ErrorOrigin.LOCAL, status=503))
    result = deepcopy(body)
    return result


class CandidateIdentityState:
    """Assign omitted indices only when exactly one identity is possible.

    Array position is never identity. A first singleton can use the protocol's
    default zero; later missing indices must identify an existing sole candidate.
    Mixed lists cannot prove whether an omitted index denotes a new candidate.
    """

    def __init__(self):
        self.known = set()

    def normalize(self, payload):
        result = deepcopy(payload)
        obj = result.get("response", result)
        if not isinstance(obj, dict):
            raise bad_stream()
        candidates = obj.get("candidates", [])
        if not isinstance(candidates, list):
            raise bad_stream()
        explicit = set()
        missing = []
        for candidate in candidates:
            if not isinstance(candidate, dict):
                raise bad_stream()
            if "index" not in candidate:
                missing.append(candidate)
                continue
            index = candidate["index"]
            if type(index) is not int or index < 0 or index in explicit:
                raise bad_stream()
            explicit.add(index)
        if missing:
            if len(missing) != 1 or len(candidates) != 1:
                raise bad_stream()
            if not self.known and len(candidates) == 1:
                index = 0
            elif len(self.known) == 1:
                index = next(iter(self.known))
            else:
                raise bad_stream()
            missing[0]["index"] = index
            explicit.add(index)
        self.known.update(explicit)
        return result

    def event(self, raw):
        text = raw.decode("utf-8") if isinstance(raw, bytes) else raw
        data = [line[5:].lstrip(" ") for line in text.split("\n") if line.startswith("data:")]
        if not data or "\n".join(data).strip() == "[DONE]":
            return raw
        from src.router.model_api_errors import parse_model_response
        payload = self.normalize(parse_model_response("\n".join(data)))
        encoded = "data: " + json.dumps(payload, ensure_ascii=True, separators=(",", ":")) + "\n\n"
        return encoded.encode("utf-8") if isinstance(raw, bytes) else encoded
