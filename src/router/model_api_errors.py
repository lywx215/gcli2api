"""Fixed, protocol-specific errors for the protected model API routes.

This module deliberately has no application-registration side effects.  The
route class and streaming adapter are opt-in so management, panel, Vertex,
and legacy routes keep their existing exception handling until an integration
task explicitly enables them.
"""

from __future__ import annotations

import asyncio
import json
import logging
import httpx
from functools import wraps
from dataclasses import dataclass
from enum import Enum
from typing import Any, Awaitable, Callable, ClassVar, Optional

from fastapi import Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.exceptions import HTTPException as StarletteHTTPException


_log = logging.getLogger(__name__)


class ErrorOrigin(str, Enum):
    """The trusted source classification used for internal error handling.

    ``CLIENT`` is reserved for a locally verified client authentication or
    authorization failure. ``UPSTREAM`` also represents an untrusted or
    otherwise unknown source. ``LOCAL`` is for local processing failures.
    """

    CLIENT = "client"
    UPSTREAM = "upstream"
    LOCAL = "local"


class ErrorKind(str, Enum):
    """Internal error category; none of these values are sent to clients."""

    HTTP = "http"
    TIMEOUT = "timeout"
    BAD_FORMAT = "bad_format"
    LOCAL = "local"


class ModelApiProtocol(str, Enum):
    OPENAI = "openai"
    CLAUDE = "claude"
    GEMINI = "gemini"


class ErrorMessageId(str, Enum):
    INVALID_REQUEST = "INVALID_REQUEST"
    AUTHENTICATION_FAILED = "AUTHENTICATION_FAILED"
    ACCESS_DENIED = "ACCESS_DENIED"
    SERVICE_ACCESS_ERROR = "SERVICE_ACCESS_ERROR"
    PAYMENT_REQUIRED = "PAYMENT_REQUIRED"
    RESOURCE_UNAVAILABLE = "RESOURCE_UNAVAILABLE"
    REQUEST_TIMEOUT = "REQUEST_TIMEOUT"
    REQUEST_TOO_LARGE = "REQUEST_TOO_LARGE"
    REQUEST_LIMIT_REACHED = "REQUEST_LIMIT_REACHED"
    INVALID_SERVICE_RESPONSE = "INVALID_SERVICE_RESPONSE"
    SERVICE_UNAVAILABLE = "SERVICE_UNAVAILABLE"
    REQUEST_REJECTED = "REQUEST_REJECTED"
    INTERNAL_ERROR = "INTERNAL_ERROR"


FIXED_ERROR_MESSAGES: dict[ErrorMessageId, str] = {
    ErrorMessageId.INVALID_REQUEST: "Invalid request. Check the request parameters and try again.",
    ErrorMessageId.AUTHENTICATION_FAILED: "Authentication failed. Provide a valid API key.",
    ErrorMessageId.ACCESS_DENIED: "Access denied. You do not have permission to perform this request.",
    ErrorMessageId.SERVICE_ACCESS_ERROR: (
        "The service could not process the request. Please contact the service administrator."
    ),
    ErrorMessageId.PAYMENT_REQUIRED: (
        "The request cannot be completed due to a payment requirement. "
        "Please contact the service administrator."
    ),
    ErrorMessageId.RESOURCE_UNAVAILABLE: "The requested resource is unavailable.",
    ErrorMessageId.REQUEST_TIMEOUT: "The request timed out. Please try again later.",
    ErrorMessageId.REQUEST_TOO_LARGE: "The request is too large. Reduce its size and try again.",
    ErrorMessageId.REQUEST_LIMIT_REACHED: (
        "The request limit has been reached. Please contact the service administrator "
        "if the issue persists."
    ),
    ErrorMessageId.INVALID_SERVICE_RESPONSE: (
        "The service received an invalid response. Please try again later."
    ),
    ErrorMessageId.SERVICE_UNAVAILABLE: (
        "The service is temporarily unavailable. Please try again later."
    ),
    ErrorMessageId.REQUEST_REJECTED: (
        "The request could not be processed. Check the request and try again."
    ),
    ErrorMessageId.INTERNAL_ERROR: (
        "An internal error occurred while processing the request. Please try again later."
    ),
}


