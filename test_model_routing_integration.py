"""Real routing/store/identity + handlers, with API transport explicitly mocked.

Transport, collector and stream2nostream are tested separately; this matrix
cannot establish real Google connectivity or collector execution.
"""

import importlib
import json
from copy import deepcopy
from types import SimpleNamespace
from urllib.parse import quote

import httpx
import pytest
from fastapi import FastAPI, Response

import config
import src.storage_adapter as adapter_module
from src.router.model_api_errors import protect_authentication
from src.router import stream_passthrough
from src.utils import authenticate_bearer, authenticate_gemini_flexible


def _payload(*, grounding=False):
    candidate = {"index": 0, "content": {"role": "model", "parts": [{"text": "测试成功"}]}, "finishReason": "STOP"}
    if grounding:
        candidate["content"]["parts"].append({"text": "签名正文 ", "thoughtSignature": "synthetic-signature"})
        candidate["groundingMetadata"] = {
            "webSearchQueries": ["synthetic current query"],
            "groundingChunks": [{"web": {"uri": "https://example.org/source", "title": "Fixture"}}],
            "groundingSupports": [{"segment": {"startIndex": 0, "endIndex": 4, "text": "测试成功"}, "groundingChunkIndices": [0]}],
        }
    return {"response": {"candidates": [candidate], "modelVersion": "private-version-sentinel",
            "responseId": "test-response", "usageMetadata": {"promptTokenCount": 0, "candidatesTokenCount": 0, "totalTokenCount": 0}}}


def _sse(value):
    return ("data: " + json.dumps(value, ensure_ascii=False) + "\n\n").encode()


def _events(response):
    return [json.loads(line[6:]) for line in response.text.splitlines()
            if line.startswith("data: ") and line[6:] != "[DONE]"]


@pytest.fixture
def runtime(monkeypatch):
    state = {"table": {"routes": []}, "reads": 0, "calls": [], "call_kinds": [], "payload": _payload(), "after_first": None,
             "actual_nonstream": {}, "call_contexts": []}

    async def fresh(key, default=None):
        assert key == "model_routing"
        state["reads"] += 1
        return deepcopy(state["table"])

    monkeypatch.setattr(adapter_module, "_storage_adapter", SimpleNamespace(_initialized=True, get_config_fresh=fresh))
    monkeypatch.setattr(config, "_config_initialized", True)
    monkeypatch.setattr(config, "_config_cache", {})

    async def record(*args, **kwargs):
        pass

    monkeypatch.setattr(stream_passthrough, "record_logical_request", record)
    app = FastAPI()
    for channel in ("geminicli", "antigravity"):
        for protocol in ("openai", "anthropic", "gemini"):
            module = importlib.import_module(f"src.router.{channel}.{protocol}")
            monkeypatch.setattr(module, "record_logical_request", record)
            app.include_router(module.router)
        api = importlib.import_module(f"src.api.{channel}")
        state["actual_nonstream"][channel] = api.non_stream_request

        async def nonstream(*args, **kwargs):
            state["call_kinds"].append("nonstream")
            state["call_contexts"].append(kwargs.get("route_context"))
            state["calls"].append(deepcopy(kwargs["body"]))
            return Response(json.dumps(state["payload"], ensure_ascii=False), media_type="application/json")

        async def stream(*args, **kwargs):
            assert kwargs.get("events") is True
            state["call_kinds"].append("stream")
            state["call_contexts"].append(kwargs.get("route_context"))
            state["calls"].append(deepcopy(kwargs["body"]))
            frame = deepcopy(state["payload"])
            context = kwargs.get("route_context")
            if context is not None and context.requested_model.startswith(("抗截断/", "流式抗截断/")):
                # Existing anti mode requires its explicit completion marker;
                # finishReason=STOP alone deliberately requests continuation.
                for candidate in frame["response"]["candidates"]:
                    if candidate.get("finishReason") == "STOP":
                        candidate["content"]["parts"][0]["text"] += " [done]"
            yield _sse(frame)
            if state["after_first"]:
                state["after_first"]()
            yield _sse({"response": {"modelVersion": "private-version-sentinel", "usageMetadata": {"totalTokenCount": 0}}})
            yield b"data: [DONE]\n\n"

        monkeypatch.setattr(api, "non_stream_request", nonstream)
        monkeypatch.setattr(api, "stream_request", stream)

    async def auth_ok():
        return "isolated-test-auth"

    app.dependency_overrides[protect_authentication(authenticate_bearer)] = auth_ok
    app.dependency_overrides[protect_authentication(authenticate_gemini_flexible)] = auth_ok
    return app, state


