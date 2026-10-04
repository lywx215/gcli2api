"""Authenticated panel operations, independent of automatic admission policy.

Legacy and management callers opt out by default in creds.py. No credentials or
raw upstream errors may leave this module in responses or diagnostic messages.
"""
import asyncio
from src.antigravity_model_access import access_model
from src.storage.antigravity_model_access import row_state as access_row_state

from fastapi import HTTPException
from fastapi.responses import JSONResponse

from src.manual_google import manual_google_phase
from src.storage.antigravity_quota import credential_version


def error_message(status):
    return {400: "Invalid request.", 401: "Authentication failed.",
            403: "Permission denied.", 404: "Resource unavailable.",
            408: "Request timed out.", 429: "Rate limit exceeded."}.get(
                status, "Service temporarily unavailable." if status and status >= 500 else "Request failed.")


def failed_update(reason="state_update_failed"):
    return {"status": "failed", "reason": reason}


def same_refresh_identity(before, after):
    # Legacy imports may replace content without rotating the row generation.
    # Accept a concurrent token refresh, never switch to a different account.
    volatile = {"access_token", "token", "expiry", "expires_at", "expires_in"}
    stable = lambda data: {k: v for k, v in data.items() if k not in volatile and v is not None}
    return stable(before) == stable(after)


def local_result(exc, events, phase="preparation"):
    # Never return exception text, which may contain tokens or upstream messages.
    if isinstance(exc, HTTPException):
        return {"success": False, "status_code": exc.status_code, "upstream_status": None,
                "response_source": "local", "phase": phase, "phases": events,
                "error": "Credential changed." if exc.status_code == 409 else error_message(exc.status_code),
                "state_update": {"credential": {"status": "skipped", "reason": "credential_changed"}}
                if exc.status_code == 409 else {}}
    status = 502
    upstream = events[-1]["upstream_status"] if events else None
    return {"success": False, "status_code": upstream or status,
            "upstream_status": upstream, "response_source": "google" if events else "local",
            "phase": events[-1]["phase"] if events else phase, "phases": events,
            "error": "Invalid upstream response." if upstream == 200 else error_message(upstream or status),
            "state_update": {}}


async def prepare(filename, events):
    from . import creds as p
    if not filename.endswith(".json"):
        raise HTTPException(400)
    storage = await p.get_storage_adapter()
    snapshot = await storage._backend.manual_snapshot(filename)
    if not snapshot or not snapshot["credential_data"]:
        raise HTTPException(404)
    data = snapshot["credential_data"]
    with manual_google_phase("oauth", events):
        credentials = p.Credentials.from_dict(data)
        refreshed = await credentials.refresh_if_needed()
    if refreshed:
        # Preserve imported metadata so concurrent refreshes retain the same
        # stable identity. Keep the legacy token alias in sync as well.
        data = {**data, **credentials.to_dict()}
        if "token" in data:
            data["token"] = data["access_token"]
        if snapshot.get("generation"):
            saved = await storage._backend.quota_refresh_credential(
                filename, snapshot["generation"], data, expected_version=snapshot["version"])
            if saved:
                snapshot["version"] = credential_version(data)
            else:
                current = await storage._backend.manual_current_credential(filename, snapshot["generation"])
                with manual_google_phase("oauth", events):
                    if (not current or not same_refresh_identity(snapshot["credential_data"], current["credential_data"])
                            or p.Credentials.from_dict(current["credential_data"]).is_expired()):
                        raise HTTPException(409)
                data = current["credential_data"]
                snapshot["version"] = current["version"]
        # If identity initialization failed, the refreshed token is usable only
        # for this request; never persist it without an identity fence.
    if not (data.get("access_token") or data.get("token")):
        raise HTTPException(400)
    access_snapshot = await storage._backend.model_access_snapshot(filename)
    snapshot["access"] = (access_snapshot["access"] if access_snapshot and
        access_snapshot["generation"] == snapshot["generation"] and access_snapshot["version"] == snapshot["version"]
        else access_row_state(snapshot["raw"]))
    return storage, snapshot, data


