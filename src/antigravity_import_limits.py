"""Process-wide Antigravity import admission and bounded request buffering."""
import asyncio
from contextlib import asynccontextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from tempfile import SpooledTemporaryFile
from urllib.parse import parse_qs

from fastapi import HTTPException
from fastapi.responses import JSONResponse
import os


@dataclass(frozen=True)
class ImportLimits:
    request_bytes: int = 32 * 1024 * 1024
    files: int = 100
    zip_entries: int = 1000
    json_bytes: int = 1024 * 1024
    expanded_bytes: int = 64 * 1024 * 1024
    requests: int = 2
    writes: int = 1

    @classmethod
    def load(cls):
        values = {}
        for key, default in cls().__dict__.items():
            name = 'ANTIGRAVITY_IMPORT_' + key.upper()
            try:
                value = int(os.getenv(name, str(default)))
                if value <= 0:
                    raise ValueError
            except ValueError:
                raise ValueError(f'{name} must be a positive integer') from None
            values[key] = value
        return cls(**values)


_admitted = ContextVar('antigravity_import_admitted', default=False)


def _gate(name, size):
    # The server uses one event loop per worker. Keeping gates on the loop also
    # avoids binding test loops/restarted application loops to a stale semaphore.
    loop = asyncio.get_running_loop()
    key = '_antigravity_import_' + name
    gate = getattr(loop, key, None)
    if gate is None:
        gate = asyncio.Semaphore(size)
        setattr(loop, key, gate)
    return gate


@asynccontextmanager
async def import_slot():
    if _admitted.get():
        yield
        return
    async with _gate('requests', ImportLimits.load().requests):
        token = _admitted.set(True)
        try:
            yield
        finally:
            _admitted.reset(token)


@asynccontextmanager
async def import_write_slot():
    async with _gate('writes', ImportLimits.load().writes):
        yield


def limit_exceeded():
    return HTTPException(status_code=413, detail='Antigravity 导入超出资源限制')


class AntigravityUploadMiddleware:
    """Check actual bytes before multipart parsing, including chunked requests.

    Buffer to a bounded temporary file, never the full body in RAM. Failed or
    cancelled bodies never reach the parser or persistence layer.
    """
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http' or scope.get('method') != 'POST' or scope.get('path', '').rstrip('/') != '/creds/upload':
            return await self.app(scope, receive, send)
        params = parse_qs(scope.get('query_string', b'').decode('latin-1'))
        if params.get('mode', ['geminicli'])[-1] != 'antigravity':
            return await self.app(scope, receive, send)
        limit = ImportLimits.load().request_bytes
        headers = dict(scope.get('headers', []))
        try:
            declared = int(headers.get(b'content-length', b'0'))
        except ValueError:
            declared = 0
        if declared > limit:
            return await _reject_oversize(scope, receive, send)
        async with import_slot():
            with SpooledTemporaryFile(max_size=1024 * 1024) as buffer:
                size = 0
                while True:
                    message = await receive()
                    if message['type'] == 'http.disconnect':
                        return
                    if message['type'] != 'http.request':
                        continue
                    body = message.get('body', b'')
                    size += len(body)
                    if size > limit:
                        return await _reject_oversize(
                            scope, receive, send, body_complete=not message.get("more_body", False)
                        )
                    buffer.write(body)
                    if not message.get('more_body', False):
                        break
                buffer.seek(0)
                remaining = size
                async def replay():
                    nonlocal remaining
                    if remaining < 0:
                        return await receive()
                    data = buffer.read(65536)
                    remaining -= len(data)
                    more = remaining > 0
                    if not more:
                        remaining = -1
                    return {'type':'http.request', 'body':data, 'more_body':more}
                await self.app(scope, replay, send)


async def _reject_oversize(scope, receive, send, *, body_complete=False):
    # Never reuse a rejected HTTP/1 connection with an unread request body.
    # Briefly drain in-flight bytes after sending 413 so closing the socket does
    # not reset a finite upload before the client can read the error response.
    headers = {"Connection": "close"} if scope.get("http_version", "1.1") in ("1.0", "1.1") else {}

    async def finish_response(message):
        if message["type"] != "http.response.body" or message.get("more_body", False):
            return await send(message)
        await send({**message, "more_body": True})
        if not body_complete:
            try:
                async with asyncio.timeout(1):
                    discarded = 0
                    while discarded < 4 * 1024 * 1024:
                        remainder = await receive()
                        if remainder["type"] == "http.disconnect":
                            break
                        discarded += len(remainder.get("body", b""))
                        if not remainder.get("more_body", False):
                            break
            except TimeoutError:
                pass
        await send({"type": "http.response.body", "body": b"", "more_body": False})

    await JSONResponse(status_code=413, headers=headers,
                       content={"detail": "Antigravity 导入超出资源限制"})(scope, receive, finish_response)
