"""Synthetic Argon route/permission-catalog coverage; generation transport is mocked."""
from copy import deepcopy
from unittest.mock import AsyncMock

import pytest

from src.antigravity_models import (
    ARGON_ANTIGRAVITY_MODEL_IDS, is_argon_model, is_disabled_antigravity_model,
    resolve_antigravity_model_id, select_public_model_ids,
)
from src.converter.gemini_fix import get_base_model_name, map_antigravity_gemini_model, normalize_gemini_request
from src.model_routing.compiler import compile_channel, parse_route_table
from src.model_routing.policy import build_policy_snapshot
from src.model_routing.projection import project_request
from src.model_routing.routing import resolve
from src.model_routing.types import FeatureSnapshot, thaw
from test_model_routing_resolver import legacy, raw
from test_model_routing_integration import runtime, _request

PREFIXES = ("", "假流式/", "抗截断/", "流式抗截断/")
NAMES = ("gemini-4-argon", *ARGON_ANTIGRAVITY_MODEL_IDS)


@pytest.mark.parametrize("prefix", PREFIXES)
@pytest.mark.parametrize("name", NAMES)
def test_exact_id_and_bare_low_alias_survive_prefix_and_body_conflicts(prefix, name):
    expected = "gemini-4-argon-low" if name == "gemini-4-argon" else name
    assert resolve_antigravity_model_id(prefix + name) == expected
    assert get_base_model_name(prefix + name, mode="antigravity") == expected
    assert map_antigravity_gemini_model(prefix + name, "HIGH", 48000) == expected
    assert is_argon_model(prefix + name)
    assert not is_disabled_antigravity_model(prefix + name)


def test_catalog_requires_exact_permission_evidence_not_quota_alias_or_disabled():
    quota = [*ARGON_ANTIGRAVITY_MODEL_IDS, "gemini-4-argon", "gemini-4-argon-disabled", "gemini-3.8-flash-high"]
    assert select_public_model_ids(quota) == ["gemini-3.8-flash-high"]
    assert select_public_model_ids(quota, permission_model_ids=["gemini-4-argon", "gemini-4-argon-disabled"]) == ["gemini-3.8-flash-high"]
    assert select_public_model_ids([], permission_model_ids=["gemini-4-argon-medium"]) == ["gemini-4-argon-medium"]
    assert select_public_model_ids(quota, permission_model_ids=["gemini-4-argon-low", "gemini-4-argon-high"]) == [
        "gemini-3.8-flash-high", "gemini-4-argon-high", "gemini-4-argon-low"]


@pytest.mark.parametrize("name", NAMES)
@pytest.mark.parametrize("prefix", PREFIXES)
@pytest.mark.parametrize("protocol", ["gemini", "openai", "anthropic"])
@pytest.mark.parametrize("mode", ["nonstream", "stream"])
async def test_all_protocols_modes_preserve_argon_route_and_client_identity(runtime, name, prefix, protocol, mode):
    app, state = runtime
    requested = prefix + name
    response = await _request(app, "antigravity", protocol, mode, requested)
    assert response.status_code == 200, response.text
    expected = "gemini-4-argon-low" if name == "gemini-4-argon" else name
    assert state["calls"] and all(item["model"] == expected for item in state["calls"])
    assert all(context.requested_model == requested for context in state["call_contexts"])
    assert all(item["request"]["generationConfig"]["thinkingConfig"] == {"includeThoughts": True}
               for item in state["calls"])


@pytest.mark.parametrize("prefix", PREFIXES)
@pytest.mark.parametrize("protocol", ["gemini", "openai", "anthropic"])
@pytest.mark.parametrize("mode", ["nonstream", "stream"])
async def test_disabled_is_local_404_before_config_and_transport(runtime, prefix, protocol, mode):
    app, state = runtime
    response = await _request(app, "antigravity", protocol, mode, prefix + "gemini-4-argon-disabled")
    assert response.status_code == 404, response.text
    assert response.headers["content-type"].startswith("application/json")
    assert state["reads"] == 0 and not state["calls"]
    assert "argon" not in response.text


