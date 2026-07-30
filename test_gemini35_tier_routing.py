import json

import pytest
from fastapi import Response

from src.api import geminicli
from src.models import ClaudeRequest
from src.router.geminicli.anthropic import messages
from src.storage.mongodb_manager import MongoDBManager
from src.storage.mysql_manager import MySQLManager
from src.utils import BASE_MODELS, normalize_geminicli_model_alias
from src.subscription_tiers import (
    TIER_CODE_ASSIST_ENTERPRISE,
    TIER_CODE_ASSIST_STANDARD,
    TIER_PRO,
    required_tiers_for_geminicli_model,
)


class FakeRedisPipeline:
    def __init__(self, redis):
        self.redis = redis
        self.operations = []

    def exists(self, key):
        self.operations.append(("exists", key))
        return self

    def sadd(self, key, *members):
        self.operations.append(("sadd", key, members))
        return self

    def srem(self, key, *members):
        self.operations.append(("srem", key, members))
        return self

    async def execute(self):
        results = []
        for operation in self.operations:
            action, key, *args = operation
            if action == "exists":
                results.append(key in self.redis.existing_keys)
            elif action == "sadd":
                self.redis.sets.setdefault(key, set()).update(args[0])
                results.append(len(args[0]))
            elif action == "srem":
                members = self.redis.sets.setdefault(key, set())
                for member in args[0]:
                    members.discard(member)
                results.append(len(args[0]))
        return results


class FakeRedis:
    def __init__(self, sets=None, existing_keys=None):
        self.sets = {key: set(value) for key, value in (sets or {}).items()}
        self.existing_keys = set(existing_keys or ())

    async def smembers(self, key):
        return set(self.sets.get(key, set()))

    async def scard(self, key):
        return len(self.sets.get(key, set()))

    async def srandmember(self, key, count):
        return list(self.sets.get(key, set()))[:count]

    async def exists(self, key):
        return key in self.existing_keys

    def pipeline(self):
        return FakeRedisPipeline(self)


@pytest.mark.asyncio
async def test_no_eligible_credential_returns_503_without_upstream_call(monkeypatch):
    upstream_called = False

    async def no_credential(*args, **kwargs):
        return None

    async def unexpected_post(*args, **kwargs):
        nonlocal upstream_called
        upstream_called = True
        raise AssertionError("upstream must not be called")

    monkeypatch.setattr(geminicli.credential_manager, "get_valid_credential", no_credential)
    monkeypatch.setattr(geminicli, "post_async", unexpected_post)

    response = await geminicli.non_stream_request({"model": "gemini-3-flash", "request": {}})
    assert response.status_code == 503
    assert "Code Assist Standard/Enterprise" in response.body.decode("utf-8")
    assert upstream_called is False

    with pytest.raises(geminicli.StreamFailure) as caught:
        async for _ in geminicli.stream_request({"model": "gemini-3.5-flash-high", "request": {}}):
            pass
    assert caught.value.status_code == 503
    assert caught.value.stage == "credential"
    assert upstream_called is False


@pytest.mark.asyncio
async def test_mysql_redis_selection_uses_only_supported_tier(monkeypatch):
    manager = MySQLManager()
    manager._redis_enabled = True
    manager._redis = FakeRedis(
        {
            manager._rk_avail("geminicli"): {"pro.json", "standard.json"},
            manager._rk_tier("geminicli", TIER_PRO): {"pro.json"},
            manager._rk_tier("geminicli", TIER_CODE_ASSIST_STANDARD): {"standard.json"},
            manager._rk_tier("geminicli", TIER_CODE_ASSIST_ENTERPRISE): set(),
        }
    )

    async def get_credential(filename, mode):
        return {"project_id": filename}

    monkeypatch.setattr(manager, "get_credential", get_credential)
    monkeypatch.setattr("config.get_routing_mode_sync", lambda: "normal")

    selected = await manager._get_next_available_from_redis("geminicli", "gemini-3-flash")
    assert selected is not None
    assert selected[0] == "standard.json"

    manager._redis.sets[manager._rk_tier("geminicli", TIER_CODE_ASSIST_STANDARD)].clear()
    assert await manager._get_next_available_from_redis("geminicli", "gemini-3-flash") is None


