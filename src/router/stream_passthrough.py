import asyncio
from typing import Any, AsyncIterator

from fastapi import Response
from fastapi.responses import StreamingResponse

from src.streaming_latency import (
    StreamFailure,
    StreamLatencyConfig,
    StreamPhase,
    StreamRequestTrace,
    bind_stream_trace,
    current_stream_trace,
    reset_stream_trace,
)
from src.public_errors import render_public_error, render_public_sse_error


def client_request_id_from_headers(headers: Any) -> str | None:
    """Read an optional downstream correlation ID without trusting it as our ID."""
    if headers is None:
        return None
    value = headers.get("x-client-request-id") or headers.get("x-request-id")
    return value if isinstance(value, str) else None


async def prepend_async_item(first_item: Any, iterator: AsyncIterator[Any]):
    """Yield a prefetched item before continuing the original iterator."""
    yield first_item
    async for item in iterator:
        yield item


async def read_first_async_item(iterator: AsyncIterator[Any]) -> Any:
    """Python 3.9-compatible async equivalent of built-in anext()."""
    return await iterator.__anext__()


async def close_async_iterator(iterator: AsyncIterator[Any]) -> None:
    close = getattr(iterator, "aclose", None)
    if close is not None:
        try:
            await close()
        except Exception:
            # Closing is best-effort and must not replace the original failure.
            pass


async def build_streaming_response_or_error(
    iterator: AsyncIterator[Any],
    media_type: str = "text/event-stream",
    *,
    model: str = "",
    protocol: str = "gemini",
    client_request_id: str | None = None,
):
    """
    Prefetch the first async item so router code can return an upstream error
    response directly before FastAPI commits a 200 streaming response.
    """
    trace = current_stream_trace() or StreamRequestTrace(model=model, protocol=protocol)
    trace.model = trace.model or model
    trace.protocol = protocol
    trace.set_client_request_id(client_request_id)
    token = bind_stream_trace(trace)
    config = StreamLatencyConfig.from_env()
    try:
        if config.guard_enabled:
            remaining = trace.remaining_first_content()
            if remaining <= 0:
                raise TimeoutError
            async with asyncio.timeout(remaining):
                first_item = await read_first_async_item(iterator)
        else:
            first_item = await read_first_async_item(iterator)
    except StopAsyncIteration:
        trace.finish("empty_stream", force_log=True)
        return Response(status_code=204, headers={"X-Request-ID": trace.request_id})
    except asyncio.CancelledError:
        await close_async_iterator(iterator)
        trace.record_cancellation()
        trace.finish("client_cancelled", force_log=True)
        raise
    except StreamFailure as exc:
        await close_async_iterator(iterator)
        exc.request_id = exc.request_id or trace.request_id
        trace.retry_reason = exc.stage
        if not trace.last_failure or trace.last_failure.get("stage") != exc.stage:
            trace.record_failure(
                stage=exc.stage,
                error_type=exc.error_type or type(exc).__name__,
                status_code=exc.status_code,
                retryable=exc.retryable,
            )
        trace.finish(f"error_{exc.stage}", force_log=True)
        return render_public_error(
            exc, protocol=protocol, request_id=trace.request_id
        )
    except TimeoutError:
        await close_async_iterator(iterator)
        failure = StreamFailure(
            "Upstream did not produce valid content before the deadline",
            stage="first_content",
            status_code=504,
            retryable=False,
            request_id=trace.request_id,
        )
        trace.retry_reason = failure.stage
        trace.record_failure(
            stage=failure.stage,
            error_type="TimeoutError",
            status_code=504,
            retryable=False,
        )
        trace.finish("error_first_content", force_log=True)
        return render_public_error(
            failure, protocol=protocol, request_id=trace.request_id
        )
    except Exception as exc:
        await close_async_iterator(iterator)
        failure = StreamFailure(
            "Stream preparation failed",
            stage="preparing",
            status_code=502,
            retryable=False,
            request_id=trace.request_id,
        )
        trace.retry_reason = f"preparing:{type(exc).__name__}"
        trace.record_failure(
            stage="preparing",
            error_type=type(exc).__name__,
            status_code=502,
            retryable=False,
        )
        trace.finish("error_preparing", force_log=True)
        return render_public_error(
            failure, protocol=protocol, request_id=trace.request_id
        )
    finally:
        reset_stream_trace(token)

    if isinstance(first_item, Response):
        await close_async_iterator(iterator)
        trace.finish(f"http_{first_item.status_code}", force_log=first_item.status_code >= 400)
        failure = StreamFailure.from_response(
            first_item,
            stage="upstream_status",
            request_id=trace.request_id,
        )
        return render_public_error(
            failure, protocol=protocol, request_id=trace.request_id
        )

    trace.mark("first_content", phase=StreamPhase.CONTENT_EMITTED)
    trace.duration_since_mark("conversion", "first_upstream_at")

    async def _terminal_error(failure: StreamFailure) -> AsyncIterator[bytes]:
        for item in render_public_sse_error(
            failure, protocol=protocol, request_id=failure.request_id or trace.request_id
        ):
            yield item

    async def _guarded_stream() -> AsyncIterator[Any]:
        stream_token = bind_stream_trace(trace)
        result = "success"
        try:
            trace.record_output(first_item)
            yield first_item
            async for item in iterator:
                trace.record_output(item)
                yield item
        except asyncio.CancelledError:
            result = "client_cancelled"
            trace.record_cancellation()
            raise
        except StreamFailure as exc:
            result = f"error_{exc.stage}"
            trace.retry_reason = exc.stage
            if not trace.last_failure or trace.last_failure.get("stage") != exc.stage:
                trace.record_failure(
                    stage=exc.stage,
                    error_type=exc.error_type or type(exc).__name__,
                    status_code=exc.status_code,
                    retryable=False,
                )
            async for error_item in _terminal_error(exc):
                trace.record_output(error_item)
                yield error_item
        except Exception as exc:
            result = "error_streaming"
            trace.retry_reason = f"streaming:{type(exc).__name__}"
            trace.record_failure(
                stage="streaming",
                error_type=type(exc).__name__,
                status_code=502,
                retryable=False,
            )
            failure = StreamFailure(
                "Upstream stream was interrupted",
                stage="streaming",
                status_code=502,
                request_id=trace.request_id,
            )
            async for error_item in _terminal_error(failure):
                trace.record_output(error_item)
                yield error_item
        finally:
            trace.finish(result, force_log=result != "success")
            reset_stream_trace(stream_token)

    response_headers = {"X-Request-ID": trace.request_id}
    if trace.diagnostics_enabled:
        response_headers["Server-Timing"] = ", ".join(
            f"{name};dur={value}"
            for name, value in trace.timings_ms.items()
            if name
            in {
                "credential",
                "oauth_refresh",
                "response_headers",
                "response_headers_total",
                "pool_wait_estimate",
                "connect",
                "tls",
                "write",
                "response_header_wait",
                "first_upstream_event",
                "conversion",
                "first_content",
                "hedge",
            }
        )

    return StreamingResponse(
        _guarded_stream(),
        media_type=media_type,
        headers=response_headers,
    )
