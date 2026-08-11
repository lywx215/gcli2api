from __future__ import annotations

import json
import time
from datetime import UTC, datetime
from typing import Any


class ActiveOperationFailure(Exception):
    """A sanitized failure from an existing provider operation."""

    def __init__(self, *, status_code: int, code: str, retryable: bool) -> None:
        super().__init__(code)
        self.status_code = status_code
        self.code = code
        self.retryable = retryable


def _response_body(response: Any) -> dict[str, object]:
    body = getattr(response, "body", b"")
    if isinstance(body, bytes):
        try:
            value = json.loads(body.decode("utf-8"))
        except (UnicodeError, ValueError):
            return {}
        return value if isinstance(value, dict) else {}
    return response if isinstance(response, dict) else {}


def _future_cooldown(raw: object, now: float) -> float:
    if isinstance(raw, str) and raw:
        try:
            parsed = datetime.fromisoformat(raw)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=UTC)
            timestamp = parsed.timestamp()
            if timestamp > now + 60:
                return timestamp
        except ValueError:
            pass
    return now + 4 * 60 * 60


class PanelActiveOperations:
    """Narrow adapter over reviewed panel operations.

    The caller is responsible for idempotency and response whitelisting. This
    adapter never returns credential material; it only passes operation output
    to the management service for normalization.
    """

    supported_actions = frozenset(
        {"enable_preview", "quota", "test", "risk_check", "sync_cooldown"}
    )

    @classmethod
    def supports(cls, action: str) -> bool:
        if action not in cls.supported_actions:
            return False
        if action == "risk_check":
            from config import is_smart_429_protection_enabled

            return is_smart_429_protection_enabled()
        return True

    async def execute(
        self,
        *,
        action: str,
        mode: str,
        filename: str,
        parameters: dict[str, object],
        storage: Any,
    ) -> dict[str, object]:
        from fastapi import HTTPException

        from src.panel.creds import (
            _fetch_quota_for_credential,
            configure_preview_channel,
            immediately_recheck_risk_control,
            test_credential_common,
        )

        before_credential = await storage.get_credential(filename, mode=mode)
        before_state = await storage.get_credential_state(filename, mode=mode)
        started = time.monotonic()
        try:
            if action == "enable_preview":
                response = await configure_preview_channel(
                    filename, token="management-api", mode=mode
                )
                payload = _response_body(response)
                payload["_status_code"] = int(getattr(response, "status_code", 200))
            elif action == "quota":
                payload = await _fetch_quota_for_credential(filename, mode=mode)
            elif action == "test":
                response = await test_credential_common(
                    filename,
                    mode=mode,
                    model=parameters.get("model_name"),
                )
                payload = _response_body(response)
                payload["_status_code"] = int(getattr(response, "status_code", 200))
            elif action == "risk_check":
                response = await immediately_recheck_risk_control(
                    filename, token="management-api"
                )
                payload = _response_body(response)
                payload["_status_code"] = int(getattr(response, "status_code", 200))
            else:
                payload = await self._sync_cooldown(
                    filename=filename, mode=mode, storage=storage
                )
        except HTTPException as exc:
            status_code = int(exc.status_code)
            if status_code == 404:
                code = "CREDENTIAL_NOT_FOUND"
            elif status_code == 409:
                code = "CONFLICT"
            else:
                code = "UPSTREAM_ERROR"
                status_code = 502
            raise ActiveOperationFailure(
                status_code=status_code,
                code=code,
                retryable=status_code in (409, 429, 502, 503),
            ) from exc
        except Exception as exc:
            raise ActiveOperationFailure(
                status_code=502, code="UPSTREAM_ERROR", retryable=True
            ) from exc

        after_credential = await storage.get_credential(filename, mode=mode)
        after_state = await storage.get_credential_state(filename, mode=mode)
        before_token = (
            before_credential.get("access_token") or before_credential.get("token")
            if isinstance(before_credential, dict)
            else None
        )
        after_token = (
            after_credential.get("access_token") or after_credential.get("token")
            if isinstance(after_credential, dict)
            else None
        )
        return {
            "payload": payload,
            "latency_ms": round((time.monotonic() - started) * 1000, 3),
            "token_refreshed": bool(
                after_token is not None and before_token != after_token
            ),
            "state_changed": before_state != after_state,
            "cooldown_changed": (
                before_state.get("model_cooldowns")
                if isinstance(before_state, dict)
                else None
            )
            != (
                after_state.get("model_cooldowns")
                if isinstance(after_state, dict)
                else None
            ),
        }

    @staticmethod
    async def _sync_cooldown(
        *, filename: str, mode: str, storage: Any
    ) -> dict[str, object]:
        from src.panel.creds import _fetch_quota_for_credential

        quota = await _fetch_quota_for_credential(filename, mode=mode)
        if quota.get("success") is not True:
            return {"success": False}
        models = quota.get("models")
        if not isinstance(models, dict):
            models = {}
        state = await storage.get_credential_state(filename, mode=mode)
        cooldowns = state.get("model_cooldowns", {}) if isinstance(state, dict) else {}
        if not isinstance(cooldowns, dict):
            cooldowns = {}
        backend = getattr(storage, "_backend", None)
        now = time.time()
        for raw_model, raw_info in list(models.items())[:128]:
            if not isinstance(raw_model, str) or not isinstance(raw_info, dict):
                continue
            remaining = raw_info.get("remaining")
            if isinstance(remaining, bool) or not isinstance(remaining, (int, float)):
                continue
            existing = cooldowns.get(raw_model)
            try:
                existing_timestamp = float(existing) if existing is not None else None
            except (TypeError, ValueError):
                existing_timestamp = None
            if remaining > 0 and existing_timestamp is not None and existing_timestamp > now:
                await backend.set_model_cooldown(filename, raw_model, None, mode=mode)
            elif remaining <= 0 and not (
                existing_timestamp is not None and existing_timestamp > now
            ):
                await backend.set_model_cooldown(
                    filename,
                    raw_model,
                    _future_cooldown(raw_info.get("resetTimeRaw"), now),
                    mode=mode,
                )
        current = await storage.get_credential_state(filename, mode=mode)
        return {
            "success": True,
            "model_cooldowns": (
                current.get("model_cooldowns", {}) if isinstance(current, dict) else {}
            ),
        }
