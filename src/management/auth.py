from __future__ import annotations

import hashlib
import os
import secrets
from typing import Annotated

from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer


management_bearer = HTTPBearer(auto_error=False)


class ManagementApiError(Exception):
    def __init__(
        self,
        *,
        status_code: int,
        code: str,
        message: str,
        retryable: bool = False,
        details: dict[str, object] | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.payload = {
            "error": {
                "code": code,
                "message": message,
                "retryable": retryable,
                "details": details or {},
            }
        }


TOKEN_HASH_PREFIX = "sha256:"


def hash_management_token(token: str) -> str:
    return TOKEN_HASH_PREFIX + hashlib.sha256(token.encode("utf-8")).hexdigest()


def _is_management_token_hash(value: object) -> bool:
    if not isinstance(value, str) or not value.startswith(TOKEN_HASH_PREFIX):
        return False
    digest = value.removeprefix(TOKEN_HASH_PREFIX)
    return len(digest) == 64 and all(
        character in "0123456789abcdef" for character in digest
    )


async def management_token_status() -> dict[str, object]:
    configured = os.getenv("NODE_MANAGEMENT_TOKEN", "").strip()
    if configured:
        return {"configured": True, "source": "environment", "locked": True}
    import config

    stored_hash = await config.get_config_value(config.NODE_MANAGEMENT_TOKEN_HASH_KEY)
    valid_hash = _is_management_token_hash(stored_hash)
    return {
        "configured": valid_hash,
        "source": "storage" if valid_hash else "none",
        "locked": False,
    }


async def validate_management_token(scheme: str | None, supplied: str | None) -> None:
    configured = os.getenv("NODE_MANAGEMENT_TOKEN", "").strip()
    stored_hash: str | None = None
    if not configured:
        import config

        candidate = await config.get_config_value(config.NODE_MANAGEMENT_TOKEN_HASH_KEY)
        if _is_management_token_hash(candidate):
            stored_hash = candidate
    if not configured and stored_hash is None:
        raise ManagementApiError(
            status_code=503,
            code="MANAGEMENT_API_DISABLED",
            message="Management API is disabled",
        )
    if (
        scheme is None
        or scheme.lower() != "bearer"
        or not supplied
        or not (
            secrets.compare_digest(supplied, configured)
            if configured
            else secrets.compare_digest(hash_management_token(supplied), stored_hash or "")
        )
    ):
        raise ManagementApiError(
            status_code=401,
            code="AUTHENTICATION_FAILED",
            message="Management authentication failed",
        )


async def require_management_token(
    authorization: Annotated[
        HTTPAuthorizationCredentials | None, Depends(management_bearer)
    ],
) -> None:
    await validate_management_token(
        authorization.scheme if authorization is not None else None,
        authorization.credentials if authorization is not None else None,
    )
