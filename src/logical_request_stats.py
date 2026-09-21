"""Record one statistics outcome for a client-visible logical request.

Credential attempt bookkeeping deliberately remains in the API clients.  This
module is the separate boundary for the daily/RPM counters: retries, credential
switches, and anti-truncation continuations must not create additional rows.
"""

import json
from typing import Any

from log import log


async def record_logical_request(model_name: str, mode: str, success: bool) -> None:
    """Best-effort dispatch to the storage backend's logical-request counter."""
    try:
        from src.storage_adapter import get_storage_adapter

        storage = await get_storage_adapter()
        backend = getattr(storage, "_backend", None)
        recorder = getattr(backend, "record_logical_request", None)
        if callable(recorder):
            await recorder(model_name, mode, success)
        else:
            log.debug("[LOGICAL_STATS] backend does not support logical request counts")
    except Exception as exc:
        # Counting must never turn a successful client request into a failure.
        log.warning(f"[LOGICAL_STATS] failed to record logical request: {exc}")


def response_has_valid_body(response: Any) -> bool:
    """Whether a non-stream response contains a client-usable successful body."""
    if getattr(response, "status_code", 500) != 200:
        return False
    body = getattr(response, "body", None)
    if body is None:
        body = getattr(response, "content", None)
    if isinstance(body, bytes):
        body = body.decode("utf-8", errors="replace")
    if not isinstance(body, str) or not body.strip():
        return False
    try:
        payload = json.loads(body)
    except (TypeError, ValueError):
        return False
    return isinstance(payload, dict) and not payload.get("error") and _payload_has_body(payload)


def stream_item_has_body(item: Any) -> bool:
    """Recognize real generated content in Gemini, OpenAI, and Anthropic SSE."""
    if not isinstance(item, (str, bytes)):
        return False
    text = item.decode("utf-8", errors="replace") if isinstance(item, bytes) else item
    text = text.strip()
    if not text or text == "[DONE]" or text == "data: [DONE]" or text.startswith(":"):
        return False

    data_lines = [line[5:].strip() for line in text.splitlines() if line.startswith("data:")]
    payload_text = data_lines[-1] if data_lines else text
    if text.startswith("event:") and not data_lines:
        # Event names alone (e.g. ping/message_start) carry no response body.
        return False
    try:
        payload = json.loads(payload_text)
    except (TypeError, ValueError):
        return False
    if not isinstance(payload, dict) or payload.get("error"):
        return False
    return _payload_has_body(payload)


def stream_item_is_error(item: Any) -> bool:
    """Detect an error frame after a stream has started."""
    if hasattr(item, "status_code"):
        return getattr(item, "status_code", 500) >= 400
    if not isinstance(item, (str, bytes)):
        return False
    text = item.decode("utf-8", errors="replace") if isinstance(item, bytes) else item
    data_lines = [line[5:].strip() for line in text.splitlines() if line.startswith("data:")]
    if not data_lines:
        return False
    try:
        payload = json.loads(data_lines[-1])
    except (TypeError, ValueError):
        return False
    return isinstance(payload, dict) and bool(payload.get("error"))


def _payload_has_body(payload: dict[str, Any]) -> bool:
    """Check the common public streaming shapes without treating metadata as text."""
    if _value_has_body(payload.get("content")) or _value_has_body(payload.get("delta")):
        return True
    response = payload.get("response")
    if isinstance(response, dict) and _payload_has_body(response):
        return True
    for candidate in payload.get("candidates", []) if isinstance(payload.get("candidates"), list) else []:
        if isinstance(candidate, dict) and _value_has_body(candidate.get("content")):
            return True
    for choice in payload.get("choices", []) if isinstance(payload.get("choices"), list) else []:
        if isinstance(choice, dict) and (
            _value_has_body(choice.get("delta")) or _value_has_body(choice.get("message"))
        ):
            return True
    return False


def _value_has_body(value: Any) -> bool:
    if isinstance(value, str):
        return bool(value.strip())
    if not isinstance(value, dict):
        return False
    if isinstance(value.get("text"), str) and value["text"].strip():
        return True
    if isinstance(value.get("content"), str) and value["content"].strip():
        return True
    parts = value.get("parts")
    if isinstance(parts, list):
        return any(_value_has_body(part) or bool(isinstance(part, dict) and part.get("inlineData")) for part in parts)
    return bool(value.get("inlineData"))
