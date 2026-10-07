"""Read-only Antigravity panel indexes. Never used for admission or live quota."""
import asyncio
import copy
import functools
import hashlib
import inspect
import json
import os
import sys
import time
from contextlib import aclosing

from log import log
from src.antigravity_panel_metrics import trace_phase
from src.antigravity_model_access import MODELS, FAMILIES, _status, public, public_families
from src.antigravity_quota import (GROUP_FILTERS, count_quota_summary, empty_quota_stats,
    finite_quota_deadline, matches_quota_filter, observe_quota_expiry, quota_summary)
from src.error_classification import (get_error_classifications, has_error_code,
    is_http_403_classification_filter, matches_error_code_filter,
    matches_http_403_classification, safe_json_list, safe_json_object)
from src.storage._stats_common import (active_model_cooldowns, has_active_model_cooldown,
    cooldowns_affect_antigravity_family)
from src.subscription_tiers import default_tier_for_mode

TTL = 5.0
MAX_ROWS = 50000
MAX_BYTES = 32 * 1024 * 1024
BATCH = 500
INDEX_FIELDS = frozenset(('filename', 'rotation_order', 'disabled', 'permanent_disabled',
    'tier', 'remark', 'error_codes', 'error_messages', 'model_cooldowns',
    'quota_group_states', 'quota_credential_generation', 'model_access_state', 'credential_data'))
LIGHT_COLUMNS = ('filename', 'rotation_order', 'disabled', 'tier', 'remark', 'error_codes',
    'model_cooldowns', 'quota_group_states', 'quota_credential_generation',
    'model_access_state', 'credential_data')
HEAVY_COLUMNS = ('user_email', 'last_success', 'success_count', 'failure_count',
                 'cycle_stats', 'last_cycle_stats', 'enable_credit')

class PanelListBusy(RuntimeError):
    pass

class PanelListChanged(RuntimeError):
    pass


# Only objects known to be shared constants are deduplicated across rows.
# Unique row containers/filenames/hashes never accumulate in a global seen set.
_SHARED_OBJECTS = (*LIGHT_COLUMNS, *HEAVY_COLUMNS, *MODELS, *FAMILIES,
    'permanent_disabled', '_version', '_classification', 'model_access_families',
    'state', 'checked_at', 'reason', 'next_check_at', 'blocked_until', 'last_attempt_at',
    'unknown', 'supported', 'unavailable', 'invalid_state', None, True, False)
_SHARED_IDS = frozenset(map(id, _SHARED_OBJECTS))


def retained_size(value, shared=None):
    """Estimate owned objects, counting known shared constants only once."""
    if shared is not None and id(value) in _SHARED_IDS:
        if id(value) in shared:
            return 0
        shared.add(id(value))
    size = sys.getsizeof(value)
    if isinstance(value, dict):
        size += sum(retained_size(k, shared) + retained_size(v, shared) for k, v in value.items())
    elif isinstance(value, (tuple, list)):
        size += sum(retained_size(v, shared) for v in value)
    return size


def _light(raw, ready):
    from src.storage.antigravity_model_access import row_state
    from src.storage.antigravity_quota import credential_version
    result = {key: raw.get(key) for key in LIGHT_COLUMNS if key not in
              {'credential_data', 'model_access_state'}}
    result['permanent_disabled'] = bool(raw.get('permanent_disabled'))
    result['disabled'] = bool(result['disabled'])
    result['tier'] = result['tier'] or default_tier_for_mode('antigravity')
    result['remark'] = result['remark'] or ''
    result['error_codes'] = safe_json_list(result['error_codes'])
    # Keep malformed policy bytes: quota_summary must retain its fail-closed semantics.
    for key in ('model_cooldowns', 'quota_group_states'):
        value = result[key]
        if isinstance(value, str):
            try:
                result[key] = json.loads(value)
            except ValueError:
                pass
    # Decode only for this row, shared by both independent identity/version fences.
    # The parsed credential object is never attached to the retained light index.
    credential = raw.get('credential_data')
    invalid_credential = False
    if isinstance(credential, str):
        try:
            credential = json.loads(credential)
        except ValueError:
            invalid_credential = True
    try:
        if invalid_credential:
            raise ValueError('invalid_panel_credential')
        state = row_state({**raw, 'credential_data': credential}) if ready else {}
        result['model_access_state'] = public(state)
        result['model_access_families'] = public_families(state)
    except (ValueError, TypeError):
        result['model_access_state'] = public({})
        result['model_access_families'] = public_families({})
    try:
        if invalid_credential:
            raise ValueError('invalid_panel_credential')
        result['_version'] = credential_version(credential)
    except (ValueError, TypeError):
        result['_version'] = hashlib.sha256(str(raw.get('credential_data')).encode()).hexdigest()
    return result


