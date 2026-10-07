"""Import-only atomic credential replacement; never used for token refresh/migration."""
import copy
import json
import math
import os
import time
import uuid


_INITIAL_FIELDS = {"disabled", "error_codes", "last_success", "user_email", "tier"}
_PROTECTION_FIELDS = {"quota_credential_generation", "model_access_state"}


def _initial_state(value):
    from src.subscription_tiers import valid_tiers_for_mode
    if value is None:
        return {}
    if not isinstance(value, dict) or set(value) - _INITIAL_FIELDS:
        raise ValueError("invalid_import_initial_state")
    value = copy.deepcopy(value)
    if "disabled" in value and type(value["disabled"]) is not bool:
        raise ValueError("invalid_import_initial_state")
    if "error_codes" in value and (not isinstance(value["error_codes"], list) or
            any(type(code) is not int for code in value["error_codes"])):
        raise ValueError("invalid_import_initial_state")
    if "last_success" in value:
        number = value["last_success"]
        try:
            valid = type(number) in (int, float) and math.isfinite(number)
        except OverflowError:
            valid = False
        if not valid:
            raise ValueError("invalid_import_initial_state")
    if "user_email" in value and value["user_email"] is not None and not isinstance(value["user_email"], str):
        raise ValueError("invalid_import_initial_state")
    if "tier" in value and value["tier"] not in valid_tiers_for_mode("antigravity"):
        raise ValueError("invalid_import_initial_state")
    return value


def _defaults(initial, now, rotation):
    from src.subscription_tiers import default_tier_for_mode
    return {"disabled": False, "permanent_disabled": False, "error_codes": [],
            "error_messages": [], "last_success": now, "user_email": None,
            "model_cooldowns": {}, "quota_group_states": {}, "cycle_stats": {},
            "last_cycle_stats": {}, "tier": default_tier_for_mode("antigravity"),
            "enable_credit": False, "rotation_order": rotation, "call_count": 0,
            "success_count": 0, "failure_count": 0, "created_at": now, "updated_at": now,
            **initial}


def _encoded(value):
    if isinstance(value, (dict, list)):
        return json.dumps(value)
    return int(value) if isinstance(value, bool) else value


