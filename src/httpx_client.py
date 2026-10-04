"""
通用的HTTP客户端模块
为所有需要使用httpx的模块提供统一的客户端配置和方法
保持通用性，不与特定业务逻辑耦合
"""

import asyncio
from contextlib import asynccontextmanager
import codecs
import json
from typing import Any, AsyncGenerator, AsyncIterable, Dict, Optional

import httpx
from src.diagnostics.http import DiagnosticAsyncClient

from config import get_proxy_config
from log import log
from src.router.model_api_errors import (
    ErrorKind,
    ErrorOrigin,
    ModelApiErrorException,
    error_from_http_status,
    error_from_model_payload,
    make_model_api_error,
)
from src.router.model_retirement import RetirementAction, new_attempt


MAX_SSE_EVENT_BYTES = 32 * 1024 * 1024


async def iter_sse_frames(chunks: AsyncIterable[bytes | str]):
    """Frame bounded UTF-8 SSE, retaining controls for protocol adapters.

    EOF may terminate a valid last event, as in the existing transport contract.
    Incomplete UTF-8/JSON is still rejected by this framer/the normalizer.
    The limit includes controls and unfinished lines, independently of retirement.
    """
    decoder = codecs.getincrementaldecoder("utf-8")("strict")
    unfinished = []
    unfinished_bytes = 0
    lines = []
    event_bytes = 0

    def accept(fragment):
        nonlocal unfinished, unfinished_bytes, lines, event_bytes
        completed = []
        pieces = fragment.split("\n")
        for position, piece in enumerate(pieces):
            unfinished.append(piece)
            unfinished_bytes += len(piece.encode("utf-8"))
            if event_bytes + unfinished_bytes + len(decoder.getstate()[0]) > MAX_SSE_EVENT_BYTES:
                raise ModelApiErrorException(make_model_api_error(
                    origin=ErrorOrigin.UPSTREAM, kind=ErrorKind.BAD_FORMAT
                ))
            if position == len(pieces) - 1:
                continue
            event_bytes += unfinished_bytes + 1
            if event_bytes > MAX_SSE_EVENT_BYTES:
                raise ModelApiErrorException(make_model_api_error(
                    origin=ErrorOrigin.UPSTREAM, kind=ErrorKind.BAD_FORMAT
                ))
            line = "".join(unfinished)
            unfinished = []
            unfinished_bytes = 0
            if line.endswith("\r"):
                line = line[:-1]
            if not line:
                if lines:
                    completed.append("\n".join(lines) + "\n\n")
                lines = []
                event_bytes = 0
            else:
                lines.append(line)
        return completed

    try:
        async for chunk in chunks:
            if not isinstance(chunk, (bytes, str)):
                raise ModelApiErrorException(make_model_api_error(
                    origin=ErrorOrigin.UPSTREAM, kind=ErrorKind.BAD_FORMAT
                ))
            # Bound transient decoding even when one HTTP chunk has many events.
            for offset in range(0, len(chunk), 64 * 1024):
                piece = chunk[offset:offset + 64 * 1024]
                if isinstance(piece, str):
                    # A str cannot complete a pending partial bytes codepoint.
                    if decoder.getstate()[0]:
                        raise UnicodeDecodeError("utf-8", decoder.getstate()[0], 0, 1, "mixed chunks")
                    fragment = piece
                else:
                    fragment = decoder.decode(piece, final=False)
                for frame in accept(fragment):
                    yield frame
        for frame in accept(decoder.decode(b"", final=True)):
            yield frame
        if unfinished_bytes:
            last_line = "".join(unfinished)
            lines.append(last_line[:-1] if last_line.endswith("\r") else last_line)
        if lines:
            yield "\n".join(lines) + "\n\n"
    except UnicodeError as exc:
        raise ModelApiErrorException(make_model_api_error(
            origin=ErrorOrigin.UPSTREAM, kind=ErrorKind.BAD_FORMAT
        )) from exc
    finally:
        close = getattr(chunks, "aclose", None)
        if close is not None:
            try:
                await close()
            except Exception:
                pass  # Cleanup must not replace a typed transport outcome.


