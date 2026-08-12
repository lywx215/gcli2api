from __future__ import annotations

from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

CredentialAction = Literal[
    "enable",
    "disable",
    "permanent_disable",
    "delete",
    "set_remark",
    "enable_preview",
    "disable_preview",
    "enable_credit",
    "disable_credit",
    "quota",
    "errors",
    "test",
    "risk_check",
    "sync_cooldown",
]
CredentialMode = Literal["geminicli", "antigravity"]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CommonMetadata(StrictModel):
    schema_version: Literal["1.1"] = "1.1"
    server_version: str
    revision: str
    generated_at: str


class ErrorDetail(StrictModel):
    code: str
    message: str
    retryable: bool
    details: dict[str, object]


class ErrorResponse(StrictModel):
    error: ErrorDetail


class CapabilitiesResponse(CommonMetadata):
    storage_backend: str
    capabilities: list[str]


class ModeSummary(StrictModel):
    total: int | None
    enabled: int | None
    disabled: int | None
    permanent_disabled: int | None
    cooling_down: int | None


class SummaryResponse(CommonMetadata):
    uptime_seconds: int
    modes: dict[Literal["geminicli", "antigravity"], ModeSummary]


class CredentialSummary(StrictModel):
    id: str
    mode: Literal["geminicli", "antigravity"]
    filename: str
    user_email: str | None
    status: Literal["enabled", "disabled", "permanent_disabled"]
    health_status: str | None
    error_codes: list[int] | None
    last_success: str | None
    model_cooldowns: dict[str, str] | None
    tier: str | None
    preview: bool | None
    enable_credit: bool | None
    success_count: int | None
    failure_count: int | None
    cycle_stats: dict[str, int] | None
    last_cycle_stats: dict[str, int] | None
    remark: str | None


class PageInfo(StrictModel):
    total: int | None
    limit: int
    has_more: bool
    next_cursor: str | None


class CredentialListResponse(CommonMetadata):
    credentials: list[CredentialSummary]
    page: PageInfo


class StatsCounts(StrictModel):
    success: int | None
    failure: int | None
    total: int | None
    rpm: int | None


class DailyStats(StrictModel):
    date: str
    success: int | None
    failure: int | None
    total: int | None


class StatsResponse(CommonMetadata):
    mode: Literal["geminicli", "antigravity"]
    window: Literal["5m", "15m", "1h", "24h", "7d"]
    group_by: Literal["node", "mode", "model"]
    totals: StatsCounts
    by_family: dict[str, StatsCounts]
    daily: list[DailyStats]