def _project(row, now):
    active, _ = active_model_cooldowns(row.get('model_cooldowns'), now)
    active = {key: value for key, value in active.items() if finite_quota_deadline(value)}
    projections = {key: {name: {**entry, 'state': _status(entry, now)} for name, entry in row[key].items()}
                   for key in ('model_access_state', 'model_access_families')}
    return {**row, **projections, 'model_cooldowns': active,
            **quota_summary(row.get('model_cooldowns'), row.get('quota_group_states'), now)}


class _Accumulator:
    def __init__(self, engine, opts, now):
        self.engine, self.opts, self.now = engine, opts, now
        self.stats = dict(total=0, normal=0, disabled=0, in_cooldown=0, no_cooldown=0,
                          **empty_quota_stats())
        if engine in ('sqlite', 'postgres'):
            self.stats['permanent_disabled'] = 0
        self.families = {f: dict(supported=0, unavailable=0, unknown=0) for f in FAMILIES}
        self.base_total = self.total = 0
        self.page = []

    def add(self, raw, classification=None):
        o, stats = self.opts, self.stats
        row = _project(raw, self.now)
        disabled, permanent = raw['disabled'], raw['permanent_disabled']
        stats['total'] += 1
        if 'permanent_disabled' in stats and permanent:
            stats['permanent_disabled'] += 1
        elif disabled:
            stats['disabled'] += 1
        else:
            stats['normal'] += 1
        normal = not disabled and (not permanent or self.engine in ('mysql', 'mongo'))
        if normal:
            stats['in_cooldown' if has_active_model_cooldown(raw.get('model_cooldowns'), self.now) else 'no_cooldown'] += 1
            if self.engine != 'mongo' or not permanent:
                count_quota_summary(stats, row)
        # Preserve each engine's original query scope for expiry observation.
        # Mongo applies its raw error-code condition before reading candidates.
        status = o['status_filter']
        if self.engine in ('mysql', 'mongo'):
            status_ok = status not in ('enabled', 'disabled') or disabled == (status == 'disabled')
        else:
            status_ok = (status == 'all' or status == 'enabled' and not disabled and not permanent
                         or status == 'disabled' and disabled and not permanent
                         or status == 'permanent_disabled' and permanent)
        ef = o['error_code_filter']
        raw_error_ok = (has_error_code(row['error_codes'], 403)
                        if is_http_403_classification_filter(ef)
                        else matches_error_code_filter(row['error_codes'], {}, ef))
        if self.engine == 'sqlite' or status_ok and (self.engine != 'mongo' or raw_error_ok):
            observe_quota_expiry(stats, row)
        if not status_ok:
            return
        if is_http_403_classification_filter(ef):
            if not matches_http_403_classification(classification or {}, ef):
                return
        elif not matches_error_code_filter(row['error_codes'], {}, ef):
            return
        if o['tier_filter'] not in (None, '', 'all') and row['tier'] != o['tier_filter']:
            return
        if o['remark_filter'] is not None and row['remark'] != o['remark_filter']:
            return
        cd = o['cooldown_filter']
        if cd in GROUP_FILTERS and not matches_quota_filter(row, cd):
            return
        if cd == 'in_cooldown' and not row['model_cooldowns']:
            return
        if cd == 'no_cooldown' and row['model_cooldowns']:
            return
        if cd in ('pro_no_cooldown', 'flash_no_cooldown') and cooldowns_affect_antigravity_family(row['model_cooldowns'], cd.split('_')[0]):
            return
        self.base_total += 1
        statuses = {family: _status(row['model_access_families'].get(family, {}), self.now)
                    for family in FAMILIES}
        for family in FAMILIES:
            self.families[family][statuses[family]] += 1
        if o['model_access_filter'] != 'all' and statuses[o['model_access_family']] != o['model_access_filter']:
            return
        if o['offset'] <= self.total < o['offset'] + o['limit']:
            if classification is not None:
                row['error_classifications'] = classification
            self.page.append(row)
        self.total += 1

    def result(self):
        return dict(items=self.page, total=self.total, offset=self.opts['offset'], limit=self.opts['limit'],
                    stats=self.stats, quota_group_filter_supported=True,
                    model_access_summary={'total': self.base_total, 'family_counts': self.families,
                        'counts': {key: dict(self.families[FAMILIES[0]]) for key in
                                   ('any', 'all_tiers', 'low', 'medium', 'high')}, 'checked_at': self.now})