async def normalize_sse_events(chunks: AsyncIterable[bytes | str]):
    """Normalize complete SSE events without guessing line-vs-event mode."""

    fields: dict[str, list[str]] = {}
    event_name = ""

    def dispatch() -> bytes | None:
        nonlocal fields, event_name
        data_lines = fields.get("data", [])
        fields = {}
        current_event = event_name
        event_name = ""
        if not data_lines:
            return None
        payload = "\n".join(data_lines)
        if payload == "[DONE]":
            if current_event == "error":
                raise ModelApiErrorException(make_model_api_error(
                    origin=ErrorOrigin.UPSTREAM, kind=ErrorKind.BAD_FORMAT
                ))
            return b"data: [DONE]\n\n"
        try:
            parsed = json.loads(payload)
        except (ValueError, TypeError, RecursionError) as exc:
            raise ModelApiErrorException(
                make_model_api_error(
                    origin=ErrorOrigin.UPSTREAM,
                    kind=ErrorKind.BAD_FORMAT,
                    status=502,
                )
            ) from exc
        if not isinstance(parsed, dict):
            raise ModelApiErrorException(
                make_model_api_error(
                    origin=ErrorOrigin.UPSTREAM,
                    kind=ErrorKind.BAD_FORMAT,
                    status=502,
                )
            )
        error = error_from_model_payload(parsed)
        if current_event == "error" or error is not None:
            error = error or make_model_api_error(
                origin=ErrorOrigin.UPSTREAM, kind=ErrorKind.BAD_FORMAT
            )
            raise ModelApiErrorException(error)
        normalized = json.dumps(parsed, ensure_ascii=False, separators=(",", ":"))
        return b"data: " + normalized.encode("utf-8") + b"\n\n"

    frames = iter_sse_frames(chunks)
    try:
        async for frame in frames:
            for line in frame.split("\n"):
                if line.startswith(":"):
                    continue
                field, separator, value = line.partition(":")
                if not separator or field not in {"data", "event", "id", "retry"}:
                    continue
                if value.startswith(" "):
                    value = value[1:]
                if field == "data":
                    fields.setdefault("data", []).append(value)
                elif field == "event":
                    event_name = value
            event = dispatch()
            if event is not None:
                yield event
    finally:
        await frames.aclose()


def _normalized_event_payload(event: bytes) -> dict[str, Any] | None:
    text = event.decode("utf-8") if isinstance(event, bytes) else str(event)
    data = [line[5:].strip() for line in text.splitlines() if line.startswith("data:")]
    if not data or data[-1] == "[DONE]":
        return None
    payload = json.loads("\n".join(data))
    return payload if isinstance(payload, dict) else None


def _encode_normalized_event(payload: Any) -> bytes:
    return (
        b"data: "
        + json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        + b"\n\n"
    )


async def _retirement_checked_events(chunks: AsyncIterable[bytes]):
    """Apply the per-attempt retirement recognizer to normalized SSE events."""

    checker = new_attempt()
    async for event in chunks:
        payload = _normalized_event_payload(event)
        if payload is None:
            final = checker.finish()
            if final.action is RetirementAction.RETIRED:
                raise ModelApiErrorException(
                    error_from_http_status(404, origin=ErrorOrigin.UPSTREAM)
                )
            if final.action is RetirementAction.BUFFER_OVERFLOW:
                raise ModelApiErrorException(
                    make_model_api_error(
                        origin=ErrorOrigin.UPSTREAM,
                        kind=ErrorKind.BAD_FORMAT,
                        status=502,
                    )
                )
            for released in final.events:
                yield _encode_normalized_event(released)
            yield event
            continue

        result = checker.feed(payload)
        if result.action is RetirementAction.RETIRED:
            raise ModelApiErrorException(
                error_from_http_status(404, origin=ErrorOrigin.UPSTREAM)
            )
        if result.action is RetirementAction.BUFFER_OVERFLOW:
            raise ModelApiErrorException(
                make_model_api_error(
                    origin=ErrorOrigin.UPSTREAM,
                    kind=ErrorKind.BAD_FORMAT,
                    status=502,
                )
            )
        # A completed recognizer returns PASS with no buffered events. Later
        # usage/metadata frames still belong to the stream and must be delivered.
        if result.action is RetirementAction.PASS and not result.events:
            yield event
        for released in result.events:
            yield _encode_normalized_event(released)

    # EOF is also a terminal boundary, even when the upstream omits [DONE].
    final = checker.finish()
    if final.action is RetirementAction.RETIRED:
        raise ModelApiErrorException(error_from_http_status(404))
    if final.action is RetirementAction.BUFFER_OVERFLOW:
        raise ModelApiErrorException(make_model_api_error(
            origin=ErrorOrigin.UPSTREAM, kind=ErrorKind.BAD_FORMAT
        ))
    for released in final.events:
        yield _encode_normalized_event(released)