class CredentialActionRequest(StrictModel):
    action: CredentialAction
    parameters: dict[str, object] = Field(default_factory=dict)
    idempotency_key: str = Field(min_length=8, max_length=128)

    @field_validator("idempotency_key")
    @classmethod
    def normalize_key(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("idempotency_key cannot be blank")
        return value

    @model_validator(mode="after")
    def validate_parameters(self) -> Self:
        if self.action == "set_remark":
            if set(self.parameters) != {"remark"}:
                raise ValueError("set_remark requires only remark")
            remark = self.parameters.get("remark")
            if not isinstance(remark, str) or len(remark) > 500:
                raise ValueError("remark must be a string of at most 500 characters")
        elif self.action in ("test", "risk_check"):
            if not set(self.parameters).issubset({"model_name"}):
                raise ValueError("only model_name is accepted for this action")
            model_name = self.parameters.get("model_name")
            if model_name is not None and (
                not isinstance(model_name, str)
                or not model_name.strip()
                or len(model_name) > 200
            ):
                raise ValueError("model_name must be a non-blank string of at most 200 characters")
        elif self.action == "quota":
            if not set(self.parameters).issubset({"refresh"}):
                raise ValueError("quota accepts only refresh")
            refresh = self.parameters.get("refresh")
            if refresh is not None and not isinstance(refresh, bool):
                raise ValueError("refresh must be a boolean")
        elif self.parameters:
            raise ValueError("action does not accept parameters")
        return self


class CredentialActionIdentity(StrictModel):
    mode: CredentialMode
    filename: str
    status: Literal["enabled", "disabled", "permanent_disabled"] | None


class SideEffect(StrictModel):
    kind: Literal[
        "credential_state_updated",
        "token_refreshed",
        "google_api_called",
        "cooldown_updated",
        "quota_cache_hit",
    ]
    occurred: bool
    description: str | None = Field(default=None, max_length=200)


class PreviewActionResult(StrictModel):
    kind: Literal["preview"] = "preview"
    enabled: bool


class CreditActionResult(StrictModel):
    kind: Literal["credit"] = "credit"
    enabled: bool


class QuotaModelResult(StrictModel):
    model_name: str = Field(max_length=200)
    remaining_percent: float | None
    resets_at: str | None


class QuotaActionResult(StrictModel):
    kind: Literal["quota"] = "quota"
    captured_at: str
    models: list[QuotaModelResult] = Field(max_length=128)


class ErrorEntryResult(StrictModel):
    code: str = Field(max_length=64)
    message: str | None = Field(default=None, max_length=500)
    last_seen: str | None = None


class ErrorsActionResult(StrictModel):
    kind: Literal["errors"] = "errors"
    entries: list[ErrorEntryResult] = Field(max_length=128)


class TestActionResult(StrictModel):
    kind: Literal["test"] = "test"
    outcome: Literal["passed", "failed"]
    model_name: str | None = Field(default=None, max_length=200)
    latency_ms: float | None = Field(default=None, ge=0, le=3_600_000)


class RiskActionResult(StrictModel):
    kind: Literal["risk"] = "risk"
    level: Literal["low", "medium", "high", "unknown"]
    codes: list[str] = Field(max_length=64)


class CooldownSyncActionResult(StrictModel):
    kind: Literal["cooldown_sync"] = "cooldown_sync"
    model_cooldowns: dict[str, str | None]


ActiveActionResult = (
    PreviewActionResult
    | CreditActionResult
    | QuotaActionResult
    | ErrorsActionResult
    | TestActionResult
    | RiskActionResult
    | CooldownSyncActionResult
)


class CredentialActionResponse(CommonMetadata):
    action: CredentialAction
    status: Literal["succeeded"] = "succeeded"
    no_change: bool
    credential: CredentialActionIdentity
    result: ActiveActionResult | None = None
    error: None = None
    side_effects: list[SideEffect] = Field(default_factory=list)


class CredentialBatchActionItem(CredentialActionRequest):
    mode: CredentialMode
    filename: str = Field(min_length=1, max_length=512)

    @field_validator("filename")
    @classmethod
    def validate_filename(cls, value: str) -> str:
        value = value.strip()
        if not value or value in (".", "..") or "/" in value or "\\" in value:
            raise ValueError("filename must be a basename")
        return value


class CredentialBatchActionRequest(StrictModel):
    idempotency_key: str = Field(min_length=8, max_length=128)
    items: list[CredentialBatchActionItem] = Field(min_length=1, max_length=100)

    @field_validator("idempotency_key")
    @classmethod
    def normalize_key(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("idempotency_key cannot be blank")
        return value

    @model_validator(mode="after")
    def validate_keys(self) -> Self:
        keys = [item.idempotency_key for item in self.items]
        if self.idempotency_key in keys or len(keys) != len(set(keys)):
            raise ValueError("batch and item idempotency keys must be unique")
        return self


class CredentialBatchActionResult(StrictModel):
    mode: CredentialMode
    filename: str
    action: CredentialAction
    status: Literal["succeeded", "failed"]
    no_change: bool
    credential_status: Literal["enabled", "disabled", "permanent_disabled"] | None
    result: ActiveActionResult | None = None
    error: ErrorDetail | None
    side_effects: list[SideEffect] = Field(default_factory=list)


class CredentialBatchActionResponse(CommonMetadata):
    status: Literal["succeeded", "partially_succeeded", "failed"]
    results: list[CredentialBatchActionResult]
