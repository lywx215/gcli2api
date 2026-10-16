"""Whitelisted wire DTOs for panel quota summaries."""
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

QuotaSummaryStatus = Literal["available", "partial", "unsupported", "unknown", "error"]
QuotaSummarySource = Literal["antigravity_quota_summary", "geminicli_retrieve_user_quota"]
QuotaSummaryWindow = Literal["5h", "weekly", "daily", "monthly", "unknown"]


class QuotaSummaryBucket(BaseModel):
    model_config = ConfigDict(extra="ignore")
    bucket_id: str
    display_name: str
    raw_window: str | None = None
    window: QuotaSummaryWindow = "unknown"
    remaining_fraction: float | None = Field(default=None, ge=0, le=1, allow_inf_nan=False)
    reset_at: str | None = None


class QuotaSummaryGroup(BaseModel):
    model_config = ConfigDict(extra="ignore")
    group_id: str
    display_name: str
    description: str | None = None
    buckets: list[QuotaSummaryBucket] = Field(default_factory=list)


class QuotaSummary(BaseModel):
    model_config = ConfigDict(extra="ignore")
    status: QuotaSummaryStatus
    source: QuotaSummarySource
    captured_at: str | None = None
    upstream_status: int | None = None
    reason: str | None = None
    groups: list[QuotaSummaryGroup] = Field(default_factory=list)
