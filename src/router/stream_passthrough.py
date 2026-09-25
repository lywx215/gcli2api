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


async def build_streaming_response_or_error(
    iterator: AsyncIterator[Any],
    media_type: str = "text/event-stream",
    *,
    model_name: Optional[str] = None,
    mode: Optional[str] = None,
):
    """
    Prefetch the first async item so router code can return an upstream error
    response directly before FastAPI commits a 200 streaming response.
    """
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
