import asyncio
from typing import Any, AsyncIterator, Optional

from fastapi import Response
from fastapi.responses import StreamingResponse

from src.logical_request_stats import (
    record_logical_request,
    stream_item_has_body,
    stream_item_is_error,
)


async def prepend_async_item(first_item: Any, iterator: AsyncIterator[Any]):
    """Yield a prefetched item before continuing the original iterator."""
    yield first_item
    async for item in iterator:
        yield item


async def read_first_async_item(iterator: AsyncIterator[Any]) -> Any:
    """Python 3.9-compatible async equivalent of built-in anext()."""
    return await iterator.__anext__()


async def build_streaming_response_or_error(
    iterator: AsyncIterator[Any],
    media_type: str = "text/event-stream",
    *,
    model_name: Optional[str] = None,
    mode: Optional[str] = None,
    protocol: str = "gemini",
    non_stream: bool = False,
):
    """
    Prefetch the first async item so router code can return an upstream error
    response directly before FastAPI commits a 200 streaming response.
    """
    if mode == "antigravity":
        return await _antigravity_response(iterator, media_type, model_name, protocol, non_stream)
    should_count = bool(model_name and mode)
    try:
        first_item = await read_first_async_item(iterator)
    except StopAsyncIteration:
        if should_count:
            await record_logical_request(model_name, mode, False)
        return Response(status_code=204)

    if isinstance(first_item, Response):
        if should_count:
            await record_logical_request(model_name, mode, False)
        return first_item

    if not should_count:
        return StreamingResponse(
            prepend_async_item(first_item, iterator),
            media_type=media_type,
        )

    async def tracked_iterator():
        has_body = False
        terminal_error = False
        completed = False
        try:
            async for item in prepend_async_item(first_item, iterator):
                terminal_error = terminal_error or stream_item_is_error(item)
                has_body = has_body or stream_item_has_body(item)
                yield item
            completed = True
        except (asyncio.CancelledError, GeneratorExit):
            # A disconnected client has no final outcome, so it is not counted.
            raise
        except BaseException:
            terminal_error = True
            raise
        finally:
            if completed or terminal_error:
                await record_logical_request(
                    model_name, mode, completed and has_body and not terminal_error
                )

    return StreamingResponse(
        tracked_iterator(),
        media_type=media_type,
    )


async def _antigravity_response(iterator, media_type, model_name, protocol, non_stream):
    from src.antigravity_limits import (
        GenerationBudget, GenerationLimits, meaningful_frame, timeout_event, timeout_response,
    )
    budget = GenerationBudget(GenerationLimits.load(), non_stream=non_stream)
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
        return timeout_response()
    except StopAsyncIteration:
        await close()
        await count(False)
        return Response(status_code=204)
    except BaseException:
        await close()
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
                has_body = has_body or meaningful_frame(item)
                terminal_error = terminal_error or stream_item_is_error(item)
                yield item
                try:
                    item = await budget.run(read_first_async_item(iterator))
                except StopAsyncIteration:
                    completed = True
                    break
                budget.observe(item)
        except (asyncio.CancelledError, GeneratorExit):
            raise
        except TimeoutError:
            terminal_error = True
            yield timeout_event(protocol)
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

    return ClosingStreamingResponse(tracked(), media_type=media_type)
