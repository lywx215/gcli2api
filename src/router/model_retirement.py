"""Finite-buffer recognition of known model retirement notices.

This module deliberately knows nothing about routes, credentials, transports,
converters, or public error renderers.  It only classifies already parsed
upstream candidate/event objects.  The public result never carries the text
that was inspected, so a caller cannot accidentally render the model name
from a retirement notice.

The stream checker is intended to be created for every upstream attempt.  It
tracks candidates independently, but buffers complete events so that an event
containing a still-undecided candidate is never partially released.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from enum import Enum
from typing import Any, Optional


MAX_LEADING_WHITESPACE = 64
MAX_MODEL_NAME_CHARS = 128
MAX_DISPLAY_PREFIX_CHARS = 256
MAX_BUFFERED_EVENT_BYTES = 16 * 1024 * 1024
RETIREMENT_STATUS_CODE = 404
BUFFER_OVERFLOW_STATUS_CODE = 502

_NOTICE_HEAD = "gemini "
_NOTICE_TAIL = " is no longer available."
_OPUS_NOTICE = (
    "claude opus 4.6 is no longer available. "
    "please switch to claude opus 5.5."
)
_ALLOWED_NAME_CHARS = frozenset(
    "abcdefghijklmnopqrstuvwxyz"
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    "0123456789"
    " ._/+-()"
)


class RetirementAction(str, Enum):
    """The only externally observable decisions made by this module."""

    PASS = "pass"
    BUFFER = "buffer"
    RETIRED = "retired"
    BUFFER_OVERFLOW = "buffer_overflow"


@dataclass(frozen=True)
class RetirementResult:
    """A safe internal decision and events that may now be released.

    ``events`` is empty for ``BUFFER``, ``RETIRED`` and ``BUFFER_OVERFLOW``.
    For ``PASS`` it contains original event objects in their original order.
    ``status_code`` is populated only for the two terminal error decisions.
    No raw match, model name, exception, or upstream payload is stored here.
    """

    action: RetirementAction
    events: tuple[Any, ...] = ()
    status_code: Optional[int] = None

    @property
    def released_events(self) -> tuple[Any, ...]:
        """Alias used by callers that prefer output-oriented terminology."""

        return self.events


def _pass(*events: Any) -> RetirementResult:
    return RetirementResult(RetirementAction.PASS, tuple(events))


def _buffer() -> RetirementResult:
    return RetirementResult(RetirementAction.BUFFER)


def _retired() -> RetirementResult:
    return RetirementResult(RetirementAction.RETIRED, status_code=RETIREMENT_STATUS_CODE)


def _overflow() -> RetirementResult:
    return RetirementResult(
        RetirementAction.BUFFER_OVERFLOW,
        status_code=BUFFER_OVERFLOW_STATUS_CODE,
    )


def _as_mapping(value: Any) -> Optional[Mapping[str, Any]]:
    if isinstance(value, Mapping):
        return value
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        try:
            dumped = model_dump(exclude_none=False)
        except TypeError:
            dumped = model_dump()
        return dumped if isinstance(dumped, Mapping) else None
    legacy_dump = getattr(value, "dict", None)
    if callable(legacy_dump):
        try:
            dumped = legacy_dump()
        except TypeError:
            dumped = legacy_dump(exclude_none=False)
        return dumped if isinstance(dumped, Mapping) else None
    return None


def _candidate_list(payload: Any) -> list[Any]:
    """Find candidates at the payload root or through response wrappers."""

    current = _as_mapping(payload)
    if current is None:
        return []
    candidates = current.get("candidates")
    if isinstance(candidates, Sequence) and not isinstance(candidates, (str, bytes, bytearray)):
        return list(candidates)
    response = current.get("response")
    if response is not None and response is not payload:
        return _candidate_list(response)
    return []


def _parts_for_candidate(candidate: Any) -> list[Any]:
    candidate_map = _as_mapping(candidate)
    if candidate_map is None:
        return []
    content = candidate_map.get("content")
    content_map = _as_mapping(content)
    if content_map is not None:
        parts = content_map.get("parts")
    else:
        parts = content
    if isinstance(parts, Sequence) and not isinstance(parts, (str, bytes, bytearray)):
        return list(parts)
    # A few parsed adapters expose a content-like candidate directly.
    direct_parts = candidate_map.get("parts")
    if isinstance(direct_parts, Sequence) and not isinstance(direct_parts, (str, bytes, bytearray)):
        return list(direct_parts)
    return []


def _is_truthy(value: Any) -> bool:
    return value is True or (isinstance(value, str) and value.casefold() == "true")


def _is_non_text_part(part: Any) -> bool:
    part_map = _as_mapping(part)
    if part_map is None:
        return False
    part_type = part_map.get("type")
    if isinstance(part_type, str) and part_type.casefold() in {
        "image",
        "image_url",
        "tool_use",
        "tool_result",
        "function_call",
        "function_response",
        "tool_call",
    }:
        return True
    return any(
        key in part_map
        for key in (
            "inlineData",
            "inline_data",
            "fileData",
            "file_data",
            "functionCall",
            "function_call",
            "functionResponse",
            "function_response",
            "executableCode",
            "executable_code",
            "codeExecutionResult",
            "code_execution_result",
            "toolUse",
            "tool_use",
            "toolResult",
            "tool_result",
            "image",
            "image_url",
        )
    )


@dataclass(frozen=True)
class _CandidateObservation:
    display_text: str = ""
    non_text_before_display: bool = False


def _observe_candidate(candidate: Any) -> _CandidateObservation:
    text_parts: list[str] = []
    saw_display = False
    non_text_before_display = False
    for part in _parts_for_candidate(candidate):
        part_map = _as_mapping(part)
        if part_map is None:
            continue
        is_thought = _is_truthy(part_map.get("thought"))
        text = part_map.get("text")
        has_text = isinstance(text, str) and not is_thought
        if _is_non_text_part(part) and not saw_display:
            non_text_before_display = True
        if has_text:
            saw_display = True
            text_parts.append(text)
    return _CandidateObservation("".join(text_parts), non_text_before_display)


def _leading_whitespace(text: str) -> tuple[str, int]:
    count = 0
    while count < len(text) and text[count].isspace():
        count += 1
    return text[count:], count


def _name_is_valid(name: str) -> bool:
    return (
        1 <= len(name) <= MAX_MODEL_NAME_CHARS
        and bool(name.strip())
        and all(char in _ALLOWED_NAME_CHARS for char in name)
    )


def _classify_display_prefix(text: str) -> RetirementAction:
    """Classify only a candidate's initial displayed-text prefix.

    ``BUFFER`` means that more displayed characters are needed to decide.  A
    normal answer is released as soon as it cannot be the known prefix.  The
    function intentionally does not search later text for the notice.
    """

    core, whitespace_count = _leading_whitespace(text)
    if whitespace_count > MAX_LEADING_WHITESPACE:
        return RetirementAction.PASS
    if not core:
        return RetirementAction.BUFFER

    lowered = core.casefold()
    # Require the observed version transition, including both sentences.
    if lowered.startswith(_OPUS_NOTICE):
        return RetirementAction.RETIRED
    if _OPUS_NOTICE.startswith(lowered):
        return RetirementAction.BUFFER
    if len(lowered) < len(_NOTICE_HEAD):
        return (
            RetirementAction.BUFFER
            if _NOTICE_HEAD.startswith(lowered)
            else RetirementAction.PASS
        )
    if not lowered.startswith(_NOTICE_HEAD):
        return RetirementAction.PASS

    rest = core[len(_NOTICE_HEAD) :]
    tail_lowered = _NOTICE_TAIL.casefold()
    # Try every possible name boundary.  Spaces are legal model-name
    # characters, so a greedy single split would misclassify partial tails.
    for boundary in range(1, min(len(rest), MAX_MODEL_NAME_CHARS) + 1):
        name = rest[:boundary]
        if not all(char in _ALLOWED_NAME_CHARS for char in name):
            continue
        suffix = rest[boundary:].casefold()
        if _name_is_valid(name) and suffix.startswith(tail_lowered):
            return RetirementAction.RETIRED
        if not tail_lowered.startswith(suffix):
            continue
        if len(suffix) == len(tail_lowered):
            if _name_is_valid(name):
                return RetirementAction.RETIRED
            continue
        if _name_is_valid(name) or not suffix:
            return RetirementAction.BUFFER

    # With no suffix yet, a valid character sequence can still become the
    # model name.  It remains undecided until the name limit or an invalid
    # character proves that it cannot be the known notice.
    if len(rest) <= MAX_MODEL_NAME_CHARS and all(
        char in _ALLOWED_NAME_CHARS for char in rest
    ):
        if any(char.strip() for char in rest):
            return RetirementAction.BUFFER
        return RetirementAction.BUFFER

    # A complete valid tail followed by arbitrary text was handled above.
    # Anything else is definitively ordinary displayed content.
    return RetirementAction.PASS


def _event_size_bytes(event: Any) -> int:
    if isinstance(event, bytes):
        return len(event)
    if isinstance(event, str):
        return len(event.encode("utf-8"))
    mapping = _as_mapping(event)
    if mapping is not None:
        try:
            encoded = json.dumps(mapping, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            return len(encoded)
        except (TypeError, ValueError):
            pass
    try:
        return len(json.dumps(event, ensure_ascii=False, default=str).encode("utf-8"))
    except (TypeError, ValueError):
        return len(str(event).encode("utf-8", errors="replace"))


def _finish_indices(payload: Any) -> set[int]:
    indices: set[int] = set()
    candidates = _candidate_list(payload)
    for position, candidate in enumerate(candidates):
        candidate_map = _as_mapping(candidate)
        if candidate_map is None or not candidate_map.get("finishReason"):
            continue
        raw_index = candidate_map.get("index", position)
        indices.add(raw_index if isinstance(raw_index, int) and not isinstance(raw_index, bool) else position)
    mapping = _as_mapping(payload)
    if mapping is not None and mapping.get("finishReason"):
        indices.update(range(len(candidates)))
    return indices


@dataclass
class _CandidateState:
    # None means that this candidate has not produced its first displayed text
    # yet.  Thought/usage/metadata events must pass while it remains None.
    status: Optional[RetirementAction] = None
    prefix: str = ""
    finished: bool = False


class RetirementStream:
    """Per-upstream-attempt, per-candidate retirement-prefix state machine."""

    def __init__(self, *, max_buffered_event_bytes: int = MAX_BUFFERED_EVENT_BYTES) -> None:
        if max_buffered_event_bytes < 0:
            raise ValueError("max_buffered_event_bytes must be non-negative")
        self.max_buffered_event_bytes = max_buffered_event_bytes
        self._states: dict[int, _CandidateState] = {}
        self._buffered_events: list[Any] = []
        self._buffered_bytes = 0
        self._terminal: Optional[RetirementResult] = None
        self._complete = False

    @classmethod
    def new_attempt(cls, **kwargs: Any) -> "RetirementStream":
        """Explicit factory emphasizing that state must not cross attempts."""

        return cls(**kwargs)

    def _state_for(self, candidate: Any, position: int) -> _CandidateState:
        candidate_map = _as_mapping(candidate)
        raw_index = candidate_map.get("index", position) if candidate_map else position
        index = raw_index if isinstance(raw_index, int) and not isinstance(raw_index, bool) else position
        return self._states.setdefault(index, _CandidateState())

    def _pending_indices(self) -> set[int]:
        return {index for index, state in self._states.items() if state.status is RetirementAction.BUFFER}

    def _release_buffer(self, current: Any = None, *, complete: bool = False) -> RetirementResult:
        released = tuple(self._buffered_events)
        self._buffered_events.clear()
        self._buffered_bytes = 0
        if current is not None:
            released += (current,)
        if complete:
            self._complete = True
        return _pass(*released)

    def _mark_candidates(self, payload: Any) -> Optional[RetirementResult]:
        for position, candidate in enumerate(_candidate_list(payload)):
            state = self._state_for(candidate, position)
            observation = _observe_candidate(candidate)
            if state.status is RetirementAction.PASS:
                continue
            if observation.non_text_before_display:
                state.status = RetirementAction.PASS
                continue
            if not observation.display_text:
                continue
            state.prefix = (state.prefix + observation.display_text)[:MAX_DISPLAY_PREFIX_CHARS]
            state.status = RetirementAction.BUFFER
            classification = _classify_display_prefix(state.prefix)
            if classification is RetirementAction.RETIRED:
                self._buffered_events.clear()
                self._buffered_bytes = 0
                self._terminal = _retired()
                return self._terminal
            if classification is RetirementAction.PASS:
                state.status = RetirementAction.PASS
        return None

    def feed(self, event: Any, *, finish: bool = False) -> RetirementResult:
        """Process one parsed event, returning only events safe to release.

        Events with an undecided first displayed-text prefix return ``BUFFER``
        and are withheld.  A ``finishReason`` on all pending candidates (or an
        explicit ``finish=True``) flushes an incomplete prefix as ordinary
        content; a confirmed notice always wins and returns 404.
        """

        if self._terminal is not None:
            return self._terminal
        if self._complete:
            return _pass()

        if is_opus_retirement_error(event):
            self._buffered_events.clear()
            self._buffered_bytes = 0
            self._terminal = _retired()
            return self._terminal

        finish_indices = _finish_indices(event)
        for index in finish_indices:
            self._states.setdefault(index, _CandidateState()).finished = True

        terminal = self._mark_candidates(event)
        if terminal is not None:
            return terminal

        pending = self._pending_indices()
        should_finish = finish or bool(pending and pending.issubset(
            {index for index, state in self._states.items() if state.finished}
        ))
        if not pending:
            return self._release_buffer(event)
        if should_finish:
            # The current event need not be retained to wait for another event;
            # releasing it with the already queued prefix preserves order and
            # avoids charging a terminal metadata event against the queue cap.
            return self._release_buffer(event, complete=True)

        event_bytes = _event_size_bytes(event)
        if self._buffered_bytes + event_bytes > self.max_buffered_event_bytes:
            self._buffered_events.clear()
            self._buffered_bytes = 0
            self._terminal = _overflow()
            return self._terminal
        self._buffered_events.append(event)
        self._buffered_bytes += event_bytes
        return _buffer()

    def finish(self) -> RetirementResult:
        """Flush EOF: incomplete prefixes are ordinary content, not errors."""

        if self._terminal is not None:
            return self._terminal
        if self._complete:
            return _pass()
        return self._release_buffer(complete=True)

    def reset(self) -> None:
        """Reset this object for an explicit new attempt."""

        self._states.clear()
        self._buffered_events.clear()
        self._buffered_bytes = 0
        self._terminal = None
        self._complete = False


ModelRetirementStream = RetirementStream


def inspect_non_stream(payload: Any) -> RetirementResult:
    """Inspect a complete response before conversion/rendering."""

    if is_opus_retirement_error(payload):
        return _retired()
    for candidate in _candidate_list(payload):
        observation = _observe_candidate(candidate)
        if observation.non_text_before_display or not observation.display_text:
            continue
        if _classify_display_prefix(observation.display_text[:MAX_DISPLAY_PREFIX_CHARS]) is RetirementAction.RETIRED:
            return _retired()
    return _pass(payload)


def is_opus_retirement_error(payload: Any) -> bool:
    """Recognize the exact notice only in an explicit error envelope.

    Some upstreams send this with HTTP 200 and no numeric error code. Arbitrary
    JSON fields and quoted messages must not be classified as retirement.
    """
    seen = set()
    while (mapping := _as_mapping(payload)) is not None and id(payload) not in seen:
        seen.add(id(payload))
        error = mapping.get("error")
        if error is not None:
            error_map = _as_mapping(error)
            message = error_map.get("message") if error_map is not None else error
            return isinstance(message, str) and message.strip().casefold() == _OPUS_NOTICE
        payload = mapping.get("response")
    return False


def check_non_stream(payload: Any) -> RetirementResult:
    """Descriptive alias for ``inspect_non_stream``."""

    return inspect_non_stream(payload)


def is_model_retirement_notice(payload: Any) -> bool:
    """Return only the safe boolean result; never return the matched text."""

    return inspect_non_stream(payload).action is RetirementAction.RETIRED


def new_attempt(**kwargs: Any) -> RetirementStream:
    """Create a fresh stream checker for one upstream attempt."""

    return RetirementStream.new_attempt(**kwargs)


__all__ = [
    "BUFFER_OVERFLOW_STATUS_CODE",
    "MAX_BUFFERED_EVENT_BYTES",
    "MAX_DISPLAY_PREFIX_CHARS",
    "MAX_LEADING_WHITESPACE",
    "MAX_MODEL_NAME_CHARS",
    "ModelRetirementStream",
    "RETIREMENT_STATUS_CODE",
    "RetirementAction",
    "RetirementResult",
    "RetirementStream",
    "check_non_stream",
    "inspect_non_stream",
    "is_model_retirement_notice",
    "new_attempt",
]
