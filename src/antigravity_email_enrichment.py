"""Bounded process-local email lookup for receipts from new Antigravity imports.

Never scans historical credentials. No credential material is kept in public
job records, and cancellation never means an already-started write rolled back.
"""
import asyncio
from collections import Counter, deque
from dataclasses import dataclass, field
import time
import uuid

from src.antigravity_directory_runtime import atomic_registry, SettlementPending, QuotaWorkError
from src.manual_google import manual_google_phase

SEARCH_CAPABILITY = "antigravity.credentials.search"
AUTO_EMAIL_CAPABILITY = "antigravity.credentials.auto_email"
ACTIVE = {"queued", "running", "settlement_pending"}
WARNING = "自动获取邮箱未完成，可使用查看账号邮箱手动获取。"
_native_single_worker = False


def confirm_native_single_worker(workers):
    """Only the native entrypoint can establish this process-local prerequisite."""
    global _native_single_worker
    _native_single_worker = workers == 1


def backend_supports_email(backend):
    return (getattr(backend, "model_access_storage_ready", False) is True
            and callable(getattr(backend, "import_antigravity_credential_with_receipt", None))
            and callable(getattr(backend, "quota_current_credential", None))
            and callable(getattr(backend, "quota_refresh_credential", None)))


@dataclass
class EmailItem:
    filename: str
    receipt: object = field(repr=False)
    queued_at: float = field(default_factory=time.monotonic)
    status: str = "queued"
    reason: str | None = None
    user_email: str | None = None
    phase: str | None = None
    outcome: object = field(default=None, repr=False)
    interrupted: bool = False
    settled: asyncio.Event = field(default_factory=asyncio.Event, repr=False)

    def public(self):
        result = {"filename": self.filename, "status": self.status, "reason": self.reason}
        if self.status == "success":
            result["user_email"] = self.user_email
        return result


@dataclass
class EmailJob:
    job_id: str = field(default_factory=lambda: uuid.uuid4().hex)
    items: list = field(default_factory=list)
    sealed: bool = False
    finished_at: float | None = None
    omitted: int = 0
    imports_pending: int = 0

    @property
    def complete(self):
        return self.sealed and not self.imports_pending and all(item.status not in ACTIVE for item in self.items)


class UploadEmailBatch:
    """Request-owned reference only; sealing does not cancel saved work."""
    def __init__(self, service):
        self.service = service
        self.job = service.new_job()
        self.accepted = self.skipped = 0
        self.warnings = []

    def add(self, receipt):
        if self.service.enqueue(self.job, receipt):
            self.accepted += 1
        else:
            self.skipped += 1
            if WARNING not in self.warnings:
                self.warnings.append(WARNING)

    def seal(self):
        if self.job is not None:
            self.job.sealed = True
            self.service.finish_job(self.job)

    def public(self):
        job = self.job
        # Validation-only batches have nothing to poll, including before seal.
        tracked = (job is not None and self.service.jobs.get(job.job_id) is job
                   and (job.items or job.imports_pending or job.omitted))
        job_id = job.job_id if tracked else None
        return {"job_id": job_id, "accepted": self.accepted, "skipped": self.skipped,
                "status_url": f"/creds/email-enrichment/{job_id}" if job_id else None}