@pytest.mark.parametrize("target", ARGON_ANTIGRAVITY_MODEL_IDS)
@pytest.mark.parametrize("protocol", ["gemini", "openai", "claude"])
@pytest.mark.parametrize("return_thoughts", [False, True])
async def test_explicit_route_parameter_profile_matches_real_converter(target, protocol, return_thoughts, monkeypatch):
    monkeypatch.setattr("config.get_return_thoughts_to_frontend", AsyncMock(return_value=return_thoughts))
    monkeypatch.setattr("config.get_compatibility_mode_enabled", AsyncMock(return_value=False))
    policy = build_policy_snapshot()
    table = compile_channel("antigravity", parse_route_table({"routes": [{
        "channel": "antigravity", "public_name": "synthetic-argon", "upstream_name": target, "enabled": True,
    }]}), policy)
    assert table.valid, table.issues
    params = {"thinkingConfig": {"thinkingBudget": 48000, "thinkingLevel": "HIGH", "includeThoughts": not return_thoughts}} if protocol == "gemini" else {"thinking": {"type": "enabled", "budget_tokens": 48000}}
    params["maxOutputTokens" if protocol == "gemini" else "max_tokens"] = 16
    payload = raw(protocol, params)
    features = FeatureSnapshot(return_thoughts=return_thoughts)
    projection = project_request("antigravity", protocol, "synthetic-argon", payload, features)
    result = resolve("antigravity", protocol, "synthetic-argon", projection, table.compiled, policy, features)
    expected = await legacy("antigravity", protocol, target, payload)
    assert result.accepted and result.explicit_target and result.dispatch_model == target == expected["model"]
    assert thaw(result.features["generation_config"]) == expected["generationConfig"]
    assert expected["generationConfig"]["thinkingConfig"] == {"includeThoughts": return_thoughts}
    assert expected["generationConfig"]["maxOutputTokens"] == 16


@pytest.mark.parametrize("name", NAMES)
@pytest.mark.parametrize("return_thoughts", [False, True])
async def test_shared_normalizer_strips_conflicts_preserves_input_and_thought_policy(name, return_thoughts, monkeypatch):
    monkeypatch.setattr("config.get_return_thoughts_to_frontend", AsyncMock(return_value=return_thoughts))
    request = {"model": name, "contents": [{"role": "user", "parts": [{"text": "synthetic"}]}],
               "generationConfig": {"thinkingConfig": {"thinkingBudget": 48000, "thinkingLevel": "HIGH", "includeThoughts": not return_thoughts}}}
    original = deepcopy(request)
    result = await normalize_gemini_request(request, mode="antigravity")
    assert result["model"] == resolve_antigravity_model_id(name)
    assert result["generationConfig"]["thinkingConfig"] == {"includeThoughts": return_thoughts}
    assert request == original


@pytest.mark.parametrize("public,target", [("synthetic-argon", "gemini-4-argon-disabled"), ("gemini-4-argon-disabled", "gemini-4-argon-low"), ("gemini-4-argon", "gemini-4-argon-high")])
def test_route_config_cannot_enable_disabled_or_capture_bare_low_alias(public, target):
    result = compile_channel("antigravity", parse_route_table({"routes": [{
        "channel": "antigravity", "public_name": public, "upstream_name": target, "enabled": True,
    }]}), build_policy_snapshot())
    assert not result.valid


@pytest.mark.parametrize("protocol", ["gemini", "openai", "claude"])
@pytest.mark.parametrize("public", ["gemini-4-argon-low", "gemini-4-argon", "synthetic-argon"])
@pytest.mark.parametrize("evidence", [False, True])
def test_explicit_catalog_requires_native_identity_and_exact_permission(protocol, public, evidence):
    from src.model_routing.catalog import project_catalog
    policy = build_policy_snapshot()
    target = "gemini-4-argon-low"
    table = compile_channel("antigravity", parse_route_table({"routes": [{
        "channel": "antigravity", "public_name": public, "upstream_name": target, "enabled": True,
    }]}), policy)
    assert table.valid, table.issues
    # A different tier and a legacy model must survive every configuration.
    def item(name):
        return {"name": "models/" + name} if protocol == "gemini" else {"id": name}
    source = [item("gemini-4-argon-high"), item("gemini-3.8-flash-high")]
    if evidence:
        source.append(item(target))
    original = deepcopy(source)
    result = project_catalog("antigravity", protocol, source, table.compiled, policy, FeatureSnapshot())
    ids = [entry.get("id", entry.get("name")).removeprefix("models/") for entry in result]
    assert source == original
    assert (target in ids) is evidence
    assert "gemini-4-argon-high" in ids and "gemini-3.8-flash-high" in ids
    assert "gemini-4-argon" not in ids and "synthetic-argon" not in ids
    if public != target or not evidence:
        assert result == source
    else:
        assert ids == ["gemini-4-argon-high", "gemini-3.8-flash-high", target, "假流式/" + target, "抗截断/" + target]


