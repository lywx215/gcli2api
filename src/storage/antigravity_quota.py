"""Authoritative, atomic Antigravity quota operations for all storage engines.

SQL uses a row lock (SQLite BEGIN IMMEDIATE); Mongo uses a document CAS including
the incarnation and every policy field. Redis is deliberately not consulted for
Antigravity selection/admission, so stale caches cannot grant model access.
"""
import copy
import hashlib
import json
import os
import random
import time
import uuid

from src.antigravity_quota import GROUPS, InvalidQuotaState, decode_quota_fields, valid_group, fraction, group_for, matches, observe_week, public_state, rolling_week, ticket, timestamp
from src.storage._stats_common import get_antigravity_cooldown_until, prepare_antigravity_cooldown


def _object(value):
    try:
        value = json.loads(value) if isinstance(value, str) else value
    except (ValueError, TypeError):
        raise InvalidQuotaState("invalid_quota_state") from None
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise InvalidQuotaState("invalid_quota_state")
    return copy.deepcopy(value)


def _decode(raw):
    row = dict(raw)
    row["quota_group_states"], row["model_cooldowns"] = decode_quota_fields(
        row.get("quota_group_states"), row.get("model_cooldowns")
    )
    row["quota_credential_generation"] = row.get("quota_credential_generation") or uuid.uuid4().hex
    return row


