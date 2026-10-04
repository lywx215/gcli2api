import asyncio
import json
from typing import Any, AsyncIterator, Optional

from fastapi import Response
from fastapi.responses import StreamingResponse

from src.logical_request_stats import (
    record_logical_request,
    stream_item_has_body,
    stream_item_is_error,
)
from src.router.model_api_errors import (
    ErrorKind,
    ErrorOrigin,
    ModelApiProtocol,
    make_model_api_error,
    render_error,
    render_error_event,
)


async def prepend_async_item(first_item: Any, iterator: AsyncIterator[Any]):
    """Yield a prefetched item before continuing the original iterator."""
    try:
        yield first_item
        async for item in iterator:
            yield item
    finally:
        close = getattr(iterator, 'aclose', None)
        if close is not None:
            try:
                await close()
            except Exception:
                pass  # Cleanup must not replace a delivered response/error.


async def read_first_async_item(iterator: AsyncIterator[Any]) -> Any:
    """Python 3.9-compatible async equivalent of built-in anext()."""
    return await iterator.__anext__()


def _protected_item_state(item):
    """Inspect explicit error envelopes, never phrases in ordinary model text."""
    if isinstance(item, Response):
        return False, not 200 <= item.status_code < 300
    text = item.decode("utf-8") if isinstance(item, bytes) else str(item)
    saw_data = False
    for line in text.splitlines():
        if not line.startswith("data:") or line[5:].strip() == "[DONE]":
            continue
        payload = json.loads(line[5:].strip())
        saw_data = True
        if isinstance(payload, dict) and payload.get("error") is not None:
            return True, True
    return saw_data, False


async def build_streaming_response_or_error(
    iterator: AsyncIterator[Any],
    media_type: str = "text/event-stream",
    *,
    model_name: Optional[str] = None,
    mode: Optional[str] = None,
    protected: bool = False,
    protocol: Optional[ModelApiProtocol | str] = None,
    non_stream: bool = False,
):
    """
    Prefetch the first async item so router code can return an upstream error
    response directly before FastAPI commits a 200 streaming response.
    """
    if mode == "antigravity":
        return await _antigravity_response(iterator, media_type, model_name, protocol, non_stream, protected)
    should_count = bool(model_name and mode)
    try:
        first_item = await read_first_async_item(iterator)
    except StopAsyncIteration:
        if should_count:
            await record_logical_request(model_name, mode, False)
        if protected and protocol is not None:
            return render_error(
                make_model_api_error(
                    origin=ErrorOrigin.UPSTREAM,
                    kind=ErrorKind.BAD_FORMAT,
                    status=502,
                ),
                protocol,
            )
        return Response(status_code=204)
    except (asyncio.CancelledError, GeneratorExit):
        raise
    except BaseException:
        if should_count:
            await record_logical_request(model_name, mode, False)
        raise

    if isinstance(first_item, Response):
        close = getattr(iterator, "aclose", None)
        if close is not None:
            await close()
        if should_count:
            await record_logical_request(model_name, mode, False)
        return first_item

    if not should_count:
        return StreamingResponse(
            prepend_async_item(first_item, iterator),
            media_type=media_type,
        )

    outcome_recorded = False
    source = prepend_async_item(first_item, iterator)
    source_started = False
    source_closed = False

    async def close_source():
        nonlocal source_closed
        if source_closed:
            return
        source_closed = True
        target = source if source_started else iterator
        close = getattr(target, "aclose", None)
        if close is not None:
            await close()

    async def count_once(success):
        nonlocal outcome_recorded
        if not outcome_recorded:
            outcome_recorded = True
            await record_logical_request(model_name, mode, success)

    async def tracked_iterator():
        nonlocal source_started
        has_body = False
        saw_data_event = False
        terminal_error = False
        completed = False
        try:
            source_started = True
            async for item in source:
                if protected:
                    item_has_data, item_is_error = _protected_item_state(item)
                    terminal_error = terminal_error or item_is_error
                    has_body = has_body or item_has_data
                else:
                    terminal_error = terminal_error or stream_item_is_error(item)
                    has_body = has_body or stream_item_has_body(item)
                if isinstance(item, (str, bytes)):
                    text = item.decode("utf-8", errors="replace") if isinstance(item, bytes) else item
                    saw_data_event = saw_data_event or any(
                        line.startswith("data:") and line[5:].strip() != "[DONE]"
                        for line in text.splitlines()
                    )
                yield item
            completed = True
            if not saw_data_event and protected and protocol is not None:
                terminal_error = True
                completed = False
                yield render_error_event(
                    make_model_api_error(
                        origin=ErrorOrigin.UPSTREAM,
                        kind=ErrorKind.BAD_FORMAT,
                        status=502,
                    ),
                    protocol,
                )
        except (asyncio.CancelledError, GeneratorExit):
            # A disconnected client has no final outcome, so it is not counted.
            raise
        except BaseException:
            terminal_error = True
            raise
        finally:
            await close_source()
            if completed or terminal_error:
                await count_once(completed and has_body and not terminal_error)

    response = StreamingResponse(
        tracked_iterator(),
        media_type=media_type,
    )
    response._model_api_stream_failure = lambda: count_once(False)
    response._model_api_stream_resource_close = close_source
    return response


