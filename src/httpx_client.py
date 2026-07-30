"""Shared HTTPX clients and bounded streaming transport."""

from __future__ import annotations

import asyncio
import hashlib
import time
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
    error_type = type(exc).__name__
    status_code = 502
    message = "Unable to connect to upstream"
    if isinstance(exc, httpx.PoolTimeout):
        stage, status_code, message = "pool", 504, "Upstream connection pool timed out"
    elif isinstance(exc, httpx.ConnectTimeout):
        stage, status_code, message = "connect", 504, "Upstream connection timed out"
    elif isinstance(exc, (httpx.ProxyError, httpx.ConnectError)):
        stage, status_code = "connect", 502
    elif isinstance(exc, httpx.WriteTimeout):
        stage, status_code, message = "write", 504, "Upstream request write timed out"
    elif isinstance(exc, httpx.WriteError):
        stage, status_code, message = "write", 502, "Unable to write upstream request"
    elif isinstance(exc, httpx.RemoteProtocolError):
        stage = "response_headers" if stage in {"response_headers", "first_event"} else "streaming"
        message = "Upstream protocol was interrupted"
    elif isinstance(exc, (httpx.ReadTimeout, httpx.TimeoutException, TimeoutError)):
        status_code, message = 504, "Upstream timed out before producing content"
    failure = StreamFailure(
        message,
        stage=stage,
        status_code=status_code,
        retryable=True,
        request_id=request_id,
        error_type=error_type,
    )
    if trace:
        trace.record_failure(
            stage=stage,
            error_type=error_type,
            status_code=status_code,
            retryable=True,
        )
    return failure


class _HttpcoreTrace:
    """Best-effort transport phase timings for a single request."""

    def __init__(self) -> None:
        self.started_at = time.perf_counter()
        self.first_event_at: Optional[float] = None
        self.starts: Dict[str, float] = {}
        self.values: Dict[str, float] = {}
        self.connected = False
        self.request_body_complete_at: Optional[float] = None

    async def __call__(self, name: str, info: Dict[str, Any]) -> None:
        del info
        now = time.perf_counter()
        if self.first_event_at is None:
            self.first_event_at = now
        if name.endswith(".started"):
            self.starts[name[:-8]] = now
            if "connect_tcp" in name or "connect_unix_socket" in name:
                self.connected = True
            return
        if not name.endswith(".complete"):
            return
        base = name[:-9]
        started = self.starts.get(base)
        duration_ms = (now - started) * 1000 if started is not None else 0.0
        if "connect_tcp" in name or "connect_unix_socket" in name:
            self.values["connect"] = self.values.get("connect", 0.0) + duration_ms
        elif "start_tls" in name:
            self.values["tls"] = self.values.get("tls", 0.0) + duration_ms
        elif "send_request_headers" in name or "send_request_body" in name:
            self.values["write"] = self.values.get("write", 0.0) + duration_ms
            if "send_request_body" in name:
                self.request_body_complete_at = now
        elif "receive_response_headers" in name:
            wait_started = self.request_body_complete_at or started
            if wait_started is not None:
                self.values["response_header_wait"] = (now - wait_started) * 1000

    def finish(self) -> Dict[str, float]:
        values = dict(self.values)
        first = self.first_event_at or time.perf_counter()
        values["pool_wait_estimate"] = max(0.0, (first - self.started_at) * 1000)
        values["reused_connection"] = 0.0 if self.connected else 1.0
        return values


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
        transport_trace = _HttpcoreTrace() if trace and trace.diagnostics_enabled else None
        request = client.build_request(
            "POST",
            url,
            json=body,
            headers=headers,
            timeout=_http_timeout(config),
        )
        if transport_trace is not None:
            request.extensions["trace"] = transport_trace
        response: Optional[httpx.Response] = None
        try:
            async with asyncio.timeout(config.response_header_timeout):
                response = await client.send(request, stream=True)
        except Exception as exc:
            if trace:
                trace.duration_since_mark("response_headers", "waiting_headers")
                trace.add_duration_ms(
                    "response_headers_total",
                    trace.timings_ms.get("response_headers", 0.0),
                )
                if transport_trace is not None:
                    trace.add_attempt_transport(transport_trace.finish())
            raise _transport_failure(exc, "response_headers") from exc

        try:
            if trace:
                trace.duration_since_mark("response_headers", "waiting_headers")
                trace.add_duration_ms(
                    "response_headers_total",
                    trace.timings_ms.get("response_headers", 0.0),
                )
                if transport_trace is not None:
                    trace.add_attempt_transport(transport_trace.finish())
                trace.upstream_request_id = (
                    response.headers.get("x-request-id")
                    or response.headers.get("x-goog-request-id")
                    or response.headers.get("x-guploader-uploadid")
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
                if trace and chunk and chunk.strip():
                    trace.mark_upstream_event()
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
