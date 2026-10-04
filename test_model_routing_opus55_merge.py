"""D1004 Opus effort/access identity survives the routing integration."""

from dataclasses import replace
from unittest.mock import AsyncMock

import pytest

from src.model_routing.compiler import compile_channel, parse_route_table
from src.model_routing.policy import build_policy_snapshot, digest
from src.model_routing.projection import project_request
from src.model_routing.routing import resolve
from src.model_routing.types import FeatureSnapshot, thaw
from test_model_routing_resolver import legacy, raw


def compile_rows(rows):
    policy = build_policy_snapshot()
    result = compile_channel("antigravity", parse_route_table({"routes": rows}), policy)
    return result, policy


def row(public, target, enabled=True):
    return dict(channel="antigravity", public_name=public, upstream_name=target, enabled=enabled)


@pytest.mark.parametrize("enabled", [False, True])
@pytest.mark.parametrize("retired", ["claude-opus-4-6", "claude-opus-4-6-thinking", "claude-opus-4.6-high",
                                    "wrapped-claude-opus-4-6-low"])
def test_opus46_restored_native_target_and_version_namespace_protection(enabled, retired):
    target, _ = compile_rows([row("public-alpha", retired, enabled)])
    public, _ = compile_rows([row(retired, "claude-opus-5-5-medium", enabled)])
    if retired == "claude-opus-4-6-thinking":
        assert target.valid, target.issues
    else:
        assert not target.valid
        assert any(issue.field == "upstream_name" and issue.reason == "UNSTABLE_TARGET_DISPATCH"
                   for issue in target.issues)
    assert public.valid is (not enabled)
    if enabled:
        assert any(issue.field == "public_name" and issue.reason == "PROTECTED_ENTRY_CAPTURE"
                   for issue in public.issues)


@pytest.mark.parametrize("name", ["claude-opus-4-6", "假流式/claude-opus-4.6-low",
                                 "wrapper/claude-opus-4-6-thinking/other"])
def test_opus46_legacy_resolution_preserves_version(name):
    result, policy = compile_rows([])
    features = FeatureSnapshot()
    projection = project_request("antigravity", "gemini", name, raw("gemini", {}), features)
    outcome = resolve("antigravity", "gemini", name, projection, result.compiled, policy, features)
    assert outcome.accepted and outcome.dispatch_model == "claude-opus-4-6-thinking"


@pytest.mark.parametrize("public", ["claude-opus-5-5", "claude-opus-5-5-thinking"])
def test_existing_opus_aliases_prove_medium_identity(public):
    result, _ = compile_rows([row(public, "claude-opus-5-5-medium")])
    assert result.valid, result.issues
    assert "namespace" in result.compiled.profiles[public].proofs


@pytest.mark.parametrize("tier", ["low", "medium", "high", "4-6-thinking"])
@pytest.mark.parametrize("protocol", ["gemini", "openai", "claude"])
@pytest.mark.parametrize("return_thoughts", [False, True])
@pytest.mark.parametrize("tools", [False, True])
async def test_explicit_opus_route_matches_actual_normalizer(tier, protocol, return_thoughts, tools, monkeypatch):
    target = "claude-opus-4-6-thinking" if tier == "4-6-thinking" else "claude-opus-5-5-" + tier
    result, policy = compile_rows([row("public-alpha", target)])
    assert result.valid, result.issues
    monkeypatch.setattr("config.get_return_thoughts_to_frontend", AsyncMock(return_value=return_thoughts))
    monkeypatch.setattr("config.get_compatibility_mode_enabled", AsyncMock(return_value=False))
    params = ({"thinkingConfig": {"thinkingBudget": 12000, "thinkingLevel": "HIGH", "includeThoughts": not return_thoughts}}
              if protocol == "gemini" else {"thinking": {"type": "enabled", "budget_tokens": 12000}})
    payload = raw(protocol, params)
    if tools:
        if protocol == "gemini":
            payload["contents"][:0] = [
                {"role": "model", "parts": [{"functionCall": {"name": "synthetic", "args": {}}}]},
                {"role": "user", "parts": [{"functionResponse": {"name": "synthetic", "response": {"ok": True}}}]},
            ]
        elif protocol == "openai":
            payload["messages"][:0] = [
                {"role": "assistant", "content": None, "tool_calls": [{"id": "fixture-call", "type": "function",
                    "function": {"name": "synthetic", "arguments": "{}"}}]},
                {"role": "tool", "tool_call_id": "fixture-call", "content": "ok"},
            ]
        else:
            payload["messages"][:0] = [
                {"role": "assistant", "content": [{"type": "tool_use", "id": "fixture-call", "name": "synthetic", "input": {}}]},
                {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "fixture-call", "content": "ok"}]},
            ]
    features = FeatureSnapshot(return_thoughts=return_thoughts)
    projection = project_request("antigravity", protocol, "public-alpha", payload, features)
    outcome = resolve("antigravity", protocol, "public-alpha", projection, result.compiled, policy, features)
    expected = await legacy("antigravity", protocol, target, payload)
    assert outcome.accepted and outcome.explicit_target
    assert outcome.dispatch_model == expected["model"] == target
    assert thaw(outcome.features["generation_config"]) == expected.get("generationConfig", {})
    if tools:
        assert "thinkingConfig" not in expected.get("generationConfig", {})
    else:
        assert expected["generationConfig"]["thinkingConfig"] == ({"includeThoughts": return_thoughts,
            "thinkingBudget": 1024} if tier == "4-6-thinking" else {"includeThoughts": return_thoughts})


