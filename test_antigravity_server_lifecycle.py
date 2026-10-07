"""Offline regression coverage for signal deadlines and cancelled transports."""
import asyncio
import pickle
import os
import signal
import time
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from hypercorn.config import Config

from src.antigravity_directory_runtime import DirectoryBroker, AtomicRegistry, QuotaWorkError
import src.antigravity_directory_runtime as runtime
import src.antigravity_server_lifecycle as lifecycle


@pytest.fixture
def isolated_runtime(monkeypatch):
    import src.antigravity_batch_runtime as batch
    from log import log
    registry = AtomicRegistry()
    monkeypatch.setattr(runtime, "atomic_registry", registry)
    monkeypatch.setattr(runtime, "directory_broker", DirectoryBroker())
    monkeypatch.setattr(batch, "batch_pool", SimpleNamespace(begin_close=Mock(), start=Mock()))
    monkeypatch.setenv("ANTIGRAVITY_SHUTDOWN_GRACE_SECONDS", "5.2")
    messages = []
    monkeypatch.setattr(log, "warning", messages.append)
    runtime.reset_directory_shutdown_signal()
    yield registry, messages
    runtime.reset_directory_shutdown_signal()


async def test_broker_shutdown_is_safe_error_and_caller_cancel_propagates():
    for close in (True, False):
        broker = DirectoryBroker()
        entered = asyncio.Event()
        async def transport(timeout):
            entered.set()
            await asyncio.Event().wait()
        caller = asyncio.create_task(broker.run(transport))
        await entered.wait()
        if close:
            broker.begin_close()
            with pytest.raises(QuotaWorkError) as error:
                await caller
            assert (error.value.code, error.value.phase) == ("quota_shutdown", "google")
        else:
            caller.cancel()
            with pytest.raises(asyncio.CancelledError):
                await caller
        for _ in range(4):
            await asyncio.sleep(0)
        assert not broker.active and not broker.queued


async def test_transport_self_cancel_does_not_cancel_its_caller():
    broker = DirectoryBroker()
    async def transport(timeout):
        raise asyncio.CancelledError()
    with pytest.raises(QuotaWorkError) as error:
        await broker.run(transport)
    assert error.value.code == "quota_cancelled"
    assert not asyncio.current_task().cancelling()


async def test_begin_shutdown_logs_pending_immediately_and_keeps_deadline(isolated_runtime):
    registry, messages = isolated_runtime
    gate = asyncio.Event()
    task = registry.cleanup(gate.wait)
    first = runtime.begin_directory_shutdown(from_signal=True)
    assert "pending_settlements=1" in messages[0]
    await asyncio.sleep(.01)
    assert runtime.begin_directory_shutdown() == first
    runtime.start_directory_runtime()
    assert registry.closing and runtime.directory_broker.closed
    gate.set()
    await task


async def test_actual_hypercorn_signal_precedes_lifespan_close(isolated_runtime, monkeypatch):
    registry, messages = isolated_runtime
    monkeypatch.setenv("ANTIGRAVITY_SHUTDOWN_GRACE_SECONDS", "5.15")
    config = Config()
    config.bind = ["127.0.0.1:0"]
    config.accesslog = config.errorlog = None
    phases = []
    old_handler = signal.getsignal(signal.SIGTERM)
    async def app(scope, receive, send):
        assert scope["type"] == "lifespan"
        assert (await receive())["type"] == "lifespan.startup"
        await send({"type": "lifespan.startup.complete"})
        asyncio.get_running_loop().call_later(.02, signal.raise_signal, signal.SIGTERM)
        assert (await receive())["type"] == "lifespan.shutdown"
        phases.append((registry.closing, registry.close_deadline, config.graceful_timeout))
        await send({"type": "lifespan.shutdown.complete"})
    async with asyncio.timeout(2):
        await lifecycle.serve_with_directory_shutdown(app, config)
    assert signal.getsignal(signal.SIGTERM) == old_handler
    assert phases[0][0] and 0 <= phases[0][2] <= .15
    assert phases[0][1] <= time.monotonic() + .15
    assert messages[0].endswith("pending_settlements=0")


