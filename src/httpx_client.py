"""Shared HTTPX clients and bounded streaming transport."""

from __future__ import annotations

import asyncio
import hashlib
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, AsyncGenerator, Dict, Optional

import httpx
from fastapi import Response

from config import get_proxy_config
from src.streaming_latency import (
    StreamFailure,
    StreamLatencyConfig,
    StreamPhase,
    current_stream_trace,
)


@dataclass
class _ClientEntry:
    client: httpx.AsyncClient
    proxy_fingerprint: str
    active: int = 0
    retiring: bool = False


class HttpxClientManager:
    """Reuse connections while safely draining clients after proxy changes."""

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._current: Optional[_ClientEntry] = None
        self._entries: list[_ClientEntry] = []

    @staticmethod
    def _proxy_fingerprint(proxy: Optional[str]) -> str:
        return hashlib.sha256((proxy or "direct").encode("utf-8")).hexdigest()[:12]

    async def _new_entry(self, proxy: Optional[str]) -> _ClientEntry:
        kwargs: Dict[str, Any] = {
            "timeout": None,
            # Proxying is controlled exclusively by the application's PROXY
            # setting.  Reading the host environment here makes "direct"
            # mode depend on HTTP_PROXY/NO_PROXY values injected by the
            # runtime; httpx also rejects common IPv6 CIDR entries such as
            # ``::1/128`` while parsing NO_PROXY.
            "trust_env": False,
            "limits": httpx.Limits(
                max_connections=100,
                max_keepalive_connections=20,
                keepalive_expiry=30.0,
            ),
        }
        if proxy:
            kwargs["proxy"] = proxy
        return _ClientEntry(
            client=httpx.AsyncClient(**kwargs),
            proxy_fingerprint=self._proxy_fingerprint(proxy),
        )

    @asynccontextmanager
    async def get_client(
        self, timeout: float = 30.0, **kwargs: Any
    ) -> AsyncGenerator[httpx.AsyncClient, None]:
        """Lease a shared client; uncommon custom client kwargs use an isolated client."""
        proxy = await get_proxy_config()
        if kwargs:
            client_kwargs: Dict[str, Any] = {
                "timeout": timeout,
                "trust_env": False,
                **kwargs,
            }
            if proxy:
                client_kwargs["proxy"] = proxy
            async with httpx.AsyncClient(**client_kwargs) as client:
                yield client
            return

        fingerprint = self._proxy_fingerprint(proxy)
        close_after: list[httpx.AsyncClient] = []
        async with self._lock:
            entry = self._current
            if entry is None or entry.proxy_fingerprint != fingerprint or entry.retiring:
                if entry is not None:
                    entry.retiring = True
                    if entry.active == 0:
                        close_after.append(entry.client)
                        self._entries.remove(entry)
                entry = await self._new_entry(proxy)
                self._current = entry
                self._entries.append(entry)
            entry.active += 1

        for client in close_after:
            await client.aclose()

        try:
            yield entry.client
        finally:
            client_to_close: Optional[httpx.AsyncClient] = None
            async with self._lock:
                entry.active -= 1
                if entry.retiring and entry.active == 0:
                    if entry in self._entries:
                        self._entries.remove(entry)
                    client_to_close = entry.client
            if client_to_close is not None:
                await client_to_close.aclose()

    @asynccontextmanager
    async def get_streaming_client(self, **kwargs: Any) -> AsyncGenerator[httpx.AsyncClient, None]:
        async with self.get_client(**kwargs) as client:
            yield client

    async def close(self) -> None:
        async with self._lock:
            entries = list(self._entries)
            self._entries.clear()
            self._current = None
            for entry in entries:
                entry.retiring = True
        if entries:
            await asyncio.gather(
                *(entry.client.aclose() for entry in entries), return_exceptions=True
            )


@dataclass
class UpstreamStream:
    response: httpx.Response
    native: bool = False

    @property
    def status_code(self) -> int:
        return self.response.status_code

    @property
    def headers(self) -> httpx.Headers:
        return self.response.headers

    async def read_error_body(self, timeout: float = 10.0) -> bytes:
        try:
            async with asyncio.timeout(timeout):
                return await self.response.aread()
        except TimeoutError:
            return b'{"error":{"message":"upstream error body timed out"}}'

    def iterator(self):
        if self.native:
            return self.response.aiter_bytes()

        async def _lines():
            async for line in self.response.aiter_lines():
                yield line.encode("utf-8") if isinstance(line, str) else line

        return _lines()


http_client = HttpxClientManager()


