"""Authenticated, bounded quota summaries with no admission or quota settlement."""
import time
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from src.antigravity_directory_runtime import (
    QuotaWorkError, directory_broker, work_class, work_deadline, work_progress,
)
from src.antigravity_panel_budget import PanelBudgetConfigError, panel_work_budget
from src.manual_google import manual_google_phase
from src.utils import verify_panel_token
from .antigravity_manual import _bounded, prepare, same_refresh_identity
from .quota_summary_models import QuotaSummary
from .quota_summary_normalize import SOURCES, normalize_summary, utc_now

router = APIRouter(prefix="/creds", tags=["credentials"])
_panel_bearer = HTTPBearer(auto_error=False)


async def _panel_token(credentials: HTTPAuthorizationCredentials | None = Depends(_panel_bearer)):
    if credentials is None:
        raise HTTPException(status_code=401, detail="panel_authentication_required")
    return await verify_panel_token(credentials)


def _failure(mode, reason, *, upstream_status=None, status="error", captured_at=None):
    return QuotaSummary(status=status, source=SOURCES[mode], reason=reason,
                        upstream_status=upstream_status, captured_at=captured_at)


def _google_failure(mode, status, *, captured_at=None):
    reasons = {
        401: "upstream_authentication_failed", 403: "permission_denied",
        404: "quota_summary_unsupported", 405: "quota_summary_unsupported",
        408: "upstream_timeout", 429: "rate_limited", 501: "quota_summary_unsupported",
    }
    return _failure(mode, reasons.get(status, "upstream_error"), upstream_status=status,
                    status="unsupported" if status in (404, 405, 501) else "error",
                    captured_at=captured_at)


async def _assert_identity(storage, filename, mode, original, deadline, *, snapshot=None):
    if mode == "antigravity" and snapshot and snapshot.get("generation"):
        current = await _bounded(lambda: storage._backend.manual_current_credential(
            filename, snapshot["generation"]), deadline, "preparation")
        data = current["credential_data"] if current else None
    else:
        data = await _bounded(lambda: storage.get_credential(filename, mode=mode), deadline, "preparation")
    if not data or not same_refresh_identity(original, data):
        raise HTTPException(status_code=409, detail="credential_changed")


async def _prepare_geminicli(storage, filename, original, events, deadline):
    from . import creds as p
    # GeminiCLI does not have the Antigravity generation/CAS contract. A necessary
    # OAuth refresh is request-only; never overwrite a concurrently replaced row.
    with manual_google_phase("oauth", events):
        credentials = p.Credentials.from_dict(original)
        refreshed = await _bounded(credentials.refresh_if_needed, deadline, "oauth", 15)
    data = {**original, **credentials.to_dict()} if refreshed else original
    if refreshed and "token" in data:
        data["token"] = data.get("access_token") or credentials.access_token
    await _assert_identity(storage, filename, "geminicli", original, deadline)
    if not (data.get("access_token") or data.get("token")):
        raise HTTPException(status_code=400, detail="missing_access_token")
    return data


