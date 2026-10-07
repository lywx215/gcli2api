"""Bounded directory checks and restart-safe automatic access recovery."""
import asyncio
import time

from log import log
from src.antigravity_model_access import access_model, check_due, eligible
from src.antigravity_directory_runtime import atomic_registry, QuotaWorkError, SettlementPending, work_deadline

QUERY_TIMEOUT = 10
SELECTION_TIMEOUT = 30
SCAN_INTERVAL = 60


class ModelAccessService:
    def __init__(self):
        self._task = None
        self._workers = []

    async def check(self, manager, filename, data=None, *, force=False, model=None,
                    scheduling_class="background", deadline=None):
        backend = manager._storage_adapter._backend
        end = min(deadline, time.monotonic() + QUERY_TIMEOUT) if deadline is not None else time.monotonic() + QUERY_TIMEOUT
        # Leave a small part of the existing attempt budget for the fenced
        # failure observation; OAuth/HTTP timeout must not lose durable backoff.
        io_end = end - min(.5, QUERY_TIMEOUT * .5)
        snapshot = None
        settled = False
        async def clear(value):
            if value:
                return await backend.model_access_clear_lease(filename, value["generation"], value["lease_id"])
        async def observe(models=None, reason=None):
            return await atomic_registry.run(lambda: backend.model_access_observe(
                filename, snapshot, models, reason=reason), deadline=end, phase="model_access")
        try:
            async with asyncio.timeout_at(end):
                snapshot = await atomic_registry.run(
                    lambda: backend.model_access_claim(filename, force=force, model=model),
                    deadline=end, phase="claim", on_abandoned=clear)
                if snapshot is None:
                    return False
                try:
                    async with asyncio.timeout_at(io_end):
                        data = await backend.quota_current_credential(filename, snapshot["generation"])
                        if data is not None and await manager._should_refresh_token(data):
                            data = await manager._refresh_token(data, filename, mode="antigravity",
                                deadline=io_end, atomic=atomic_registry.run)
                            if data:
                                snapshot["version"] = data["_quota_credential_version"]
                        if data is None:
                            result = {"success": False}
                        else:
                            from src.api.antigravity import fetch_quota_info
                            result = await fetch_quota_info(data.get("access_token") or data.get("token"),
                                timeout=QUERY_TIMEOUT, scheduling_class=scheduling_class, deadline=io_end)
                    if result.get("error_code") and result.get("phase") == "http_queue":
                        return False
                    applied = await observe(result["models"] if result.get("success") else None,
                        None if result.get("success") else "directory_query_failed")
                    settled = bool(applied)
                    return applied if data is not None else False
                except SettlementPending:
                    return False
                except (TimeoutError, QuotaWorkError) as exc:
                    if atomic_registry.pending_phase(asyncio.current_task()) is not None:
                        return False
                    if isinstance(exc, QuotaWorkError) and exc.code == "quota_shutdown":
                        return False
                    settled = bool(await observe(reason="directory_timeout"))
                    return False
                except Exception:
                    settled = bool(await observe(reason="directory_query_failed"))
                    return False
        except (TimeoutError, QuotaWorkError):
            return False
        finally:
            if snapshot is not None and not settled:
                cleanup = atomic_registry.cleanup_after(asyncio.current_task(), lambda: clear(snapshot))
                if isinstance(cleanup, asyncio.Task) and not asyncio.current_task().cancelling():
                    # Normal early returns can finish their quick lease cleanup
                    # within the original attempt budget. Timeout/cancel paths
                    # retain it in the registry for lifecycle draining.
                    await asyncio.wait([cleanup], timeout=max(0, end - time.monotonic()))

    async def select(self, manager, model, excluded):
        backend = manager._storage_adapter._backend
        if not getattr(backend, "model_access_storage_ready", False):
            return None
        target = access_model(model)
        excluded = set(excluded or ())
        from src.antigravity_limits import current_budget
        budget = current_budget.get()
        remaining = getattr(budget, "model_access_remaining", SELECTION_TIMEOUT)
        if remaining <= 0:
            result = await manager._get_valid_credential_unchecked("antigravity", model, excluded)
            if result:
                snapshot = await backend.model_access_snapshot(result[0])
                if snapshot and eligible(snapshot["access"], target):
                    return result
            return None
        started = time.monotonic()
        deadline_token = work_deadline.set(started + remaining)
        try:
            async with asyncio.timeout(max(0.001, remaining)):
                while True:
                    batch = []
                    for _ in range(2):
                        result = await manager._get_valid_credential_unchecked("antigravity", model, excluded)
                        if not result:
                            break
                        filename, data = result
                        excluded.add(filename)
                        snapshot = await backend.model_access_snapshot(filename)
                        if snapshot and eligible(snapshot["access"], target):
                            return result
                        # A different version being due must not turn this
                        # request into an early recheck of its paused version.
                        if snapshot and not check_due(snapshot["access"], target):
                            continue
                        await atomic_registry.run(lambda: backend.model_access_queue(filename),
                            deadline=started + remaining, phase="claim")
                        batch.append(result)
                    if not batch:
                        return None
                    await asyncio.gather(*(self.check(manager, filename, data, model=target, scheduling_class="business", deadline=started + remaining) for filename, data in batch),
                                         return_exceptions=True)
                    for filename, _ in batch:
                        snapshot = await backend.model_access_snapshot(filename)
                        if snapshot and eligible(snapshot["access"], target):
                            data = await backend.quota_current_credential(filename, snapshot["generation"])
                            if data:
                                return filename, data
        except (TimeoutError, ValueError, TypeError, QuotaWorkError):
            return None
        finally:
            work_deadline.reset(deadline_token)
            if budget is not None:
                budget.model_access_remaining = max(0, remaining - (time.monotonic() - started))

    async def scan(self, manager):
        backend = manager._storage_adapter._backend
        names = await backend.model_access_due()
        # Fixed workers avoid creating an unbounded task pool.
        queue = asyncio.Queue()
        for name in names:
            queue.put_nowait(name)
        async def worker():
            while not queue.empty():
                name = queue.get_nowait()
                try:
                    await self.check(manager, name)
                except Exception:
                    log.warning("[ANTIGRAVITY] model access check unavailable")
        await worker()

    async def start(self):
        if self._task and not self._task.done():
            return
        from src.credential_manager import credential_manager
        queue = asyncio.Queue(maxsize=200)
        queued = set()
        async def worker():
            while True:
                name = await queue.get()
                try:
                    manager = await credential_manager._get_or_create()
                    await self.check(manager, name)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    log.warning("[ANTIGRAVITY] model access check unavailable")
                finally:
                    queued.discard(name)
                    queue.task_done()
        async def loop():
            while True:
                try:
                    manager = await credential_manager._get_or_create()
                    for name in await manager._storage_adapter._backend.model_access_due():
                        if name not in queued and not queue.full():
                            queued.add(name)
                            queue.put_nowait(name)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    log.warning("[ANTIGRAVITY] model access scheduler unavailable")
                await asyncio.sleep(SCAN_INTERVAL)
        self._workers = [asyncio.create_task(worker()) for _ in range(1)]
        self._task = asyncio.create_task(loop())

    async def close(self, deadline=None):
        tasks = [*self._workers, *([self._task] if self._task else [])]
        for task in tasks:
            task.cancel()
        if tasks:
            if deadline is None:
                await asyncio.gather(*tasks, return_exceptions=True)
            else:
                await asyncio.wait(tasks, timeout=max(0, deadline - time.monotonic()))
        self._workers = []
        self._task = None


model_access_service = ModelAccessService()
