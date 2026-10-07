"""Five process-wide batch workers, bounded admission, and per-request rotation."""
import asyncio
import time
from collections import OrderedDict, deque
from dataclasses import dataclass, field

from src.antigravity_panel_budget import panel_work_budget, PanelBudgetConfigError


@dataclass(eq=False)
class _Job:
    filename: str
    request_id: object
    deadline: float
    future: asyncio.Future
    task: asyncio.Task | None = None
    started: bool = False
    result: dict | None = None
    progress: dict = field(default_factory=lambda: {"phase": "worker_queue"})


def _error(job, code, phase):
    from src.panel.antigravity_manual import quota_error
    return quota_error(job.filename, code, phase, started=job.started)


class BatchQuotaPool:
    def __init__(self, workers=5, queue_limit=200):
        self.worker_count, self.queue_limit = workers, queue_limit
        self.queues = OrderedDict()
        self.active = set()
        self.workers = []
        self.wake = asyncio.Event()
        self.closed = False

    @property
    def queued(self):
        return sum(map(len, self.queues.values()))

    def start(self):
        self.closed = False

    def _ensure_workers(self):
        self.workers = [task for task in self.workers if not task.done()]
        self.workers.extend(asyncio.create_task(self._worker())
                            for _ in range(self.worker_count - len(self.workers)))

    def submit(self, filenames, request_id, deadline):
        loop = asyncio.get_running_loop()
        jobs = []
        for filename in filenames:
            job = _Job(filename, request_id, deadline, loop.create_future())
            jobs.append(job)
            if self.closed:
                job.future.set_result(_error(job, "quota_shutdown", "worker_queue"))
            elif self.queued >= self.queue_limit:
                job.future.set_result(_error(job, "quota_queue_full", "worker_queue"))
            elif deadline <= time.monotonic():
                job.future.set_result(_error(job, "quota_timeout", "worker_queue"))
            else:
                self.queues.setdefault(request_id, deque()).append(job)
        if self.queues and not self.closed:
            self._ensure_workers()
            self.wake.set()
        return jobs

    def cancel(self, job, code="quota_cancelled"):
        queue = self.queues.get(job.request_id)
        if queue and job in queue:
            queue.remove(job)
            if not queue:
                self.queues.pop(job.request_id, None)
        from src.antigravity_directory_runtime import atomic_registry
        phase = atomic_registry.pending_phase(job.task) if job.task else None
        stage = phase or (job.progress.get("phase", "preparation") if job.started else "worker_queue")
        if job.task:
            job.task.cancel()
        if not job.future.done():
            if job.result is not None:
                result = {**job.result, "state_update": dict(job.result.get("state_update", {})),
                          "error_code": code, "phase": stage, "started": job.started}
                update = {"status": "pending" if phase else "skipped",
                          "reason": "settlement_unconfirmed" if phase else code}
                result["state_update"][stage] = update
                if phase == "model_access":
                    result["model_access_update"] = update
            else:
                result = _error(job, code, stage)
                if phase:
                    result["state_update"] = {phase: {"status": "pending", "reason": "settlement_unconfirmed"}}
            job.future.set_result(result)

    async def _worker(self):
        from src.panel.antigravity_manual import quota
        while not self.closed:
            if not self.queues:
                return
            request_id, queue = self.queues.popitem(last=False)
            job = queue.popleft()
            if queue:
                self.queues[request_id] = queue
            if job.future.done():
                continue
            if job.deadline <= time.monotonic():
                job.future.set_result(_error(job, "quota_timeout", "worker_queue"))
                continue
            self.active.add(job)
            try:
                job.task = asyncio.create_task(quota(job.filename, sync=True,
                    scheduling_class="batch", deadline=job.deadline,
                    _on_started=lambda j=job: setattr(j, "started", True),
                    _on_result=lambda result, j=job: setattr(j, "result", result),
                    _progress=job.progress))
                result = await job.task
                if not job.future.done():
                    job.future.set_result(result)
            except asyncio.CancelledError:
                if not job.future.done():
                    job.future.set_result(_error(job, "quota_shutdown" if self.closed else "quota_cancelled",
                                                job.progress.get("phase", "preparation") if job.started else "worker_queue"))
                if self.closed or asyncio.current_task().cancelling():
                    raise
            except Exception:
                if not job.future.done():
                    job.future.set_result(_error(job, "quota_failed", job.progress.get("phase", "preparation") if job.started else "worker_queue"))
            finally:
                self.active.discard(job)

    def begin_close(self):
        self.closed = True
        queued = [job for queue in self.queues.values() for job in queue]
        for job in queued + list(self.active):
            self.cancel(job, "quota_shutdown")
        self.wake.set()
        for worker in self.workers:
            worker.cancel()

    async def wait_closed(self, deadline):
        if self.workers:
            await asyncio.wait(self.workers, timeout=max(0, deadline - time.monotonic()))


batch_pool = BatchQuotaPool()


async def batch_quota(filenames, request=None):
    from src.panel.antigravity_manual import quota_error
    filenames = list(filenames)
    try:
        request_budget = panel_work_budget(len(filenames))
    except PanelBudgetConfigError:
        return [quota_error(name, "quota_budget_configuration", "config") for name in filenames]
    request_deadline = time.monotonic() + request_budget
    request_id = object()
    results, current = [], []
    try:
        for offset in range(0, len(filenames), 10):
            # A legacy large request progresses in bounded windows. The old
            # request's nominal/T/L budget never resets between windows.
            if request_deadline <= time.monotonic():
                # No job/Future or prepare is created for an unadmitted window.
                results.extend(quota_error(name, "quota_timeout", "request_budget")
                               for name in filenames[offset:])
                return results
            window = filenames[offset:offset + 10]
            deadline = min(request_deadline, time.monotonic() + 50)
            current = batch_pool.submit(window, request_id, deadline)
            pending = {job.future for job in current if not job.future.done()}
            while pending:
                seconds = deadline - time.monotonic()
                if seconds <= 0:
                    for job in current:
                        if not job.future.done():
                            # The shared progress records the actual OAuth,
                            # queue/HTTP or CAS phase before cancellation.
                            batch_pool.cancel(job, "quota_timeout")
                    break
                if request is not None and callable(getattr(request, "is_disconnected", None)):
                    if await request.is_disconnected():
                        for job in current:
                            batch_pool.cancel(job)
                        results.extend(job.future.result() for job in current)
                        results.extend(quota_error(name, "quota_cancelled", "worker_queue")
                                       for name in filenames[offset + len(window):])
                        return results
                _, pending = await asyncio.wait(pending, timeout=min(seconds, .2))
            results.extend(job.future.result() for job in current)
            current = []
        return results
    except asyncio.CancelledError:
        for job in current:
            batch_pool.cancel(job)
        raise