@pytest.mark.asyncio
async def test_mysql_redis_sync_moves_credential_between_tier_buckets():
    manager = MySQLManager()
    manager._redis_enabled = True
    manager._redis = FakeRedis()

    await manager._redis_sync_cred(
        "geminicli",
        "credential.json",
        disabled=False,
        tier=TIER_CODE_ASSIST_STANDARD,
        preview=True,
    )
    standard_key = manager._rk_tier("geminicli", TIER_CODE_ASSIST_STANDARD)
    enterprise_key = manager._rk_tier("geminicli", TIER_CODE_ASSIST_ENTERPRISE)
    assert "credential.json" in manager._redis.sets[standard_key]

    await manager._redis_sync_cred(
        "geminicli",
        "credential.json",
        disabled=False,
        tier=TIER_CODE_ASSIST_ENTERPRISE,
        preview=True,
    )
    assert "credential.json" not in manager._redis.sets[standard_key]
    assert "credential.json" in manager._redis.sets[enterprise_key]


@pytest.mark.asyncio
async def test_mongodb_redis_selection_uses_only_supported_tier(monkeypatch):
    manager = MongoDBManager()
    manager._redis = FakeRedis(
        {
            manager._rk_avail("geminicli"): {"pro.json", "enterprise.json"},
            manager._rk_tier("geminicli", TIER_PRO): {"pro.json"},
            manager._rk_tier("geminicli", TIER_CODE_ASSIST_STANDARD): set(),
            manager._rk_tier("geminicli", TIER_CODE_ASSIST_ENTERPRISE): {"enterprise.json"},
        }
    )

    async def get_credential(filename, mode):
        return {"project_id": filename}

    monkeypatch.setattr(manager, "get_credential", get_credential)
    selected = await manager._get_next_available_from_redis(
        "geminicli",
        "gemini-3-flash-high",
        required_tiers=(TIER_CODE_ASSIST_STANDARD, TIER_CODE_ASSIST_ENTERPRISE),
    )
    assert selected is not None
    assert selected[0] == "enterprise.json"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("client_model", "upstream_model"),
    [
        ("gemini-3.5-flash", "gemini-3.5-flash"),
        ("gemini-3.5-flash-preview", "gemini-3-flash"),
    ],
)
async def test_anthropic_route_normalizes_gemini_35_flash_alias(
    monkeypatch, client_model, upstream_model
):
    captured = {}

    async def fake_non_stream_request(body, headers=None):
        captured["model"] = body["model"]
        return Response(
            content=json.dumps({"error": {"message": "test"}}),
            status_code=503,
            media_type="application/json",
        )

    monkeypatch.setattr(geminicli, "non_stream_request", fake_non_stream_request)
    request = ClaudeRequest(
        model=client_model,
        messages=[{"role": "user", "content": "hello"}],
        max_tokens=32,
        stream=False,
    )

    await messages(request, token="test")
    assert captured["model"] == upstream_model


def test_gemini_35_client_model_aliases_and_tiers():
    assert normalize_geminicli_model_alias("gemini-3.5-flash") == "gemini-3.5-flash"
    assert normalize_geminicli_model_alias("gemini-3.5-flash-high") == "gemini-3.5-flash-high"
    assert normalize_geminicli_model_alias("gemini-3.5-flash-preview") == "gemini-3-flash"
    assert normalize_geminicli_model_alias("gemini-3.5-flash-preview-high") == "gemini-3-flash-high"
    assert "gemini-3.5-flash-preview" in BASE_MODELS
    assert required_tiers_for_geminicli_model("gemini-3.5-flash-preview") == (
        TIER_CODE_ASSIST_STANDARD,
        TIER_CODE_ASSIST_ENTERPRISE,
    )


@pytest.mark.asyncio
async def test_quota_display_preserves_distinct_google_model_ids(monkeypatch):
    class QuotaResponse:
        status_code = 200

        @staticmethod
        def json():
            return {
                "buckets": [
                    {"modelId": "gemini-3.5-flash", "remainingFraction": 0.8},
                    {"modelId": "gemini-3-flash", "remainingFraction": 0.7},
                ]
            }

    async def fake_post(*args, **kwargs):
        return QuotaResponse()

    async def fake_endpoint():
        return "https://example.test"

    monkeypatch.setattr(geminicli, "post_async", fake_post)
    monkeypatch.setattr(geminicli, "get_code_assist_endpoint", fake_endpoint)

    result = await geminicli.fetch_geminicli_quota_info(
        access_token="secret-token",
        project_id="project-123",
    )

    assert result["success"] is True
    assert result["models"]["gemini-3.5-flash"]["displayName"] == "gemini-3.5-flash"
    assert result["models"]["gemini-3-flash"]["displayName"] == "gemini-3-flash"