@dataclass(frozen=True, slots=True)
class ModelApiError:
    """Immutable internal error information.

    There is intentionally no message, model, request, response body, or
    exception field.  Raw diagnostics remain in the existing API layer; this
    value is the only information accepted by the public renderer.
    """

    origin: ErrorOrigin
    kind: ErrorKind
    status: int
    retry_after: Optional[int] = None

    def __post_init__(self) -> None:
        if not isinstance(self.origin, ErrorOrigin):
            object.__setattr__(self, "origin", ErrorOrigin(self.origin))
        if not isinstance(self.kind, ErrorKind):
            object.__setattr__(self, "kind", ErrorKind(self.kind))
        if self.kind == ErrorKind.TIMEOUT:
            object.__setattr__(self, "status", 504)
        elif self.kind == ErrorKind.BAD_FORMAT:
            object.__setattr__(self, "status", 502)
        status = self.status
        if isinstance(status, bool) or not isinstance(status, int):
            raise TypeError("status must be an integer")
        if not 400 <= status <= 599:
            raise ValueError("status must be between 400 and 599")
        if self.retry_after is not None:
            if isinstance(self.retry_after, bool) or not isinstance(self.retry_after, int):
                raise TypeError("retry_after must be an integer")
            if self.retry_after < 0:
                raise ValueError("retry_after must be non-negative")


def make_model_api_error(
    *,
    origin: ErrorOrigin,
    kind: ErrorKind = ErrorKind.HTTP,
    status: int = 500,
    retry_after: Optional[int] = None,
) -> ModelApiError:
    """Create the internal error, applying the only two typed status overrides."""

    if kind == ErrorKind.TIMEOUT:
        status = 504
    elif kind == ErrorKind.BAD_FORMAT:
        status = 502
    return ModelApiError(origin=origin, kind=kind, status=status, retry_after=retry_after)


def error_from_http_status(
    status: int,
    *,
    origin: ErrorOrigin = ErrorOrigin.UPSTREAM,
    retry_after: Optional[int] = None,
) -> ModelApiError:
    """Classify a received HTTP status without inspecting its body or headers."""

    if isinstance(status, bool) or not isinstance(status, int) or status < 400 or status > 599:
        return make_model_api_error(
            origin=origin,
            kind=ErrorKind.BAD_FORMAT,
            status=502,
            retry_after=retry_after,
        )
    return make_model_api_error(
        origin=origin,
        kind=ErrorKind.HTTP,
        status=status,
        retry_after=retry_after,
    )


def error_from_model_payload(
    payload: Any,
    *,
    origin: ErrorOrigin = ErrorOrigin.UPSTREAM,
) -> Optional[ModelApiError]:
    """Classify an upstream JSON error envelope, including HTTP-200 errors.

    The payload is inspected only for the presence of an error envelope and a
    numeric HTTP-like code.  Its message and other fields never cross the
    protected route boundary.
    """

    candidate = payload
    seen = set()
    while isinstance(candidate, dict) and id(candidate) not in seen:
        seen.add(id(candidate))
        value = candidate.get("error")
        if value is not None:
            code = value.get("code") if isinstance(value, dict) else None
            if type(code) is int and 400 <= code <= 599:
                return error_from_http_status(code, origin=origin)
            return make_model_api_error(origin=origin, kind=ErrorKind.BAD_FORMAT)
        if "response" not in candidate:
            return None
        candidate = candidate["response"]
    return make_model_api_error(origin=origin, kind=ErrorKind.BAD_FORMAT)


def parse_model_response(body: Any) -> dict:
    """Validate upstream JSON before conversion; never classify converter bugs here."""
    try:
        payload = json.loads(body)
    except (ValueError, TypeError, RecursionError) as exc:
        raise ModelApiErrorException(
            make_model_api_error(origin=ErrorOrigin.UPSTREAM, kind=ErrorKind.BAD_FORMAT)
        ) from exc
    error = error_from_model_payload(payload)
    if error is not None:
        raise ModelApiErrorException(error)
    return payload


_AUTH_WRAPPERS = {}


def protect_authentication(dependency):
    """Opt-in wrapper: only failures raised by the local auth dependency are CLIENT."""
    if dependency in _AUTH_WRAPPERS:
        return _AUTH_WRAPPERS[dependency]
    @wraps(dependency)
    async def protected_auth(*args, **kwargs):
        try:
            return await dependency(*args, **kwargs)
        except StarletteHTTPException as exc:
            if exc.status_code in (401, 403):
                raise ModelApiErrorException(
                    error_from_http_status(exc.status_code, origin=ErrorOrigin.CLIENT)
                ) from exc
            raise
    _AUTH_WRAPPERS[dependency] = protected_auth
    return protected_auth


