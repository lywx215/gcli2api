"""Process-local HTTP admission and bounded, cancellation-safe atomic settlement.

No token, filename or database payload is retained in public diagnostics.
"""
import asyncio
import contextvars
import time
from collections import deque
from dataclasses import dataclass
from src.antigravity_panel_metrics import trace_phase

work_deadline = contextvars.ContextVar("antigravity_directory_deadline", default=None)
work_class = contextvars.ContextVar("antigravity_directory_class", default="business")
work_progress = contextvars.ContextVar("antigravity_directory_progress", default=None)
_signal_close_requested = False


def mark_phase(phase):
    progress = work_progress.get()
    if progress is not None:
        progress["phase"] = phase


class QuotaWorkError(Exception):
    def __init__(self, code, phase, *, started=True):
        self.code, self.phase, self.started = code, phase, started
        super().__init__(code)


class SettlementPending(QuotaWorkError):
    def __init__(self, phase):
        super().__init__("quota_timeout", phase)


def remaining(deadline, phase):
    seconds = deadline - time.monotonic() if deadline is not None else None
    if seconds is not None and seconds <= 0:
        raise QuotaWorkError("quota_timeout", phase)
    return seconds


@dataclass(eq=False)
class _Ticket:
    kind: str
    future: asyncio.Future
    deadline: float | None
    task: asyncio.Task | None = None


class DirectoryBroker:
    """FIFO within each class; work-conserving weighted round robin across classes."""
    order = ("interactive",) * 4 + ("business",) * 4 + ("batch",) * 2 + ("background",)

    def __init__(self, capacity=5, queue_limit=200):
        self.capacity, self.queue_limit = capacity, queue_limit
        self.queues = {kind: deque() for kind in set(self.order)}
        self.active = set()
        self.cursor = 0
        self.closed = False

    @property
    def queued(self):
        return sum(map(len, self.queues.values()))

    def start(self):
        self.closed = False

    def _dispatch(self):
        if self.closed:
            return
        while len(self.active) < self.capacity:
            chosen = None
            for _ in range(len(self.order)):
                kind = self.order[self.cursor]
                self.cursor = (self.cursor + 1) % len(self.order)
                queue = self.queues[kind]
                while queue and (queue[0].future.done() or
                        queue[0].deadline is not None and queue[0].deadline <= time.monotonic()):
                    stale = queue.popleft()
                    if not stale.future.done():
                        stale.future.set_exception(QuotaWorkError("quota_timeout", "http_queue"))
                if kind == "background" and any(t.kind == kind for t in self.active):
                    continue
                if queue:
                    chosen = queue.popleft()
                    break
            if chosen is None:
                break
            self.active.add(chosen)
            chosen.future.set_result(None)

    async def run(self, operation, *, kind=None, deadline=None, timeout=30):
        kind = kind or work_class.get()
        deadline = deadline if deadline is not None else work_deadline.get()
        if kind not in self.queues:
            raise ValueError("invalid_directory_scheduling_class")
        if self.closed:
            raise QuotaWorkError("quota_shutdown", "http_queue")
        remaining(deadline, "http_queue")
        progress = work_progress.get()
        if progress is not None:
            progress["phase"] = "http_queue"
        # Every accepted ticket has one owner. A cancelled granted ticket is also
        # released; no permit can leak between future completion and resumption.
        if self.queued >= self.queue_limit:
            raise QuotaWorkError("quota_queue_full", "http_queue")
        ticket = _Ticket(kind, asyncio.get_running_loop().create_future(), deadline)
        self.queues[kind].append(ticket)
        self._dispatch()
        try:
            try:
                with trace_phase("quota_queue"):
                    async with asyncio.timeout_at(deadline):
                        await ticket.future
            except TimeoutError:
                raise QuotaWorkError("quota_timeout", "http_queue") from None
            if self.closed:
                raise QuotaWorkError("quota_shutdown", "http_queue")
            budget = remaining(deadline, "google")
            if progress is not None:
                progress["phase"] = "google"
            limit = min(timeout, budget) if budget is not None else timeout
            ticket.task = asyncio.create_task(operation(limit))
            with trace_phase("quota_google"):
                done, _ = await asyncio.wait([ticket.task], timeout=limit)
                if not done:
                    raise QuotaWorkError("quota_timeout", "google")
                if ticket.task.cancelled() and not asyncio.current_task().cancelling():
                    raise QuotaWorkError("quota_shutdown" if self.closed else "quota_cancelled", "google")
                return ticket.task.result()
        finally:
            if ticket in self.queues[kind]:
                self.queues[kind].remove(ticket)
            def release(done=None):
                if done is not None and not done.cancelled():
                    done.exception()
                self.active.discard(ticket)
                self._dispatch()
            if ticket.task is not None and not ticket.task.done():
                # Return within the caller's deadline even if transport cleanup
                # is slow, but retain its slot until the real IO has closed.
                ticket.task.cancel()
                ticket.task.add_done_callback(release)
            else:
                release()

    def begin_close(self):
        self.closed = True
        for queue in self.queues.values():
            while queue:
                ticket = queue.popleft()
                if not ticket.future.done():
                    ticket.future.set_exception(QuotaWorkError("quota_shutdown", "http_queue"))
        for ticket in tuple(self.active):
            if ticket.task:
                ticket.task.cancel()


