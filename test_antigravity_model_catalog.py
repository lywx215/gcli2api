"""Regression coverage for the Antigravity public/raw model split."""

import json
from pathlib import Path

import config

from src.antigravity_models import (
    ANTIGRAVITY_NATIVE_MODEL_IDS,
    HIDDEN_ANTIGRAVITY_QUOTA_MODEL_IDS,
    PUBLIC_ANTIGRAVITY_MODEL_IDS,
    describe_antigravity_model,
    select_public_model_ids,
)
from src.api import antigravity as antigravity_api
from src.converter.gemini_fix import (
    get_base_model_name,
    map_antigravity_gemini_model,
)
from src.converter.antigravity_fix import normalize_antigravity_request
from src.router.antigravity import model_list as antigravity_model_list
from src.utils import normalize_antigravity_model_alias


class _FakeCredentialManager:
    async def get_valid_credential(self, mode="geminicli", model_name=None):
        return "fixture.json", {"access_token": "fixture-access-token"}


class _FakeResponse:
    status_code = 200

    def __init__(self, payload):
        self._payload = payload
        self.text = "fixture-response"

    def json(self):
        return self._payload


def test_public_catalog_intersects_upstream_in_stable_order():
    upstream = {
        "chat_23310",
        "gemini-3.6-flash-medium",
        "gemini-3.8-flash-tiered",
        "claude-sonnet-4-6",
        "gemini-3.8-flash-high",
        "gemini-2.5-flash",
    }

    assert select_public_model_ids(upstream) == [
        "gemini-3.8-flash-high",
        "gemini-3.6-flash-medium",
        "claude-sonnet-4-6",
    ]
    assert len(PUBLIC_ANTIGRAVITY_MODEL_IDS) == len(set(PUBLIC_ANTIGRAVITY_MODEL_IDS)) == 14


def test_quota_metadata_preserves_raw_internal_models():
    public = describe_antigravity_model("gemini-3.8-flash-medium")
    internal = describe_antigravity_model("gemini-3.8-flash-tiered")

    assert public == {
        "displayName": "Gemini 3.8 Flash (Medium)",
        "rawModelId": "gemini-3.8-flash-medium",
        "public": True,
        "family": "gemini-3.8-flash",
        "tier": "medium",
        "testModel": "gemini-3.8-flash-medium",
        "visible": True,
        "availability": "public",
        "badge": None,
    }
    assert internal["public"] is False
    assert internal["rawModelId"] == "gemini-3.8-flash-tiered"
    assert internal["family"] == "gemini-3.8-flash"
    assert internal["tier"] == "tiered"
    assert internal["visible"] is True
    assert internal["availability"] == "compatible"
    assert internal["badge"] == "内部/兼容"


def test_unavailable_quota_models_keep_raw_metadata_but_are_hidden():
    assert HIDDEN_ANTIGRAVITY_QUOTA_MODEL_IDS == {
        "chat_20706",
        "chat_23310",
        "tab_flash_lite_preview",
        "tab_jump_flash_lite_preview",
        "gemini-2.5-pro",
        "gemini-3-flash-agent",
        "gemini-3.1-flash-image",
        "gemini-3.5-flash-extra-low",
        "gemini-3.5-flash-low",
    }

    for model_id in HIDDEN_ANTIGRAVITY_QUOTA_MODEL_IDS:
        metadata = describe_antigravity_model(model_id)
        assert metadata["rawModelId"] == model_id
        assert metadata["testModel"] == model_id
        assert metadata["visible"] is False
        assert metadata["availability"] == "unavailable"
        assert metadata["badge"] == "不可用"
        assert get_base_model_name(model_id, mode="antigravity") == model_id
        assert map_antigravity_gemini_model(model_id, None, None) == model_id


def test_gemini_3_flash_is_visible_without_public_advertising_or_badge():
    metadata = describe_antigravity_model("gemini-3-flash")

    assert metadata["public"] is False
    assert metadata["visible"] is True
    assert metadata["availability"] == "available"
    assert metadata["badge"] is None
    assert "gemini-3-flash" not in PUBLIC_ANTIGRAVITY_MODEL_IDS


