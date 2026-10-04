"""Bounded directory checks and restart-safe automatic access recovery."""
import asyncio
import time

from log import log
from src.antigravity_model_access import access_model, check_due, eligible

QUERY_TIMEOUT = 10
SELECTION_TIMEOUT = 30
SCAN_INTERVAL = 60


class ModelAccessService:
    def __init__(self):
        self._slots = asyncio.Semaphore(2)
        self._task = None
        self._workers = []

    async def check(self, manager, filename, data=None, *, force=False, model=None):
        backend = manager._storage_adapter._backend
        async with self._slots:
            async with asyncio.timeout(QUERY_TIMEOUT):
                snapshot = await backend.model_access_claim(filename, force=force, model=model)
                if snapshot is None:
                    return False
                try:
                    data = await backend.quota_current_credential(filename, snapshot["generation"])
                    if data is None:
                        return False
                    if await manager._should_refresh_token(data):
                        data = await manager._refresh_token(data, filename, mode="antigravity")
                        if not data:
                            return False
                        snapshot["version"] = data["_quota_credential_version"]
                    from src.api.antigravity import fetch_quota_info
                    result = await fetch_quota_info(data.get("access_token") or data.get("token"), timeout=QUERY_TIMEOUT, slot_held=True)
                    return await backend.model_access_observe(filename, snapshot,
                        result["models"] if result.get("success") else None,
                        reason=None if result.get("success") else "directory_query_failed")
                except asyncio.CancelledError:
                    # The lease and next check survive cancellation/restart.
                    await asyncio.shield(backend.model_access_observe(filename, snapshot, reason="directory_timeout"))
                    raise
                except Exception:
                    await backend.model_access_observe(filename, snapshot, reason="directory_query_failed")
                    return False

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
                await backend.model_access_queue(result[0])
            return None
        started = time.monotonic()
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
                        await backend.model_access_queue(filename)
                        batch.append(result)
                    if not batch:
                        return None
                    await asyncio.gather(*(self.check(manager, filename, data, model=target) for filename, data in batch),
                                         return_exceptions=True)
                    for filename, _ in batch:
                        snapshot = await backend.model_access_snapshot(filename)
                        if snapshot and eligible(snapshot["access"], target):
                            data = await backend.quota_current_credential(filename, snapshot["generation"])
                            if data:
                                return filename, data
        except (TimeoutError, ValueError, TypeError):
            return None
        finally:
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
        await asyncio.gather(worker(), worker())

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
        self._workers = [asyncio.create_task(worker()) for _ in range(2)]
        self._task = asyncio.create_task(loop())

    async def close(self):
        tasks = [*self._workers, *([self._task] if self._task else [])]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self._workers = []
        self._task = None


model_access_service = ModelAccessService()