class AtomicRegistry:
    """Reserve capacity before starting exactly one atomic operation.

    The caller may time out; a started database operation is retained until its
    result is observed. A pending result never authorizes the next operation.
    """
    def __init__(self, limit=200):
        self.limit = limit
        self.tasks = set()
        self.owners = {}
        self.awaiting_receipts = set()
        self.changed = asyncio.Event()
        self.closing = False
        self.close_deadline = None
        self.unknown = 0

    def start(self):
        self.closing = False
        self.close_deadline = None

    def _track(self, task):
        self.tasks.add(task)
        def finished(done):
            self.tasks.discard(done)
            if done not in self.awaiting_receipts:
                self.owners.pop(done, None)
            self.changed.set()
            if not done.cancelled():
                done.exception()  # Retrieve failures even after the waiter left.
        task.add_done_callback(finished)
        return task

    async def run(self, operation, *, deadline=None, phase="settlement", on_abandoned=None):
        deadline = deadline if deadline is not None else work_deadline.get()
        if self.closing:
            raise QuotaWorkError("quota_shutdown", phase)
        while len(self.tasks) >= self.limit:
            remaining(deadline, phase)
            self.changed.clear()
            try:
                async with asyncio.timeout_at(deadline):
                    await self.changed.wait()
            except TimeoutError:
                raise QuotaWorkError("quota_timeout", phase) from None
            if self.closing:
                raise QuotaWorkError("quota_shutdown", phase)
        remaining(deadline, phase)
        task = self._track(asyncio.create_task(operation()))
        self.owners[task] = (asyncio.current_task(), phase)
        self.awaiting_receipts.add(task)
        abandoned = False
        def cleanup(done):
            if abandoned and on_abandoned is not None and not done.cancelled():
                try:
                    value = done.result()
                except Exception:
                    return
                self.cleanup(lambda: on_abandoned(value))
        task.add_done_callback(cleanup)
        try:
            async with asyncio.timeout_at(deadline):
                return await asyncio.shield(task)
        except TimeoutError:
            abandoned = True
            raise SettlementPending(phase) from None
        except asyncio.CancelledError:
            abandoned = True
            raise
        finally:
            self.awaiting_receipts.discard(task)
            if task.done():
                self.owners.pop(task, None)

    def pending_phase(self, owner):
        return next((phase for task, (waiter, phase) in self.owners.items()
                     if waiter is owner), None)

    def cleanup_after(self, owner, operation):
        pending = next((task for task, (waiter, _) in self.owners.items()
                        if waiter is owner and not task.done()), None)
        if pending is None:
            return self.cleanup(operation)
        # Do not race lease removal against an unconfirmed result or token CAS.
        pending.add_done_callback(lambda done: self.cleanup(operation))
        return True

    def cleanup(self, operation):
        # Cleanup is the sole exception to "no new CAS after deadline". It must
        # only remove the caller's fenced lease, never produce new evidence.
        if len(self.tasks) >= self.limit or (self.close_deadline is not None and
                time.monotonic() >= self.close_deadline):
            return False  # Durable lease expiry is the bounded fallback.
        return self._track(asyncio.create_task(operation()))

    def begin_close(self, deadline):
        self.closing = True
        self.close_deadline = deadline
        self.changed.set()

    async def drain(self):
        while self.tasks:
            seconds = max(0, self.close_deadline - time.monotonic())
            if seconds <= 0:
                break
            self.changed.clear()
            try:
                async with asyncio.timeout(seconds):
                    await self.changed.wait()
            except TimeoutError:
                break
        self.unknown = len(self.tasks)
        return self.unknown


directory_broker = DirectoryBroker()
atomic_registry = AtomicRegistry()


def reset_directory_shutdown_signal():
    global _signal_close_requested
    _signal_close_requested = False


def start_directory_runtime():
    if _signal_close_requested:
        return  # A signal received during ASGI startup cannot reopen admission.
    directory_broker.start()
    atomic_registry.start()
    from src.antigravity_batch_runtime import batch_pool
    batch_pool.start()


def begin_directory_shutdown(*, from_signal=False, started_at=None):
    global _signal_close_requested
    _signal_close_requested = _signal_close_requested or from_signal
    if atomic_registry.closing and atomic_registry.close_deadline is not None:
        return atomic_registry.close_deadline
    from src.antigravity_panel_budget import shutdown_budgets, PanelBudgetConfigError
    from src.antigravity_batch_runtime import batch_pool
    from log import log
    started = time.monotonic() if started_at is None else started_at
    log.warning(f"[ANTIGRAVITY] shutdown started: pending_settlements={len(atomic_registry.tasks)}")
    try:
        config = shutdown_budgets()
        budget = config.shutdown()
        if config.S is None:
            log.warning("[ANTIGRAVITY] shutdown grace unknown; using 5 seconds")
    except PanelBudgetConfigError:
        budget = 0
        log.warning("[ANTIGRAVITY] invalid shutdown budget; no settlement wait")
    deadline = started + budget
    atomic_registry.begin_close(deadline)
    directory_broker.begin_close()
    batch_pool.begin_close()
    return deadline


async def wait_directory_shutdown(deadline):
    from src.antigravity_batch_runtime import batch_pool
    from log import log
    await batch_pool.wait_closed(deadline)
    transports = [ticket.task for ticket in directory_broker.active if ticket.task is not None]
    if transports:
        await asyncio.wait(transports, timeout=max(0, deadline - time.monotonic()))
    unknown = await atomic_registry.drain()
    if unknown:
        log.warning(f"[ANTIGRAVITY] shutdown settlement unknown: {unknown}; connection close is not rollback")
    return unknown