def error_from_retirement_payload(
    payload: Any,
    *,
    origin: ErrorOrigin = ErrorOrigin.UPSTREAM,
) -> Optional[ModelApiError]:
    """Map the isolated model-retirement recognizer to a typed 404."""

    from src.router.model_retirement import RetirementAction, inspect_non_stream

    result = inspect_non_stream(payload)
    if result.action is RetirementAction.RETIRED:
        return error_from_http_status(404, origin=origin)
    return None


def error_from_exception(exc: BaseException) -> ModelApiError:
    """Map framework exceptions while intentionally discarding their details."""

    if isinstance(exc, ModelApiErrorException):
        return exc.error
    if isinstance(exc, (httpx.TimeoutException, TimeoutError)):
        return make_model_api_error(origin=ErrorOrigin.UPSTREAM, kind=ErrorKind.TIMEOUT)
    if isinstance(exc, UnicodeDecodeError):
        return make_model_api_error(origin=ErrorOrigin.UPSTREAM, kind=ErrorKind.BAD_FORMAT)
    if isinstance(exc, RequestValidationError):
        return make_model_api_error(
            origin=ErrorOrigin.LOCAL,
            kind=ErrorKind.HTTP,
            status=422,
        )
    if isinstance(exc, StarletteHTTPException):
        # An exception string cannot prove that a 401/403 came from local
        # client authentication.  Local auth dependencies should raise the
        # typed ModelApiErrorException below instead.
        return error_from_http_status(exc.status_code, origin=ErrorOrigin.UPSTREAM)
    if isinstance(exc, asyncio.CancelledError) or isinstance(exc, GeneratorExit):
        raise exc
    return make_model_api_error(origin=ErrorOrigin.LOCAL, kind=ErrorKind.LOCAL, status=500)


def _message_id(error: ModelApiError) -> ErrorMessageId:
    status = error.status
    if error.kind == ErrorKind.TIMEOUT or status in (408, 504):
        return ErrorMessageId.REQUEST_TIMEOUT
    if error.kind == ErrorKind.BAD_FORMAT or status == 502:
        return ErrorMessageId.INVALID_SERVICE_RESPONSE
    if status == 400 or status == 422:
        return ErrorMessageId.INVALID_REQUEST
    if status == 401:
        return (
            ErrorMessageId.AUTHENTICATION_FAILED
            if error.origin == ErrorOrigin.CLIENT
            else ErrorMessageId.SERVICE_ACCESS_ERROR
        )
    if status == 403:
        return (
            ErrorMessageId.ACCESS_DENIED
            if error.origin == ErrorOrigin.CLIENT
            else ErrorMessageId.SERVICE_ACCESS_ERROR
        )
    if status == 402:
        return ErrorMessageId.PAYMENT_REQUIRED
    if status == 404:
        return ErrorMessageId.RESOURCE_UNAVAILABLE
    if status == 413:
        return ErrorMessageId.REQUEST_TOO_LARGE
    if status == 429:
        return ErrorMessageId.REQUEST_LIMIT_REACHED
    if status == 503:
        return ErrorMessageId.SERVICE_UNAVAILABLE
    if 400 <= status <= 499:
        return ErrorMessageId.REQUEST_REJECTED
    return ErrorMessageId.INTERNAL_ERROR


def fixed_error_message(error: ModelApiError) -> str:
    """Return the fixed English message for an internal error description."""

    return FIXED_ERROR_MESSAGES[_message_id(error)]


def _openai_type(error: ModelApiError) -> str:
    status = error.status
    if status == 401 and error.origin == ErrorOrigin.CLIENT:
        return "authentication_error"
    if status == 403 and error.origin == ErrorOrigin.CLIENT:
        return "permission_error"
    if status == 404:
        return "not_found_error"
    if status == 429:
        return "rate_limit_error"
    if status == 503:
        return "service_unavailable_error"
    if status in (408, 504):
        return "timeout_error"
    if status == 401 or status == 403 or status == 402 or status >= 500:
        return "server_error"
    if status == 400 or status == 413 or status == 422 or 400 <= status <= 499:
        return "invalid_request_error"
    return "server_error"