class HttpxClientManager:
    """通用HTTP客户端管理器"""

    async def get_client_kwargs(self, timeout: float = 30.0, **kwargs) -> Dict[str, Any]:
        """获取httpx客户端的通用配置参数"""
        client_kwargs = {"timeout": timeout, **kwargs}

        # 动态读取代理配置，支持热更新
        current_proxy_config = await get_proxy_config()
        if current_proxy_config:
            client_kwargs["proxy"] = current_proxy_config

        return client_kwargs

    @asynccontextmanager
    async def get_client(
        self, timeout: float = 30.0, **kwargs
    ) -> AsyncGenerator[httpx.AsyncClient, None]:
        """获取配置好的异步HTTP客户端"""
        client_kwargs = await self.get_client_kwargs(timeout=timeout, **kwargs)

        async with DiagnosticAsyncClient(**client_kwargs) as client:
            yield client

    @asynccontextmanager
    async def get_streaming_client(
        self, timeout: float = None, **kwargs
    ) -> AsyncGenerator[httpx.AsyncClient, None]:
        """获取用于流式请求的HTTP客户端（无超时限制）"""
        client_kwargs = await self.get_client_kwargs(timeout=timeout, **kwargs)

        # 创建独立的客户端实例用于流式处理
        client = DiagnosticAsyncClient(**client_kwargs)
        try:
            yield client
        finally:
            # 确保无论发生什么都关闭客户端
            try:
                await client.aclose()
            except Exception as e:
                log.warning(f"Error closing streaming client: {e}")


# 全局HTTP客户端管理器实例
http_client = HttpxClientManager()


# 通用的异步方法
async def get_async(
    url: str, headers: Optional[Dict[str, str]] = None, timeout: float = 30.0, **kwargs
) -> httpx.Response:
    """通用异步GET请求"""
    async with http_client.get_client(timeout=timeout, **kwargs) as client:
        return await client.get(url, headers=headers)


async def post_async(
    url: str,
    data: Any = None,
    json: Any = None,
    headers: Optional[Dict[str, str]] = None,
    timeout: float = 900.0,
    response_header_timeout: Optional[float] = None,
    **kwargs,
) -> httpx.Response:
    """通用异步POST请求"""
    async with http_client.get_client(timeout=timeout, **kwargs) as client:
        if response_header_timeout is None:
            return await client.post(url, data=data, json=json, headers=headers)
        async with _bounded_response(client, url, json=json, data=data, headers=headers,
                                     header_timeout=response_header_timeout) as response:
            await response.aread()
            return response


# 调试用：设为 True 时所有流式请求都返回 429
_MOCK_STREAM_429 = False

async def stream_post_async(
    url: str,
    body: Dict[str, Any],
    native: bool = False,
    headers: Optional[Dict[str, str]] = None,
    events: bool = False,
    response_header_timeout: Optional[float] = None,
    **kwargs,
):
    """流式异步POST请求"""
    if _MOCK_STREAM_429:
        from fastapi import Response
        import json
        log.warning(f"[MOCK] stream_post_async: 返回模拟429错误")
        yield Response(
            content=json.dumps({"error": {"code": 429, "message": "mock rate limit", "status": "RESOURCE_EXHAUSTED"}}),
            status_code=429,
        )
        return

    async with http_client.get_streaming_client(**kwargs) as client:
        response_context = (
            client.stream("POST", url, json=body, headers=headers)
            if response_header_timeout is None else
            _bounded_response(client, url, json=body, headers=headers,
                              header_timeout=response_header_timeout)
        )
        async with response_context as r:
            # 错误直接返回
            if r.status_code != 200:
                from fastapi import Response
                yield Response(await r.aread(), r.status_code, dict(r.headers))
                return

            # 如果native=True，直接返回bytes流
            if events:
                normalized_events = normalize_sse_events(r.aiter_bytes())
                checked_events = _retirement_checked_events(normalized_events)
                try:
                    async for event in checked_events:
                        yield event
                finally:
                    await checked_events.aclose()
                    await normalized_events.aclose()
            elif native:
                async for chunk in r.aiter_bytes():
                    yield chunk
            else:
                # 通过aiter_lines转化成bytes流返回（统一为bytes避免下游str/bytes混合）
                async for line in r.aiter_lines():
                    yield line.encode('utf-8') if isinstance(line, str) else line


@asynccontextmanager
async def _bounded_response(client, url, *, header_timeout, **kwargs):
    """Deadline begins after request body transmission, for HTTP/1.1 and HTTP/2.

    httpx connect/write limits govern earlier phases. Waiting for the entire
    header block is bounded even when an upstream trickles individual bytes.
    """
    sent = asyncio.Event()

    async def trace(event, info):
        if event.endswith("send_request_body.complete"):
            sent.set()

    request = client.build_request("POST", url, extensions={"trace": trace}, **kwargs)
    opening = asyncio.create_task(client.send(request, stream=True))
    transmitted = asyncio.create_task(sent.wait())
    response = None
    try:
        await asyncio.wait((opening, transmitted), return_when=asyncio.FIRST_COMPLETED)
        if opening.done():
            response = opening.result()
        else:
            response = await asyncio.wait_for(opening, header_timeout)
        yield response
    finally:
        for task in (opening, transmitted):
            if not task.done():
                task.cancel()
        await asyncio.gather(opening, transmitted, return_exceptions=True)
        if response is None and not opening.cancelled() and opening.exception() is None:
            response = opening.result()
        if response is not None:
            await response.aclose()