@pytest.mark.parametrize("grace, maximum", [("5", 0), (None, 5), ("unbounded", 30)])
async def test_trigger_caps_hypercorn_drain_and_starts_before_startup(isolated_runtime, monkeypatch, grace, maximum):
    registry, _ = isolated_runtime
    if grace is None:
        monkeypatch.delenv("ANTIGRAVITY_SHUTDOWN_GRACE_SECONDS")
    else:
        monkeypatch.setenv("ANTIGRAVITY_SHUTDOWN_GRACE_SECONDS", grace)
    event = asyncio.Event()
    config = Config()
    config.graceful_timeout = 90
    signal_time = time.monotonic() - .02
    event.set()
    async def serve(app, config, shutdown_trigger):
        await asyncio.sleep(.01)  # Synthetic ASGI startup before server drain.
        assert registry.closing
        assert registry.close_deadline == pytest.approx(signal_time + maximum)
        runtime.start_directory_runtime()
        assert registry.closing
        await shutdown_trigger()
        assert config.graceful_timeout <= max(0, maximum - .02)
    await lifecycle._serve_with_trigger(serve, None, config, shutdown_trigger=event.wait,
                                         started_at=lambda: signal_time)


def test_picklable_worker_adapter_preserves_server_arguments_and_restores(monkeypatch, isolated_runtime):
    import hypercorn.asyncio.run as worker
    registry, _ = isolated_runtime
    original = worker.worker_serve
    socket_marker = object()
    signal_time = time.monotonic() - .04
    event = lifecycle._TimedShutdownEvent(SimpleNamespace(is_set=lambda: True), SimpleNamespace(value=signal_time))
    calls = []
    async def original_serve(app, config, *, sockets, shutdown_trigger):
        await shutdown_trigger()
        assert registry.closing
        assert registry.close_deadline == pytest.approx(signal_time + .2)
        calls.append((app, sockets, config.graceful_timeout))
    def original_worker(config, sockets, shutdown_event):
        assert shutdown_event is event
        async def trigger():
            return None
        asyncio.run(worker.worker_serve("synthetic_app", config, sockets=sockets, shutdown_trigger=trigger))
    monkeypatch.setattr(worker, "worker_serve", original_serve)
    monkeypatch.setattr(lifecycle, "_original_asyncio_worker", original_worker)
    lifecycle.directory_asyncio_worker(Config(), socket_marker, event)
    assert worker.worker_serve is original_serve
    assert calls[0][:2] == ("synthetic_app", socket_marker)
    assert calls[0][2] < .17
    assert pickle.loads(pickle.dumps(lifecycle.directory_asyncio_worker)) is lifecycle.directory_asyncio_worker


def test_installed_hypercorn_interface_is_supported_and_unknown_rejected(monkeypatch):
    lifecycle._validate_worker_adapter(Config())
    monkeypatch.setattr(lifecycle, "version", lambda name: "99.0.0")
    with pytest.raises(RuntimeError, match="Unsupported Hypercorn"):
        lifecycle._validate_worker_adapter(Config())


def test_timed_parent_event_records_first_signal_and_reset():
    from multiprocessing import get_context
    event = lifecycle._TimedContext(get_context("spawn")).Event()
    start = time.monotonic()
    event.set()
    first = event.started_at
    event.set()
    assert event.is_set() and start <= first <= time.monotonic()
    assert event.started_at == first
    event.clear()
    assert not event.is_set() and event.started_at is None