def _route(state, channel, public="public-alpha", target="opaque-target"):
    state["table"] = {"routes": [{"channel": channel, "public_name": public, "upstream_name": target, "enabled": True}]}


async def _request(app, channel, protocol, mode, requested):
    prefix = "/antigravity" if channel == "antigravity" else ""
    if protocol == "gemini":
        method = "generateContent" if mode == "nonstream" else "streamGenerateContent"
        path = f"{prefix}/v1/models/{quote(requested, safe='')}:{method}"
        body = {"contents": [{"role": "user", "parts": [{"text": "请返回测试成功"}]}], "tools": [{"googleSearch": {}}]}
    else:
        path = prefix + ("/v1/chat/completions" if protocol == "openai" else "/v1/messages")
        body = {"model": requested, "messages": [{"role": "user", "content": "请返回测试成功"}], "stream": mode != "nonstream"}
        if protocol == "anthropic":
            body["max_tokens"] = 32
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        return await client.post(path, json=body)


@pytest.mark.asyncio
@pytest.mark.parametrize("channel", ["geminicli", "antigravity"])
@pytest.mark.parametrize("protocol", ["openai", "anthropic", "gemini"])
@pytest.mark.parametrize("mode", ["nonstream", "stream", "fake", "anti"])
async def test_six_handlers_four_modes_use_real_routing_and_exact_identity(runtime, channel, protocol, mode):
    app, state = runtime
    _route(state, channel)
    requested = {"fake": "假流式/", "anti": "流式抗截断/"}.get(mode, "") + "public-alpha"
    response = await _request(app, channel, protocol, mode, requested)
    assert response.status_code == 200, response.text
    assert "private-version-sentinel" not in response.text
    assert state["reads"] == 1
    assert state["calls"] and all(item["model"] == "opaque-target" for item in state["calls"])
    assert state["call_kinds"] == ["nonstream" if mode in ("nonstream", "fake") else "stream"]
    assert all(context is not None and context.requested_model == requested for context in state["call_contexts"])
    if mode == "nonstream":
        assert response.json()["modelVersion" if protocol == "gemini" else "model"] == requested
    else:
        assert response.headers["content-type"].startswith("text/event-stream")
        events = _events(response)
        assert events and "测试成功" in response.text
        if protocol == "anthropic":
            assert [event["message"]["model"] for event in events if event.get("type") == "message_start"] == [requested]
            assert any(event.get("type") == "message_stop" for event in events)
        elif protocol == "openai":
            business = [event for event in events if "choices" in event]
            assert business and all(event["model"] == requested for event in business)
            assert "data: [DONE]" in response.text
        else:
            business = [event for event in events if "candidates" in event or "modelVersion" in event]
            assert business and all(event["modelVersion"] == requested for event in business)
            assert "data: [DONE]" in response.text


@pytest.mark.asyncio
@pytest.mark.parametrize("channel", ["geminicli", "antigravity"])
@pytest.mark.parametrize("mode", ["nonstream", "stream", "fake"])
async def test_native_grounding_and_signed_parts_are_preserved(runtime, channel, mode):
    app, state = runtime
    _route(state, channel)
    state["payload"] = _payload(grounding=True)
    requested = ("假流式/" if mode == "fake" else "") + "public-alpha"
    response = await _request(app, channel, "gemini", mode, requested)
    assert response.status_code == 200, response.text
    if mode == "nonstream":
        payload = response.json()
    else:
        data = [item for item in _events(response) if item.get("candidates")]
        assert len(data) == 1
        payload = data[0]
    expected = state["payload"]["response"]
    assert payload["candidates"] == expected["candidates"]
    assert payload["modelVersion"] == requested
    assert state["calls"][0]["request"]["tools"] == [{"googleSearch": {}}]