async def _antigravity_response(iterator, media_type, model_name, protocol, non_stream, protected):
    from src.antigravity_limits import (
        GenerationBudget, GenerationLimits, meaningful_frame, timeout_event, timeout_response,
    )
    protocol = protocol or "gemini"
    budget = GenerationBudget(GenerationLimits.load(), non_stream=non_stream)

    def failure(kind):
        return make_model_api_error(origin=ErrorOrigin.UPSTREAM, kind=kind)

    def timeout():
        return render_error(failure(ErrorKind.TIMEOUT), protocol) if protected else timeout_response()
    counted = False
    closed = False

    async def count(success):
        nonlocal counted
        if not counted and model_name:
            counted = True
            await record_logical_request(model_name, "antigravity", success)

    async def close():
        nonlocal closed
        if closed:
            return
        closed = True
        try:
            closer = getattr(iterator, "aclose", None)
            if closer:
                await closer()
        finally:
            await budget.close()

    try:
        first = await budget.run(read_first_async_item(iterator))
    except TimeoutError:
        await close()
        await count(False)
        return timeout()
    except StopAsyncIteration:
        await close()
        await count(False)
        return render_error(failure(ErrorKind.BAD_FORMAT), protocol) if protected else Response(status_code=204)
    except (asyncio.CancelledError, GeneratorExit):
        await close()
        raise
    except BaseException:
        await close()
        await count(False)
        raise
    if isinstance(first, Response):
        await close()
        await count(False)
        return first
    budget.observe(first)

    async def tracked():
        has_body = False
        terminal_error = False
        completed = False
        try:
            item = first
            while True:
                if protected:
                    item_has_data, item_is_error = _protected_item_state(item)
                    has_body = has_body or item_has_data
                    terminal_error = terminal_error or item_is_error
                else:
                    has_body = has_body or meaningful_frame(item)
                    terminal_error = terminal_error or stream_item_is_error(item)
                yield item
                try:
                    item = await budget.run(read_first_async_item(iterator))
                except StopAsyncIteration:
                    completed = True
                    if protected and not has_body:
                        terminal_error = True
                        yield render_error_event(failure(ErrorKind.BAD_FORMAT), protocol)
                    break
                budget.observe(item)
        except (asyncio.CancelledError, GeneratorExit):
            raise
        except TimeoutError:
            terminal_error = True
            yield render_error_event(failure(ErrorKind.TIMEOUT), protocol) if protected else timeout_event(protocol)
        except BaseException:
            terminal_error = True
            raise
        finally:
            await close()
            if completed or terminal_error:
                await count(completed and has_body and not terminal_error)

    class ClosingStreamingResponse(StreamingResponse):
        async def __call__(self, scope, receive, send):
            try:
                await super().__call__(scope, receive, send)
            finally:
                # A disconnect can occur while sending response headers, before
                # tracked() starts and its own finally becomes active.
                await close()

    response = ClosingStreamingResponse(tracked(), media_type=media_type)
    response._model_api_stream_failure = lambda: count(False)
    response._model_api_stream_resource_close = close
    return response
