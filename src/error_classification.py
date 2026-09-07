"""Helpers for classifying and filtering persisted upstream errors."""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from typing import Any


HTTP_403_TOS_VIOLATION = "tos_violation"
HTTP_403_SUBSCRIPTION_REQUIRED = "subscription_required"
HTTP_403_OTHER = "other"

HTTP_403_FILTERS = {
    "403_tos_violation": HTTP_403_TOS_VIOLATION,
    "403_subscription_required": HTTP_403_SUBSCRIPTION_REQUIRED,
    "403_other": HTTP_403_OTHER,
}

ErrorMessageLoader = Callable[[list[str]], Awaitable[dict[str, Any]]]


def safe_json_list(value: Any) -> list[Any]:
    """Decode a JSON list without allowing one corrupt row to fail a listing."""
    if isinstance(value, list):
        return value
    if isinstance(value, bytes):
        try:
            value = value.decode("utf-8")
        except UnicodeDecodeError:
            return []
    if isinstance(value, str):
        try:
            decoded = json.loads(value)
        except (TypeError, ValueError):
            return []
        return decoded if isinstance(decoded, list) else []
    return []


def safe_json_object(value: Any) -> dict[Any, Any]:
    """Decode a JSON object, returning an empty object for malformed values."""
    if isinstance(value, dict):
        return value
    if isinstance(value, bytes):
        try:
            value = value.decode("utf-8")
        except UnicodeDecodeError:
            return {}
    if isinstance(value, str):
        try:
            decoded = json.loads(value)
        except (TypeError, ValueError):
            return {}
        return decoded if isinstance(decoded, dict) else {}
    return {}


def _iter_error_codes(error_codes: Any) -> list[Any]:
    if isinstance(error_codes, (tuple, set)):
        return list(error_codes)
    return safe_json_list(error_codes)


def has_error_code(error_codes: Any, expected: int) -> bool:
    """Match numeric error codes while tolerating legacy string values."""
    for code in _iter_error_codes(error_codes):
        if isinstance(code, bool):
            continue
        if code == expected or code == str(expected):
            return True
    return False


def classify_http_403(error_message: Any) -> str:
    """Classify a 403 response body using structured Google ErrorInfo reasons."""
    payload = error_message
    if isinstance(payload, bytes):
        try:
            payload = payload.decode("utf-8")
        except UnicodeDecodeError:
            return HTTP_403_OTHER

    payload = safe_json_object(payload)
    if not payload:
        return HTTP_403_OTHER

    error = payload.get("error")
    if not isinstance(error, dict):
        return HTTP_403_OTHER
    details = error.get("details")
    if not isinstance(details, list):
        return HTTP_403_OTHER

    reasons = {
        detail.get("reason")
        for detail in details
        if isinstance(detail, dict) and isinstance(detail.get("reason"), str)
    }
    if "TOS_VIOLATION" in reasons:
        return HTTP_403_TOS_VIOLATION
    if "SUBSCRIPTION_REQUIRED" in reasons:
        return HTTP_403_SUBSCRIPTION_REQUIRED
    return HTTP_403_OTHER


def get_error_classifications(
    error_codes: Any, error_messages: Any
) -> dict[str, str]:
    """Return panel-safe classifications without exposing stored error bodies."""
    if not has_error_code(error_codes, 403):
        return {}

    message = None
    error_messages = safe_json_object(error_messages)
    if error_messages:
        message = error_messages.get("403")
        if message is None:
            message = error_messages.get(403)
    return {"403": classify_http_403(message)}


def is_http_403_classification_filter(error_code_filter: Any) -> bool:
    normalized_filter = str(error_code_filter or "all").strip().lower()
    return normalized_filter in HTTP_403_FILTERS


def matches_http_403_classification(
    classifications: dict[str, str], error_code_filter: Any
) -> bool:
    normalized_filter = str(error_code_filter or "all").strip().lower()
    expected = HTTP_403_FILTERS.get(normalized_filter)
    return expected is not None and classifications.get("403") == expected


def matches_error_code_filter(
    error_codes: Any, error_messages: Any, error_code_filter: Any
) -> bool:
    """Apply numeric, empty, and classified 403 filters consistently."""
    normalized_filter = str(error_code_filter or "all").strip().lower()
    codes = _iter_error_codes(error_codes)

    if normalized_filter == "all":
        return True
    if normalized_filter == "none":
        return not codes

    expected_classification = HTTP_403_FILTERS.get(normalized_filter)
    if expected_classification is not None:
        classifications = get_error_classifications(codes, error_messages)
        return classifications.get("403") == expected_classification

    try:
        expected_code = int(normalized_filter)
    except ValueError:
        return any(code == normalized_filter for code in codes)
    return has_error_code(codes, expected_code)


async def paginate_and_classify_summaries(
    summaries: list[dict[str, Any]],
    *,
    offset: int,
    limit: int | None,
    error_code_filter: Any,
    include_error_classifications: bool,
    load_error_messages: ErrorMessageLoader,
) -> tuple[list[dict[str, Any]], int]:
    """Classify only 403 candidates, and only before paging when filtering needs it."""
    if is_http_403_classification_filter(error_code_filter):
        candidates = [
            summary
            for summary in summaries
            if has_error_code(summary.get("error_codes"), 403)
        ]
        if candidates:
            messages_by_filename = await load_error_messages(
                [str(summary.get("filename", "")) for summary in candidates]
            )
        else:
            messages_by_filename = {}
        classified: list[dict[str, Any]] = []
        for summary in candidates:
            filename = str(summary.get("filename", ""))
            classifications = get_error_classifications(
                summary.get("error_codes"), messages_by_filename.get(filename, {})
            )
            if not matches_http_403_classification(
                classifications, error_code_filter
            ):
                continue
            if include_error_classifications:
                summary["error_classifications"] = classifications
            classified.append(summary)
        summaries = classified

    total_count = len(summaries)
    selected = (
        summaries[offset : offset + limit]
        if limit is not None
        else summaries[offset:]
    )

    if (
        include_error_classifications
        and not is_http_403_classification_filter(error_code_filter)
    ):
        page_403 = [
            summary
            for summary in selected
            if has_error_code(summary.get("error_codes"), 403)
        ]
        if page_403:
            messages_by_filename = await load_error_messages(
                [str(summary.get("filename", "")) for summary in page_403]
            )
        else:
            messages_by_filename = {}
        for summary in page_403:
            filename = str(summary.get("filename", ""))
            summary["error_classifications"] = get_error_classifications(
                summary.get("error_codes"), messages_by_filename.get(filename, {})
            )

    return selected, total_count
