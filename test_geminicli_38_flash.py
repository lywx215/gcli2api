"""Gemini CLI 3.8 Flash coverage; all upstream calls use synthetic fixtures."""
import copy
import json
import time
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException, Response

from src.api import geminicli as api
from src.converter.gemini_fix import normalize_gemini_request
from src.geminicli_models import GEMINI_38_FLASH_MODEL as MODEL, GEMINI_38_FLASH_SUFFIXES
from src.models import ClaudeRequest, GeminiRequest, OpenAIChatCompletionRequest
from src.router.geminicli import anthropic, gemini, model_list, openai
from src.storage._stats_common import normalize_logical_request_model_family, normalize_model_family
from src.storage.sqlite_manager import SQLiteManager
from src.subscription_tiers import (
    GEMINI_35_FLASH_TIERS, TIER_CODE_ASSIST_STANDARD,
    TIER_CODE_ASSIST_ENTERPRISE, required_tiers_for_geminicli_model,
)
from src.utils import get_available_models, normalize_geminicli_model_alias

SUFFIXES = ("", "-search", "-low", "-medium", "-high", "-low-search", "-medium-search", "-high-search")
PREFIXES = ("", "假流式/", "抗截断/")
USER = {"role": "user", "parts": [{"text": "A synthetic test request"}]}


@pytest.fixture(autouse=True)
def isolate(monkeypatch):
    monkeypatch.setattr("config.get_return_thoughts_to_frontend", AsyncMock(return_value=True))
    monkeypatch.setattr("src.logical_request_stats.record_logical_request", AsyncMock())
    monkeypatch.setattr("src.router.stream_passthrough.record_logical_request", AsyncMock())
    monkeypatch.setattr("config.is_smart_429_protection_enabled", lambda: False)


async def call_route(protocol, name, stream=False):
    if protocol == "gemini":
        request = GeminiRequest(contents=[copy.deepcopy(USER)])
        handler = gemini.stream_generate_content if stream else gemini.generate_content
        return await handler(request, model=name)
    if protocol == "openai":
        return await openai.chat_completions(OpenAIChatCompletionRequest(
            model=name, messages=[{"role": "user", "content": "A synthetic test request"}],
            stream=stream,
        ))
    return await anthropic.messages(ClaudeRequest(
        model=name, messages=[{"role": "user", "content": "A synthetic test request"}],
        max_tokens=64, stream=stream,
    ))


@pytest.mark.parametrize("router_type", ["gemini", "openai"])
def test_complete_catalog_and_no_invented_preview_or_minimal(router_type):
    models = get_available_models(router_type)
    expected = {prefix + MODEL + suffix for prefix in PREFIXES for suffix in SUFFIXES}
    assert set(GEMINI_38_FLASH_SUFFIXES) == set(SUFFIXES)
    assert {name for name in models if MODEL in name} == expected
    assert len(models) == len(set(models))
    assert "gemini-3.5-flash-minimal" in models
    assert "gemini-3.5-flash-preview" in models


async def test_both_model_list_endpoints_expose_every_variant():
    first = json.loads((await model_list.list_openai_models()).body)
    second = json.loads((await model_list.list_gemini_models()).body)
    openai_ids = {item["id"] for item in first["data"]}
    gemini_ids = {item["name"].removeprefix("models/") for item in second["models"]}
    expected = {prefix + MODEL + suffix for prefix in PREFIXES for suffix in SUFFIXES}
    assert expected <= openai_ids
    assert expected <= gemini_ids


@pytest.mark.parametrize("prefix", (*PREFIXES, "流式抗截断/"))
@pytest.mark.parametrize("suffix", SUFFIXES)
def test_all_variants_share_local_tier_policy_and_stats(prefix, suffix):
    name = prefix + MODEL + suffix
    assert required_tiers_for_geminicli_model(name) == GEMINI_35_FLASH_TIERS
    assert normalize_model_family(name) == "3.8-flash"
    assert normalize_logical_request_model_family(name) == "3.8-flash"
    assert normalize_geminicli_model_alias(MODEL + suffix) == MODEL + suffix


@pytest.mark.parametrize("model", [
    "gemini-3.8-pro", "gemini-3.8-flash-lite", "gemini-3.8-flash-preview",
    "gemini-3.8-flash-invalid", "gemini-3-flash-preview",
])
def test_unknown_or_unrelated_models_do_not_inherit_tier_policy(model):
    assert required_tiers_for_geminicli_model(model) is None