async def test(filename, model=None):
    from . import creds as p
    retired_response = p._retired_antigravity_test_response(model)
    if retired_response is not None:
        return retired_response
    from src.httpx_client import post_async
    from src.api.antigravity import build_antigravity_headers
    from src.converter.gemini_fix import map_antigravity_gemini_model
    from src.utils import normalize_antigravity_model_alias
    from src.antigravity_completion import validate_json
    from src.router.model_api_errors import parse_model_response, error_from_retirement_payload, ModelApiErrorException

    events, snapshot = [], None
    response = None
    strict = model is not None
    requested_model = model or "gemini-2.5-flash"
    upstream_model = requested_model
    dispatched = False
    try:
        storage, snapshot, data = await prepare(filename, events)
        if not data.get("project_id"):
            raise HTTPException(400)
        upstream_model = normalize_antigravity_model_alias(requested_model)
        if upstream_model.startswith("gemini-"):
            upstream_model = map_antigravity_gemini_model(upstream_model, None, None)
        url = f"{await p.get_antigravity_api_url()}/v1internal:generateContent"
        dispatched = True
        response = await post_async(
            url=url,
            headers=build_antigravity_headers(data.get("access_token") or data.get("token")),
            json={"model": upstream_model, "project": data["project_id"], "request": {
                "contents": [{"role": "user", "parts": [{"text": p.ANTIGRAVITY_MODEL_TEST_PROMPT if strict else "hi"}]}],
                "generationConfig": {"maxOutputTokens": 256 if strict else 1}}}, timeout=30.0)
    except asyncio.CancelledError:
        if dispatched:
            try:
                await storage._backend.manual_record_result(filename, snapshot, upstream_model, False)
                if strict:
                    await p.record_logical_request(p._antigravity_test_stats_model(requested_model, upstream_model), "antigravity", False)
            except Exception:
                p.log.warning("[MANUAL ANTIGRAVITY] Cancelled request settlement failed.")
        raise
    except Exception as exc:
        result = local_result(exc, events)
        # A generation transport failure is distinct from a preceding OAuth 200.
        if dispatched:
            result.update(status_code=502, upstream_status=None, response_source="transport", phase="generation")
            result["error"] = "Service temporarily unavailable."
            try:
                result["state_update"] = await storage._backend.manual_record_result(
                    filename, snapshot, upstream_model, False)
            except Exception:
                result["state_update"] = {"settlement": failed_update()}
            if strict:
                try:
                    await p.record_logical_request(p._antigravity_test_stats_model(requested_model, upstream_model), "antigravity", False)
                except Exception:
                    result["state_update"]["logical_statistics"] = failed_update("statistics_update_failed")
        return JSONResponse(status_code=result["status_code"], content=result)

    status = response.status_code
    p.log.info(f"[MANUAL ANTIGRAVITY] Generation response HTTP {status}")
    valid = False
    if status == 200:
        try:
            payload = validate_json(response.content) if strict else parse_model_response(response.content)
            valid = isinstance(payload, dict) and error_from_retirement_payload(payload) is None
            if strict:
                valid = valid and p._is_expected_antigravity_model_test_reply(p._extract_antigravity_model_test_reply(response))
        except ModelApiErrorException as exc:
            valid = False
            if access_model(upstream_model) and exc.error.status == 404:
                status = 404
        except (ValueError, TypeError):
            valid = False
    message = "Test succeeded." if valid else "Invalid upstream response." if status == 200 else error_message(status)
    result = {"filename": filename, "success": valid, "status_code": status, "upstream_status": response.status_code,
              "response_source": "google", "phase": "generation", "phases": events,
              "verified_reply": valid if strict else None, "message": message}
    if not valid:
        result["error"] = message
    if strict:
        result["expected_reply"] = p.ANTIGRAVITY_MODEL_TEST_EXPECTED_REPLY
        if valid:
            result["model_reply"] = p.ANTIGRAVITY_MODEL_TEST_EXPECTED_REPLY
    try:
        cooldown = await p.parse_and_log_cooldown(response.text, mode="antigravity") if status in (429, 503) else None
        ban = status != 200 and await p.check_should_auto_ban(status)
        target = access_model(upstream_model)
        if target and (valid or status == 404):
            if status == 404:
                ban = False
            try:
                applied = await storage._backend.model_access_observe(filename, snapshot,
                    model=target, success=valid, reason="generation_succeeded" if valid else "generation_404")
                result["model_access_update"] = {"status": "applied" if applied else "skipped"}
                result["model_access_state"] = await storage._backend.model_access_public(filename)
            except Exception:
                result["model_access_update"] = failed_update()
        result["state_update"] = await storage._backend.manual_record_result(
            filename, snapshot, upstream_model, valid, status=status, error=message,
            cooldown=cooldown, auto_ban=ban)
    except Exception:
        result["state_update"] = {"settlement": failed_update()}
    if strict:
        try:
            await p.record_logical_request(p._antigravity_test_stats_model(requested_model, upstream_model), "antigravity", valid)
        except Exception:
            result["state_update"]["logical_statistics"] = failed_update("statistics_update_failed")
    return JSONResponse(status_code=status, content=result)


