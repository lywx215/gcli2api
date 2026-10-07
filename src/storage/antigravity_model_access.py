"""Fenced, atomic access observations and durable directory-check leases."""
import time
import hashlib
import json
import uuid

from src.antigravity_model_access import (MODELS, ROUTES, FAMILIES, QUERY_RETRY, decode, eligible,
    observe, observe_entry, public, public_families, project, access_family, check_due)


def identity(row):
    data = row.get("credential_data") or {}
    data = json.loads(data) if isinstance(data, str) else data
    if not isinstance(data, dict):
        raise ValueError("invalid_access_credential")
    volatile = {"access_token", "token", "expiry", "expires_at", "expires_in", "enable_credit"}
    stable = {k: v for k, v in data.items() if k not in volatile and not k.startswith("_quota_")}
    return hashlib.sha256(json.dumps([row.get("quota_credential_generation"), stable], sort_keys=True).encode()).hexdigest()


def row_state(row):
    try:
        state = decode(row.get("model_access_state"))
    except (ValueError, TypeError):
        return decode({})
    if state.get("identity") != identity(row):
        return decode({})
    return state


class AntigravityModelAccessMixin:
    model_access_storage_ready = False

    async def model_access_initialize(self):
        self.model_access_storage_ready = False
        if self.QUOTA_ENGINE != "mongo":
            # Verify the migrated column even for empty databases; fail closed.
            table = self._get_table_name("antigravity")
            if self.QUOTA_ENGINE == "sqlite":
                import aiosqlite
                async with aiosqlite.connect(self._db_path) as conn:
                    await conn.execute(f"SELECT model_access_state FROM {table} LIMIT 0")
            elif self.QUOTA_ENGINE == "postgres":
                async with self._pool.acquire() as conn:
                    await conn.fetch(f"SELECT model_access_state FROM {table} LIMIT 0")
            elif self.QUOTA_ENGINE == "mysql":
                async with self._pool.acquire() as conn:
                    async with conn.cursor() as cur:
                        await cur.execute(f"SELECT model_access_state FROM {table} LIMIT 0")
            else:
                return False
        self.model_access_storage_ready = True
        return True

    @staticmethod
    def _access_fence(row, snapshot):
        from src.storage.antigravity_quota import credential_version
        return bool(snapshot and snapshot.get("generation") == row.get("quota_credential_generation")
                    and snapshot.get("version") == credential_version(row.get("credential_data")))

    async def model_access_snapshot(self, filename):
        if not self.model_access_storage_ready:
            return None
        snapshot = await self.manual_snapshot(filename)
        if snapshot:
            if "access" not in snapshot:
                snapshot["access"] = row_state(snapshot["raw"])
        return snapshot

    async def model_access_public(self, filename):
        rows = await self._quota_rows(filename)
        return public(row_state(rows[0])) if rows else {}

    async def model_access_family_public(self, filename):
        rows = await self._quota_rows(filename)
        return public_families(row_state(rows[0])) if rows else {}

    async def model_access_list_family_public(self):
        return await self.model_access_list_public(families=True)

    async def model_access_list_public(self, *, families=False):
        """One cached read including disabled accounts; no per-row queries or writes.

        Credential contents are used only internally to validate the identity fence.
        The returned projection contains no tokens, identity, revision or leases.
        """
        if not self.model_access_storage_ready:
            return {}
        columns = ("filename", "credential_data", "quota_credential_generation", "model_access_state")
        engine = self.QUOTA_ENGINE
        if engine == "mongo":
            collection = self._db[self._get_collection_name("antigravity")]
            rows = await collection.find({}, {key: 1 for key in columns}).to_list(length=None)
        else:
            table = self._get_table_name("antigravity")
            query = f"SELECT {', '.join(columns)} FROM {table}"
            if engine == "sqlite":
                import aiosqlite
                async with aiosqlite.connect(self._db_path, timeout=30) as conn:
                    conn.row_factory = aiosqlite.Row
                    async with conn.execute(query) as cursor:
                        rows = await cursor.fetchall()
            elif engine == "postgres":
                async with self._pool.acquire() as conn:
                    rows = await conn.fetch(query)
            elif engine == "mysql":
                import aiomysql
                async with self._pool.acquire() as conn:
                    async with conn.cursor(aiomysql.DictCursor) as cursor:
                        await cursor.execute(query + " WHERE server_name = %s", (self._server_name,))
                        rows = await cursor.fetchall()
            else:
                return {}
        result = {}
        for raw in rows:
            row = dict(raw)
            try:
                result[row["filename"]] = (public_families if families else public)(row_state(row))
            except (ValueError, TypeError):
                result[row["filename"]] = (public_families if families else public)({})
        return result

    async def model_access_claim(self, filename, *, force=False, now=None, model=None):
        if not self.model_access_storage_ready:
            return None
        now = time.time() if now is None else now
        lease_id = uuid.uuid4().hex
        def operation(row):
            if row.get("disabled") or row.get("permanent_disabled"):
                return None
            state = row_state(row)
            if state.get("lease", {}).get("until", 0) > now:
                return None
            if not force and not check_due(state, model, now):
                return None
            state["lease"] = {"id": lease_id, "until": now + 120}
            state["identity"] = identity(row)
            row["model_access_state"] = state
            from src.storage.antigravity_quota import credential_version
            return {"generation": row["quota_credential_generation"],
                    "version": credential_version(row.get("credential_data")),
                    "access": decode(state), "lease_id": lease_id}
        return await self._quota_atomic(filename, operation, validate=False)

    async def model_access_queue(self, filename):
        def operation(row):
            state = row_state(row)
            for family in FAMILIES:
                state["families"].setdefault(family, {"state": "unknown", "revision": 1, "next_check_at": time.time()})
            project(state)
            state["identity"] = identity(row)
            row["model_access_state"] = state
        if self.model_access_storage_ready:
            await self._quota_atomic(filename, operation, validate=False)

    async def model_access_observe(self, filename, snapshot, models=None, **kwargs):
        result = await self.model_access_observe_with_projection(filename, snapshot, models, **kwargs)
        return result["applied"]

    async def model_access_clear_lease(self, filename, generation, lease_id):
        """Clear only the exact claimed lease; preserve evidence and backoff."""
        if not generation or not lease_id:
            return False
        def operation(row):
            if row.get("quota_credential_generation") != generation:
                return False
            state = decode(row.get("model_access_state"))
            if state.get("lease", {}).get("id") != lease_id:
                return False
            state.pop("lease", None)
            row["model_access_state"] = state
            return True
        return bool(await self._quota_atomic(filename, operation, validate=False))

    async def model_access_observe_with_projection(self, filename, snapshot, models=None, *, model=None, success=None, reason=None, now=None):
        """Observe version permissions and only the native routes actually evidenced."""
        if not self.model_access_storage_ready:
            return {"applied": False, "public": {}, "families": {}}
        if models is None and success is not None and model not in ROUTES:
            return {"applied": False, "public": {}, "families": {}}
        now = time.time() if now is None else now
        def operation(row):
            def result(applied, state):
                return {"applied": applied, "public": public(state), "families": public_families(state)}
            if not self._access_fence(row, snapshot):
                return result(False, row_state(row))
            state = row_state(row)
            if snapshot.get("lease_id") and state.get("lease", {}).get("id") != snapshot["lease_id"]:
                return result(False, row_state(row))
            prior = decode(snapshot.get("access", {}))
            targets = (access_family(model),) if model in ROUTES else FAMILIES
            applied = False
            for family in targets:
                entry = state["families"].get(family, {})
                # Queueing or a failed query establishes no permission evidence.
                def evidence_revision(value):
                    return value.get("revision", 0) if "checked_at" in value else 0
                if evidence_revision(entry) != evidence_revision(prior["families"].get(family, {})):
                    continue
                routes = [native for native in ROUTES if access_family(native) == family]
                if models is not None:
                    present = any(native in models for native in routes)
                    observe_entry(state["families"], family, present,
                                  reason or ("directory_supported" if present else "directory_missing"), now)
                    for native in routes:
                        if state["routes"].get(native, {}).get("revision", 0) != prior["routes"].get(native, {}).get("revision", 0):
                            continue
                        observe_entry(state["routes"], native, native in models,
                                      "directory_supported" if native in models else "directory_missing", now)
                elif success is not None and model in ROUTES:
                    if state["routes"].get(model, {}).get("revision", 0) != prior["routes"].get(model, {}).get("revision", 0):
                        continue
                    observe(state, model, success, reason or ("generation_succeeded" if success else "generation_404"), now)
                else:
                    state["families"][family] = {**entry, "state": entry.get("state", "unknown"),
                        "revision": entry.get("revision", 1), "reason": reason or "directory_query_failed",
                        "last_attempt_at": now, "next_check_at": now + QUERY_RETRY}
                applied = True
            project(state)
            if snapshot.get("lease_id"):
                state.pop("lease", None)
            state["identity"] = identity(row)
            row["model_access_state"] = state
            return result(applied, state)
        return await self._quota_atomic(filename, operation, validate=False) or {"applied": False, "public": {}, "families": {}}

    async def model_access_union(self):
        if not self.model_access_storage_ready:
            return set()
        result = set()
        for row in await self._quota_rows():
            if row.get("disabled") or row.get("permanent_disabled"):
                continue
            try:
                state = row_state(row)
                result.update(model for model in ROUTES if eligible(state, model))
            except (ValueError, TypeError):
                continue
        return result

    async def model_access_due(self, limit=100):
        if not self.model_access_storage_ready:
            return []
        now, result = time.time(), []
        for row in await self._quota_rows():
            if row.get("disabled") or row.get("permanent_disabled"):
                continue
            try:
                state = row_state(row)
                if (state.get("lease", {}).get("until", 0) <= now and
                        check_due(state, now=now)):
                    result.append(row["filename"])
            except (ValueError, TypeError):
                continue
            if len(result) >= limit:
                break
        return result
