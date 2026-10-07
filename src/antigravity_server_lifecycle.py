"""Primary Hypercorn entrypoints with one signal-to-close deadline.

Third-party ASGI hosts own their signal and drain policy; lifespan alone cannot
promise an OS-signal deadline. Hypercorn's supported asyncio worker is adapted
in its child process, preserving the server's application/socket setup.
"""
import asyncio
import inspect
import signal
import time
from importlib.metadata import version

from hypercorn.asyncio.run import asyncio_worker as _original_asyncio_worker
_retained_tasks = set()

from src.antigravity_directory_runtime import (
    begin_directory_shutdown, reset_directory_shutdown_signal,
)


def _begin(config, started_at=None):
    deadline = begin_directory_shutdown(from_signal=True, started_at=started_at)
    config.graceful_timeout = min(config.graceful_timeout, max(0, deadline-time.monotonic()))
    return deadline


async def _serve_with_trigger(serve, app, config, *, shutdown_trigger=None,
                              started_at=None, **kwargs):
    reset_directory_shutdown_signal()
    event = asyncio.Event()
    loop = asyncio.get_running_loop()
    previous = {}
    signal_time = None
    close_scheduled = False
    if shutdown_trigger is None:
        # A signal can interrupt queue bookkeeping between bytecodes. Only
        # record its time here; all runtime/config/log mutations run normally
        # on the loop after the interrupted callback has finished.
        def close_on_loop():
            _begin(config, signal_time)
            event.set()
        def received(signum, frame):
            nonlocal signal_time, close_scheduled
            received_at = time.monotonic()
            if signal_time is None or received_at < signal_time:
                signal_time = received_at
            # Also wake a POSIX selector restarted after EINTR (PEP 475).
            if not close_scheduled:
                close_scheduled = True
                loop.call_soon_threadsafe(close_on_loop)
        for name in ("SIGINT", "SIGTERM", "SIGBREAK"):
            if hasattr(signal, name):
                sig = getattr(signal, name)
                previous[sig] = signal.signal(sig, received)
        shutdown_trigger = event.wait

    async def watch():
        await shutdown_trigger()
        return _begin(config, started_at() if started_at is not None else None)

    # Start watching before ASGI startup: a slow startup must not defer the
    # shutdown clock or reopen directory admission after receiving the event.
    watcher = asyncio.create_task(watch())
    async def trigger():
        await watcher

    server = asyncio.create_task(serve(app, config, shutdown_trigger=trigger, **kwargs))
    try:
        await asyncio.wait([server, watcher], return_when=asyncio.FIRST_COMPLETED)
        if not server.done():
            deadline = watcher.result()
            await asyncio.wait([server], timeout=max(0, deadline-time.monotonic()))
        if server.done():
            return server.result()
        # Startup and shutdown may both be blocked inside Hypercorn. Cancelling
        # requests cleanup, but cannot grant cleanup an additional grace period.
        server.cancel()
    finally:
        received_at = signal_time if signal_time is not None else (started_at() if started_at is not None else None)
        _begin(config, received_at)
        for task in (server, watcher):
            if not task.done():
                task.cancel()
            _retain(task)
        for sig, handler in previous.items():
            signal.signal(sig, handler)


def _retain(task):
    _retained_tasks.add(task)
    def finished(done):
        _retained_tasks.discard(done)
        if not done.cancelled():
            done.exception()
    task.add_done_callback(finished)


def run_directory_main(coroutine, *, debug=False, loop_factory=None):
    """Bound application cleanup without asyncio.Runner's unbounded gather.

    Loop close does not confirm or roll back pending writes. Driver/executor
    threads and OS process teardown are outside this async waiting guarantee.
    """
    import src.antigravity_directory_runtime as runtime
    from log import log
    loop = loop_factory() if loop_factory is not None else asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    loop.set_debug(debug)
    try:
        return loop.run_until_complete(coroutine)
    finally:
        async def finish():
            deadline = runtime.begin_directory_shutdown()
            current = asyncio.current_task()
            pending = {task for task in asyncio.all_tasks() if task is not current}
            # Started atomic writes retain their chance to settle until the
            # original deadline. Unrelated server tasks receive cancellation.
            for task in pending - runtime.atomic_registry.tasks:
                task.cancel()
            if pending and deadline > time.monotonic():
                await asyncio.wait(pending, timeout=max(0, deadline-time.monotonic()))
            for task in pending:
                _retain(task)
            unfinished = sum(not task.done() for task in pending)
            if unfinished:
                log.warning(f"[ANTIGRAVITY] loop close: pending_tasks={unfinished}; "
                            f"pending_settlements={len(runtime.atomic_registry.tasks)}; results unknown, not rollback")
        try:
            loop.run_until_complete(finish())
        finally:
            asyncio.set_event_loop(None)
            loop.close()
            runtime.reset_directory_shutdown_signal()