async def test_completed_atomic_receipt_is_pending_until_owner_consumes():
    registry = AtomicRegistry()
    observed = []
    gate = asyncio.Event()
    async def write():
        await gate.wait()
        return "committed"
    caller = asyncio.create_task(registry.run(write, phase="model_access"))
    await asyncio.sleep(0)
    atomic = next(iter(registry.tasks))
    # Register before shield resumes its owner; _track.finished runs first.
    atomic.add_done_callback(lambda done: observed.append(registry.pending_phase(caller)))
    gate.set()
    assert await caller == "committed"
    assert observed == ["model_access"]
    assert not registry.owners and not registry.awaiting_receipts


async def test_google_failure_is_preserved_when_its_evidence_cas_is_pending(monkeypatch):
    from unittest.mock import AsyncMock
    from src.panel import antigravity_manual as manual
    from src.panel import creds
    registry = AtomicRegistry()
    gate = asyncio.Event()
    async def observe(*args, **kwargs):
        await gate.wait()
        return {"applied": True, "public": {}, "families": {}}
    backend = SimpleNamespace(model_access_storage_ready=True,
        model_access_observe_with_projection=observe, manual_sync_quota=AsyncMock())
    monkeypatch.setattr(manual, "atomic_registry", registry)
    monkeypatch.setattr(manual, "prepare", AsyncMock(return_value=(
        SimpleNamespace(_backend=backend), {"generation":"synthetic"}, {"token":"synthetic"})))
    monkeypatch.setattr(creds, "fetch_quota_info", AsyncMock(return_value={
        "success":False, "upstream_status":403, "response_source":"google", "error":"Denied."}))
    progress = {}
    result = await manual.quota("synthetic.json", sync=True, deadline=time.monotonic()+.02, _progress=progress)
    assert result["success"] is False and result["status_code"] == 403
    assert result["upstream_status"] == 403 and result["response_source"] == "google"
    assert result["model_access_update"]["status"] == "pending"
    assert result["state_update"]["model_access"]["status"] == "pending"
    assert progress["phase"] == "model_access"
    backend.manual_sync_quota.assert_not_called()
    gate.set()
    await asyncio.gather(*registry.tasks)


@pytest.mark.parametrize("phase", ["model_access", "quota_sync"])
async def test_batch_cancel_after_commit_before_receipt_is_pending(monkeypatch, phase):
    from src.panel import antigravity_manual as manual
    from src.antigravity_batch_runtime import BatchQuotaPool
    registry = AtomicRegistry()
    pool = BatchQuotaPool(workers=1)
    gate, entered = asyncio.Event(), asyncio.Event()
    writes = []
    job = None
    async def quota(filename, **kwargs):
        kwargs["_on_started"]()
        kwargs["_on_result"]({"filename":filename, "success":True, "status_code":200})
        kwargs["_progress"]["phase"] = phase
        async def save():
            entered.set()
            await gate.wait()
            writes.append("committed")
            asyncio.get_running_loop().call_soon(pool.cancel, job, "quota_timeout")
            return {"applied": True}
        await registry.run(save, phase=phase)
    monkeypatch.setattr(runtime, "atomic_registry", registry)
    monkeypatch.setattr(manual, "quota", quota)
    job = pool.submit(["synthetic.json"], object(), time.monotonic()+1)[0]
    await entered.wait()
    gate.set()
    result = await job.future
    assert writes == ["committed"]
    assert result["success"] and result["status_code"] == 200
    assert result["state_update"][phase]["status"] == "pending"
    pool.begin_close()
    await pool.wait_closed(time.monotonic()+1)
    await asyncio.sleep(0)
    assert not registry.owners and not registry.awaiting_receipts and not registry.tasks


@pytest.mark.parametrize("failure", [False, True])
async def test_server_early_exit_starts_shutdown(isolated_runtime, failure):
    registry, messages = isolated_runtime
    async def serve(app, config, shutdown_trigger):
        if failure:
            raise RuntimeError("synthetic startup failure")
        return 42
    if failure:
        with pytest.raises(RuntimeError, match="synthetic startup failure"):
            await lifecycle._serve_with_trigger(serve, None, Config())
    else:
        assert await lifecycle._serve_with_trigger(serve, None, Config()) == 42
    assert registry.closing and "pending_settlements=0" in messages[0]
    await asyncio.sleep(0)