@pytest.mark.asyncio
@pytest.mark.parametrize("channel", ["geminicli", "antigravity"])
@pytest.mark.parametrize("protocol", ["openai", "anthropic", "gemini"])
@pytest.mark.parametrize("mode", ["nonstream", "stream", "fake", "anti"])
async def test_handler_passes_one_feature_snapshot_to_every_path(runtime, monkeypatch, channel, protocol, mode):
    app, state = runtime
    _route(state, channel)
    reads = {"compatibility": 0, "thoughts": 0, "stream2nostream": 0}

    def getter(key, value):
        async def once():
            reads[key] += 1
            assert reads[key] == 1, "handler failed to pass its feature snapshot"
            return value
        return once

    monkeypatch.setattr(config, "get_compatibility_mode_enabled", getter("compatibility", True))
    monkeypatch.setattr(config, "get_return_thoughts_to_frontend", getter("thoughts", False))
    monkeypatch.setattr(config, "get_antigravity_stream2nostream", getter("stream2nostream", True))
    requested = {"fake": "假流式/", "anti": "流式抗截断/"}.get(mode, "") + "public-alpha"
    response = await _request(app, channel, protocol, mode, requested)
    assert response.status_code == 200, response.text
    assert reads == {"compatibility": 1, "thoughts": 1, "stream2nostream": 1}
    assert state["reads"] == 1
    assert state["calls"]


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["nonstream", "fake"])
async def test_ag_real_api_stream2nostream_collector_and_handler_preserve_grounding(runtime, monkeypatch, mode):
    """Only upstream stream attempt is mocked; the API and collector are real."""
    app, state = runtime
    _route(state, "antigravity")
    state["payload"] = _payload(grounding=True)
    from src.api import antigravity as api
    monkeypatch.setattr(api, "non_stream_request", state["actual_nonstream"]["antigravity"])

    async def stream_enabled():
        return True

    monkeypatch.setattr(config, "get_antigravity_stream2nostream", stream_enabled)
    requested = ("假流式/" if mode == "fake" else "") + "public-alpha"
    response = await _request(app, "antigravity", "gemini", mode, requested)
    assert response.status_code == 200, response.text
    payloads = [item for item in _events(response) if item.get("candidates")] if mode == "fake" else [response.json()]
    assert len(payloads) == 1
    payload = payloads[0]
    assert payload["candidates"] == state["payload"]["response"]["candidates"]
    assert payload["usageMetadata"]["totalTokenCount"] == 0
    assert payload["modelVersion"] == requested
    assert "private-version-sentinel" not in response.text
    assert state["reads"] == 1 and state["call_kinds"] == ["stream"]


@pytest.mark.asyncio
@pytest.mark.parametrize("channel", ["geminicli", "antigravity"])
async def test_native_unmapped_identity_masks_upstream_version(runtime, channel):
    app, state = runtime
    response = await _request(app, channel, "gemini", "nonstream", "original-opaque")
    assert response.status_code == 200
    assert response.json()["modelVersion"] == "original-opaque"
    assert state["calls"][0]["model"] == "original-opaque"


@pytest.mark.asyncio
async def test_antigravity_full_name_has_no_cli_suffix_derivation(runtime):
    app, state = runtime
    _route(state, "antigravity")
    response = await _request(app, "antigravity", "openai", "nonstream", "public-alpha-search")
    assert response.status_code == 200
    assert state["calls"][0]["model"] == "public-alpha-search"
    assert not any("googleSearch" in tool for tool in state["calls"][0]["request"].get("tools", []))


