"""Subscription tier normalization shared by Gemini CLI credential flows."""

from dataclasses import dataclass
from typing import Any, Mapping, Optional


TIER_FREE = "free"
TIER_PRO = "pro"
TIER_ULTRA = "ultra"
TIER_CODE_ASSIST_STANDARD = "code_assist_standard"
TIER_CODE_ASSIST_ENTERPRISE = "code_assist_enterprise"
TIER_UNKNOWN = "unknown"

ANTIGRAVITY_TIERS = (TIER_FREE, TIER_PRO, TIER_ULTRA)
GEMINICLI_TIERS = (
    TIER_FREE,
    TIER_PRO,
    TIER_ULTRA,
    TIER_CODE_ASSIST_STANDARD,
    TIER_CODE_ASSIST_ENTERPRISE,
    TIER_UNKNOWN,
)
GEMINICLI_PAID_TIERS = (
    TIER_PRO,
    TIER_ULTRA,
    TIER_CODE_ASSIST_STANDARD,
    TIER_CODE_ASSIST_ENTERPRISE,
)

GEMINI_35_FLASH_TIERS = (
    TIER_CODE_ASSIST_STANDARD,
    TIER_CODE_ASSIST_ENTERPRISE,
)

# Keep the GA public ID, the separately exposed compatibility alias, and the
# Code Assist upstream ID under the same Tier policy. This also covers direct
# callers and retry paths that enter below the protocol routers.
_GEMINI_35_FLASH_MODEL_BASES = (
    "gemini-3.5-flash",
    "gemini-3.5-flash-preview",
    "gemini-3-flash",
)
_GEMINI_35_FLASH_MODEL_SUFFIXES = (
    "",
    "-minimal",
    "-low",
    "-medium",
    "-high",
    "-search",
    "-minimal-search",
    "-low-search",
    "-medium-search",
    "-high-search",
)
_GEMINI_35_FLASH_MODEL_IDS = frozenset(
    f"{base}{suffix}"
    for base in _GEMINI_35_FLASH_MODEL_BASES
    for suffix in _GEMINI_35_FLASH_MODEL_SUFFIXES
)


def required_tiers_for_geminicli_model(model_name: Optional[str]) -> Optional[tuple[str, ...]]:
    """Return the hard Tier allow-list for a restricted Gemini CLI model."""
    if not model_name:
        return None

    normalized = str(model_name).strip().lower()
    for prefix in ("假流式/", "流式抗截断/"):
        if normalized.startswith(prefix):
            normalized = normalized[len(prefix):]
            break

    if normalized in _GEMINI_35_FLASH_MODEL_IDS:
        return GEMINI_35_FLASH_TIERS
    return None


@dataclass(frozen=True)
class GeminiCliSubscriptionInfo:
    """Normalized result from the Gemini CLI loadCodeAssist endpoint."""

    project_id: Optional[str]
    tier: str
    raw_tier_id: Optional[str]
    raw_tier_name: Optional[str]
    detected_at: Optional[int]
    status: str

    @classmethod
    def unavailable(cls, project_id: Optional[str] = None) -> "GeminiCliSubscriptionInfo":
        return cls(
            project_id=project_id,
            tier=TIER_UNKNOWN,
            raw_tier_id=None,
            raw_tier_name=None,
            detected_at=None,
            status="unavailable",
        )

    def state_fields(self) -> dict[str, Any]:
        """Return fields persisted in the Gemini CLI credential state."""
        return {
            "tier": self.tier,
            "tier_raw_id": self.raw_tier_id,
            "tier_raw_name": self.raw_tier_name,
            "tier_detected_at": self.detected_at,
        }


_LEGACY_TIER_IDS = {
    "free-tier": TIER_FREE,
    "g1-pro-tier": TIER_PRO,
    "helium-tier": TIER_PRO,
    "g1-ultra-tier": TIER_ULTRA,
    "ws-ai-ultra-business-tier": TIER_ULTRA,
}


def _tier_object(data: Mapping[str, Any]) -> Mapping[str, Any]:
    paid_tier = data.get("paidTier")
    if isinstance(paid_tier, Mapping) and (paid_tier.get("id") or paid_tier.get("name")):
        return paid_tier

    current_tier = data.get("currentTier")
    if isinstance(current_tier, Mapping):
        return current_tier
    return {}


def normalize_geminicli_subscription(
    data: Mapping[str, Any], detected_at: int
) -> GeminiCliSubscriptionInfo:
    """Normalize paidTier/currentTier without guessing from quota or account metadata."""
    tier_object = _tier_object(data)
    raw_id_value = tier_object.get("id")
    raw_name_value = tier_object.get("name")
    raw_tier_id = str(raw_id_value).strip() if raw_id_value else None
    raw_tier_name = str(raw_name_value).strip() if raw_name_value else None

    normalized_id = (raw_tier_id or "").lower()
    normalized_name = (raw_tier_name or "").lower()

    if "gemini code assist enterprise" in normalized_name:
        tier = TIER_CODE_ASSIST_ENTERPRISE
    elif "standard" in normalized_name:
        tier = TIER_CODE_ASSIST_STANDARD
    elif normalized_id == "standard-tier":
        tier = TIER_CODE_ASSIST_STANDARD
    else:
        tier = _LEGACY_TIER_IDS.get(normalized_id, TIER_UNKNOWN)

    status = "detected" if tier != TIER_UNKNOWN else "unrecognized"
    project_value = data.get("cloudaicompanionProject")
    if isinstance(project_value, Mapping):
        project_value = project_value.get("id")
    project_id = str(project_value).strip() if project_value else None

    return GeminiCliSubscriptionInfo(
        project_id=project_id,
        tier=tier,
        raw_tier_id=raw_tier_id,
        raw_tier_name=raw_tier_name,
        detected_at=detected_at,
        status=status,
    )


def valid_tiers_for_mode(mode: str) -> tuple[str, ...]:
    return GEMINICLI_TIERS if mode == "geminicli" else ANTIGRAVITY_TIERS


def default_tier_for_mode(mode: str) -> str:
    return TIER_UNKNOWN if mode == "geminicli" else TIER_PRO