@pytest.mark.parametrize("budget", ["zero", "unknown"])
@pytest.mark.parametrize("runner", ["single", "worker"])
def test_real_hypercorn_slow_startup_signal_has_bounded_cleanup_subprocess(budget, runner):
    """No application imports, credentials, database, or external network IO."""
    import json
    import os
    import subprocess
    import sys
    import textwrap
    script = textwrap.dedent('''
        import asyncio, json, os, signal, time
        from types import SimpleNamespace
        from hypercorn.config import Config
        import src.antigravity_panel_budget as budgets
        import src.antigravity_directory_runtime as runtime
        import src.antigravity_server_lifecycle as lifecycle
        from log import log
        # Capture only synthetic safe diagnostics independently of production
        # logging configuration (the isolated suite sets ENABLE_LOG=0).
        log.warning = lambda message: print(message)
        selected = os.environ['SYNTHETIC_SHUTDOWN_TEST_BUDGET']
        if selected == 'zero':
            os.environ['ANTIGRAVITY_SHUTDOWN_GRACE_SECONDS'] = '5'
        else:
            os.environ.pop('ANTIGRAVITY_SHUTDOWN_GRACE_SECONDS', None)
            # Preserve the unknown-domain branch while shortening the test.
            budgets.shutdown_budgets = lambda: SimpleNamespace(S=None, shutdown=lambda: .04)
        config = Config()
        config.bind = ['127.0.0.1:0']
        config.accesslog = config.errorlog = None
        signalled = []
        def stop():
            signalled.append(time.monotonic())
            signal.raise_signal(signal.SIGTERM)
        async def app(scope, receive, send):
            assert (await receive())['type'] == 'lifespan.startup'
            asyncio.get_running_loop().call_later(.02, stop)
            # Deliberately resist cleanup to reproduce Runner.close's former
            # unbounded gather, even though Hypercorn startup_timeout is 60s.
            while True:
                try:
                    await asyncio.sleep(60)
                except asyncio.CancelledError:
                    pass
        if os.environ['SYNTHETIC_SHUTDOWN_TEST_RUNNER'] == 'single':
            lifecycle.run_directory_main(lifecycle.serve_with_directory_shutdown(app, config))
        else:
            lifecycle._run_worker(lambda **kwargs: lifecycle.serve_with_directory_shutdown(app, config))
        print(json.dumps({'elapsed':time.monotonic()-signalled[0],
                          'closing':runtime.atomic_registry.closing,
                          'retained':len(lifecycle._retained_tasks)}))
    ''')
    env = {**os.environ, "SYNTHETIC_SHUTDOWN_TEST_BUDGET":budget,
           "SYNTHETIC_SHUTDOWN_TEST_RUNNER":runner, "ANTIGRAVITY_PANEL_TIMING_SAMPLE_RATE":"0"}
    child = subprocess.run([sys.executable, "-X", "utf8", "-c", script],
                           capture_output=True, text=True, env=env, timeout=5)
    assert child.returncode == 0, child.stderr
    result = json.loads(child.stdout.strip().splitlines()[-1])
    assert result["closing"] and result["retained"] > 0
    assert result["elapsed"] < .5
    assert "results unknown, not rollback" in child.stdout + child.stderr