@pytest.mark.asyncio
async def test_cli_derived_search_uses_target_and_search_tool(runtime):
    app, state = runtime
    _route(state, "geminicli")
    response = await _request(app, "geminicli", "openai", "nonstream", "public-alpha-high-search")
    assert response.status_code == 200, response.text
    assert state["calls"][0]["model"] == "opaque-target"
    assert {"googleSearch": {}} in state["calls"][0]["request"]["tools"]
    assert response.json()["model"] == "public-alpha-high-search"


@pytest.mark.asyncio
async def test_live_stream_keeps_snapshot_and_next_request_reads_new_table(runtime):
    app, state = runtime
    _route(state, "geminicli")
    state["after_first"] = lambda: _route(state, "geminicli", target="opaque-next")
    response = await _request(app, "geminicli", "gemini", "stream", "public-alpha")
    assert response.status_code == 200
    assert state["reads"] == 1 and state["calls"][0]["model"] == "opaque-target"
    state["after_first"] = None
    second = await _request(app, "geminicli", "gemini", "nonstream", "public-alpha")
    assert second.status_code == 200
    assert state["reads"] == 2 and state["calls"][-1]["model"] == "opaque-next"


@pytest.mark.asyncio
@pytest.mark.parametrize("channel", ["geminicli", "antigravity"])
async def test_anti_continuation_keeps_first_route_after_table_change(runtime, channel):
    app, state = runtime
    _route(state, channel)
    state["payload"]["response"]["candidates"][0]["finishReason"] = "MAX_TOKENS"

    def changed():
        _route(state, channel, target="opaque-next")
        state["payload"] = _payload()
        state["after_first"] = None

    state["after_first"] = changed
    response = await _request(app, channel, "gemini", "anti", "流式抗截断/public-alpha")
    assert response.status_code == 200, response.text
    assert "测试成功" in response.text and "data: [DONE]" in response.text
    assert state["reads"] == 1
    assert state["call_kinds"] == ["stream", "stream"]
    assert [call["model"] for call in state["calls"]] == ["opaque-target", "opaque-target"]
    assert state["call_contexts"][0] is not None
    assert state["call_contexts"][0] is state["call_contexts"][1]


@pytest.mark.asyncio
async def test_invalid_channel_isolated_and_global_corruption_fails_closed(runtime):
    app, state = runtime
    state["table"] = {"routes": [{"channel": "antigravity", "public_name": "public-alpha", "upstream_name": "opaque-target", "enabled": "true"}]}
    good = await _request(app, "geminicli", "gemini", "nonstream", "original-opaque")
    assert good.status_code == 200
    bad = await _request(app, "antigravity", "gemini", "nonstream", "original-opaque")
    assert bad.status_code == 503 and len(state["calls"]) == 1
    state["table"] = {"routes": [None]}
    for channel in ("geminicli", "antigravity"):
        result = await _request(app, channel, "gemini", "nonstream", "original-opaque")
        assert result.status_code == 503
    assert len(state["calls"]) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("protocol", ["gemini", "openai", "anthropic"])
async def test_cli_nonstream_local_normalization_error_records_exactly_once(runtime, monkeypatch, protocol):
    from src.geminicli_models import GEMINI_38_FLASH_MODEL
    app, state = runtime
    recorded = []

    async def record(*args):
        recorded.append(args)

    module = importlib.import_module(f"src.router.geminicli.{protocol}")
    monkeypatch.setattr(module, "record_logical_request", record)
    if protocol == "gemini":
        path = f"/v1/models/{GEMINI_38_FLASH_MODEL}:generateContent"
        body = {"contents": [{"role": "user", "parts": [{"text": "synthetic"}]}],
                "generationConfig": {"thinkingConfig": {"thinkingBudget": 128}}}
    else:
        path = "/v1/chat/completions" if protocol == "openai" else "/v1/messages"
        body = {"model": GEMINI_38_FLASH_MODEL, "messages": [{"role": "user", "content": "synthetic"}]}
        if protocol == "openai":
            body["model"] += "-minimal"
        else:
            body.update(max_tokens=32, thinking={"type": "enabled", "budget_tokens": 128})
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        result = await client.post(path, json=body)
    assert result.status_code == 400, result.text
    assert recorded == [(GEMINI_38_FLASH_MODEL, "geminicli", False)]
    assert state["calls"] == [] and state["reads"] == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("channel", ["geminicli", "antigravity"])
