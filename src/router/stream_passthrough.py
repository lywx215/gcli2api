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

    async def tracked_iterator():
        has_body = False
        saw_data_event = False
        terminal_error = False
        completed = False
        source = prepend_async_item(first_item, iterator)
        try:
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
            await source.aclose()
            if completed or terminal_error:
                await record_logical_request(
                    model_name, mode, completed and has_body and not terminal_error
                )

    return StreamingResponse(
        tracked_iterator(),
        media_type=media_type,
    )