@pytest.mark.parametrize("public", ARGON_ANTIGRAVITY_MODEL_IDS)
@pytest.mark.parametrize("target", ARGON_ANTIGRAVITY_MODEL_IDS)
def test_native_argon_tier_cannot_be_remapped_by_configuration(public, target):
    table = compile_channel("antigravity", parse_route_table({"routes": [{
        "channel": "antigravity", "public_name": public, "upstream_name": target, "enabled": True,
    }]}), build_policy_snapshot())
    assert table.valid is (public == target)
    if public != target:
        assert any(issue.reason == "PROTECTED_ENTRY_CAPTURE" for issue in table.issues)


@pytest.mark.parametrize("protocol", ["gemini", "openai", "anthropic"])
@pytest.mark.parametrize("prefix", PREFIXES)
@pytest.mark.parametrize("mode", ["nonstream", "stream"])
async def test_real_protocol_handlers_preserve_sixteen_token_cap(runtime, protocol, prefix, mode):
    import httpx
    from urllib.parse import quote
    app, state = runtime
    requested = prefix + "gemini-4-argon-high"
    if protocol == "gemini":
        method = "generateContent" if mode == "nonstream" else "streamGenerateContent"
        path = f"/antigravity/v1/models/{quote(requested, safe='')}:{method}"
        body = {"contents": [{"role": "user", "parts": [{"text": "Synthetic cap request"}]}],
                "generationConfig": {"maxOutputTokens": 16}}
    else:
        path = "/antigravity/v1/chat/completions" if protocol == "openai" else "/antigravity/v1/messages"
        body = {"model": requested, "messages": [{"role": "user", "content": "Synthetic cap request"}],
                "stream": mode != "nonstream", "max_tokens": 16}
        if protocol == "openai":
            body.update(max_tokens=512, max_completion_tokens=16)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://synthetic") as client:
        response = await client.post(path, json=body)
    assert response.status_code == 200, response.text
    assert state["calls"]
    assert all(call["request"]["generationConfig"]["maxOutputTokens"] == 16 for call in state["calls"])
    assert all(call["model"] == "gemini-4-argon-high" for call in state["calls"])


@pytest.mark.parametrize("shared", [False, True])
@pytest.mark.parametrize("value,expected", [(1, 1), (16, 16), (64000, 64000), (64001, 64000),
    (0, 64000), (-1, 64000), (True, 64000), (False, 64000), (16.0, 64000), ("16", 64000), (None, 64000)])
async def test_argon_output_limit_valid_integer_boundary_and_invalid_defaults(shared, value, expected, monkeypatch):
    from src.converter.antigravity_fix import normalize_antigravity_request
    monkeypatch.setattr("config.get_return_thoughts_to_frontend", AsyncMock(return_value=False))
    request = {"model": "gemini-4-argon", "contents": [{"role": "user", "parts": [{"text": "synthetic"}]}],
               "generationConfig": {"maxOutputTokens": value}}
    result = await normalize_gemini_request(request, mode="antigravity") if shared else await normalize_antigravity_request(request)
    assert result["generationConfig"]["maxOutputTokens"] == expected
    assert result["generationConfig"]["topK"] == 64


@pytest.mark.parametrize("model", ["gemini-3.8-flash-high", "claude-opus-5-5-high"])
async def test_non_argon_output_limit_behavior_unchanged(model, monkeypatch):
    from src.converter.antigravity_fix import normalize_antigravity_request
    monkeypatch.setattr("config.get_return_thoughts_to_frontend", AsyncMock(return_value=False))
    result = await normalize_antigravity_request({"model": model, "generationConfig": {"maxOutputTokens": 16}})
    assert result["generationConfig"]["maxOutputTokens"] == 64000