@pytest.mark.parametrize("tier", ["low", "medium", "high"])
def test_native_opus_tier_cannot_be_captured_by_another_tier(tier):
    target = "claude-opus-5-5-" + tier
    result, _ = compile_rows([row(target, "claude-opus-5-5-medium" if tier != "medium" else "claude-opus-5-5-high")])
    assert not result.valid
    assert any(issue.reason == "PROTECTED_ENTRY_CAPTURE" for issue in result.issues)


@pytest.mark.parametrize("path,old_hash", [
    ("src/antigravity_models.py", "01ade1d13151c6a48f11bbf2057ec12a5d09d6e813c58de2d66abe5a9bcc8b19"),
    ("src/converter/gemini_fix.py", "c030dc41a5ab2f473e720c39a41752d08f78593f94d48fb3268c4d918fbdf2ab"),
    ("src/converter/antigravity_fix.py", "06c7eb5b9cd6717cd1690d3a368b37f64f7975926ea8179b6bdd2dedb0393866"),
])
def test_opus55_policy_never_trusts_old_opus46_source(path, old_hash):
    policy = build_policy_snapshot()
    rules = thaw(policy.static_rules)
    rules["source_digests"][path] = old_hash
    stale = replace(policy, static_rules=rules, digest=digest(rules))
    parsed = parse_route_table({"routes": [row("public-alpha", "claude-opus-5-5-medium")]})
    result = compile_channel("antigravity", parsed, stale)
    assert not result.valid
    assert any(issue.reason == "AMBIGUOUS_COMPATIBILITY" for issue in result.issues)


@pytest.mark.parametrize("path,old_hash", [
    ("src/utils.py", "1b29b9d6ac09b30157972d06561c3c50235619005fa4dc27ba9bdfd4748c0492"),
    ("src/antigravity_models.py", "f080954b7ddb0024c54fa1f8096fc32669038aced0b3af5ab0ff2753c0e063ea"),
    ("src/converter/gemini_fix.py", "684926a87312ff06474b59be0c7eab9c69e3c2379a4b93d9f5c638efb44fcdd2"),
    ("src/converter/antigravity_fix.py", "b7ec433a8b21717f4941eb6de96638b08f9f30cf0553a1a25a8a9c50362aaa64"),
])
def test_family_policy_refuses_previous_single_version_sources(path, old_hash):
    policy = build_policy_snapshot()
    rules = thaw(policy.static_rules)
    rules["source_digests"][path] = old_hash
    stale = replace(policy, static_rules=rules, digest=digest(rules))
    result = compile_channel("antigravity", parse_route_table({"routes": [
        row("public-alpha", "claude-opus-4-6-thinking")]}), stale)
    assert not result.valid
    assert any(issue.reason == "AMBIGUOUS_COMPATIBILITY" for issue in result.issues)


def test_source_proof_uses_explicit_empty_ast_fields_on_both_dump_apis(monkeypatch):
    import ast
    from src.model_routing import policy as policy_module

    policy_module._source_digests.cache_clear()
    expected = policy_module._source_digests()
    modern_dump = ast.dump

    def legacy_dump(node, **kwargs):
        if "show_empty" in kwargs:
            raise TypeError("Synthetic pre-3.13 dump API")
        return modern_dump(node, show_empty=True, **kwargs)

    try:
        monkeypatch.setattr(ast, "dump", legacy_dump)
        policy_module._source_digests.cache_clear()
        assert policy_module._source_digests() == expected
        result, _ = compile_rows([row("public-alpha", "claude-opus-4-6-thinking")])
        assert result.valid, result.issues
    finally:
        policy_module._source_digests.cache_clear()