async def fetch_summary(filename: str, mode: Literal["antigravity", "geminicli"] = "antigravity"):
    """Return the fixed DTO and a local HTTP status; Google failures remain data."""
    from . import creds as p
    from src.api.antigravity import build_antigravity_headers
    from src.api.geminicli import get_geminicli_user_agent
    from src.httpx_client import post_async

    if (not filename.endswith(".json") or filename in (".json", "..json")
            or any(char in filename for char in ("/", "\\", "\x00"))):
        return _failure(mode, "invalid_filename"), 400
    try:
        deadline = time.monotonic() + panel_work_budget()
    except PanelBudgetConfigError:
        return _failure(mode, "quota_budget_configuration"), 503
    tokens = (work_deadline.set(deadline), work_class.set("interactive"),
              work_progress.set({"phase": "preparation"}))
    events, upstream_status, captured_at = [], None, None
    try:
        storage = await _bounded(p.get_storage_adapter, deadline, "preparation")
        original = await _bounded(lambda: storage.get_credential(filename, mode=mode), deadline, "preparation")
        if not original:
            return _failure(mode, "credential_not_found"), 404
        if not isinstance(original.get("project_id"), str) or not original["project_id"].strip():
            return _failure(mode, "missing_project", status="unknown"), 200
        snapshot = None
        if mode == "antigravity":
            storage, snapshot, data = await prepare(filename, events, deadline=deadline)
            original = snapshot["credential_data"]
            # prepare() may have fenced and saved a necessary token refresh.
            await _assert_identity(storage, filename, mode, data, deadline, snapshot=snapshot)
            api_base = await _bounded(p.get_antigravity_api_url, deadline, "preparation")
            path = "/v1internal:retrieveUserQuotaSummary"
            headers = build_antigravity_headers(data.get("access_token") or data.get("token"))
        else:
            data = await _prepare_geminicli(storage, filename, original, events, deadline)
            api_base = await _bounded(p.get_code_assist_endpoint, deadline, "preparation")
            path = "/v1internal:retrieveUserQuota"
            headers = {"Authorization": f"Bearer {data.get('access_token') or data.get('token')}",
                       "Content-Type": "application/json", "User-Agent": get_geminicli_user_agent(),
                       "Accept-Encoding": "gzip"}
        project = data.get("project_id")
        if not isinstance(project, str) or not project.strip():
            return _failure(mode, "missing_project", status="unknown"), 200

        async def send(http_timeout):
            return await post_async(url=f"{api_base.rstrip('/')}{path}",
                                    json={"project": project}, headers=headers,
                                    timeout=http_timeout, follow_redirects=False)

        response = await directory_broker.run(send, kind="interactive", deadline=deadline, timeout=30)
        upstream_status, captured_at = response.status_code, utc_now()
        # Discard results belonging to a row replaced during Google/OAuth IO.
        await _assert_identity(storage, filename, mode,
                               data if mode == "antigravity" else original, deadline, snapshot=snapshot)
        if upstream_status != 200:
            return _google_failure(mode, upstream_status, captured_at=captured_at), 200
        try:
            payload = response.json()
        except (ValueError, TypeError):
            return _failure(mode, "invalid_upstream_response", upstream_status=200,
                            captured_at=captured_at), 200
        return normalize_summary(payload, mode, captured_at=captured_at), 200
    except HTTPException as exc:
        reasons = {400: "invalid_credential", 404: "credential_not_found", 409: "credential_changed"}
        return _failure(mode, reasons.get(exc.status_code, "preparation_failed"),
                        upstream_status=upstream_status, captured_at=captured_at), exc.status_code if exc.status_code in (400, 404, 409) else 503
    except QuotaWorkError as exc:
        return _failure(mode, exc.code, upstream_status=upstream_status, captured_at=captured_at), 504 if exc.code == "quota_timeout" else 503
    except Exception:
        # OAuth helper records only the HTTP status in the protected phase. Never
        # return exception text, raw errors, response bodies, or credentials.
        oauth_status = events[-1].get("upstream_status") if events and events[-1].get("phase") == "oauth" else None
        if upstream_status is None and oauth_status and oauth_status != 200:
            return _failure(mode, "oauth_refresh_failed", upstream_status=oauth_status), 200
        return _failure(mode, "invalid_upstream_response" if upstream_status == 200 else "transport_error",
                        upstream_status=upstream_status, captured_at=captured_at), 200
    finally:
        work_progress.reset(tokens[2])
        work_class.reset(tokens[1])
        work_deadline.reset(tokens[0])


@router.get("/quota-summary/{filename}", response_model=QuotaSummary)
async def get_quota_summary(filename: str,
                            mode: Literal["antigravity", "geminicli"] = "antigravity",
                            _token: str = Depends(_panel_token)):
    result, status = await fetch_summary(filename, mode)
    return JSONResponse(status_code=status, content=result.model_dump())