@pytest.mark.parametrize("payload", [[], "invalid model object"])
async def test_native_nonobject_stream_fails_safely_at_real_identity_boundary(runtime, monkeypatch, channel, payload):
    app, state = runtime
    api = importlib.import_module(f"src.api.{channel}")

    async def stream(**kwargs):
        state["calls"].append(deepcopy(kwargs["body"]))
        yield _sse(payload)
        yield b"data: [DONE]\n\n"

    monkeypatch.setattr(api, "stream_request", stream)
    result = await _request(app, channel, "gemini", "stream", "original-opaque")
    assert result.status_code == 502, result.text
    assert result.json()["error"]["code"] == 502
    assert "private-version-sentinel" not in result.text
    assert len(state["calls"]) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("channel", ["geminicli", "antigravity"])
async def test_anthropic_anti_preserves_first_finish_boundary_without_extra_turns(runtime, monkeypatch, channel):
    app, state = runtime
    _route(state, channel)
    api = importlib.import_module(f"src.api.{channel}")
    closed = []

    async def stream(**kwargs):
        state["calls"].append(deepcopy(kwargs["body"]))
        try:
            yield _sse(_payload())  # STOP without the anti completion marker.
            yield b"data: [DONE]\n\n"
        finally:
            closed.append(True)

    monkeypatch.setattr(api, "stream_request", stream)
    result = await _request(app, channel, "anthropic", "anti", "抗截断/public-alpha")
    assert result.status_code == 200 and "测试成功" in result.text
    assert any(event.get("type") == "message_stop" for event in _events(result))
    assert len(state["calls"]) == 1 and closed == [True]


@pytest.mark.asyncio
@pytest.mark.parametrize("channel", ["geminicli", "antigravity"])
@pytest.mark.parametrize("protocol", ["gemini", "openai", "anthropic"])
@pytest.mark.parametrize("missing", [False, True])
async def test_empty_or_missing_table_source_drift_keeps_real_legacy_requests(runtime, monkeypatch, channel, protocol, missing):
    from dataclasses import replace
    from src.model_routing import policy
    from src.model_routing.types import thaw
    app, state = runtime
    if missing:
        async def fresh(key, default=None):
            state["reads"] += 1
            return default
        adapter_module._storage_adapter.get_config_fresh = fresh
    requested = "original-opaque-search"
    baseline = await _request(app, channel, protocol, "nonstream", requested)
    assert baseline.status_code == 200
    original_body = deepcopy(state["calls"][-1])
    original = policy.build_policy_snapshot()
    rules = thaw(original.static_rules)
    rules["source_digests"]["src/models.py"] = "synthetic-unreviewed-source"
    candidate = replace(original, static_rules=rules, digest=policy.digest(rules))
    monkeypatch.setattr(policy, "build_policy_snapshot", lambda: candidate)
    result = await _request(app, channel, protocol, "nonstream", requested)
    assert result.status_code == baseline.status_code and "测试成功" in result.text
    assert state["calls"][-1] == original_body
    assert result.json()["modelVersion" if protocol == "gemini" else "model"] == requested
    assert state["reads"] == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("channel", ["geminicli", "antigravity"])
@pytest.mark.parametrize("protocol", ["gemini", "openai", "anthropic"])
@pytest.mark.parametrize("failure", [OSError, SyntaxError])
async def test_generation_policy_read_or_parse_failure_is_fixed_local503(runtime, monkeypatch, channel, protocol, failure):
    from src.model_routing import policy
    app, state = runtime
    def broken():
        raise failure("private-source-error-sentinel")
    monkeypatch.setattr(policy, "_source_digests", broken)
    result = await _request(app, channel, protocol, "nonstream", "original-opaque")
    assert result.status_code == 503
    assert "private-source-error-sentinel" not in result.text
    assert state["reads"] == 0 and state["calls"] == []
