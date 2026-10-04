"""Authenticated model-routing GET/PUT, with fixed safe diagnostics."""

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from src.utils import verify_panel_token
from . import store
from .types import CHANNELS, RoutingConfigReadError, ValidationIssue, thaw

router = APIRouter(prefix="/config", tags=["config"])
CAPABILITIES = ("model.routing.aliases", "model.identity.public")


def issue_json(issue):
    # Never echo diagnostic free text from a target proof or a backend.
    return {
        "channel": issue.channel, "row": issue.row, "field": issue.field,
        "reason": issue.reason, "related_rows": list(issue.related_rows),
        "message": "Invalid model routing configuration.",
    }


def _unavailable():
    return JSONResponse(status_code=503, content={"error": {
        "code": "MODEL_ROUTING_UNAVAILABLE",
        "message": "Model routing configuration is unavailable.",
    }})


def _invalid(issues):
    return JSONResponse(status_code=400, content={"error": {
        "code": "MODEL_ROUTING_VALIDATION_FAILED",
        "message": "Invalid model routing configuration.",
        "issues": [issue_json(issue) for issue in issues],
    }})


def _response(snapshot, policy_digest):
    if any(result.scope == "global" and not result.valid for result in snapshot.channels.values()):
        return _unavailable()
    table = thaw(snapshot.raw_table)
    if not isinstance(table, dict) or not isinstance(table.get("routes"), list):
        return _unavailable()
    return JSONResponse(content={
        "routes": table["routes"], "supported_channels": list(CHANNELS),
        "capabilities": list(CAPABILITIES), "policy_digest": policy_digest,
        "validation": {
            channel: {"valid": snapshot.channels[channel].valid,
                      "issues": [issue_json(issue) for issue in snapshot.channels[channel].issues]}
            for channel in CHANNELS
        },
    })


@router.get("/model-routing")
async def get_model_routing(token: str = Depends(verify_panel_token)):
    try:
        policy_snapshot = store._policy()
        snapshot = await store._read_snapshot(policy_snapshot)
        return _response(snapshot, policy_snapshot.digest)
    except RoutingConfigReadError:
        return _unavailable()
    except Exception:
        return _unavailable()


@router.put("/model-routing")
async def put_model_routing(request: Request, token: str = Depends(verify_panel_token)):
    try:
        raw_value = await request.json()
    except (ValueError, UnicodeError, RecursionError):
        return _invalid((ValidationIssue(None, None, None, "INVALID_STRUCTURE"),))
    try:
        policy_snapshot = store._policy()
        parsed_table = store._parse(raw_value)
        snapshot = await store.save_routing_config(parsed_table, policy_snapshot)
        return _response(snapshot, policy_snapshot.digest)
    except store.RoutingConfigValidationError as exc:
        return _invalid(exc.issues)
    except (RoutingConfigReadError, store.RoutingConfigWriteError):
        return _unavailable()
    except Exception:
        return _unavailable()
