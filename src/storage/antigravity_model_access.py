"""Fenced, atomic access observations and durable directory-check leases."""
import time
import hashlib
import json
import uuid

from src.antigravity_model_access import MODELS, QUERY_RETRY, decode, eligible, observe, public


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
        return {"models": {}}
    if state.get("identity") != identity(row):
        return {"models": {}}
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
            snapshot["access"] = row_state(snapshot["raw"])
        return snapshot

    async def model_access_public(self, filename):
        rows = await self._quota_rows(filename)
        return public(row_state(rows[0])) if rows else {}

    async def model_access_claim(self, filename, *, force=False, now=None):
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
            if not force and state["models"] and not any(e.get("next_check_at", 0) <= now for e in state["models"].values()):
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
            for model in MODELS:
                state["models"].setdefault(model, {"state": "unknown", "revision": 1, "next_check_at": time.time()})
            state["identity"] = identity(row)
            row["model_access_state"] = state
        if self.model_access_storage_ready:
            await self._quota_atomic(filename, operation, validate=False)

    async def model_access_observe(self, filename, snapshot, models=None, *, model=None, success=None, reason=None, now=None):
        """A directory observes all tiers; a generation observes only its exact tier."""
        if not self.model_access_storage_ready:
            return False
        now = time.time() if now is None else now
        def operation(row):
            if not self._access_fence(row, snapshot):
                return False
            state = row_state(row)
            if snapshot.get("lease_id") and state.get("lease", {}).get("id") != snapshot["lease_id"]:
                return False
            prior = snapshot.get("access", {}).get("models", {})
            targets = (model,) if model in MODELS else MODELS
            applied = False
            for target in targets:
                entry = state["models"].get(target, {})
                if entry.get("revision", 0) != prior.get(target, {}).get("revision", 0):
                    continue
                if models is not None or success is not None:
                    present = target in models if models is not None else success
                    observe(state, target, present, reason or ("directory_supported" if present else "directory_missing"), now)
                else:
                    state["models"][target] = {**entry, "state": entry.get("state", "unknown"),
                        "revision": entry.get("revision", 0) + 1, "reason": reason or "directory_query_failed",
                        "last_attempt_at": now, "next_check_at": now + QUERY_RETRY}
                applied = True
            if snapshot.get("lease_id"):
                state.pop("lease", None)
            state["identity"] = identity(row)
            row["model_access_state"] = state
            return applied
        return bool(await self._quota_atomic(filename, operation, validate=False))

    async def model_access_union(self):
        if not self.model_access_storage_ready:
            return set()
        result = set()
        for row in await self._quota_rows():
            if row.get("disabled") or row.get("permanent_disabled"):
                continue
            try:
                state = row_state(row)
                result.update(model for model in MODELS if eligible(state, model))
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
                        (not state["models"] or any(e.get("next_check_at", 0) <= now for e in state["models"].values()))):
                    result.append(row["filename"])
            except (ValueError, TypeError):
                continue
            if len(result) >= limit:
                break
        return result
