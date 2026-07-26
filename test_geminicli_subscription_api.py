import pytest

from src import google_oauth_api
from src.subscription_tiers import (
    TIER_CODE_ASSIST_ENTERPRISE,
    TIER_CODE_ASSIST_STANDARD,
    TIER_FREE,
    TIER_PRO,
    TIER_ULTRA,
    TIER_UNKNOWN,
)


class FakeResponse:
    def __init__(self, status_code, data):
        self.status_code = status_code
        self._data = data

    def json(self):
        return self._data


async def test_geminicli_request_uses_gemini_metadata_and_project(monkeypatch):
    captured = {}

    async def fake_post(url, **kwargs):
        captured["call_count"] = captured.get("call_count", 0) + 1
        captured["url"] = url
        captured.update(kwargs)
        return FakeResponse(200, {
            "paidTier": {
                "id": "standard-tier",
                "name": "Gemini Code Assist Enterprise",
            },
            "cloudaicompanionProject": "project-123",
        })

    monkeypatch.setattr(google_oauth_api, "post_async", fake_post)

    info = await google_oauth_api.fetch_geminicli_subscription_info(
        access_token="secret-token",
        user_agent="gemini-cli/test",
        api_base_url="https://example.test/",
        project_id="project-123",
        antigravity_api_base_url="https://antigravity.test",
        antigravity_user_agent="antigravity/test",
    )

    assert captured["url"] == "https://example.test/v1internal:loadCodeAssist"
    assert captured["json"] == {
        "metadata": {
            "ideType": "IDE_UNSPECIFIED",
            "platform": "PLATFORM_UNSPECIFIED",
            "pluginType": "GEMINI",
            "duetProject": "project-123",
        },
        "cloudaicompanionProject": "project-123",
    }
    assert captured["headers"]["Authorization"] == "Bearer secret-token"
    assert captured["call_count"] == 1
    assert info.tier == TIER_CODE_ASSIST_ENTERPRISE
    assert isinstance(info.detected_at, int)


async def test_geminicli_http_failure_is_unavailable(monkeypatch):
    calls = []

    async def fake_post(*args, **kwargs):
        calls.append(args[0])
        return FakeResponse(503, {"paidTier": {"id": "standard-tier"}})

    monkeypatch.setattr(google_oauth_api, "post_async", fake_post)

    info = await google_oauth_api.fetch_geminicli_subscription_info(
        access_token="secret-token",
        user_agent="gemini-cli/test",
        api_base_url="https://example.test",
        project_id="project-123",
        antigravity_api_base_url="https://antigravity.test",
        antigravity_user_agent="antigravity/test",
    )

    assert info.status == "unavailable"
    assert info.project_id == "project-123"
    assert info.detected_at is None
    assert calls == ["https://example.test/v1internal:loadCodeAssist"]


@pytest.mark.parametrize(
    ("paid_tier", "expected_tier"),
    [
        ({"id": "free-tier", "name": "Antigravity Starter Quota"}, TIER_FREE),
        ({"id": "g1-pro-tier", "name": "Google AI Pro"}, TIER_PRO),
        ({"id": "g1-ultra-tier", "name": "Google AI Ultra"}, TIER_ULTRA),
        ({"id": "standard-tier", "name": "Antigravity"}, TIER_CODE_ASSIST_STANDARD),
        (
            {"id": "gcp-enterprise-tier", "name": "Gemini Code Assist Enterprise"},
            TIER_CODE_ASSIST_ENTERPRISE,
        ),
    ],
)
async def test_unknown_geminicli_tier_uses_antigravity_paid_tier_fallback(
    monkeypatch, paid_tier, expected_tier
):
    calls = []

    async def fake_post(url, **kwargs):
        calls.append((url, kwargs))
        if url.startswith("https://geminicli.test"):
            return FakeResponse(200, {
                "allowedTiers": [{"id": "standard-tier"}],
                "ineligibleTiers": [{"reasonCode": "UNSUPPORTED_CLIENT"}],
                "cloudaicompanionProject": "project-123",
            })
        return FakeResponse(200, {
            "paidTier": paid_tier,
            "currentTier": {"id": "free-tier", "name": "Antigravity"},
        })

    monkeypatch.setattr(google_oauth_api, "post_async", fake_post)

    info = await google_oauth_api.fetch_geminicli_subscription_info(
        access_token="secret-token",
        user_agent="gemini-cli/test",
        api_base_url="https://geminicli.test",
        project_id="project-123",
        antigravity_api_base_url="https://antigravity.test",
        antigravity_user_agent="antigravity/test",
    )

    assert info.tier == expected_tier
    assert info.raw_tier_id == paid_tier["id"]
    assert info.raw_tier_name == paid_tier["name"]
    assert info.project_id == "project-123"
    assert info.status == "detected"
    assert [call[0] for call in calls] == [
        "https://geminicli.test/v1internal:loadCodeAssist",
        "https://antigravity.test/v1internal:loadCodeAssist",
    ]
    assert calls[1][1]["json"] == {"metadata": {"ideType": "ANTIGRAVITY"}}
    assert calls[1][1]["headers"]["User-Agent"] == "antigravity/test"


@pytest.mark.parametrize("fallback_status", [200, 503])
async def test_unrecognized_antigravity_fallback_keeps_primary_unknown(
    monkeypatch, fallback_status
):
    async def fake_post(url, **kwargs):
        if url.startswith("https://geminicli.test"):
            return FakeResponse(200, {"allowedTiers": [{"id": "standard-tier"}]})
        return FakeResponse(
            fallback_status,
            {"paidTier": {"id": "future-tier", "name": "Future Plan"}},
        )

    monkeypatch.setattr(google_oauth_api, "post_async", fake_post)
    info = await google_oauth_api.fetch_geminicli_subscription_info(
        access_token="secret-token",
        user_agent="gemini-cli/test",
        api_base_url="https://geminicli.test",
        antigravity_api_base_url="https://antigravity.test",
    )

    assert info.tier == TIER_UNKNOWN
    assert info.status == "unrecognized"
    assert info.raw_tier_id is None


async def test_antigravity_load_code_assist_body_is_unchanged(monkeypatch):
    captured = {}

    class AntigravityResponse(FakeResponse):
        text = "{}"

    async def fake_post(url, **kwargs):
        captured["json"] = kwargs["json"]
        return AntigravityResponse(200, {
            "currentTier": {"id": "free-tier"},
            "cloudaicompanionProject": "ag-project",
        })

    monkeypatch.setattr(google_oauth_api, "post_async", fake_post)

    await google_oauth_api._try_load_code_assist(
        "https://example.test", {"Authorization": "Bearer secret"}
    )

    assert captured["json"] == {"metadata": {"ideType": "ANTIGRAVITY"}}