def test_current_native_effort_and_tiered_ids_are_never_stripped():
    model_ids = [
        f"gemini-{version}-flash-{tier}"
        for version in ("3.6", "3.7", "3.8")
        for tier in ("high", "medium", "low", "tiered")
    ]

    for model_id in model_ids:
        assert model_id in ANTIGRAVITY_NATIVE_MODEL_IDS
        assert get_base_model_name(model_id, mode="antigravity") == model_id
        assert map_antigravity_gemini_model(model_id, None, None) == model_id


def test_bare_and_claude_aliases_resolve_to_real_upstream_ids():
    assert normalize_antigravity_model_alias("gemini-3.8-flash") == (
        "gemini-3.8-flash-medium"
    )
    assert normalize_antigravity_model_alias("gemini-3.7-flash") == (
        "gemini-3.7-flash-medium"
    )
    assert normalize_antigravity_model_alias("gemini-3.6-flash") == (
        "gemini-3.6-flash-medium"
    )
    assert normalize_antigravity_model_alias("gemini-3.1-pro") == "gemini-3.1-pro-high"
    assert normalize_antigravity_model_alias("claude-sonnet-4-6-thinking") == (
        "claude-sonnet-4-6"
    )
    assert normalize_antigravity_model_alias("claude-opus-4-6") == (
        "claude-opus-4-6-thinking"
    )
    assert normalize_antigravity_model_alias("gpt-oss-120b") == "gpt-oss-120b-medium"
    assert map_antigravity_gemini_model("gemini-3.1-pro-high", None, None) == (
        "gemini-pro-agent"
    )


async def test_native_effort_model_drops_conflicting_thinking_config(monkeypatch):
    async def fake_get_return_thoughts_to_frontend():
        return True

    monkeypatch.setattr(
        config, "get_return_thoughts_to_frontend", fake_get_return_thoughts_to_frontend
    )

    result = await normalize_antigravity_request(
        {
            "model": "gemini-3.8-flash-high",
            "contents": [{"role": "user", "parts": [{"text": "OK"}]}],
            "generationConfig": {
                "thinkingConfig": {"thinkingLevel": "LOW", "includeThoughts": True}
            },
        }
    )

    assert result["model"] == "gemini-3.8-flash-high"
    thinking_config = result.get("generationConfig", {}).get("thinkingConfig", {})
    assert "thinkingBudget" not in thinking_config
    assert "thinkingLevel" not in thinking_config


async def test_gpt_oss_uses_minimal_non_gemini_generation_config(monkeypatch):
    async def fake_get_return_thoughts_to_frontend():
        return True

    monkeypatch.setattr(
        config, "get_return_thoughts_to_frontend", fake_get_return_thoughts_to_frontend
    )

    result = await normalize_antigravity_request(
        {
            "model": "gpt-oss-120b-medium",
            "contents": [{"role": "user", "parts": [{"text": "OK"}]}],
            "generationConfig": {
                "maxOutputTokens": 8,
                "topK": 64,
                "thinkingConfig": {"thinkingLevel": "LOW"},
            },
        }
    )

    assert result["model"] == "gpt-oss-120b-medium"
    assert "safetySettings" not in result
    assert result["generationConfig"] == {"maxOutputTokens": 8}


async def test_fetch_available_models_advertises_only_public_intersection(monkeypatch):
    payload = {
        "models": {
            "gemini-3.8-flash-tiered": {},
            "chat_23310": {},
            "gemini-3.8-flash-medium": {},
            "claude-opus-4-6-thinking": {},
            "gemini-2.5-flash": {},
            "gemini-3.6-flash-high": {},
        }
    }

    async def fake_post_async(**kwargs):
        return _FakeResponse(payload)

    async def fake_get_antigravity_api_url():
        return "https://antigravity.invalid"

    monkeypatch.setattr(antigravity_api, "credential_manager", _FakeCredentialManager())
    monkeypatch.setattr(antigravity_api, "post_async", fake_post_async)
    monkeypatch.setattr(
        antigravity_api, "get_antigravity_api_url", fake_get_antigravity_api_url
    )

    models = await antigravity_api.fetch_available_models()

    assert [model["id"] for model in models] == [
        "gemini-3.8-flash-medium",
        "gemini-3.6-flash-high",
        "claude-opus-4-6-thinking",
    ]