async def test_signal_only_schedules_shutdown_and_keeps_first_time(isolated_runtime, monkeypatch):
    registry, _ = isolated_runtime
    loop = asyncio.get_running_loop()
    original = loop.call_soon_threadsafe
    previous = signal.getsignal(signal.SIGTERM)
    wakeups = []
    first = []
    def wake(callback, *args, **kwargs):
        # The handler must not mutate broker/pool/registry/config state while
        # it can be interrupting their bookkeeping between Python bytecodes.
        assert not registry.closing and registry.close_deadline is None
        wakeups.append(callback)
        return original(callback, *args, **kwargs)
    monkeypatch.setattr(loop, "call_soon_threadsafe", wake)
    async def serve(app, config, shutdown_trigger):
        first.append(time.monotonic())
        signal.raise_signal(signal.SIGTERM)
        first.append(time.monotonic())
        assert not registry.closing
        time.sleep(.01)  # No await: emulate an interrupted accounting callback.
        signal.raise_signal(signal.SIGTERM)
        assert not registry.closing and config.graceful_timeout == 3
        await shutdown_trigger()
        assert first[0] + .2 <= registry.close_deadline <= first[1] + .2
    await lifecycle._serve_with_trigger(serve, None, Config())
    assert len(wakeups) == 1
    assert registry.closing
    assert signal.getsignal(signal.SIGTERM) == previous
    await asyncio.sleep(0)


@pytest.mark.skipif(os.name != "posix", reason="Requires POSIX external SIGTERM and idle selector; Windows uses wakeup spy coverage")
def test_posix_external_signal_wakes_idle_hypercorn_startup():
    """Signal arrives from the parent while the child's selector is asleep."""
    import select
    import subprocess
    import sys
    import textwrap
    script = textwrap.dedent('''
        import asyncio, os
        from hypercorn.config import Config
        import src.antigravity_server_lifecycle as lifecycle
        from log import log
        log.warning = lambda message: None
        os.environ['ANTIGRAVITY_SHUTDOWN_GRACE_SECONDS'] = '5'
        config = Config()
        config.bind = ['127.0.0.1:0']
        config.accesslog = config.errorlog = None
        async def app(scope, receive, send):
            assert (await receive())['type'] == 'lifespan.startup'
            print('READY', flush=True)
            # No heartbeat or short timer can accidentally wake this selector.
            await asyncio.Event().wait()
        lifecycle.run_directory_main(lifecycle.serve_with_directory_shutdown(app, config))
        print('CLOSED', flush=True)
    ''')
    child = subprocess.Popen([sys.executable, "-X", "utf8", "-u", "-c", script],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                             env={**os.environ, "ENABLE_LOG":"0"})
    try:
        assert select.select([child.stdout], [], [], 3)[0], "synthetic child did not reach startup"
        assert child.stdout.readline().strip() == "READY"
        time.sleep(.1)  # Let the selector enter its idle wait before OS delivery.
        sent = time.monotonic()
        child.send_signal(signal.SIGTERM)
        stdout, stderr = child.communicate(timeout=2)
        assert child.returncode == 0, stderr
        assert "CLOSED" in stdout and time.monotonic()-sent < 1
    finally:
        if child.poll() is None:
            child.kill()
            child.communicate(timeout=2)


async def test_early_server_return_keeps_signal_time_before_callback_runs(isolated_runtime, monkeypatch):
    registry, _ = isolated_runtime
    queued = []
    loop = asyncio.get_running_loop()
    # Deliberately hold the wake callback to cover the early-return/finally
    # branch independently of the event loop's usual ready-queue ordering.
    monkeypatch.setattr(loop, "call_soon_threadsafe", lambda callback: queued.append(callback))
    first = []
    async def serve(app, config, shutdown_trigger):
        first.append(time.monotonic())
        signal.raise_signal(signal.SIGTERM)
        first.append(time.monotonic())
        time.sleep(.02)
        signal.raise_signal(signal.SIGTERM)
        assert not registry.closing
        return 42
    assert await lifecycle._serve_with_trigger(serve, None, Config()) == 42
    assert len(queued) == 1
    assert first[0]+.2 <= registry.close_deadline <= first[1]+.2
    await asyncio.sleep(0)
