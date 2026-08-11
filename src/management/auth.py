from __future__ import annotations

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


def validate_management_token(scheme: str | None, supplied: str | None) -> None:
    configured = os.getenv("NODE_MANAGEMENT_TOKEN", "").strip()
    if not configured:
        raise ManagementApiError(
            status_code=503,
            code="MANAGEMENT_API_DISABLED",
            message="Management API is disabled",
        )
    if (
        scheme is None
        or scheme.lower() != "bearer"
        or not supplied
        or not secrets.compare_digest(
            supplied.encode("utf-8"), configured.encode("utf-8")
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
    validate_management_token(
        authorization.scheme if authorization is not None else None,
        authorization.credentials if authorization is not None else None,
    )
