from src import google_oauth_api
from src.subscription_tiers import TIER_CODE_ASSIST_ENTERPRISE


class FakeResponse:
    def __init__(self, status_code, data):
        self.status_code = status_code
        self._data = data

    def json(self):
        return self._data


async def test_geminicli_request_uses_gemini_metadata_and_project(monkeypatch):
    captured = {}

    async def fake_post(url, **kwargs):
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
    assert info.tier == TIER_CODE_ASSIST_ENTERPRISE
    assert isinstance(info.detected_at, int)


async def test_geminicli_http_failure_is_unavailable(monkeypatch):
    async def fake_post(*args, **kwargs):
        return FakeResponse(503, {"paidTier": {"id": "standard-tier"}})

    monkeypatch.setattr(google_oauth_api, "post_async", fake_post)

    info = await google_oauth_api.fetch_geminicli_subscription_info(
        access_token="secret-token",
        user_agent="gemini-cli/test",
        api_base_url="https://example.test",
        project_id="project-123",
    )

    assert info.status == "unavailable"
    assert info.project_id == "project-123"
    assert info.detected_at is None


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