def _claude_type(error: ModelApiError) -> str:
    status = error.status
    if status == 401 and error.origin == ErrorOrigin.CLIENT:
        return "authentication_error"
    if status == 403 and error.origin == ErrorOrigin.CLIENT:
        return "permission_error"
    if status == 404:
        return "not_found_error"
    if status == 429:
        return "rate_limit_error"
    if status == 503:
        return "overloaded_error"
    if status == 401 or status == 403 or status == 402 or status in (408, 504) or status >= 500:
        return "api_error"
    if status == 400 or status == 413 or status == 422 or 400 <= status <= 499:
        return "invalid_request_error"
    return "api_error"


def _gemini_status(error: ModelApiError) -> str:
    status = error.status
    if 400 <= status <= 499 and status not in (401, 402, 403, 404, 408, 429):
        return "INVALID_ARGUMENT"
    return {
        400: "INVALID_ARGUMENT",
        401: "UNAUTHENTICATED",
        402: "RESOURCE_EXHAUSTED",
        403: "PERMISSION_DENIED",
        404: "NOT_FOUND",
        408: "DEADLINE_EXCEEDED",
        413: "INVALID_ARGUMENT",
        422: "INVALID_ARGUMENT",
        429: "RESOURCE_EXHAUSTED",
        502: "INTERNAL",
        503: "UNAVAILABLE",
        504: "DEADLINE_EXCEEDED",
    }.get(error.status, "INTERNAL")


def _protocol(value: ModelApiProtocol | str) -> ModelApiProtocol:
    if isinstance(value, ModelApiProtocol):
        return value
    return ModelApiProtocol(value)


def _payload(error: ModelApiError, protocol: ModelApiProtocol) -> dict[str, Any]:
    message = fixed_error_message(error)
    if protocol == ModelApiProtocol.OPENAI:
        return {
            "error": {
                "message": message,
                "type": _openai_type(error),
                "code": error.status,
            }
        }
    if protocol == ModelApiProtocol.CLAUDE:
        return {
            "type": "error",
            "error": {
                "type": _claude_type(error),
                "message": message,
            },
        }
    return {
        "error": {
            "code": error.status,
            "message": message,
            "status": _gemini_status(error),
        }
    }


# This object is private and never serialized into a response header/body.
_RENDER_MARKER = object()
_ATTACHED_MARKER = object()
_RENDERED_ATTR = "_model_api_error_render_marker"
_ATTACHED_MARKER_ATTR = "_model_api_error_attached_marker"
_ERROR_ATTR = "_model_api_error_description"


def is_rendered_model_api_error(response: Response) -> bool:
    """Return whether this exact process rendered the response."""

    return getattr(response, _RENDERED_ATTR, None) is _RENDER_MARKER


def _mark_rendered(response: Response, error: ModelApiError) -> Response:
    setattr(response, _RENDERED_ATTR, _RENDER_MARKER)
    setattr(response, _ERROR_ATTR, error)
    return response


def render_error(error: ModelApiError, protocol: ModelApiProtocol | str) -> JSONResponse:
    """Render a fixed non-streaming error with a local header allow-list."""

    protocol = _protocol(protocol)
    headers: dict[str, str] = {}
    if error.origin == ErrorOrigin.CLIENT and error.status == 401:
        headers["WWW-Authenticate"] = "Bearer"
    if error.origin in (ErrorOrigin.CLIENT, ErrorOrigin.LOCAL) and error.retry_after is not None:
        headers["Retry-After"] = str(error.retry_after)
    response = JSONResponse(
        content=_payload(error, protocol),
        status_code=error.status,
        headers=headers,
    )
    return _mark_rendered(response, error)