@pytest.mark.parametrize("suffix", SUFFIXES)
async def test_normalization_uses_exact_upstream_id_and_supported_config(suffix):
    original = {
        "model": MODEL + suffix, "contents": [copy.deepcopy(USER)],
        "generationConfig": {"temperature": .3, "topP": .8, "topK": 12, "candidateCount": 1},
    }
    snapshot = copy.deepcopy(original)
    result = await normalize_gemini_request(original)
    assert original == snapshot
    assert result["model"] == MODEL
    config = result["generationConfig"]
    assert not {"temperature", "topP", "topK", "candidateCount", "thinkingBudget"} & config.keys()
    level = next((level for level in ("low", "medium", "high") if "-" + level in suffix), None)
    if level:
        assert config["thinkingConfig"]["thinkingLevel"] == level.upper()
        assert config["thinkingConfig"]["includeThoughts"] is True
        assert "thinkingBudget" not in config["thinkingConfig"]
    if suffix.endswith("-search"):
        assert {"googleSearch": {}} in result["tools"]


@pytest.mark.parametrize("suffix,thinking", [
    ("-minimal", {}), ("-minimal-search", {}), ("-nothinking", {}),
    ("", {"thinkingLevel": "MINIMAL"}), ("", {"thinkingLevel": "invalid"}),
    ("", {"thinkingBudget": 1024}),
])
async def test_unsupported_thinking_rejected_instead_of_silent_fallback(suffix, thinking):
    with pytest.raises(HTTPException) as exc:
        await normalize_gemini_request({
            "model": MODEL + suffix, "generationConfig": {"thinkingConfig": thinking},
        })
    assert exc.value.status_code == 400


async def test_thinking_level_precedence_client_thoughts_and_no_input_mutation():
    original = {
        "model": MODEL + "-high",
        "generationConfig": {"thinkingConfig": {
            "thinkingBudget": 1024, "thinkingLevel": "LOW", "includeThoughts": False,
        }},
    }
    snapshot = copy.deepcopy(original)
    result = await normalize_gemini_request(original)
    assert original == snapshot
    assert result["generationConfig"]["thinkingConfig"] == {
        "thinkingLevel": "HIGH", "includeThoughts": False,
    }


async def test_cleaned_trailing_prefill_removed_only_for_new_cli_model():
    contents = [copy.deepcopy(USER), {"role": "model", "parts": [{"text": "prefill"}]},
                {"role": "user", "parts": [{}]}]
    new = await normalize_gemini_request({"model": MODEL, "contents": copy.deepcopy(contents)})
    old = await normalize_gemini_request({"model": "gemini-3.5-flash", "contents": copy.deepcopy(contents)})
    assert new["contents"] == [USER]
    assert old["contents"][-1]["role"] == "model"


@pytest.mark.parametrize("protocol", ["gemini", "openai", "anthropic"])
@pytest.mark.parametrize("kind", ["nonstream", "stream", "fake", "continuation"])
@pytest.mark.parametrize("suffix", SUFFIXES)
async def test_protocol_mode_matrix_keeps_model_and_config(monkeypatch, protocol, kind, suffix):
    captured = []
    async def nonstream(body, **kwargs):
        captured.append(copy.deepcopy(body))
        return Response(status_code=503)
    async def stream(body, **kwargs):
        assert kwargs.get("events") is True
        captured.append(copy.deepcopy(body))
        yield Response(status_code=503)
    monkeypatch.setattr(api, "non_stream_request", nonstream)
    monkeypatch.setattr(api, "stream_request", stream)
    prefix = {"fake": "假流式/", "continuation": "抗截断/"}.get(kind, "")
    result = await call_route(protocol, prefix + MODEL + suffix, kind != "nonstream")
    assert result.status_code == 503
    assert len(captured) == 1
    assert captured[0]["model"] == MODEL
    config = captured[0]["request"].get("generationConfig", {})
    assert not {"temperature", "topP", "topK", "candidateCount"} & config.keys()
    level = next((level for level in ("low", "medium", "high") if "-" + level in suffix), None)
    if level:
        assert config["thinkingConfig"]["thinkingLevel"] == level.upper()
    if suffix.endswith("-search"):
        assert {"googleSearch": {}} in captured[0]["request"]["tools"]