def _http_timeout(config: StreamLatencyConfig) -> httpx.Timeout:
    return httpx.Timeout(
        connect=config.connect_timeout,
        pool=config.pool_timeout,
        write=config.write_timeout,
        read=None,
    )


def _transport_failure(exc: Exception, stage: str) -> StreamFailure:
    trace = current_stream_trace()
    request_id = trace.request_id if trace else None
    if isinstance(exc, (httpx.TimeoutException, TimeoutError)):
        return StreamFailure(
            "Upstream timed out before producing content",
            stage=stage,
            status_code=504,
            retryable=True,
            request_id=request_id,
        )
    return StreamFailure(
        "Unable to connect to upstream",
        stage=stage,
        status_code=502,
        retryable=True,
        request_id=request_id,
    )


@asynccontextmanager
async def open_stream_post(
    url: str,
    body: Dict[str, Any],
    *,
    native: bool = False,
    headers: Optional[Dict[str, str]] = None,
    trace=None,
) -> AsyncGenerator[UpstreamStream, None]:
    """Open a streaming response with a bounded response-header phase."""
    config = StreamLatencyConfig.from_env()
    trace = trace or current_stream_trace()
    if trace:
        trace.mark("waiting_headers", phase=StreamPhase.WAITING_HEADERS)
    async with http_client.get_streaming_client() as client:
        request = client.build_request(
            "POST",
            url,
            json=body,
            headers=headers,
            timeout=_http_timeout(config),
        )
        response: Optional[httpx.Response] = None
        try:
            async with asyncio.timeout(config.response_header_timeout):
                response = await client.send(request, stream=True)
        except Exception as exc:
            raise _transport_failure(exc, "response_headers") from exc

        try:
            if trace:
                trace.duration_since_mark("response_headers", "waiting_headers")
                trace.upstream_request_id = (
                    response.headers.get("x-request-id")
                    or response.headers.get("x-goog-request-id")
                    or response.headers.get("traceparent")
                )
            yield UpstreamStream(response=response, native=native)
        finally:
            await response.aclose()


async def get_async(
    url: str, headers: Optional[Dict[str, str]] = None, timeout: float = 30.0, **kwargs: Any
) -> httpx.Response:
    async with http_client.get_client(timeout=timeout, **kwargs) as client:
        return await client.get(url, headers=headers, timeout=timeout)


async def post_async(
    url: str,
    data: Any = None,
    json: Any = None,
    headers: Optional[Dict[str, str]] = None,
    timeout: float = 30.0,
    **kwargs: Any,
) -> httpx.Response:
    async with http_client.get_client(timeout=timeout, **kwargs) as client:
        return await client.post(url, data=data, json=json, headers=headers, timeout=timeout)


async def stream_post_async(
    url: str,
    body: Dict[str, Any],
    native: bool = False,
    headers: Optional[Dict[str, str]] = None,
    typed_errors: bool = False,
    **kwargs: Any,
):
    """Compatibility iterator used by both upstream API clients."""
    del kwargs
    config = StreamLatencyConfig.from_env()
    error_response: Optional[Response] = None
    async with open_stream_post(url, body, native=native, headers=headers) as stream:
        if stream.status_code != 200:
            error_response = Response(
                await stream.read_error_body(),
                stream.status_code,
                dict(stream.headers),
            )
        else:
            iterator = stream.iterator()
            first = True
            loop = asyncio.get_running_loop()
            first_event_deadline = loop.time() + config.first_event_timeout
            trace = current_stream_trace()
            if trace:
                trace.mark("waiting_first_event", phase=StreamPhase.WAITING_FIRST_EVENT)
            while True:
                try:
                    if not config.guard_enabled:
                        chunk = await iterator.__anext__()
                    else:
                        timeout = (
                            max(0.0, first_event_deadline - loop.time())
                            if first
                            else config.idle_timeout
                        )
                        async with asyncio.timeout(timeout):
                            chunk = await iterator.__anext__()
                except StopAsyncIteration:
                    break
                except Exception as exc:
                    stage = "first_event" if first else "stream_idle"
                    raise _transport_failure(exc, stage) from exc
                if first and chunk and chunk.strip():
                    first = False
                yield chunk

    # Error responses are surfaced only after the upstream context has closed,
    # so callers that stop after the first error cannot leak the response lease.
    if error_response is not None:
        if typed_errors:
            trace = current_stream_trace()
            raise StreamFailure.from_response(
                error_response,
                stage="upstream_status",
                request_id=trace.request_id if trace else None,
            )
        yield error_response