class EmailEnrichmentService:
    def __init__(self, *, worker_count=4, queue_limit=1000, job_limit=128,
                 item_limit=5000, execution_budget=10, queue_ttl=45*60, terminal_ttl=15*60,
                 manager=None, fetch_email=None):
        self.worker_count, self.queue_limit = worker_count, queue_limit
        self.job_limit, self.item_limit = job_limit, item_limit
        self.execution_budget, self.queue_ttl, self.terminal_ttl = execution_budget, queue_ttl, terminal_ttl
        self.manager, self.fetch_email = manager, fetch_email or _fetch_google_email
        self.jobs, self.queue = {}, deque()
        self.wake = asyncio.Event()
        self.workers = []
        self.housekeeper = None
        self.enabled = False
        self.closing = False
        self._start_lock = asyncio.Lock()
        self._close_active = 0

    async def start(self, *, single_worker=None, backend=None):
        async with self._start_lock:
            previous = self.workers + ([self.housekeeper] if self.housekeeper else [])
            if self._close_active or any(not task.done() for task in previous):
                # In particular, an old worker may still own an unconfirmed CAS.
                # Keep its references and closing flag until it actually exits.
                return
            for task in previous:
                if not task.cancelled():
                    task.exception()
            self.workers = []
            self.housekeeper = None
            self.wake.clear()
            self.closing = False
            self.enabled = False
            if single_worker is None:
                single_worker = _native_single_worker
            if single_worker is not True:
                return
            if backend is None:
                from src.storage_adapter import get_storage_adapter
                try:
                    backend = (await get_storage_adapter())._backend
                except Exception:
                    return
            # A close signal during backend initialization cannot reopen admission.
            if self.closing or atomic_registry.closing:
                return
            self.enabled = backend_supports_email(backend)
            if not self.enabled:
                return
            self.workers = [asyncio.create_task(self._worker(), name=f"ag-email-{i}")
                            for i in range(self.worker_count)]
            self.housekeeper = asyncio.create_task(self._housekeeping(), name="ag-email-expiry")

    def supports(self, backend):
        return self.enabled and not self.closing and not atomic_registry.closing and backend_supports_email(backend)

    def batch(self):
        return UploadEmailBatch(self)

    def new_job(self):
        self.purge()
        if not self.enabled or self.closing or atomic_registry.closing or len(self.jobs) >= self.job_limit:
            return None
        job = EmailJob()
        self.jobs[job.job_id] = job
        return job

    def enqueue(self, job, receipt):
        self.purge()
        if job is None or self.jobs.get(job.job_id) is not job:
            return False
        if sum(len(j.items) for j in self.jobs.values()) >= self.item_limit:
            job.omitted += 1
            return False
        item = EmailItem(receipt.filename, receipt)
        job.items.append(item)
        self.finish_job(job)
        reason = None
        if not self.enabled or self.closing or atomic_registry.closing:
            reason = "service_unavailable"
        elif not getattr(receipt, "email_fence_supported", False):
            reason = "identity_fence_unavailable"
        elif len(self.queue) >= self.queue_limit:
            reason = "queue_full"
        if reason:
            item.status, item.reason = "skipped", reason
            self.finish_job(job)
            return False
        self.queue.append((job, item))
        self.wake.set()
        return True

    def finish_job(self, job):
        if job.sealed and not job.imports_pending and not job.items and not job.omitted:
            # Invalid/all-failed uploads must not reserve a terminal job slot.
            # A sealed batch with a pending commit or omitted results is retained.
            if self.jobs.get(job.job_id) is job:
                self.jobs.pop(job.job_id)
            job.finished_at = None
            return
        if not job.complete:
            # A late committed import may add work after the HTTP batch sealed.
            # Retention starts only when all imports and queued work are terminal.
            job.finished_at = None
        elif job.finished_at is None:
            job.finished_at = time.monotonic()

    def purge(self):
        now = time.monotonic()
        kept = deque()
        while self.queue:
            job, item = self.queue.popleft()
            if now - item.queued_at >= self.queue_ttl:
                item.status, item.reason = "failed", "queue_timeout"
                self.finish_job(job)
            else:
                kept.append((job, item))
        self.queue = kept
        for key, job in list(self.jobs.items()):
            self.finish_job(job)
            if job.complete and job.finished_at is not None and now - job.finished_at >= self.terminal_ttl:
                del self.jobs[key]

    def snapshot(self, job_id, offset=0, limit=100):
        self.purge()
        job = self.jobs.get(job_id)
        if job is None:
            return None
        counts = Counter(item.status for item in job.items)
        counts["skipped"] += job.omitted
        return {"job_id": job.job_id, "sealed": job.sealed, "complete": job.complete,
                "counts": dict(counts), "total": len(job.items),
                "items": [item.public() for item in job.items[offset:offset+limit]]}

    def annotations(self, filenames):
        """Build newest public statuses in one traversal for the current page."""
        self.purge()
        wanted = set(filenames)
        result = {}
        for job in reversed(tuple(self.jobs.values())):
            if not wanted:
                break
            for item in reversed(job.items):
                if item.filename in wanted:
                    result[item.filename] = {"email_enrichment_status": item.status,
                                             "email_enrichment_reason": item.reason}
                    wanted.remove(item.filename)
                    if not wanted:
                        break
        return result

    def annotate(self, filename):
        return self.annotations((filename,)).get(filename, {})

    async def _housekeeping(self):
        try:
            while not self.closing:
                await asyncio.sleep(1)
                self.purge()
        except asyncio.CancelledError:
            pass

    async def _worker(self):
        while not self.closing:
            self.purge()
            if not self.queue:
                self.wake.clear()
                await self.wake.wait()
                continue
            job, item = self.queue.popleft()
            item.status = "running"
            try:
                await self._process(item)
            except asyncio.CancelledError:
                if item.status != "settlement_pending":
                    item.status, item.reason = "failed", "shutdown"
            except (TimeoutError, QuotaWorkError):
                item.status, item.reason = "failed", "execution_timeout"
            except Exception:
                item.status, item.reason = "failed", "email_lookup_failed"
            self.finish_job(job)

    async def _manager(self):
        if self.manager is not None:
            return self.manager
        from src.storage_adapter import get_storage_adapter
        return (await get_storage_adapter())._backend

    async def _bounded(self, operation, deadline):
        async with asyncio.timeout_at(deadline):
            return await operation()

    async def _process(self, item):
        from src.google_oauth_api import Credentials
        from src.storage.antigravity_quota import credential_version
        receipt = item.receipt
        deadline = time.monotonic() + self.execution_budget
        manager = await self._bounded(self._manager, deadline)
        data = await self._bounded(lambda: manager.quota_current_credential(
            item.filename, receipt.generation), deadline)
        if not data or data.get("_quota_credential_version") != receipt.credential_version:
            item.status, item.reason = "superseded", "credential_changed"
            return
        version = receipt.credential_version
        with manual_google_phase("email_enrichment", []):
            credentials = Credentials.from_dict(data)
            refreshed = await self._bounded(credentials.refresh_if_needed, deadline)
            if refreshed:
                updated = {**data, **credentials.to_dict()}
                updated.pop("_quota_generation", None)
                updated.pop("_quota_credential_version", None)
                updated.pop("enable_credit", None)
                if "token" in updated:
                    updated["token"] = updated["access_token"]
                if not await self._write(item, manager, "token_refresh", updated, version, deadline):
                    return
                version = credential_version(updated)
            email = await self._bounded(lambda: self.fetch_email(credentials), deadline)
            if not isinstance(email, str) or not email.strip() or len(email) > 320:
                item.status, item.reason = "failed", "email_unavailable"
                return
            item.user_email = email.strip()
            if await self._write(item, manager, "email_write", None, version, deadline,
                                 {"user_email": item.user_email}):
                item.status, item.reason = "success", None

    @staticmethod
    def _apply_settlement(item):
        outcome = item.outcome
        if outcome is None:
            return
        if outcome.status != "succeeded":
            item.status, item.reason = "unknown", "commit_unconfirmed"
        elif outcome.result is False:
            item.status, item.reason = "superseded", "credential_changed"
        elif outcome.result is True and item.phase == "email_write":
            item.status, item.reason = "success", None
        elif outcome.result is True:
            item.status, item.reason = "failed", "token_saved_email_not_fetched"
        else:
            item.status, item.reason = "unknown", "commit_unconfirmed"

    async def _write(self, item, manager, phase, data, version, deadline, state_updates=None):
        item.phase, item.outcome, item.interrupted = phase, None, False
        item.settled.clear()
        def settled(outcome):
            item.outcome = outcome
            item.settled.set()
            if item.interrupted:
                self._apply_settlement(item)
        started = False
        def operation():
            nonlocal started
            started = True
            return manager.quota_refresh_credential(
                item.filename, item.receipt.generation, data, expected_version=version,
                state_updates=state_updates)
        try:
            result = await atomic_registry.run(operation, deadline=deadline, phase=phase, on_settled=settled)
            if result is not True:
                item.status, item.reason = "superseded", "credential_changed"
                return False
            return True
        except (SettlementPending, asyncio.CancelledError):
            if item.outcome is None and not started:
                raise
            item.interrupted = True
            item.status, item.reason = "settlement_pending", "commit_unconfirmed"
            if item.outcome is not None:
                self._apply_settlement(item)
            # Keep this execution slot until the operation itself settles. This
            # wait cannot authorize another network request or database write.
            while item.outcome is None:
                try:
                    await item.settled.wait()
                except asyncio.CancelledError:
                    if self.closing:
                        continue
                    raise
            self._apply_settlement(item)
            return False
        except Exception:
            if item.outcome is not None:
                self._apply_settlement(item)
                return False
            raise

    def begin_close(self):
        if self.closing:
            return
        self.closing, self.enabled = True, False
        while self.queue:
            job, item = self.queue.popleft()
            item.status, item.reason = "failed", "shutdown"
            self.finish_job(job)
        self.wake.set()
        if self.housekeeper:
            self.housekeeper.cancel()
        for worker in self.workers:
            worker.cancel()

    async def close(self, *, deadline):
        self._close_active += 1
        try:
            self.begin_close()
            tasks = self.workers + ([self.housekeeper] if self.housekeeper else [])
            if tasks:
                await asyncio.wait(tasks, timeout=max(0, deadline-time.monotonic()))
            for job in tuple(self.jobs.values()):
                for item in job.items:
                    if item.status == "settlement_pending":
                        item.status, item.reason = "unknown", "shutdown_commit_unconfirmed"
                self.finish_job(job)
        finally:
            self._close_active -= 1