async def test_fetch_quota_info_keeps_all_models_with_visibility_metadata(monkeypatch):
    payload = {
        "models": {
            "gemini-3.8-flash-medium": {
                "quotaInfo": {"remainingFraction": 0.75, "resetTime": ""}
            },
            "gemini-3.8-flash-tiered": {
                "quotaInfo": {"remainingFraction": 1.0, "resetTime": ""}
            },
            "chat_23310": {
                "quotaInfo": {"remainingFraction": 0.5, "resetTime": ""}
            },
            "gemini-3-flash": {
                "quotaInfo": {"remainingFraction": 0.25, "resetTime": ""}
            },
        }
    }

    async def fake_post_async(**kwargs):
        return _FakeResponse(payload)

    async def fake_get_antigravity_api_url():
        return "https://antigravity.invalid"

    monkeypatch.setattr(antigravity_api, "post_async", fake_post_async)
    monkeypatch.setattr(
        antigravity_api, "get_antigravity_api_url", fake_get_antigravity_api_url
    )

    result = await antigravity_api.fetch_quota_info("fixture-access-token")

    assert result["success"] is True
    assert list(result["models"]) == [
        "gemini-3.8-flash-medium",
        "gemini-3.8-flash-tiered",
        "chat_23310",
        "gemini-3-flash",
    ]
    assert result["models"]["gemini-3.8-flash-medium"]["public"] is True
    assert result["models"]["gemini-3.8-flash-tiered"]["public"] is False
    assert result["models"]["chat_23310"]["rawModelId"] == "chat_23310"
    assert result["models"]["chat_23310"]["visible"] is False
    assert result["models"]["gemini-3-flash"]["visible"] is True
    assert result["models"]["gemini-3-flash"]["badge"] is None


async def test_model_list_adds_features_only_to_public_models(monkeypatch):
    async def fake_fetch_available_models():
        return [
            {"id": "gemini-3.8-flash-medium"},
            {"id": "claude-sonnet-4-6"},
        ]

    monkeypatch.setattr(
        antigravity_model_list, "fetch_available_models", fake_fetch_available_models
    )

    models = await antigravity_model_list.get_antigravity_models_with_features()

    assert models == [
        "gemini-3.8-flash-medium",
        "假流式/gemini-3.8-flash-medium",
        "抗截断/gemini-3.8-flash-medium",
        "claude-sonnet-4-6",
        "假流式/claude-sonnet-4-6",
        "抗截断/claude-sonnet-4-6",
    ]


async def test_openai_and_gemini_model_list_contracts_remain_compatible(monkeypatch):
    models = [
        "gemini-3.8-flash-medium",
        "假流式/gemini-3.8-flash-medium",
        "抗截断/gemini-3.8-flash-medium",
    ]

    async def fake_models_with_features():
        return models

    monkeypatch.setattr(
        antigravity_model_list,
        "get_antigravity_models_with_features",
        fake_models_with_features,
    )

    openai_response = await antigravity_model_list.list_openai_models(token="fixture")
    gemini_response = await antigravity_model_list.list_gemini_models(token="fixture")
    openai_payload = json.loads(openai_response.body)
    gemini_payload = json.loads(gemini_response.body)

    assert openai_payload["object"] == "list"
    assert [model["id"] for model in openai_payload["data"]] == models
    assert [model["name"] for model in gemini_payload["models"]] == [
        f"models/{model}" for model in models
    ]
    assert all(
        model["supportedGenerationMethods"]
        == ["generateContent", "streamGenerateContent"]
        for model in gemini_payload["models"]
    )


def test_quota_panel_filters_hidden_models_and_groups_visible_models():
    common_js = Path(__file__).parent / "front" / "common.js"
    source = common_js.read_text(encoding="utf-8")

    assert 'data-quota-model-group="${quotaGroup}"' in source
    assert "终端可选模型" in source
    assert "可用模型" in source
    assert "内部/兼容模型" in source
    assert "quotaData.visible !== false" in source
    assert "data-model-availability" in source
    assert "available: 1" in source
    assert "&& data.success === true" in source
    assert "实际返回:" in source
