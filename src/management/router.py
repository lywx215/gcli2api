from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, FastAPI, Request
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from .auth import (
    ManagementApiError,
    require_management_token,
    validate_management_token,
)
from .schemas import (
    CapabilitiesResponse,
    CredentialActionRequest,
    CredentialActionResponse,
    CredentialBatchActionRequest,
    CredentialBatchActionResponse,
    CredentialListResponse,
    ErrorResponse,
    StatsResponse,
    SummaryResponse,
)
from .service import ManagementService, get_management_service

ERROR_RESPONSES = {
    400: {"model": ErrorResponse},
    401: {"model": ErrorResponse},
    404: {"model": ErrorResponse},
    409: {"model": ErrorResponse},
    429: {"model": ErrorResponse},
    502: {"model": ErrorResponse},
    501: {"model": ErrorResponse},
    503: {"model": ErrorResponse},
    500: {"model": ErrorResponse},
}

router = APIRouter(
    prefix="/management/v1",
    tags=["Management API v1"],
    dependencies=[Depends(require_management_token)],
)


@router.get(
    "/capabilities",
    response_model=CapabilitiesResponse,
    responses=ERROR_RESPONSES,
)
async def capabilities(
    service: Annotated[ManagementService, Depends(get_management_service)],
) -> CapabilitiesResponse:
    return await service.capabilities()


@router.get("/summary", response_model=SummaryResponse, responses=ERROR_RESPONSES)
async def summary(
    service: Annotated[ManagementService, Depends(get_management_service)],
) -> SummaryResponse:
    return await service.summary()


@router.get(
    "/credentials",
    response_model=CredentialListResponse,
    responses=ERROR_RESPONSES,
)
async def credentials(
    service: Annotated[ManagementService, Depends(get_management_service)],
    mode: str,
    cursor: str | None = None,
    offset: int | None = None,
    limit: int = 100,
    status: str | None = None,
    error_code: int | None = None,
    cooldown: bool | None = None,
    preview: bool | None = None,
    tier: str | None = None,
    remark: str | None = None,
) -> CredentialListResponse:
    if status not in (None, "enabled", "disabled", "permanent_disabled"):
        raise ManagementApiError(
            status_code=400,
            code="INVALID_ACTION",
            message="Invalid credential status",
        )
    if error_code is not None and not 0 <= error_code <= 999:
        raise ManagementApiError(
            status_code=400,
            code="INVALID_ACTION",
            message="Invalid error code",
        )
    return await service.credentials(
        mode=mode,
        cursor=cursor,
        offset=offset,
        limit=limit,
        status=status,
        error_code=error_code,
        cooldown=cooldown,
        preview=preview,
        tier=tier,
        remark=remark,
    )


@router.get("/stats", response_model=StatsResponse, responses=ERROR_RESPONSES)
async def stats(
    service: Annotated[ManagementService, Depends(get_management_service)],
    mode: str,
    window: str = "24h",
    group_by: str = "model",
) -> StatsResponse:
    return await service.stats(mode=mode, window=window, group_by=group_by)


@router.post(
    "/credentials/{mode}/{filename}/actions",
    response_model=CredentialActionResponse,
    responses=ERROR_RESPONSES,
)
async def credential_action(
    mode: str,
    filename: str,
    payload: CredentialActionRequest,
    service: Annotated[ManagementService, Depends(get_management_service)],
) -> CredentialActionResponse:
    return await service.execute_action(
        mode=mode, filename=filename, request=payload
    )


@router.post(
    "/credentials/batch-actions",
    response_model=CredentialBatchActionResponse,
    responses=ERROR_RESPONSES,
)
async def credential_batch_action(
    payload: CredentialBatchActionRequest,
    service: Annotated[ManagementService, Depends(get_management_service)],
) -> CredentialBatchActionResponse:
    return await service.execute_batch(payload)


@router.api_route(
    "/{unknown_path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    include_in_schema=False,
)
async def unknown_management_path(unknown_path: str) -> None:
    raise ManagementApiError(
        status_code=501,
        code="CAPABILITY_NOT_SUPPORTED",
        message="Management capability is not implemented",
        details={"path": unknown_path[:128]},
    )


async def management_error_handler(
    _: Request, exc: ManagementApiError
) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content=exc.payload)


async def management_validation_error_handler(
    request: Request, exc: RequestValidationError
):
    if request.url.path.startswith("/management/v1"):
        error = ManagementApiError(
            status_code=400,
            code="INVALID_ACTION",
            message="Invalid Management API request",
        )
        return JSONResponse(status_code=error.status_code, content=error.payload)
    return await request_validation_exception_handler(request, exc)


async def management_exception_boundary(request: Request, call_next):
    try:
        if request.url.path.startswith("/management/v1"):
            scheme, separator, supplied = request.headers.get(
                "authorization", ""
            ).partition(" ")
            await validate_management_token(
                scheme if separator else None,
                supplied if separator else None,
            )
        response = await call_next(request)
    except ManagementApiError as exc:
        response = JSONResponse(status_code=exc.status_code, content=exc.payload)
    except Exception:
        if not request.url.path.startswith("/management/v1"):
            raise
        error = ManagementApiError(
            status_code=500,
            code="INTERNAL_ERROR",
            message="Management API request failed",
        )
        response = JSONResponse(status_code=500, content=error.payload)
    if request.url.path.startswith("/management/v1"):
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
    return response


def install_management_api(app: FastAPI) -> None:
    app.add_exception_handler(ManagementApiError, management_error_handler)
    app.add_exception_handler(
        RequestValidationError, management_validation_error_handler
    )
    app.middleware("http")(management_exception_boundary)
    app.include_router(router)

    original_openapi = app.openapi

    def contract_openapi():
        schema = original_openapi()
        paths = schema.get("paths")
        if isinstance(paths, dict):
            for path, path_item in paths.items():
                if not path.startswith("/management/v1") or not isinstance(
                    path_item, dict
                ):
                    continue
                for operation in path_item.values():
                    if not isinstance(operation, dict):
                        continue
                    responses = operation.get("responses")
                    if isinstance(responses, dict):
                        # Runtime validation is normalized to contract HTTP 400.
                        responses.pop("422", None)
        return schema

    app.openapi = contract_openapi