async def _fetch_google_email(credentials):
    # Fetch userinfo directly after our fenced refresh; the generic helper may
    # refresh again and would make the version used for the email CAS ambiguous.
    from config import get_googleapis_proxy_url
    from src.httpx_client import get_async
    base = await get_googleapis_proxy_url()
    response = await get_async(f"{base.rstrip('/')}/oauth2/v2/userinfo",
                               headers={"Authorization": f"Bearer {credentials.access_token}"})
    response.raise_for_status()
    payload = response.json()
    return payload.get("email") if isinstance(payload, dict) else None


email_enrichment_service = EmailEnrichmentService()


async def import_with_email_receipt(manager, filename, data, *, initial_state=None, email_batch=None):
    """Enqueue the committed identity even if the HTTP waiter leaves mid-commit."""
    own_batch = email_batch is None
    batch = email_batch or email_enrichment_service.batch()
    method = getattr(manager, "add_antigravity_credential_with_receipt", None)
    if method is None:
        method = getattr(manager, "import_antigravity_credential_with_receipt", None)
    async def save():
        if callable(method):
            return await method(filename, data, initial_state=initial_state)
        add = getattr(manager, "add_antigravity_credential", None)
        if callable(add):
            await add(filename, data, initial_state=initial_state)
        elif not await manager.import_antigravity_credential(filename, data, initial_state=initial_state):
            raise RuntimeError("credential_import_failed")
        from src.storage.antigravity_import import ImportReceipt
        return ImportReceipt(filename, None, "", False)
    if batch.job is not None:
        batch.job.imports_pending += 1
    callback_called = False
    def committed(outcome):
        nonlocal callback_called
        callback_called = True
        try:
            if outcome.status == "succeeded":
                # Keep the pending import counted while enqueue performs purge.
                # A sealed empty batch is not terminal before its receipt joins it.
                batch.add(outcome.result)
        finally:
            if batch.job is not None:
                batch.job.imports_pending -= 1
                batch.service.finish_job(batch.job)
    started = False
    def operation():
        nonlocal started
        started = True
        return save()
    try:
        return await atomic_registry.run(operation, phase="credential_import", on_settled=committed)
    except BaseException:
        # A failure before AtomicRegistry started has no completion callback.
        if not callback_called and not started and batch.job is not None:
            if batch.job.imports_pending:
                batch.job.imports_pending -= 1
        raise
    finally:
        if own_batch:
            batch.seal()
