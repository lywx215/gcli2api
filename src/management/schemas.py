from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CommonMetadata(StrictModel):
    schema_version: Literal["1.0"] = "1.0"
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
