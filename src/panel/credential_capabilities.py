"""Panel credential capabilities backed by persisted, per-mode semantics."""

from fastapi.responses import JSONResponse

PERMANENT_DISABLED = "antigravity.credentials.permanent_disabled"
REMARK = "antigravity.credentials.remark"
CREDIT_MODE = "antigravity.credentials.credit_mode"
ARGON_ACCESS = "antigravity.model_access.argon"
GEMINICLI_SEARCH = "geminicli.credentials.search"
KNOWN_CREDENTIAL_BACKENDS = frozenset(("sqlite", "postgresql", "mongodb", "mysql"))

# Permanent disable includes independent list filtering and global statistics.
# MongoDB supports remark/credit persistence; MySQL currently supports neither.
_BACKEND_CAPABILITIES = {
    "sqlite": (PERMANENT_DISABLED, REMARK, CREDIT_MODE),
    "postgresql": (PERMANENT_DISABLED, REMARK, CREDIT_MODE),
    "mongodb": (REMARK, CREDIT_MODE),
}
_GEMINICLI_CAPABILITIES = {
    "sqlite": ("geminicli.credentials.permanent_disabled", "geminicli.credentials.remark"),
    "postgresql": ("geminicli.credentials.permanent_disabled", "geminicli.credentials.remark"),
    "mongodb": ("geminicli.credentials.remark",),
}
ACTION_CAPABILITIES = {
    "permanent_disable": PERMANENT_DISABLED,
    "enable_credit": CREDIT_MODE,
    "disable_credit": CREDIT_MODE,
}


def capability_for_mode(capability: str, mode: str) -> str:
    return capability.replace("antigravity.", "geminicli.", 1) if mode == "geminicli" else capability


def credential_capabilities(backend_type: str, mode: str = "antigravity") -> tuple[str, ...]:
    capabilities = _GEMINICLI_CAPABILITIES if mode == "geminicli" else _BACKEND_CAPABILITIES
    return capabilities.get(backend_type, ())


def panel_operation_capabilities(mode: str) -> tuple[str, ...]:
    # Response contracts are implemented independently of optional storage fields.
    if mode == "geminicli":
        return ("geminicli.oauth.safe_response", "geminicli.preview.state_update")
    if mode == "antigravity":
        return ("antigravity.oauth.safe_response",)
    return ()


def supports_argon_model_access(backend) -> bool:
    return (getattr(backend, "model_access_storage_ready", False) is True
            and all(callable(getattr(backend, method, None)) for method in
                    ("model_access_snapshot", "model_access_union", "quota_admit")))


def supports_credential_search(backend) -> bool:
    # These readers project saved metadata, never credential JSON or live email.
    return (getattr(backend, "SUPPORTS_PANEL_CREDENTIAL_SEARCH", False) is True
            and callable(getattr(backend, "get_credentials_summary", None)))


def should_gate_credential_capabilities(backend_type: str, mode: str) -> bool:
    # Unknown legacy GCLI adapters retain their existing requests and semantics.
    return mode == "antigravity" or backend_type in KNOWN_CREDENTIAL_BACKENDS


async def unavailable_capability(adapter, mode: str, capability: str | None) -> str | None:
    if capability is None or (mode == "geminicli" and capability == CREDIT_MODE):
        return None
    capability = capability_for_mode(capability, mode)
    info = await adapter.get_backend_info()
    if not should_gate_credential_capabilities(info.get("backend_type"), mode):
        return None
    return capability if capability not in credential_capabilities(info.get("backend_type"), mode) else None


def capability_unavailable_response(capability: str) -> JSONResponse:
    return JSONResponse(status_code=501, content={
        "detail": "当前存储后端不支持该凭证能力",
        "error_code": "capability_unavailable",
        "capability": capability,
    })