class AntigravityPanelMixin:
    """One immutable index per backend instance, with bounded queued readers."""
    def __init_subclass__(cls, **kwargs):
        super().__init_subclass__(**kwargs)
        # Managers expose legacy write methods directly as well as via adapters.
        # Wrap only methods defined here, after their own commit/rollback logic.
        for name in ('store_credential', 'delete_credential', 'update_credential_state',
                     'clear_all_model_cooldowns', 'record_success', 'record_failure', 'close'):
            fn = cls.__dict__.get(name)
            if fn is None:
                continue
            signature = inspect.signature(fn)
            @functools.wraps(fn)
            async def wrapped(self, *args, __fn=fn, __name=name, __sig=signature, **kw):
                bound = __sig.bind(self, *args, **kw)
                bound.apply_defaults()
                mode = bound.arguments.get('mode', 'geminicli')
                if __name == 'close':
                    jobs = list(getattr(self, '_panel_jobs', {}).values())
                    for job in jobs:
                        job.cancel()
                    if jobs:
                        await asyncio.gather(*jobs, return_exceptions=True)
                if __name == 'record_success' and mode == 'antigravity' and self.QUOTA_ENGINE != 'mongo':
                    return await self._panel_record_success(bound.arguments['filename'], bound.arguments.get('model_name'))
                result = await __fn(self, *args, **kw)
                if __name == 'close':
                    self.panel_index_invalidate()
                elif mode == 'antigravity' and result is not False:
                    changes = bound.arguments.get('state_updates', {})
                    if __name == 'record_success':
                        pass  # Mongo's atomic increment notifies its committed error change.
                    elif __name == 'update_credential_state':
                        pass  # Managers compare the committed indexed fields in their transaction.
                    elif __name == 'store_credential':
                        if self._panel_update_changed(bound.arguments.get('filename', ''), {'credential_data': bound.arguments.get('credential_data')}):
                            self.panel_index_invalidate()
                    elif __name == 'record_failure':
                        code = bound.arguments.get('error_code')
                        message = bound.arguments.get('error_message')
                        changes = {'error_codes': [code], 'error_messages': {str(code): message} if message else {}}
                        if self._panel_update_changed(bound.arguments.get('filename', ''), changes):
                            self.panel_index_invalidate()
                    else:
                        self.panel_index_invalidate()
                return result
            setattr(cls, name, wrapped)

    async def _panel_record_success(self, filename, model_name):
        """Preserve backend success semantics, invalidate only committed field changes."""
        self._ensure_initialized()
        engine = self.QUOTA_ENGINE
        now = time.time()
        def operation(row):
            errors = row.get('error_codes')
            had_errors = errors not in (None, '', '[]', [])
            if engine != 'mysql':
                row['success_count'] = (row.get('success_count') or 0) + 1
                row['call_count'] = (row.get('call_count') or 0) + 1
                row['last_success'] = int(now) if engine == 'sqlite' else now
                row['updated_at'] = int(now) if engine == 'sqlite' else now
                if engine in ('sqlite', 'postgres'):
                    row['cycle_stats'] = self._bump_cycle_stats(row.get('cycle_stats'), model_name)
            if engine == 'mongo' or had_errors:
                row['error_codes'], row['error_messages'] = [], {}
                if engine == 'mysql':
                    row['last_success'], row['updated_at'] = now, now
        try:
            await self._quota_atomic(filename, operation, validate=False, ensure_generation=False)
            if engine in ('sqlite', 'postgres'):
                await self._quota_result_stats(model_name, True)
        except Exception as exc:
            # Like the legacy method, accounting failures do not replace a successful
            # model response. Log only fixed context and exception type, never DB text.
            log.error(f'Antigravity success accounting failed ({engine}, {type(exc).__name__})')

    def _panel_update_changed(self, filename, updates):
        changes = INDEX_FIELDS.intersection(updates)
        if not changes:
            return False
        cache = getattr(self, '_panel_index', None)
        if cache is None:
            return True
        filename = os.path.basename(filename)
        row = next((r for r in cache['rows'] if r['filename'] == filename), None)
        if row is None:
            return True
        for key in changes:
            value = updates[key]
            if key == 'error_messages':
                codes = updates.get('error_codes', row['error_codes'])
                if not has_error_code(codes, 403):
                    continue
                if row.get('_classification') != get_error_classifications(codes, value):
                    return True
                continue
            if key == 'credential_data':
                from src.storage.antigravity_quota import credential_version
                try:
                    if credential_version(value) != row['_version']:
                        return True
                except (ValueError, TypeError):
                    return True
                continue
            if key == 'model_access_state':
                return True
            if isinstance(value, str) and key in ('error_codes', 'model_cooldowns', 'quota_group_states'):
                try:
                    value = json.loads(value)
                except ValueError:
                    pass
            if value != row.get(key):
                return True
        return False

    @staticmethod
    def panel_effective_updates(clauses, values):
        return {clause.split(' = ', 1)[0]: value for clause, value in zip(clauses, values)
                if clause.split(' = ', 1)[0] in INDEX_FIELDS}

    def panel_index_committed(self, raw, updates):
        def normalized(key, value):
            if key in ('model_access_state', 'model_cooldowns', 'quota_group_states', 'error_codes', 'error_messages', 'credential_data') and isinstance(value, str):
                try:
                    value = json.loads(value)
                except ValueError:
                    pass
            if key == 'model_access_state' and isinstance(value, dict):
                value = {k: v for k, v in value.items() if k != 'lease'}
            return value
        changed = {key for key in INDEX_FIELDS.intersection(updates)
                   if normalized(key, raw.get(key)) != normalized(key, updates[key])}
        self.panel_index_invalidate(changed)

    def panel_index_invalidate(self, updates=None):
        if updates is not None and not INDEX_FIELDS.intersection(updates):
            return
        self._panel_epoch = getattr(self, '_panel_epoch', 0) + 1
        self._panel_index = None

    def _panel_columns(self, *, heavy=False, errors=False):
        columns = [key for key in LIGHT_COLUMNS if getattr(self, 'model_access_storage_ready', False)
                   or key not in ('model_access_state', 'quota_credential_generation')]
        if self.QUOTA_ENGINE != 'mysql':
            columns.append('permanent_disabled')
        if heavy:
            columns.extend(HEAVY_COLUMNS if self.QUOTA_ENGINE != 'mysql' else ('user_email', 'last_success'))
        if errors:
            columns.append('error_messages')
        return columns

    async def _panel_scan(self, *, errors=False):
        with trace_phase('list_scan') as phase:
            async with aclosing(self._panel_scan_rows(errors=errors)) as cursor:
                async for row in cursor:
                    phase.rows += 1
                    yield row

    async def _panel_scan_rows(self, *, errors=False):
        """Cursor owns exactly one connection; callers must not nest pool reads."""
        columns = self._panel_columns(errors=errors)
        engine = self.QUOTA_ENGINE
        if engine == 'mongo':
            cursor = self._db[self._get_collection_name('antigravity')].find({}, {k: 1 for k in columns}).sort([('rotation_order', 1), ('_id', 1)]).batch_size(BATCH)
            try:
                async for row in cursor:
                    yield row
            finally:
                await cursor.close()
            return
        table = self._get_table_name('antigravity')
        query = f"SELECT {', '.join(columns)} FROM {table}"
        if engine == 'mysql':
            import aiomysql
            query += ' WHERE server_name = %s ORDER BY rotation_order, id'
            async with self._pool.acquire() as conn:
                await conn.rollback()
                try:
                    async with conn.cursor(aiomysql.SSDictCursor) as cur:
                        await cur.execute(query, (self._server_name,))
                        while batch := await cur.fetchmany(BATCH):
                            for row in batch:
                                yield row
                finally:
                    await conn.rollback()
        elif engine == 'postgres':
            query += ' ORDER BY rotation_order, filename'
            async with self._pool.acquire() as conn:
                async with conn.transaction():
                    async for row in conn.cursor(query, prefetch=BATCH):
                        yield dict(row)
        elif engine == 'sqlite':
            import aiosqlite
            query += ' ORDER BY rotation_order, rowid'
            async with aiosqlite.connect(self._db_path, timeout=30) as conn:
                conn.row_factory = aiosqlite.Row
                async with conn.execute(query) as cur:
                    while batch := await cur.fetchmany(BATCH):
                        for row in batch:
                            yield dict(row)
        else:
            raise RuntimeError('unsupported_panel_storage')

    async def _panel_read(self, filenames, *, errors_only=False):
        with trace_phase('list_filter' if errors_only else 'list_page', rows=len(filenames)):
            return await self._panel_read_rows(filenames, errors_only=errors_only)

    async def _panel_read_rows(self, filenames, *, errors_only=False):
        if not filenames:
            return {}
        columns = ('filename', 'error_messages') if errors_only else self._panel_columns(heavy=True, errors=True)
        result = {}
        for start in range(0, len(filenames), BATCH):
            names = filenames[start:start+BATCH]
            engine = self.QUOTA_ENGINE
            if engine == 'mongo':
                rows = await self._db[self._get_collection_name('antigravity')].find({'filename': {'$in': names}}, {k: 1 for k in columns}).to_list(length=BATCH)
            else:
                table = self._get_table_name('antigravity')
                query = f"SELECT {', '.join(columns)} FROM {table} WHERE "
                if engine == 'sqlite':
                    import aiosqlite
                    async with aiosqlite.connect(self._db_path, timeout=30) as conn:
                        conn.row_factory = aiosqlite.Row
                        async with conn.execute(query + 'filename IN (' + ','.join('?' for _ in names) + ')', names) as cur:
                            rows = [dict(r) for r in await cur.fetchall()]
                elif engine == 'postgres':
                    async with self._pool.acquire() as conn:
                        rows = await conn.fetch(query + 'filename = ANY($1::text[])', names)
                else:
                    import aiomysql
                    async with self._pool.acquire() as conn:
                        await conn.rollback()
                        try:
                            async with conn.cursor(aiomysql.DictCursor) as cur:
                                await cur.execute(query + 'server_name = %s AND filename IN (' + ','.join('%s' for _ in names) + ')', (self._server_name, *names))
                                rows = await cur.fetchall()
                        finally:
                            await conn.rollback()
            result.update((r['filename'], dict(r)) for r in rows)
        return result

    async def _panel_attempt(self, opts, *, fresh=False):
        ready = bool(getattr(self, 'model_access_storage_ready', False))
        epoch = getattr(self, '_panel_epoch', 0)
        started = time.monotonic()
        now = time.time()
        cache = None if fresh else getattr(self, '_panel_index', None)
        if cache and (cache['epoch'] != epoch or cache['ready'] != ready or started-cache['started'] >= TTL):
            cache = None
            self._panel_index = None
        classified = is_http_403_classification_filter(opts['error_code_filter'])
        acc = _Accumulator(self.QUOTA_ENGINE, opts, now)
        if cache is not None:
            if classified and not cache['classified']:
                # Store only enums. Messages and filename batches are discarded.
                batch = []
                for row in cache['rows']:
                    if has_error_code(row['error_codes'], 403):
                        batch.append(row)
                    if len(batch) == BATCH:
                        if not await self._panel_classify(batch, cache):
                            self._panel_index = None
                            cache['rows'].clear()
                            cache = None
                            return await self._panel_attempt(opts, fresh=True)
                        batch.clear()
                if batch:
                    if not await self._panel_classify(batch, cache):
                        self._panel_index = None
                        cache['rows'].clear()
                        cache = None
                        return await self._panel_attempt(opts, fresh=True)
                cache['classified'] = True
                if cache['bytes'] > MAX_BYTES:
                    self._panel_index = None
            for index, row in enumerate(cache['rows']):
                acc.add(row, row.get('_classification'))
                if index % BATCH == 0:
                    await asyncio.sleep(0)
        else:
            rows, size, eligible = [], sys.getsizeof([]), not fresh
            shared = set()
            async with aclosing(self._panel_scan(errors=classified)) as cursor:
                async for raw in cursor:
                    row = _light(raw, ready)
                    classification = get_error_classifications(row['error_codes'], raw.get('error_messages')) if classified else None
                    if classification is not None:
                        row['_classification'] = classification
                    acc.add(row, classification)
                    if eligible:
                        size += retained_size(row, shared) + 16
                        if len(rows) >= MAX_ROWS or size > MAX_BYTES:
                            rows.clear()
                            shared.clear()
                            eligible = False
                        else:
                            rows.append(row)
                    # Let timeouts/cancellation run even for in-memory driver batches.
                    if acc.stats['total'] % BATCH == 0:
                        await asyncio.sleep(0)
            shared.clear()
            if eligible and epoch == getattr(self, '_panel_epoch', 0) and time.monotonic()-started < TTL:
                self._panel_index = dict(rows=rows, bytes=size, epoch=epoch, ready=ready,
                                         started=started, classified=classified)
        result = acc.result()
        result['quota_group_filter_supported'] = bool(getattr(self, 'SUPPORTS_QUOTA_GROUP_FILTER', False))
        details = await self._panel_read([r['filename'] for r in result['items']])
        if not fresh and epoch != getattr(self, '_panel_epoch', 0):
            raise PanelListChanged('panel_index_changed')
        for row in result['items']:
            raw = details.get(row['filename'])
            if raw is None:
                raise PanelListChanged('panel_page_changed')
            # Detect replacement and external index changes in the displayed page.
            current = _light(raw, ready)
            previous = {k: v for k, v in row.items() if k in current}
            expected = _project(current, now)
            # Last uncached pass is a read snapshot: unrelated or same-identity
            # policy writes must not starve listing. Replacement/deletion still fences.
            checked = ('_version', 'quota_credential_generation') if fresh else previous
            if any(previous[k] != expected[k] for k in checked):
                raise PanelListChanged('panel_page_changed')
            for key in HEAVY_COLUMNS:
                if key in raw:
                    row[key] = safe_json_object(raw[key]) if key in ('cycle_stats', 'last_cycle_stats') else raw[key]
            classification = get_error_classifications(row['error_codes'], raw.get('error_messages'))
            if not fresh and classified and row.get('error_classifications') != classification:
                raise PanelListChanged('panel_page_classification_changed')
            row['error_classifications'] = classification
            for key in ('_version', '_classification', 'quota_credential_generation', 'quota_group_states'):
                row.pop(key, None)
        return result

    async def _panel_classify(self, rows, cache):
        messages = await self._panel_read([r['filename'] for r in rows], errors_only=True)
        for row in rows:
            classification = get_error_classifications(row['error_codes'], messages.get(row['filename'], {}).get('error_messages'))
            additional = retained_size(classification) + 96
            if cache['bytes'] + additional > MAX_BYTES:
                return False
            row['_classification'] = classification
            cache['bytes'] += additional
        return True

    async def get_antigravity_panel_summary(self, *, offset=0, limit=20, status_filter='all',
            error_code_filter=None, cooldown_filter=None, tier_filter=None, remark_filter=None,
            model_access_filter='all', model_access_family='claude-opus-5-5',
            preview_filter=None, model_access_tier='any'):
        from src.antigravity_panel_budget import panel_list_budget
        self._ensure_initialized()
        opts = dict(offset=offset, limit=limit, status_filter=status_filter,
            error_code_filter=error_code_filter, cooldown_filter=cooldown_filter,
            tier_filter=tier_filter, remark_filter=remark_filter,
            model_access_filter=model_access_filter, model_access_family=model_access_family)
        if not getattr(self, 'model_access_storage_ready', False):
            if model_access_filter != 'all' or model_access_family != FAMILIES[0]:
                raise RuntimeError('model_access_capability_unavailable')
        if not hasattr(self, '_panel_lock'):
            self._panel_lock = asyncio.Lock()
            self._panel_waiters = 0
            self._panel_jobs = {}
            self._panel_job_readers = {}
        seconds = panel_list_budget()
        if self._panel_waiters >= 21:
            raise PanelListBusy('panel_list_queue_full')
        key = tuple(opts.items())
        job = self._panel_jobs.get(key)
        if job is None:
            async def produce():
                async with asyncio.timeout(seconds):
                    async with self._panel_lock:
                        for attempt in range(3):
                            try:
                                return await self._panel_attempt(opts, fresh=attempt == 2)
                            except PanelListChanged:
                                self._panel_index = None
                                if attempt == 2:
                                    raise
            job = asyncio.create_task(produce())
            self._panel_jobs[key] = job
            def finished(task):
                if self._panel_jobs.get(key) is task:
                    self._panel_jobs.pop(key, None)
                if not task.cancelled():
                    task.exception()  # A disconnected last waiter must not leak an exception.
            job.add_done_callback(finished)
        self._panel_job_readers[job] = self._panel_job_readers.get(job, 0) + 1
        self._panel_waiters += 1
        try:
            async with asyncio.timeout(seconds):
                return copy.deepcopy(await asyncio.shield(job))
        finally:
            self._panel_waiters -= 1
            remaining = self._panel_job_readers.get(job, 1) - 1
            if remaining:
                self._panel_job_readers[job] = remaining
            else:
                self._panel_job_readers.pop(job, None)
                if not job.done():
                    if self._panel_jobs.get(key) is job:
                        self._panel_jobs.pop(key, None)
                    job.cancel()
