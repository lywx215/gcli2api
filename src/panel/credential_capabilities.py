"""Panel-only Antigravity credential capabilities, backed by persisted semantics."""

from fastapi.responses import JSONResponse

PERMANENT_DISABLED = "antigravity.credentials.permanent_disabled"
REMARK = "antigravity.credentials.remark"
CREDIT_MODE = "antigravity.credentials.credit_mode"

# Permanent disable includes independent list filtering and global statistics.
# MongoDB supports remark/credit persistence; MySQL currently supports none.
_BACKEND_CAPABILITIES = {
    "sqlite": (PERMANENT_DISABLED, REMARK, CREDIT_MODE),
    "postgresql": (PERMANENT_DISABLED, REMARK, CREDIT_MODE),
    "mongodb": (REMARK, CREDIT_MODE),
}
ACTION_CAPABILITIES = {
    "permanent_disable": PERMANENT_DISABLED,
    "enable_credit": CREDIT_MODE,
    "disable_credit": CREDIT_MODE,
}


def credential_capabilities(backend_type: str) -> tuple[str, ...]:
    return _BACKEND_CAPABILITIES.get(backend_type, ())


async def unavailable_capability(adapter, mode: str, capability: str | None) -> str | None:
    if mode != "antigravity" or capability is None:
        return None
    info = await adapter.get_backend_info()
    return capability if capability not in credential_capabilities(info.get("backend_type")) else None


def capability_unavailable_response(capability: str) -> JSONResponse:
    return JSONResponse(status_code=501, content={
        "detail": "当前存储后端不支持该凭证能力",
        "error_code": "capability_unavailable",
        "capability": capability,
    })