async def quota(filename, *, sync=False):
    from . import creds as p
    events = []
    try:
        storage, snapshot, data = await prepare(filename, events)
        result = await p.fetch_quota_info(data.get("access_token") or data.get("token"), origin="manual")
    except Exception as exc:
        result = {**local_result(exc, events), "filename": filename}
        try:
            storage = await p.get_storage_adapter()
            result["model_access_state"] = await storage._backend.model_access_public(filename)
        except Exception:
            pass
        return result
    result.update(filename=filename, phase="quota", phases=events)
    result["status_code"] = result.get("upstream_status") or 502
    if getattr(storage._backend, "model_access_storage_ready", False):
        try:
            access_applied = await storage._backend.model_access_observe(filename, snapshot,
                result.get("models") if result.get("success") else None,
                reason=None if result.get("success") else "directory_query_failed")
            result["model_access_state"] = await storage._backend.model_access_public(filename)
            result["model_access_update"] = {"status": "applied" if access_applied else "skipped"}
        except Exception:
            result["model_access_update"] = failed_update()
    if not sync:
        result["_manual_snapshot"] = snapshot
        return result
    result["state_update"] = {}
    if result.get("success"):
        try:
            applied = await storage._backend.manual_sync_quota(
                filename, result.get("models", {}), result.get("observation", {}), snapshot,
                fallback_seconds=60 * await p.get_quota_fallback_cooldown_minutes())
            if applied is None:
                result["state_update"] = {"quota": failed_update("credential_changed")}
            else:
                result.update(applied)
        except Exception:
            result["state_update"] = {"quota": failed_update()}
    if result.get("model_access_update"):
        result.setdefault("state_update", {})["model_access"] = result["model_access_update"]
    result.setdefault("cleared", [])
    result.setdefault("added", [])
    return result


async def project(filename):
    from . import creds as p
    events = []
    try:
        storage, snapshot, data = await prepare(filename, events)
        with manual_google_phase("project", events):
            project_id, tier, credit = await p.fetch_project_id_and_tier(
                access_token=data.get("access_token") or data.get("token"),
                user_agent=p.ANTIGRAVITY_USER_AGENT, api_base_url=await p.get_antigravity_api_url(),
                include_credits=True)
    except Exception as exc:
        result = local_result(exc, events)
        return JSONResponse(status_code=result["status_code"], content=result)
    status = events[-1]["upstream_status"] if events else None
    # A tier from an earlier loadCodeAssist response cannot turn a failed
    # onboarding/project lookup into success or clear its credential errors.
    success = isinstance(project_id, str) and bool(project_id.strip())
    result = {"filename": filename, "success": success, "project_id": project_id,
              "subscription_tier": tier, "credit_amount": credit, "upstream_status": status,
              "response_source": "google" if events else "local", "phase": "project", "phases": events,
              "state_update": {}}
    if success:
        if project_id:
            data = {**data, "project_id": project_id}
        try:
            saved = await storage._backend.manual_save_project(filename, snapshot, data, tier)
            result["state_update"]["project"] = saved or failed_update("credential_changed")
        except Exception:
            result["state_update"]["project"] = failed_update()
        applied = result["state_update"]["project"]["status"] == "applied"
        result["message"] = ("Project information updated; errors cleared. Disabled state unchanged."
                             if applied else "Project response received. State update was not applied.")
    else:
        result["error"] = error_message(status) if status != 200 else "Invalid upstream response."
        result["message"] = result["error"]
    return JSONResponse(status_code=status or 502, content=result)