@pytest.mark.parametrize("protocol", ["gemini", "openai", "anthropic"])
async def test_continuation_uses_user_prompt_not_unsupported_model_prefill(monkeypatch, protocol):
    captured = []
    async def stream(body, **kwargs):
        captured.append(copy.deepcopy(body))
        text = "first part" if len(captured) == 1 else "second part\n[done]"
        reason = "MAX_TOKENS" if len(captured) == 1 else "STOP"
        data = {"candidates": [{"content": {"role": "model", "parts": [{"text": text}]},
                               "finishReason": reason}]}
        yield ("data: " + json.dumps(data) + "\n\n").encode()
    monkeypatch.setattr(api, "stream_request", stream)
    module = {"gemini": gemini, "openai": openai, "anthropic": anthropic}[protocol]
    monkeypatch.setattr(module, "get_anti_truncation_max_attempts", AsyncMock(return_value=2))
    result = await call_route(protocol, "抗截断/" + MODEL + "-high", True)
    chunks = [chunk async for chunk in result.body_iterator]
    assert chunks
    assert len(captured) == 2
    assert captured[1]["model"] == MODEL
    tail = captured[1]["request"]["contents"][-1]
    assert tail["role"] == "user" and tail["parts"][0]["text"]
    assert captured[1]["request"]["contents"][-2]["role"] == "model"


async def test_no_matching_credential_is_503_and_never_calls_upstream(monkeypatch):
    monkeypatch.setattr(api.credential_manager, "get_valid_credential", AsyncMock(return_value=None))
    upstream = AsyncMock(side_effect=AssertionError("must not call upstream"))
    monkeypatch.setattr(api, "post_async", upstream)
    monkeypatch.setattr(api, "stream_post_async", upstream)
    result = await api.non_stream_request({"model": MODEL, "request": {}}, record_logical=False)
    assert result.status_code == 503
    assert b"3.5" not in result.body
    chunks = [item async for item in api.stream_request({"model": MODEL, "request": {}})]
    assert len(chunks) == 1 and chunks[0].status_code == 503
    upstream.assert_not_called()


@pytest.mark.parametrize("tier", [TIER_CODE_ASSIST_STANDARD, TIER_CODE_ASSIST_ENTERPRISE])
async def test_sqlite_selection_and_cooldown_use_new_model(tmp_path, monkeypatch, tier):
    monkeypatch.setenv("CREDENTIALS_DIR", str(tmp_path))
    manager = SQLiteManager()
    await manager.initialize()
    try:
        for name, value in (("synthetic-pro", "pro"), ("synthetic-eligible", tier)):
            await manager.store_credential(name, {"project_id": "synthetic"}, mode="geminicli")
            await manager.update_credential_state(name, {"tier": value}, mode="geminicli")
        selected = await manager.get_next_available_credential(mode="geminicli", model_name=MODEL)
        assert selected[0] == "synthetic-eligible"
        await manager.set_model_cooldown("synthetic-eligible", MODEL, time.time() + 300, mode="geminicli")
        assert await manager.get_next_available_credential(mode="geminicli", model_name=MODEL) is None
    finally:
        await manager.close()


def test_existing_frontend_label_and_antigravity_alias_remain_separate():
    source = (Path(__file__).parent / "front/common.js").read_text(encoding="utf-8")
    assert "key: '3.8-flash'" in source
    from src.utils import normalize_antigravity_model_alias
    assert normalize_antigravity_model_alias(MODEL) == MODEL + "-medium"
    assert normalize_geminicli_model_alias(MODEL) == MODEL

@pytest.mark.parametrize("protocol", ["gemini", "openai", "anthropic"])
@pytest.mark.parametrize("reason", ["STOP", "MAX_TOKENS"])
async def test_continuation_does_not_emit_intermediate_finish(monkeypatch, protocol, reason):
    captured = []
    async def stream(body, **kwargs):
        captured.append(copy.deepcopy(body))
        text = "part one" if len(captured) == 1 else "part two\n[done]"
        data = {"candidates": [{"content": {"role": "model", "parts": [{"text": text}]},
                               "finishReason": reason if len(captured) == 1 else "STOP"}]}
        yield ("data: " + json.dumps(data) + "\n\n").encode()
    monkeypatch.setattr(api, "stream_request", stream)
    module = {"gemini": gemini, "openai": openai, "anthropic": anthropic}[protocol]
    monkeypatch.setattr(module, "get_anti_truncation_max_attempts", AsyncMock(return_value=2))
    result = await call_route(protocol, "抗截断/" + MODEL, True)
    text = b"".join([chunk async for chunk in result.body_iterator]).decode()
    assert len(captured) == 2
    assert text.count("part one") == 1
    assert text.count("part two") == 1
    assert "MAX_TOKENS" not in text


