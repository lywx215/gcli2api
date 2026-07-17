import pytest

from src.subscription_tiers import (
    TIER_CODE_ASSIST_ENTERPRISE,
    TIER_CODE_ASSIST_STANDARD,
    TIER_FREE,
    TIER_PRO,
    TIER_ULTRA,
    TIER_UNKNOWN,
    normalize_geminicli_subscription,
    required_tiers_for_geminicli_model,
)


def normalize(data):
    return normalize_geminicli_subscription(data, detected_at=1234567890)


def test_enterprise_name_overrides_standard_id():
    info = normalize({
        "paidTier": {
            "id": "standard-tier",
            "name": "Gemini Code Assist Enterprise",
        }
    })

    assert info.tier == TIER_CODE_ASSIST_ENTERPRISE
    assert info.status == "detected"
    assert info.raw_tier_id == "standard-tier"
    assert info.raw_tier_name == "Gemini Code Assist Enterprise"


@pytest.mark.parametrize(
    ("tier_data", "expected"),
    [
        ({"id": "standard-tier"}, TIER_CODE_ASSIST_STANDARD),
        ({"name": "Gemini Code Assist Standard"}, TIER_CODE_ASSIST_STANDARD),
        ({"id": "free-tier"}, TIER_FREE),
        ({"id": "g1-pro-tier"}, TIER_PRO),
        ({"id": "helium-tier"}, TIER_PRO),
        ({"id": "g1-ultra-tier"}, TIER_ULTRA),
        ({"id": "ws-ai-ultra-business-tier"}, TIER_ULTRA),
    ],
)
def test_known_tiers(tier_data, expected):
    assert normalize({"currentTier": tier_data}).tier == expected


def test_paid_tier_has_priority_over_current_tier():
    info = normalize({
        "paidTier": {"id": "standard-tier", "name": "Gemini Code Assist Standard"},
        "currentTier": {"id": "free-tier", "name": "Free"},
    })

    assert info.tier == TIER_CODE_ASSIST_STANDARD


def test_empty_paid_tier_falls_back_to_current_tier():
    info = normalize({"paidTier": {}, "currentTier": {"id": "free-tier"}})

    assert info.tier == TIER_FREE


@pytest.mark.parametrize(
    "data",
    [
        {},
        {"paidTier": "invalid", "currentTier": []},
        {"currentTier": {"id": "new-future-tier", "name": "Future Plan"}},
    ],
)
def test_unknown_or_malformed_tier(data):
    info = normalize(data)

    assert info.tier == TIER_UNKNOWN
    assert info.status == "unrecognized"


def test_project_id_can_be_returned_as_object():
    info = normalize({
        "currentTier": {"id": "free-tier"},
        "cloudaicompanionProject": {"id": "project-123"},
    })

    assert info.project_id == "project-123"
    assert info.detected_at == 1234567890


@pytest.mark.parametrize(
    "model_name",
    [
        "gemini-3.5-flash",
        "gemini-3.5-flash-high",
        "gemini-3.5-flash-minimal-search",
        "gemini-3-flash",
        "gemini-3-flash-medium",
        "gemini-3-flash-high-search",
        "假流式/gemini-3.5-flash",
        "流式抗截断/gemini-3-flash-low",
    ],
)
def test_gemini_35_flash_requires_code_assist_tiers(model_name):
    assert required_tiers_for_geminicli_model(model_name) == (
        TIER_CODE_ASSIST_STANDARD,
        TIER_CODE_ASSIST_ENTERPRISE,
    )


@pytest.mark.parametrize(
    "model_name",
    [
        None,
        "",
        "gemini-2.5-flash",
        "gemini-3-flash-preview",
        "gemini-3-flash-agent",
        "gemini-3.5-flash-unsupported-suffix",
    ],
)
def test_other_models_are_not_tier_restricted(model_name):
    assert required_tiers_for_geminicli_model(model_name) is None
