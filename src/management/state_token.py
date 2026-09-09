from __future__ import annotations

import hashlib
import json
from typing import Any


TOKEN_NAMESPACE = "gcli2api.management.credential-state.v1"
TOKEN_STATE_FIELDS = (
    "disabled",
    "permanent_disabled",
    "user_email",
    "error_codes",
    "model_cooldowns",
    "health_status",
    "quarantine_reason",
    "probe_stage",
    "next_probe_at",
    "health_check_started_at",
    "health_state_version",
)


def credential_state_token(
    *,
    mode: str,
    filename: str,
    credential_data: str,
    state: dict[str, Any],
) -> str:
    """Return a domain-separated digest without exposing credential material."""
    payload_digest = hashlib.sha256(credential_data.encode("utf-8")).hexdigest()
    canonical = {
        "namespace": TOKEN_NAMESPACE,
        "mode": mode,
        "filename": filename,
        "credential_payload_sha256": payload_digest,
        "state": {field: state.get(field) for field in TOKEN_STATE_FIELDS},
    }
    encoded = json.dumps(
        canonical, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()