@pytest.mark.parametrize("enabled", [False, True])
@pytest.mark.parametrize("reason,tool", [("STOP", False), ("MAX_TOKENS", False), ("SAFETY", False), ("STOP", True)])
async def test_finish_deferral_is_opt_in_and_preserves_safety_and_tools(enabled, reason, tool):
    from fastapi.responses import StreamingResponse
    from src.converter.anti_truncation import AntiTruncationStreamProcessor
    part = {"functionCall": {"name": "synthetic_tool", "args": {}}} if tool else {"text": "partial"}
    async def frames():
        yield ("data: " + json.dumps({"candidates": [{"content": {"parts": [part]},
                                                     "finishReason": reason}]}) + "\n\n").encode()
    async def request(body):
        return StreamingResponse(frames())
    processor = AntiTruncationStreamProcessor(
        request, {"model": MODEL, "request": {"contents": [copy.deepcopy(USER)]}},
        max_attempts=2, defer_intermediate_finish=enabled,
    )
    stream = processor.process_stream()
    try:
        first = json.loads((await anext(stream)).decode().removeprefix("data: "))
        assert ("finishReason" not in first["candidates"][0]) == (
            enabled and reason in ("STOP", "MAX_TOKENS") and not tool
        )
    finally:
        await stream.aclose()


async def test_mysql_redis_uses_same_tier_rule_for_new_model(monkeypatch):
    from src.storage.mysql_manager import MySQLManager
    from test_gemini35_tier_routing import FakeRedis
    manager = MySQLManager()
    manager._redis_enabled = True
    manager._redis = FakeRedis({
        manager._rk_avail("geminicli"): {"pro", "standard"},
        manager._rk_tier("geminicli", "pro"): {"pro"},
        manager._rk_tier("geminicli", TIER_CODE_ASSIST_STANDARD): {"standard"},
        manager._rk_tier("geminicli", TIER_CODE_ASSIST_ENTERPRISE): set(),
    })
    monkeypatch.setattr(manager, "get_credential", AsyncMock(return_value={"project_id": "synthetic"}))
    monkeypatch.setattr("config.get_routing_mode_sync", lambda: "normal")
    assert (await manager._get_next_available_from_redis("geminicli", MODEL))[0] == "standard"
    manager._redis.sets[manager._rk_tier("geminicli", TIER_CODE_ASSIST_STANDARD)].clear()
    assert await manager._get_next_available_from_redis("geminicli", MODEL) is None


async def test_mongodb_passes_tier_constraint_to_redis(monkeypatch):
    from src.storage.mongodb_manager import MongoDBManager
    manager = MongoDBManager()
    monkeypatch.setattr(manager, "_ensure_initialized", lambda: None)
    manager._redis_enabled = True
    select = AsyncMock(return_value=("synthetic-standard", {}))
    monkeypatch.setattr(manager, "_get_next_available_from_redis", select)
    assert (await manager.get_next_available_credential("geminicli", MODEL))[0] == "synthetic-standard"
    assert select.await_args.kwargs["required_tiers"] == GEMINI_35_FLASH_TIERS
    assert select.await_args.kwargs["preview_only"] is False


async def test_postgresql_applies_tier_query_and_row_filter(monkeypatch):
    from contextlib import asynccontextmanager
    from src.storage.psql_manager import PSQLManager
    class Connection:
        async def fetch(self, query, *args):
            assert "tier = ANY($1::text[])" in query
            assert args == (list(GEMINI_35_FLASH_TIERS),)
            return [{"filename": name, "credential_data": "{}", "model_cooldowns": "{}",
                     "preview": False, "tier": tier} for name, tier in
                    (("synthetic-pro", "pro"), ("synthetic-standard", TIER_CODE_ASSIST_STANDARD))]
    class Pool:
        @asynccontextmanager
        async def acquire(self):
            yield Connection()
    manager = PSQLManager()
    monkeypatch.setattr(manager, "_ensure_initialized", lambda: None)
    manager._pool = Pool()
    assert (await manager.get_next_available_credential("geminicli", MODEL))[0] == "synthetic-standard"
