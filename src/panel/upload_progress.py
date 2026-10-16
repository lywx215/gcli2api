"""Optional, process-local observation of bytes consumed by the legacy upload.

No request body is buffered, parsed, or read ahead here. A finished response is
transport evidence only: the original upload response owns persistence results.
"""

import hashlib
import hmac
import math
import os
import re
import secrets
import threading
import time
from dataclasses import dataclass, field
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from starlette._utils import get_route_path

from src.utils import security, verify_panel_token


CAPABILITY = "panel.credentials.upload_progress.v1"
TICKET_TTL_SECONDS = 900
MAX_TICKETS = 256
MAX_OWNER_TICKETS = 8
POLL_INTERVAL_MS = 500
Mode = Literal["geminicli", "antigravity"]
Phase = Literal["receiving", "processing", "finished", "interrupted"]
_ID = re.compile(r"[0-9a-f]{32}")
_native_workers = None


def confirm_native_single_worker(workers: int) -> None:
    """Called by a launcher that actually controls the server worker count."""
    global _native_workers
    _native_workers = workers if type(workers) is int else None


def unsupported_reason() -> str | None:
    try:
        workers = int(os.environ.get("WORKERS", "1"))
    except ValueError:
        return "worker_count_invalid"
    if workers != 1 or (_native_workers is not None and _native_workers != 1):
        return "multi_worker"
    if _native_workers != 1:
        return "single_worker_unconfirmed"
    return None


class Capabilities(BaseModel):
    capability: Literal["panel.credentials.upload_progress.v1"] = CAPABILITY
    supported: bool
    reason: Literal["multi_worker", "worker_count_invalid", "single_worker_unconfirmed"] | None
    modes: list[Mode] = ["geminicli", "antigravity"]
    ttl_seconds: int = TICKET_TTL_SECONDS
    poll_interval_ms: int = POLL_INTERVAL_MS


class Progress(BaseModel):
    progress_id: str
    mode: Mode
    received_bytes: int
    total_bytes: int | None
    phase: Phase
    http_status: int | None
    bound: bool
    expires_in_seconds: int


@dataclass
class _Ticket:
    owner: bytes = field(repr=False)
    mode: str
    expires_at: float
    received_bytes: int = 0
    total_bytes: int | None = None
    phase: str = "receiving"
    http_status: int | None = None
    bound: bool = False


class UploadProgressStore:
    def __init__(self, *, ttl=TICKET_TTL_SECONDS, capacity=MAX_TICKETS,
                 owner_capacity=MAX_OWNER_TICKETS, clock=time.monotonic):
        self.ttl = ttl
        self.capacity = capacity
        self.owner_capacity = owner_capacity
        self.clock = clock
        self._key = secrets.token_bytes(32)
        self._tickets: dict[str, _Ticket] = {}
        self._lock = threading.RLock()

    def owner_digest(self, token: str) -> bytes:
        return hmac.digest(self._key, token.encode("utf-8"), hashlib.sha256)

    def _prune(self):
        now = self.clock()
        for progress_id in list(self._tickets):
            if self._tickets[progress_id].expires_at <= now:
                del self._tickets[progress_id]

    def _find(self, progress_id, owner, mode):
        self._prune()
        if not _ID.fullmatch(progress_id):
            return None
        ticket = self._tickets.get(progress_id)
        if ticket is None or not hmac.compare_digest(ticket.owner, owner) or ticket.mode != mode:
            return None
        return ticket

    def _snapshot(self, progress_id, ticket):
        return Progress(
            progress_id=progress_id, mode=ticket.mode,
            received_bytes=ticket.received_bytes, total_bytes=ticket.total_bytes,
            phase=ticket.phase, http_status=ticket.http_status, bound=ticket.bound,
            expires_in_seconds=max(0, math.ceil(ticket.expires_at - self.clock())),
        )

    def create(self, owner, mode):
        with self._lock:
            self._prune()
            owned = sum(hmac.compare_digest(item.owner, owner) for item in self._tickets.values())
            if len(self._tickets) >= self.capacity or owned >= self.owner_capacity:
                raise HTTPException(429, "upload_progress_capacity")
            progress_id = secrets.token_hex(16)
            while progress_id in self._tickets:
                progress_id = secrets.token_hex(16)
            ticket = _Ticket(owner=owner, mode=mode, expires_at=self.clock() + self.ttl)
            self._tickets[progress_id] = ticket
            return self._snapshot(progress_id, ticket)

    def read(self, progress_id, owner, mode):
        with self._lock:
            ticket = self._find(progress_id, owner, mode)
            if ticket is None:
                raise HTTPException(404, "upload_progress_not_found")
            return self._snapshot(progress_id, ticket)

    def bind(self, progress_id, owner, mode, total_bytes):
        with self._lock:
            ticket = self._find(progress_id, owner, mode)
            # Use one response for missing, expired, wrong-owner/mode and replay.
            if ticket is None or ticket.bound:
                raise HTTPException(409, "upload_progress_unavailable")
            ticket.bound = True
            ticket.total_bytes = total_bytes
            return ticket

    def received(self, ticket, message):
        with self._lock:
            if message["type"] == "http.disconnect":
                if ticket.phase != "finished":
                    ticket.phase = "interrupted"
            elif message["type"] == "http.request":
                ticket.received_bytes += len(message.get("body", b""))
                if not message.get("more_body", False) and ticket.phase == "receiving":
                    ticket.phase = "processing"

    def sent(self, ticket, message):
        with self._lock:
            if message["type"] == "http.response.start":
                ticket.http_status = message["status"]
            elif (message["type"] == "http.response.body"
                  and not message.get("more_body", False) and ticket.phase != "interrupted"):
                ticket.phase = "finished"

    def interrupted(self, ticket):
        with self._lock:
            if ticket.phase != "finished":
                ticket.phase = "interrupted"