class AntigravityImportMixin:
    async def import_antigravity_credential(self, filename, credential_data, *, initial_state=None):
        """Replace contents and invalidate access in one database write.

        Initial state is insert-only. Existing quota/state bytes are not decoded.
        SQL column discovery is read-only and occurs in the write transaction;
        failure never falls back to an unfenced generic store or performs DDL.
        """
        self._ensure_initialized()
        filename = os.path.basename(filename)
        if not filename or not isinstance(credential_data, dict):
            raise ValueError("invalid_import_credential")
        initial = _initial_state(initial_state)
        changes = {"credential_data": copy.deepcopy(credential_data),
                   "quota_credential_generation": uuid.uuid4().hex, "model_access_state": {}}
        # Validate serializability before any database operation.
        json.dumps(changes)
        engine, now = self.QUOTA_ENGINE, time.time()
        inserted = False
        cache_state = initial
        if engine == "mongo":
            from pymongo.errors import DuplicateKeyError
            collection = self._db[self._get_collection_name("antigravity")]
            maximum = await collection.find_one({}, sort=[("rotation_order", -1)], projection={"rotation_order": 1})
            last_order = (maximum or {}).get("rotation_order", -1)
            rotation = (last_order if type(last_order) is int else -1) + 1
            defaults = {"filename": filename, "preview": True, **_defaults(initial, now, rotation)}
            try:
                result = await collection.update_one({"filename": filename},
                    {"$set": changes, "$setOnInsert": defaults}, upsert=True)
                inserted = result.upserted_id is not None
                if not inserted and not result.matched_count:
                    raise RuntimeError("credential_import_not_applied")
            except DuplicateKeyError:
                # A concurrent insert won. Never apply insert defaults to it.
                result = await collection.update_one({"filename": filename}, {"$set": changes})
                if not result.matched_count:
                    raise RuntimeError("credential_import_conflict") from None
        elif engine == "sqlite":
            import aiosqlite
            table = self._get_table_name("antigravity")
            async with aiosqlite.connect(self._db_path, timeout=30) as conn:
                await conn.execute("BEGIN IMMEDIATE")
                async with conn.execute(f"PRAGMA table_info({table})") as cur:
                    columns = {row[1] for row in await cur.fetchall()}
                async with conn.execute(f"SELECT COALESCE(MAX(rotation_order), -1) + 1 FROM {table}") as cur:
                    rotation = (await cur.fetchone())[0]
                values, updates = self._import_sql_values(columns, filename, changes, initial, now, rotation)
                query = self._import_upsert(table, values, updates, engine)
                await conn.execute(query, tuple(_encoded(v) for v in values.values()))
                await conn.commit()
        elif engine == "postgres":
            table = self._get_table_name("antigravity")
            async with self._pool.acquire() as conn:
                async with conn.transaction():
                    found = await conn.fetch("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1", table)
                    columns = {row["column_name"] for row in found}
                    rotation = await conn.fetchval(f"SELECT COALESCE(MAX(rotation_order), -1) + 1 FROM {table}")
                    values, updates = self._import_sql_values(columns, filename, changes, initial, now, rotation)
                    await conn.execute(self._import_upsert(table, values, updates, engine), *(_encoded(v) for v in values.values()))
        elif engine == "mysql":
            table = self._get_table_name("antigravity")
            async with self._pool.acquire() as conn:
                await conn.begin()
                try:
                    async with conn.cursor() as cur:
                        await cur.execute(f"SHOW COLUMNS FROM {table}")
                        columns = {row[0] for row in await cur.fetchall()}
                        await cur.execute(f"SELECT COALESCE(MAX(rotation_order), -1) + 1 FROM {table} WHERE server_name = %s", (self._server_name,))
                        rotation = (await cur.fetchone())[0]
                        values, updates = self._import_sql_values(columns, filename, changes, initial, now, rotation)
                        if "server_name" not in columns:
                            raise RuntimeError("invalid_import_schema")
                        values["server_name"] = self._server_name
                        await cur.execute(self._import_upsert(table, values, updates, engine), tuple(_encoded(v) for v in values.values()))
                        inserted = cur.rowcount == 1
                        if inserted:
                            # CLIENT_FOUND_ROWS may report one affected row for a
                            # no-op legacy-table overwrite. Check authoritative
                            # policy before adding anything to advisory Redis.
                            if {"disabled", "tier"} <= columns:
                                keys = [key for key in ("disabled", "permanent_disabled", "tier") if key in columns]
                                await cur.execute(f"SELECT {', '.join(keys)} FROM {table} WHERE server_name = %s AND filename = %s",
                                                  (self._server_name, filename))
                                current = await cur.fetchone()
                                cache_state = dict(zip(keys, current)) if current is not None else {"disabled": True}
                            else:
                                cache_state = {"disabled": True}
                    await conn.commit()
                except BaseException:
                    await conn.rollback()
                    raise
        else:
            raise RuntimeError("unsupported_import_storage")
        self.panel_index_invalidate()
        if (inserted and cache_state.get("disabled", False) in (False, 0)
                and not cache_state.get("permanent_disabled", False) and hasattr(self, "_redis_add_cred")):
            try:
                await self._redis_add_cred("antigravity", filename, tier=cache_state.get("tier") or "pro", preview=True)
            except Exception:
                # Cache is advisory; the import has already atomically committed.
                from log import log
                log.warning("[ANTIGRAVITY] import cache update unavailable")
        return True

    def _import_sql_values(self, columns, filename, changes, initial, now, rotation):
        if not {"filename", "credential_data"} <= columns:
            raise RuntimeError("invalid_import_schema")
        if not _PROTECTION_FIELDS <= columns:
            self.model_access_storage_ready = False
        updates = {key: value for key, value in changes.items() if key in columns}
        defaults = _defaults(initial, now, rotation)
        values = {"filename": filename, **updates,
                  **{key: value for key, value in defaults.items() if key in columns}}
        return values, updates

    @staticmethod
    def _import_upsert(table, values, updates, engine):
        names = ', '.join(values)
        placeholders = ', '.join(f"${index}" if engine == "postgres" else ('?' if engine == 'sqlite' else '%s')
                                 for index in range(1, len(values) + 1))
        if engine == "mysql":
            conflict = 'ON DUPLICATE KEY UPDATE ' + ', '.join(f'{key} = VALUES({key})' for key in updates)
        else:
            conflict = 'ON CONFLICT (filename) DO UPDATE SET ' + ', '.join(f'{key} = excluded.{key}' for key in updates)
        return f"INSERT INTO {table} ({names}) VALUES ({placeholders}) {conflict}"