def render_error_event(error: ModelApiError, protocol: ModelApiProtocol | str) -> bytes:
    """Render a protocol-complete terminal error event."""

    data = json.dumps(
        _payload(error, _protocol(protocol)),
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    protocol = _protocol(protocol)
    if protocol == ModelApiProtocol.OPENAI:
        return b"data: " + data + b"\n\n" + b"data: [DONE]\n\n"
    if protocol == ModelApiProtocol.CLAUDE:
        return b"event: error\n" + b"data: " + data + b"\n\n"
    return b"data: " + data + b"\n\n"


LogicalRequestRecorder = Callable[[Request, bool], Awaitable[None] | None]


class ModelApiErrorException(Exception):
    """Typed internal terminal error; it carries no string representation."""

    def __init__(self, error: ModelApiError) -> None:
        self.error = error
        super().__init__()


def attach_model_api_error(response: Response, error: ModelApiError) -> Response:
    """Attach a process-private typed error for a later protected-route render."""

    setattr(response, _ERROR_ATTR, error)
    setattr(response, _ATTACHED_MARKER_ATTR, _ATTACHED_MARKER)
    return response


def get_attached_model_api_error(response: Response) -> Optional[ModelApiError]:
    if getattr(response, _ATTACHED_MARKER_ATTR, None) is not _ATTACHED_MARKER:
        return None
    value = getattr(response, _ERROR_ATTR, None)
    return value if isinstance(value, ModelApiError) else None


def local_retry_response(*, retry_after: int, **kwargs) -> Response:
    """Preserve legacy payload/headers with a trusted, process-local cooldown."""
    return attach_model_api_error(
        Response(headers={"Retry-After": str(retry_after)}, **kwargs),
        make_model_api_error(origin=ErrorOrigin.LOCAL, status=503, retry_after=retry_after),
    )


def error_from_response(response: Response) -> ModelApiError:
    """Keep a trusted internal type across every Response-to-exception boundary."""
    return get_attached_model_api_error(response) or error_from_http_status(response.status_code)


def attach_local_unavailable(response: Response) -> Response:
    """Preserve the legacy wire response; protected callers see local 503."""
    return attach_model_api_error(response, make_model_api_error(origin=ErrorOrigin.LOCAL, status=503))


def attach_exception_error(response: Response, exc: BaseException) -> Response:
    """Retain legacy wire output while preserving known upstream failure types."""
    if isinstance(exc, json.JSONDecodeError):
        error = make_model_api_error(origin=ErrorOrigin.UPSTREAM, kind=ErrorKind.BAD_FORMAT)
    elif isinstance(exc, (ModelApiErrorException, httpx.TimeoutException, TimeoutError, UnicodeDecodeError)):
        error = error_from_exception(exc)
    else:
        return response
    return attach_model_api_error(response, error)


def activate_logical_request_recording(
    request: Request,
    recorder: Optional[LogicalRequestRecorder] = None,
) -> None:
    """Opt a successfully authenticated generation request into one completion."""

    request.state.model_api_logical_recording_enabled = True
    if recorder is not None:
        request.state.model_api_logical_recorder = recorder


async def record_logical_request_once(
    request: Request,
    success: bool,
    *,
    recorder: Optional[LogicalRequestRecorder] = None,
) -> None:
    """Invoke the shared completion callback once, isolating recorder failures."""

    state = request.state
    if not getattr(state, "model_api_logical_recording_enabled", False):
        return
    if getattr(state, "_model_api_logical_recorded", False):
        return
    callback = recorder or getattr(state, "model_api_logical_recorder", None)
    state._model_api_logical_recorded = True
    if callback is None:
        return
    try:
        result = callback(request, success)
        if result is not None:
            await result
    except (asyncio.CancelledError, GeneratorExit):
        raise
    except Exception:
        _log.exception("model API logical request recorder failed")


async def _close_response_resources(response: Response) -> None:
    iterator = getattr(response, "body_iterator", None)
    close = getattr(iterator, "aclose", None)
    if close is not None:
        try:
            await close()
        except (asyncio.CancelledError, GeneratorExit):
            raise
        except Exception:
            _log.exception("model API response iterator close failed")
    background = getattr(response, "background", None)
    if background is not None:
        try:
            await background()
        except (asyncio.CancelledError, GeneratorExit):
            raise
        except Exception:
            _log.exception("model API response background task failed")


async def protect_streaming_response(
    response: StreamingResponse,
    protocol: ModelApiProtocol | str,
    *,
    request: Optional[Request] = None,
    recorder: Optional[LogicalRequestRecorder] = None,
) -> StreamingResponse:
    """Attach the explicit post-header stream boundary adapter.

    ``Exception`` is converted to one fixed protocol SSE event.  Cancellation
    and ``GeneratorExit`` intentionally propagate, and the finally block only
    closes the upstream iterator.  The function is async solely to make its
    use explicit at integration call sites; it does not consume the stream.
    """

    if getattr(response, "_model_api_stream_protected", False):
        return response
    original_iterator = response.body_iterator
    setattr(response, "_model_api_stream_protected", True)

    async def finish(success: bool) -> None:
        if request is not None:
            await record_logical_request_once(request, success, recorder=recorder)

    async def adapted() -> Any:
        try:
            async for chunk in original_iterator:
                if isinstance(chunk, Response) and not 200 <= chunk.status_code < 300:
                    error = get_attached_model_api_error(chunk) or error_from_http_status(
                        chunk.status_code,
                        origin=ErrorOrigin.UPSTREAM,
                    )
                    await finish(False)
                    yield render_error_event(error, protocol)
                    return
                yield chunk
            await finish(True)
        except Exception as exc:
            _log.exception("model API streaming iterator failed")
            error = error_from_exception(exc)
            await finish(False)
            yield render_error_event(error, protocol)
        finally:
            close = getattr(original_iterator, "aclose", None)
            if close is not None:
                try:
                    await close()
                except (asyncio.CancelledError, GeneratorExit):
                    raise
                except Exception:
                    _log.exception("model API streaming iterator close failed")

    response.body_iterator = adapted()
    return response


def make_protected_model_api_route_class(
    protocol: ModelApiProtocol | str,
    *,
    recorder: Optional[LogicalRequestRecorder] = None,
) -> type["ProtectedModelApiRoute"]:
    """Bind protocol/callback values for use as ``APIRouter(route_class=...)``."""

    class BoundProtectedModelApiRoute(ProtectedModelApiRoute):
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            super().__init__(*args, protocol=protocol, logical_request_recorder=recorder, **kwargs)

    return BoundProtectedModelApiRoute


class ProtectedModelApiRoute(APIRoute):
    """Opt-in APIRoute that protects pre-stream model API failures."""

    _protocol: ClassVar[ModelApiProtocol | str | None] = None
    _logical_request_recorder: ClassVar[Optional[LogicalRequestRecorder]] = None

    def __init__(
        self,
        *args: Any,
        protocol: ModelApiProtocol | str | None = None,
        logical_request_recorder: Optional[LogicalRequestRecorder] = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(*args, **kwargs)
        if protocol is not None:
            self._protocol = _protocol(protocol)
        if logical_request_recorder is not None:
            self._logical_request_recorder = logical_request_recorder

    def get_route_handler(self) -> Callable[[Request], Awaitable[Response]]:
        original = super().get_route_handler()

        async def protected(request: Request) -> Response:
            # Counting is opt-in below; token helpers still need sanitization.
            try:
                response = await original(request)
            except (asyncio.CancelledError, GeneratorExit):
                raise
            except ModelApiErrorException as exc:
                error = exc.error
                response = render_error(error, self._require_protocol())
            except (RequestValidationError, StarletteHTTPException) as exc:
                error = error_from_exception(exc)
                response = render_error(error, self._require_protocol())
            except Exception as exc:
                _log.exception("model API protected route failed")
                error = error_from_exception(exc)
                response = render_error(error, self._require_protocol())

            if not isinstance(response, Response):
                error = make_model_api_error(
                    origin=ErrorOrigin.LOCAL,
                    kind=ErrorKind.LOCAL,
                    status=500,
                )
                response = render_error(error, self._require_protocol())
            elif response.status_code < 200 or response.status_code >= 300:
                if not is_rendered_model_api_error(response):
                    error = get_attached_model_api_error(response)
                    if error is None:
                        error = error_from_http_status(
                            response.status_code,
                            origin=ErrorOrigin.UPSTREAM,
                        )
                    await _close_response_resources(response)
                    response = render_error(error, self._require_protocol())

            recorder = getattr(request.state, "model_api_logical_recorder", None)
            if recorder is None and getattr(
                request.state, "model_api_logical_recording_enabled", False
            ):
                recorder = self._logical_request_recorder
            if isinstance(response, StreamingResponse) and 200 <= response.status_code < 300:
                return await protect_streaming_response(
                    response,
                    self._require_protocol(),
                    request=request,
                    recorder=recorder,
                )
            if recorder is not None:
                await record_logical_request_once(
                    request,
                    200 <= response.status_code < 300,
                    recorder=recorder,
                )
            return response

        return protected

    def _require_protocol(self) -> ModelApiProtocol:
        if self._protocol is None:
            raise RuntimeError("ProtectedModelApiRoute requires a model API protocol")
        return _protocol(self._protocol)