_store = UploadProgressStore()
router = APIRouter(prefix="/creds/upload-progress", tags=["Panel Upload Progress"])


def _require_supported():
    if unsupported_reason() is not None:
        raise HTTPException(503, "upload_progress_unsupported")


def _mode(request: Request) -> str:
    values = request.query_params.getlist("mode")
    if len(values) != 1 or values[0] not in ("geminicli", "antigravity"):
        raise HTTPException(400, "upload_progress_invalid_mode")
    return values[0]


@router.get("/capabilities", response_model=Capabilities)
async def capabilities(_token: str = Depends(verify_panel_token)):
    reason = unsupported_reason()
    return Capabilities(supported=reason is None, reason=reason)


@router.post("", response_model=Progress, status_code=201)
async def create_progress(request: Request, mode: Mode = Query(...),
                          token: str = Depends(verify_panel_token)):
    _require_supported()
    return _store.create(_store.owner_digest(token), _mode(request))


@router.get("/{progress_id}", response_model=Progress)
async def read_progress(progress_id: str, request: Request, mode: Mode = Query(...),
                        token: str = Depends(verify_panel_token)):
    _require_supported()
    return _store.read(progress_id, _store.owner_digest(token), _mode(request))


def _content_length(scope) -> int | None:
    values = [value for name, value in scope.get("headers", []) if name.lower() == b"content-length"]
    # Unknown/malformed length stays unknown; this is never an admission limit.
    if len(values) != 1 or not re.fullmatch(rb"[0-9]{1,15}", values[0]):
        return None
    return int(values[0])


def _no_store(send):
    async def send_private(message):
        if message["type"] == "http.response.start":
            headers = [(name, value) for name, value in message.get("headers", [])
                       if name.lower() != b"cache-control"]
            message = {**message, "headers": [*headers, (b"cache-control", b"no-store")]}
        await send(message)
    return send_private


class UploadProgressMiddleware:
    """Observe the original receive BEFORE Antigravity's existing body limiter."""

    def __init__(self, app, store=None):
        self.app = app
        self.store = store if store is not None else _store

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        # Match the same logical path as Starlette, including mounted service
        # prefixes; its root_path removal checks the complete path boundary.
        path = get_route_path(scope)
        if path == "/creds/upload-progress" or path.startswith("/creds/upload-progress/"):
            return await self.app(scope, receive, _no_store(send))
        if scope.get("method") != "POST" or path.rstrip("/") != "/creds/upload":
            return await self.app(scope, receive, send)
        request = Request(scope)
        progress_ids = request.query_params.getlist("progress_id")
        if not progress_ids:
            return await self.app(scope, receive, send)

        send_private = _no_store(send)
        try:
            # Opt-in only. The legacy upload keeps its normal dependency check.
            credentials = await security(request)
            token = await verify_panel_token(credentials)
            owner = self.store.owner_digest(token)
            del token, credentials
            _require_supported()
            mode = _mode(request)
            if len(progress_ids) != 1:
                raise HTTPException(409, "upload_progress_unavailable")
            ticket = self.store.bind(progress_ids[0], owner, mode, _content_length(scope))
        except HTTPException as exc:
            headers = dict(exc.headers or {})
            # These opt-in rejections occur before any body read. Do not reuse
            # an HTTP/1 connection whose upload bytes have not been consumed.
            if scope.get("http_version", "1.1") in ("1.0", "1.1"):
                headers["Connection"] = "close"
            return await JSONResponse({"detail": exc.detail}, status_code=exc.status_code,
                                      headers=headers)(scope, receive, send_private)

        async def observed_receive():
            message = await receive()
            self.store.received(ticket, message)
            return message

        async def observed_send(message):
            await send_private(message)
            self.store.sent(ticket, message)

        try:
            return await self.app(scope, observed_receive, observed_send)
        finally:
            # Also runs on disconnect, cancellation and receive/send exceptions;
            # do not convert or swallow the original exception or cancellation.
            self.store.interrupted(ticket)


def install_upload_progress(app) -> None:
    # Install after app.add_middleware(AntigravityUploadMiddleware), so this
    # wrapper sees bytes from the server rather than the limiter's replay.
    app.add_middleware(UploadProgressMiddleware)
    app.include_router(router)