def _run_worker(main, *, debug=False, shutdown_trigger=None, loop_factory=None):
    return run_directory_main(main(shutdown_trigger=shutdown_trigger), debug=debug, loop_factory=loop_factory)


async def serve_with_directory_shutdown(app, config):
    from hypercorn.asyncio import serve
    return await _serve_with_trigger(serve, app, config)


class _TimedShutdownEvent:
    """Spawn-safe event carrying the parent's actual signal time."""
    def __init__(self, event, timestamp):
        self.event, self.timestamp = event, timestamp

    def set(self):
        if not self.event.is_set():
            self.timestamp.value = time.monotonic()
        self.event.set()

    def clear(self):
        self.event.clear()
        self.timestamp.value = 0

    def is_set(self):
        return self.event.is_set()

    @property
    def started_at(self):
        return self.timestamp.value or None


class _TimedContext:
    def __init__(self, context):
        self.context = context

    def Event(self):
        return _TimedShutdownEvent(self.context.Event(), self.context.Value("d", 0, lock=False))

    def __getattr__(self, name):
        return getattr(self.context, name)


def directory_asyncio_worker(config, sockets=None, shutdown_event=None):
    """Picklable worker target; patch worker_serve only in this child."""
    import hypercorn.asyncio.run as worker_module
    original_serve, original_run = worker_module.worker_serve, worker_module._run

    async def serve(app, config, *, sockets=None, shutdown_trigger=None):
        started_at = (lambda: shutdown_event.started_at) if isinstance(shutdown_event, _TimedShutdownEvent) else None
        return await _serve_with_trigger(original_serve, app, config, sockets=sockets,
                                         shutdown_trigger=shutdown_trigger, started_at=started_at)

    worker_module.worker_serve, worker_module._run = serve, _run_worker
    try:
        return _original_asyncio_worker(config, sockets, shutdown_event)
    finally:
        worker_module.worker_serve, worker_module._run = original_serve, original_run


def _validate_worker_adapter(config):
    import hypercorn.asyncio.run as worker_module
    import hypercorn.run as runner
    release = tuple(int(part) for part in version("hypercorn").split(".")[:2])
    valid = (
        release in {(0, 17), (0, 18)} and config.worker_class == "asyncio"
        and {"config", "sockets", "shutdown_event"} <= set(inspect.signature(_original_asyncio_worker).parameters)
        and {"app", "config", "sockets", "shutdown_trigger"} <= set(inspect.signature(worker_module.worker_serve).parameters)
        and {"get_context", "asyncio_worker"} <= set(runner.run.__code__.co_names)
        and {"worker_serve", "_run"} <= set(_original_asyncio_worker.__code__.co_names)
        and {"main", "debug", "shutdown_trigger"} <= set(inspect.signature(worker_module._run).parameters)
    )
    if not valid:
        raise RuntimeError("Unsupported Hypercorn worker interface for Antigravity shutdown deadlines")


def run_directory_workers(config):
    import hypercorn.asyncio.run as worker_module
    import hypercorn.run as runner
    _validate_worker_adapter(config)
    original_worker, original_context = worker_module.asyncio_worker, runner.get_context
    # Hypercorn 0.17/0.18 accepts only built-in worker names. Its parent chooses
    # this picklable target; all actual worker_serve wrapping stays in children.
    worker_module.asyncio_worker = directory_asyncio_worker
    runner.get_context = lambda method: _TimedContext(original_context(method))
    try:
        return runner.run(config)
    finally:
        worker_module.asyncio_worker, runner.get_context = original_worker, original_context