def credential_version(value):
    data = _object(value)
    return hashlib.sha256(json.dumps(data, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


from src.storage.antigravity_model_access import AntigravityModelAccessMixin, row_state as access_row_state
from src.antigravity_model_access import access_model, check_due as access_check_due, eligible as access_eligible


from src.storage.antigravity_import import AntigravityImportMixin


from src.storage.antigravity_panel import AntigravityPanelMixin


class AntigravityQuotaMixin(AntigravityPanelMixin, AntigravityModelAccessMixin, AntigravityImportMixin):
    async def _quota_rows(self, filename=None):
        """Read-only selection/control snapshot; final admission is separate."""
        filename = os.path.basename(filename) if filename else None
        engine = self.QUOTA_ENGINE
        if engine == "mongo":
            collection = self._db[self._get_collection_name("antigravity")]
            if filename:
                row = await collection.find_one({"filename": filename})
                return [row] if row else []
            return await collection.find({"disabled": {"$ne": True}}).to_list(length=None)
        table = self._get_table_name("antigravity")
        where = "filename = {}" if filename else "COALESCE(disabled, 0) = 0"
        if engine == "sqlite":
            import aiosqlite
            async with aiosqlite.connect(self._db_path, timeout=30) as conn:
                conn.row_factory = aiosqlite.Row
                async with conn.execute(f"SELECT * FROM {table} WHERE " + where.format("?"), (filename,) if filename else ()) as cursor:
                    return [dict(row) for row in await cursor.fetchall()]
        if engine == "postgres":
            async with self._pool.acquire() as conn:
                rows = await conn.fetch(f"SELECT * FROM {table} WHERE " + where.format("$1"), *((filename,) if filename else ()))
                return [dict(row) for row in rows]
        if engine == "mysql":
            import aiomysql
            async with self._pool.acquire() as conn:
                async with conn.cursor(aiomysql.DictCursor) as cursor:
                    await cursor.execute(f"SELECT * FROM {table} WHERE server_name = %s AND " + where.format("%s"),
                                         (self._server_name, filename) if filename else (self._server_name,))
                    return list(await cursor.fetchall())
        raise RuntimeError("unsupported_quota_storage")

    async def quota_ensure_generation(self, filename):
        # A control-plane upload must not fail merely because existing quota
        # metadata is corrupt. Keep that metadata unchanged and generation stable.
        return await self._quota_atomic(filename, lambda row: row["quota_credential_generation"], validate=False)

    async def quota_control_snapshot(self, filename):
        rows = await self._quota_rows(filename)
        if not rows:
            return {}
        try:
            result = public_state(_decode(rows[0]))
            result["quota_credential_generation"] = rows[0].get("quota_credential_generation")
            return result
        except InvalidQuotaState:
            return {"quota_state_invalid": True}

    async def _quota_atomic(self, filename, operation, *, validate=True, cas_fields=None, ensure_generation=True):
        """operation is synchronous; locks are never held across upstream I/O."""
        filename = os.path.basename(filename)
        fields = ("model_access_state", "quota_group_states", "quota_credential_generation", "model_cooldowns", "cycle_stats", "last_cycle_stats",
                  "success_count", "failure_count", "call_count", "last_success", "error_codes", "error_messages", "credential_data", "disabled", "user_email", "tier", "updated_at")

        def apply(raw):
            row = _decode(raw) if validate else dict(raw)
            if ensure_generation:
                row["quota_credential_generation"] = row.get("quota_credential_generation") or uuid.uuid4().hex
            result = operation(row)
            def changed(key):
                previous = raw.get(key)
                if isinstance(previous, str) and isinstance(row[key], (dict, list)):
                    try:
                        previous = json.loads(previous)
                    except ValueError:
                        pass
                return row[key] != previous
            updates = {key: row[key] for key in fields if key in row and changed(key)}
            return result, updates

        engine = self.QUOTA_ENGINE
        if engine == "mongo":
            collection = self._db[self._get_collection_name("antigravity")]
            for _ in range(32):
                raw = await collection.find_one({"filename": filename})
                if raw is None:
                    return None
                result, updates = apply(raw)
                expected = {"_id": raw["_id"]}
                for key in (cas_fields if cas_fields is not None else (*fields, "permanent_disabled")):
                    expected[key] = raw[key] if key in raw else {"$exists": False}
                # Even read admission has a CAS linearization point.
                updates.setdefault("quota_credential_generation", raw.get("quota_credential_generation") or uuid.uuid4().hex)
                changed = await collection.update_one(expected, {"$set": updates})
                if changed.matched_count:
                    await self._quota_cache_changed(filename, raw, updates)
                    return result
            raise RuntimeError("quota_state_contention")

        table = self._get_table_name("antigravity")
        def encoded(updates):
            return {k: json.dumps(v) if isinstance(v, (dict, list)) else v for k, v in updates.items()}

        if engine == "sqlite":
            import aiosqlite
            async with aiosqlite.connect(self._db_path, timeout=30) as conn:
                conn.row_factory = aiosqlite.Row
                await conn.execute("BEGIN IMMEDIATE")
                async with conn.execute(f"SELECT * FROM {table} WHERE filename = ?", (filename,)) as cursor:
                    raw = await cursor.fetchone()
                if raw is None:
                    return None
                result, updates = apply(dict(raw))
                updates = encoded(updates)
                if updates:
                    await conn.execute(f"UPDATE {table} SET " + ", ".join(f"{k} = ?" for k in updates) + " WHERE filename = ?", (*updates.values(), filename))
                await conn.commit()
                await self._quota_cache_changed(filename, dict(raw), updates)
                return result
        if engine == "postgres":
            async with self._pool.acquire() as conn:
                async with conn.transaction():
                    raw = await conn.fetchrow(f"SELECT * FROM {table} WHERE filename = $1 FOR UPDATE", filename)
                    if raw is None:
                        return None
                    result, updates = apply(dict(raw))
                    updates = encoded(updates)
                    if updates:
                        clauses = ", ".join(f"{k} = ${i}" for i, k in enumerate(updates, 1))
                        await conn.execute(f"UPDATE {table} SET {clauses} WHERE filename = ${len(updates)+1}", *updates.values(), filename)
                await self._quota_cache_changed(filename, dict(raw), updates)
                return result
        if engine == "mysql":
            import aiomysql
            async with self._pool.acquire() as conn:
                await conn.begin()
                try:
                    async with conn.cursor(aiomysql.DictCursor) as cursor:
                        await cursor.execute(f"SELECT * FROM {table} WHERE server_name = %s AND filename = %s FOR UPDATE", (self._server_name, filename))
                        raw = await cursor.fetchone()
                        if raw is None:
                            await conn.rollback()
                            return None
                        result, updates = apply(raw)
                        updates = encoded(updates)
                        if updates:
                            await cursor.execute(f"UPDATE {table} SET " + ", ".join(f"{k} = %s" for k in updates) + " WHERE server_name = %s AND filename = %s", (*updates.values(), self._server_name, filename))
                    await conn.commit()
                    await self._quota_cache_changed(filename, raw, updates)
                    return result
                except BaseException:
                    await conn.rollback()
                    raise
        raise RuntimeError("unsupported_quota_storage")

    async def _quota_cache_changed(self, filename, raw, updates):
        self.panel_index_committed(raw, updates)
        if not getattr(self, "_redis_enabled", False) or not {"quota_group_states", "model_cooldowns"}.intersection(updates):
            return
        try:
            models = set(_object(raw.get("model_cooldowns"))) | set(_object(updates.get("model_cooldowns"))) | set(GROUPS)
            keys = [self._rk_cd("antigravity", filename, self._escape_model_name(model)) for model in models]
            await self._redis.delete(*keys)
        except Exception:
            # Redis is advisory: Antigravity selection and final admission always
            # bypass it, even when invalidation cannot reach the cache server.
            from log import log
            log.warning("[ANTIGRAVITY] quota cache invalidation unavailable")

    async def quota_snapshot(self, filename):
        rows = await self._quota_rows(filename)
        if not rows:
            return None
        if not rows[0].get("quota_credential_generation"):
            await self.quota_ensure_generation(filename)
            rows = await self._quota_rows(filename)
            if not rows:
                return None
        row = _decode(rows[0])
        return {**public_state(row), "_quota_credential_version": credential_version(row.get("credential_data"))}

    async def quota_credential_fence(self, filename):
        """Internal control-plane identity; never validate or expose quota data."""
        rows = await self._quota_rows(filename)
        if not rows:
            return None
        if not rows[0].get("quota_credential_generation"):
            await self.quota_ensure_generation(filename)
            rows = await self._quota_rows(filename)
            if not rows:
                return None
        return {"quota_credential_generation": rows[0].get("quota_credential_generation"),
                "_quota_credential_version": credential_version(rows[0].get("credential_data"))}

    async def quota_current_credential(self, filename, generation):
        rows = await self._quota_rows(filename)
        if not rows or rows[0].get("quota_credential_generation") != generation:
            return None
        row = _decode(rows[0])
        data = _object(row.get("credential_data"))
        return {**data, "_quota_generation": generation,
                "_quota_credential_version": credential_version(row.get("credential_data")),
                "enable_credit": bool(row.get("enable_credit"))}

    async def quota_refresh_credential(self, filename, generation, credential_data, expected_version=None, state_updates=None):
        # Network-derived control metadata must share the content fence, too.
        updates = dict(state_updates or {})
        if set(updates) - {"user_email", "tier", "disabled", "error_codes"}:
            raise ValueError("unsupported_quota_control_update")
        def operation(row):
            if (row["quota_credential_generation"] != generation or not expected_version
                    or credential_version(row.get("credential_data")) != expected_version):
                return False
            if credential_data is not None:
                row["credential_data"] = {k: v for k, v in credential_data.items() if not k.startswith("_quota_")}
            row.update(updates)
            return True
        # Refresh/control metadata is independent of quota policy. Corrupt
        # quota fields stay byte-for-byte intact and still block model admission.
        return bool(await self._quota_atomic(filename, operation, validate=False))

    async def quota_disable(self, filename, generation, expected_version=None):
        def operation(row):
            if (not generation or row["quota_credential_generation"] != generation or not expected_version
                    or credential_version(row.get("credential_data")) != expected_version):
                return False
            row["disabled"] = True
            return True
        return bool(await self._quota_atomic(filename, operation))

    async def quota_admit(self, filename, model, purpose="business", generation=None, expected_version=None):
        from config import is_smart_429_protection_enabled
        from src.smart_429 import smart_429_service
        if purpose == "business" and is_smart_429_protection_enabled() and smart_429_service.all_capacity_cooling_retry_after("antigravity", model, {filename}):
            return None
        def operation(row):
            if row.get("disabled") or row.get("permanent_disabled"):
                return None
            if generation is not None and generation != row["quota_credential_generation"]:
                return None
            version = credential_version(row.get("credential_data"))
            if expected_version is not None and version != expected_version:
                return None
            access_target = access_model(model)
            if purpose == "business" and access_target:
                if not self.model_access_storage_ready:
                    return None
                try:
                    access = access_row_state(row)
                    if not access_eligible(access, access_target):
                        return None
                except (ValueError, TypeError):
                    return None
            admission = ticket(row, model, purpose, version)
            if access_target:
                admission["model_access_snapshot"] = {"generation": row["quota_credential_generation"],
                    "version": version, "access": access_row_state(row)}
            state = row["quota_group_states"].get(admission["group"], {})
            until = get_antigravity_cooldown_until(row["model_cooldowns"], model)
            if model and (state.get("state") == "blocked_unknown" or (until and until > time.time())):
                return None
            return admission
        return await self._quota_atomic(filename, operation, cas_fields=(
            "quota_credential_generation", "quota_group_states", "model_cooldowns",
            "disabled", "permanent_disabled", "credential_data", "model_access_state"))

    async def get_next_available_credential(self, mode="geminicli", model_name=None, excluded_credentials=None):
        if mode != "antigravity":
            return await self._get_next_available_credential_legacy(mode=mode, model_name=model_name, excluded_credentials=excluded_credentials)
        candidates = await self._quota_rows()
        random.shuffle(candidates)
        access_target = access_model(model_name)
        if access_target:
            if not self.model_access_storage_ready:
                return None
            def rank(raw):
                try:
                    return not access_eligible(access_row_state(raw), access_target)
                except (ValueError, TypeError):
                    return True
            candidates.sort(key=rank)
        excluded = set(excluded_credentials or ())
        for raw in candidates:
            filename = raw["filename"]
            if filename in excluded or raw.get("disabled") or raw.get("permanent_disabled"):
                continue
            if model_name:
                from config import is_smart_429_protection_enabled
                from src.smart_429 import smart_429_service
                if is_smart_429_protection_enabled() and smart_429_service.all_capacity_cooling_retry_after("antigravity", model_name, {filename}):
                    continue
            try:
                row = _decode(raw)
                if access_target:
                    access = access_row_state(row)
                    if not access_eligible(access, access_target) and not access_check_due(access, access_target):
                        continue
                group = group_for(model_name)
                state = row["quota_group_states"].get(group, {})
                until = get_antigravity_cooldown_until(row["model_cooldowns"], model_name)
                if model_name and (state.get("state") == "blocked_unknown" or (until and until > time.time())):
                    continue
                # Only legacy rows lacking an incarnation need one initialization
                # write, after the read-only candidate filters have accepted them.
                if not raw.get("quota_credential_generation"):
                    generation = await self.quota_ensure_generation(filename)
                    if not generation:
                        continue
                    fresh = await self._quota_rows(filename)
                    if not fresh:
                        continue
                    row = _decode(fresh[0])
                    state = row["quota_group_states"].get(group, {})
                    until = get_antigravity_cooldown_until(row["model_cooldowns"], model_name)
                    if row.get("disabled") or row.get("permanent_disabled") or (model_name and
                            (state.get("state") == "blocked_unknown" or (until and until > time.time()))):
                        continue
                data = _object(row["credential_data"])
                data["_quota_credential_version"] = credential_version(row["credential_data"])
                data["enable_credit"] = bool(row.get("enable_credit"))
                data["_quota_generation"] = row["quota_credential_generation"]
                return filename, data
            except (InvalidQuotaState, ValueError, TypeError):
                from log import log
                log.warning("[ANTIGRAVITY] candidate skipped: invalid_quota_state")
        return None

    async def quota_release(self, filename, group):
        if not valid_group(group):
            raise ValueError("invalid_quota_group")
        def operation(row):
            prior = row["quota_group_states"].get(group)
            if prior:
                row["quota_group_states"][group] = {**prior, "state": "manual_override", "revision": prior["revision"] + 1}
            return public_state(row)
        return await self._quota_atomic(filename, operation)

    async def manual_snapshot(self, filename):
        """Trusted panel snapshot; corrupt scheduling data never blocks a probe."""
        rows = await self._quota_rows(filename)
        if not rows:
            return None
        reliable = True
        if not rows[0].get("quota_credential_generation"):
            try:
                await self.quota_ensure_generation(filename)
                rows = await self._quota_rows(filename)
            except Exception:
                reliable = False
            if not rows:
                return None
        raw = copy.deepcopy(rows[0])
        return {"raw": raw, "access": access_row_state(raw), "credential_data": _object(raw.get("credential_data")),
                "generation": raw.get("quota_credential_generation") if reliable else None,
                "version": credential_version(raw.get("credential_data"))}

    async def manual_current_credential(self, filename, generation):
        current = await self.manual_snapshot(filename)
        return current if current and generation and current["generation"] == generation else None

    @staticmethod
    def _manual_identity(row, snapshot):
        return bool(snapshot and snapshot.get("generation")
                    and snapshot["generation"] == row.get("quota_credential_generation")
                    and snapshot["version"] == credential_version(row.get("credential_data")))

    @staticmethod
    def _manual_fields_match(row, snapshot, fields):
        def value(raw):
            if isinstance(raw, str):
                try:
                    return json.loads(raw)
                except ValueError:
                    pass
            return raw
        return all(value(row.get(k)) == value(snapshot["raw"].get(k)) for k in fields)

    @staticmethod
    def _manual_policy(row, snapshot, group):
        try:
            current, prior = _decode(row), _decode(snapshot["raw"])
        except InvalidQuotaState:
            return None, "invalid_policy"
        cooldowns = lambda r: {k: v for k, v in r["model_cooldowns"].items() if group_for(k) == group}
        if (current["quota_group_states"].get(group) != prior["quota_group_states"].get(group)
                or cooldowns(current) != cooldowns(prior)):
            return None, "state_conflict"
        return current, None

    @staticmethod
    def _manual_result(status, reason=None):
        return {"status": status, **({"reason": reason} if reason else {})}

    @staticmethod
    def _manual_restore(row, group):
        row["model_cooldowns"], _ = prepare_antigravity_cooldown(row["model_cooldowns"], group, None)
        prior = row["quota_group_states"].get(group)
        if prior:
            row["quota_group_states"][group] = {**prior, "state": "manual_override", "revision": prior["revision"] + 1}

    async def manual_save_project(self, filename, snapshot, data, tier):
        def operation(row):
            if not self._manual_identity(row, snapshot):
                return self._manual_result("skipped", "credential_changed")
            if not self._manual_fields_match(row, snapshot, ("tier", "error_codes", "error_messages")):
                return self._manual_result("skipped", "state_conflict")
            row.update(credential_data=data, tier=tier, error_codes=[], error_messages={})
            return self._manual_result("applied")
        return await self._quota_atomic(filename, operation, validate=False)

    async def manual_record_result(self, filename, snapshot, model, success, *, status=None,
                                   error=None, cooldown=None, auto_ban=False):
        if snapshot.get("settlement_started"):
            return {"counts": self._manual_result("skipped", "already_settled")}
        snapshot["settlement_started"] = True
        def operation(row):
            if not self._manual_identity(row, snapshot):
                return {"counts": self._manual_result("skipped", "credential_changed")}
            result = {}
            counter = "success_count" if success else "failure_count"
            for key in (counter, "call_count"):
                if key in row:
                    row[key] = (row[key] or 0) + 1
            if success:
                row["last_success"] = time.time()
            result["counts"] = self._manual_result("applied")
            if not success and status is None:
                result["diagnostics"] = self._manual_result("skipped", "no_upstream_response")
            elif self._manual_fields_match(row, snapshot, ("error_codes", "error_messages")):
                row["error_codes"] = [] if success or status is None else [status]
                row["error_messages"] = {} if success or status is None else {str(status): error}
                result["diagnostics"] = self._manual_result("applied")
            else:
                result["diagnostics"] = self._manual_result("skipped", "state_conflict")
            if auto_ban:
                if self._manual_fields_match(row, snapshot, ("disabled", "permanent_disabled")):
                    row["disabled"] = True
                    result["disabled"] = self._manual_result("applied")
                else:
                    result["disabled"] = self._manual_result("skipped", "state_conflict")
            group = group_for(model)
            policy, reason = self._manual_policy(row, snapshot, group)
            cycle_ok = self._manual_fields_match(row, snapshot, ("cycle_stats", "last_cycle_stats"))
            try:
                _object(row.get("cycle_stats"))
                _object(row.get("last_cycle_stats"))
            except InvalidQuotaState:
                cycle_ok = False
            if policy is not None and cycle_ok and hasattr(self, "_bump_cycle_stats"):
                try:
                    policy["cycle_stats"] = self._bump_cycle_stats(row.get("cycle_stats"), model)
                    row["cycle_stats"] = policy["cycle_stats"]
                    result["cycle_stats"] = self._manual_result("applied")
                except (TypeError, ValueError, OverflowError):
                    cycle_ok = False
                    result["cycle_stats"] = self._manual_result("skipped", "invalid_cycle_stats")
            elif hasattr(self, "_bump_cycle_stats"):
                result["cycle_stats"] = self._manual_result("skipped", reason or "state_conflict")
            if policy is None:
                result["quota"] = self._manual_result("skipped", reason)
            else:
                if success:
                    self._manual_restore(policy, group)
                elif cooldown is not None:
                    key = self._escape_model_name(model) if self.QUOTA_ENGINE == "mongo" else model
                    policy["model_cooldowns"], close = prepare_antigravity_cooldown(policy["model_cooldowns"], key, cooldown)
                    if close and cycle_ok and hasattr(self, "_close_cycle_stats"):
                        try:
                            row["cycle_stats"], row["last_cycle_stats"] = self._close_cycle_stats(policy.get("cycle_stats"), model)
                        except (TypeError, ValueError, OverflowError):
                            result["cycle_stats"] = self._manual_result("skipped", "invalid_cycle_stats")
                row["quota_group_states"] = policy["quota_group_states"]
                row["model_cooldowns"] = policy["model_cooldowns"]
                result["quota"] = self._manual_result("applied" if success or cooldown else "skipped",
                                                     None if success or cooldown else "no_recovery_evidence")
            return result
        result = await self._quota_atomic(filename, operation, validate=False)
        result = result or {"counts": self._manual_result("skipped", "credential_changed")}
        if result["counts"]["status"] == "applied":
            try:
                await self._quota_result_stats(model, success)
                result["statistics"] = self._manual_result("applied")
            except Exception:
                result["statistics"] = self._manual_result("failed", "statistics_update_failed")
        return result

    async def manual_sync_quota(self, filename, models, observation, snapshot, fallback_seconds=300):
        def operation(row):
            result = {"cleared": [], "added": [], "state_update": {}}
            if not self._manual_identity(row, snapshot):
                result["state_update"]["quota"] = self._manual_result("skipped", "credential_changed")
                return result
            grouped = {}
            cycle_matches = self._manual_fields_match(row, snapshot, ("cycle_stats", "last_cycle_stats"))
            for model, info in models.items():
                if isinstance(model, str) and isinstance(info, dict):
                    grouped.setdefault(group_for(model), {})[model] = info
            now = time.time()
            for group, entries in grouped.items():
                policy, reason = self._manual_policy(row, snapshot, group)
                if policy is None:
                    result["state_update"][group] = self._manual_result("skipped", reason)
                    continue
                zeros = [(m, i) for m, i in entries.items() if fraction(i.get("remaining")) == 0]
                if zeros:
                    for model, info in zeros:
                        existing = get_antigravity_cooldown_until(policy["model_cooldowns"], model)
                        if existing and existing > now:
                            continue
                        deadline = timestamp(info.get("resetTimeRaw"))
                        deadline = deadline if deadline and deadline > now else now + fallback_seconds
                        key = self._escape_model_name(model) if self.QUOTA_ENGINE == "mongo" else model
                        policy["model_cooldowns"], close = prepare_antigravity_cooldown(policy["model_cooldowns"], key, deadline)
                        # Preserve corrupt/conflicting cycle state while applying valid quota evidence.
                        try:
                            _object(row.get("cycle_stats")); _object(row.get("last_cycle_stats"))
                            if close and cycle_matches and hasattr(self, "_close_cycle_stats"):
                                row["cycle_stats"], row["last_cycle_stats"] = self._close_cycle_stats(row.get("cycle_stats"), model)
                            elif close and not cycle_matches:
                                result["state_update"]["cycle_stats"] = self._manual_result("skipped", "state_conflict")
                        except (InvalidQuotaState, TypeError, ValueError, OverflowError):
                            result["state_update"]["cycle_stats"] = self._manual_result("skipped", "invalid_cycle_stats")
                        result["added"].append(model)
                elif any(fraction(i.get("remaining")) is None for i in entries.values()):
                    result["state_update"][group] = self._manual_result("skipped", "incomplete_quota")
                    continue
                else:
                    if not policy["quota_group_states"].get(group):
                        anomalous = next((i for i in entries.values() if rolling_week(i.get("resetTimeRaw"), observation)), None)
                        if anomalous:
                            observe_week(policy, group, anomalous, now)
                    self._manual_restore(policy, group)
                    result["cleared"].extend(entries)
                row["model_cooldowns"] = policy["model_cooldowns"]
                row["quota_group_states"] = policy["quota_group_states"]
                result["state_update"][group] = self._manual_result("applied")
            try:
                result.update(public_state(_decode(row)))
            except InvalidQuotaState:
                result["quota_state_invalid"] = True
            return result
        return await self._quota_atomic(filename, operation, validate=False)

    async def quota_business_result(self, filename, admission, status):
        def operation(row):
            if status == 429 and admission and admission.get("purpose") == "business" and matches(row, admission):
                state = row["quota_group_states"].get(admission["group"], {})
                if state.get("state") == "manual_override":
                    state.update(state="blocked_unknown", reason="override_failed_429", revision=state["revision"] + 1, lastSeen=time.time())
            return True
        return await self._quota_atomic(filename, operation)

    async def quota_record_result(self, filename, admission, model, success, status=None, cooldown=None, error=None):
        # An admission is request-owned and never reused for another attempt.
        # Claim settlement before the first await, including concurrent closers.
        if not admission or admission.get("_settlement_started"):
            return False
        admission["_settlement_started"] = True
        def operation(row):
            if not admission or admission.get("generation") != row["quota_credential_generation"]:
                return False
            same_revision = matches(row, admission)
            if not success and status == 429 and admission.get("purpose") == "business" and same_revision:
                state = row["quota_group_states"].get(admission["group"], {})
                if state.get("state") == "manual_override":
                    state.update(state="blocked_unknown", reason="override_failed_429", revision=state["revision"] + 1, lastSeen=time.time())
            counter = "success_count" if success else "failure_count"
            if counter in row:
                row[counter] = (row[counter] or 0) + 1
            if "call_count" in row:
                row["call_count"] = (row["call_count"] or 0) + 1
            if hasattr(self, "_bump_cycle_stats"):
                row["cycle_stats"] = self._bump_cycle_stats(row.get("cycle_stats"), model)
            if success:
                row["last_success"] = time.time()
            elif same_revision:
                row["error_codes"] = [status] if status else []
                row["error_messages"] = {str(status): error} if error else {}
            if not success and cooldown is not None:
                # Revision fences override transitions, not new exhaustion evidence.
                self._quota_cooldown(row, model, cooldown)
            return True
        recorded = await self._quota_atomic(filename, operation)
        if recorded:
            await self._quota_result_stats(model, success)
        return bool(recorded)

    async def _quota_result_stats(self, model, success):
        if hasattr(self, "_bump_stats_buffer"):
            self._bump_stats_buffer(model, "antigravity", is_success=success)
        if self.QUOTA_ENGINE == "postgres":
            from src.storage._stats_common import _today_beijing_str, normalize_model_family
            count = "success_count" if success else "failure_count"
            today, family = _today_beijing_str(), normalize_model_family(model)
            async with self._pool.acquire() as conn:
                async with conn.transaction():
                    await conn.execute(f"INSERT INTO daily_stats (date,mode,{count},updated_at) VALUES ($1,'antigravity',1,EXTRACT(EPOCH FROM NOW())) ON CONFLICT (date,mode) DO UPDATE SET {count}=daily_stats.{count}+1", today)
                    await conn.execute(f"INSERT INTO daily_model_stats (date,mode,model_family,{count},updated_at) VALUES ($1,'antigravity',$2,1,EXTRACT(EPOCH FROM NOW())) ON CONFLICT (date,mode,model_family) DO UPDATE SET {count}=daily_model_stats.{count}+1", today, family)
                    await conn.execute("INSERT INTO minute_model_stats (minute_ts,mode,model_family,count) VALUES ($1,'antigravity',$2,1) ON CONFLICT (minute_ts,mode,model_family) DO UPDATE SET count=minute_model_stats.count+1", int(time.time()//60)*60, family)

    def _quota_cooldown(self, row, model, deadline):
        # Mongo's legacy model keys replace dots with hyphens.
        key = self._escape_model_name(model) if self.QUOTA_ENGINE == "mongo" else model
        row["model_cooldowns"], close = prepare_antigravity_cooldown(row["model_cooldowns"], key, deadline)
        if close and hasattr(self, "_close_cycle_stats"):
            row["cycle_stats"], row["last_cycle_stats"] = self._close_cycle_stats(row.get("cycle_stats"), model)

    async def set_model_cooldown(self, filename, model_name, cooldown_until, mode="geminicli"):
        if mode != "antigravity":
            return await self._set_model_cooldown_legacy(filename, model_name, cooldown_until, mode=mode)
        def operation(row):
            self._quota_cooldown(row, model_name, cooldown_until)
            return True
        return bool(await self._quota_atomic(filename, operation))

    async def quota_sync(self, filename, models, observation, snapshot, fallback_seconds=300, required_models=None):
        """One transaction per snapshot; unknown/partial data never clears a group."""
        def operation(row):
            result = {"cleared": [], "added": [], "stale": False}
            if not snapshot or snapshot.get("quota_credential_generation") != row["quota_credential_generation"]:
                return {**result, "stale": True, **public_state(row)}
            now = time.time()
            grouped = {}
            for model, info in models.items():
                if isinstance(model, str) and isinstance(info, dict):
                    grouped.setdefault(group_for(model), {})[model] = info
            for group, entries in grouped.items():
                state = row["quota_group_states"].get(group, {})
                previous = snapshot.get("quota_group_states", {}).get(group, {})
                if state.get("revision", 0) != previous.get("revision", 0) or state.get("lastSeen", 0) > observation.get("sentAt", now):
                    result["stale"] = True
                    continue
                anomalous = [info for info in entries.values() if rolling_week(info.get("resetTimeRaw"), observation)]
                if anomalous:
                    observe_week(row, group, anomalous[0], now)
                zeros = [(m, info) for m, info in entries.items()
                         if fraction(info.get("remaining")) == 0 and not rolling_week(info.get("resetTimeRaw"), observation)]
                if zeros:
                    for model, info in zeros:
                        existing = get_antigravity_cooldown_until(row["model_cooldowns"], model)
                        deadline = timestamp(info.get("resetTimeRaw"))
                        if not deadline or deadline <= now:
                            if existing and existing > now:
                                continue
                            deadline = now + fallback_seconds
                        self._quota_cooldown(row, model, deadline)
                        result["added"].append(model)
                    continue
                if anomalous:
                    continue
                # required_models=None means the routable universe is unknown.
                required = {m for m in (required_models or ()) if group_for(m) == group}
                required |= {m for m, d in row["model_cooldowns"].items() if group_for(m) == group and d > now}
                # Mongo persists dots as hyphens; compare coverage in its stored
                # namespace, while requiring every colliding entry to be positive.
                key_for = self._escape_model_name if self.QUOTA_ENGINE == "mongo" else lambda value: value
                required_keys = {key_for(m) for m in required}
                covered = {}
                for model, info in entries.items():
                    covered.setdefault(key_for(model), []).append(info)
                if (required_models is not None and required_keys and required_keys <= covered.keys()
                        and all(fraction(info.get("remaining")) not in (None, 0)
                                for key in required_keys for info in covered[key])):
                    self._quota_cooldown(row, group, None)
                    result["cleared"].extend(sorted(required))
            result.update(public_state(row))
            return result
        return await self._quota_atomic(filename, operation)
