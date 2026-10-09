"""Offline Flash transport checks with real routers and synthetic HTTP boundaries."""
import asyncio
from dataclasses import replace
from unittest.mock import AsyncMock

import httpx
import pytest

import config
from src.api import antigravity as api
from src.api.antigravity import is_antigravity_text_flash_model
from src.model_routing.types import FeatureSnapshot
from src import antigravity_limits as limits
from test_antigravity_stream_replay import _configure_stream
from test_model_routing_transport import context
from test_model_routing_integration import runtime, _request, _route, _payload, _sse, _events

FLASH = ["gemini-3-flash", "gemini-3.8-flash-high", "gemini-2.5-flash-lite-preview",
         "gemini-3-flash-agent", "gemini-3.5-flash-extra-low", "gemini-3.7-flash-tiered",
         "gemini-2.0-flash-thinking", "GEMINI-3.8-FLASH-MINIMAL"]
OTHER = ["gemini-3-pro", "claude-sonnet-4-6", "gemini-2.5-flash-image",
         "tab_flash_lite_preview", "tab_jump_flash_lite_preview", "my-gemini-3-flash",
         "gemini-３-flash", "gemini-3-flash-unknown", "gemini-3-flash\n", "gemini-3-flash "]


@pytest.mark.parametrize("model,expected", [(m, True) for m in FLASH] + [(m, False) for m in OTHER])
def test_final_model_classification(model, expected):
    assert is_antigravity_text_flash_model(model) is expected


def test_old_positional_snapshot_is_compatible():
    snapshot = FeatureSnapshot(True, False, True, {"old": 1})
    assert snapshot.values["old"] == 1
    assert snapshot.antigravity_flash_non_stream_mode == "inherit"


@pytest.mark.parametrize("mode", ["inherit", "native", "stream_collect"])
@pytest.mark.parametrize("global_mode", [False, True])
@pytest.mark.parametrize("model", FLASH + OTHER[:5])
async def test_snapshot_selector(monkeypatch, mode, global_mode, model):
    forbidden = AsyncMock(side_effect=AssertionError("snapshot must not reread config"))
    monkeypatch.setattr(api, "get_antigravity_stream2nostream", forbidden)
    monkeypatch.setattr(api, "get_antigravity_flash_non_stream_mode", forbidden)
    captured = context(antigravity_stream2nostream=global_mode, antigravity_flash_non_stream_mode=mode)
    expected = global_mode if model in OTHER or mode == "inherit" else mode == "stream_collect"
    assert await api._use_stream_collector(model, captured) is expected
    forbidden.assert_not_awaited()


async def wire_http(monkeypatch, status=200, stall=False):
    calls = []
    payload = _payload()
    payload["response"]["candidates"][0]["content"]["parts"][0]["text"] += " [done]"
    async def stream(**kwargs):
        calls.append((kwargs["url"], limits.current_budget.get()))
        if stall:
            await asyncio.sleep(5)
        if status != 200:
            from fastapi import Response
            yield Response('{"error":{"message":"synthetic"}}', status_code=status)
        else:
            yield _sse(payload)
            yield b"data: [DONE]\n\n"
    await _configure_stream(monkeypatch, stream)
    async def post(**kwargs):
        calls.append((kwargs["url"], limits.current_budget.get()))
        if stall:
            await asyncio.sleep(5)
        return httpx.Response(status, json=payload if status == 200 else {"error": {"message": "synthetic"}})
    monkeypatch.setattr(api, "post_async", post)
    monkeypatch.setattr(api, "_capacity_breaker_response", lambda _: None)
    monkeypatch.setattr(api, "get_antigravity_stream2nostream", AsyncMock(return_value=False))
    monkeypatch.setattr(api, "get_antigravity_flash_non_stream_mode", AsyncMock(return_value="inherit"))
    return calls


@pytest.mark.parametrize("mode", ["inherit", "native", "stream_collect"])
@pytest.mark.parametrize("global_mode", [False, True])
async def test_http_url_and_one_logical_outcome(monkeypatch, mode, global_mode):
    from src import logical_request_stats
    calls = await wire_http(monkeypatch)
    record = AsyncMock()
    monkeypatch.setattr(logical_request_stats, "record_logical_request", record)
    monkeypatch.setattr(api, "get_antigravity_stream2nostream", AsyncMock(return_value=global_mode))
    monkeypatch.setattr(api, "get_antigravity_flash_non_stream_mode", AsyncMock(return_value=mode))
    result = await api.non_stream_request({"model": "gemini-3.8-flash", "request": {}})
    assert result.status_code == 200
    expected_stream = global_mode if mode == "inherit" else mode == "stream_collect"
    assert len(calls) == 1
    assert (":streamGenerateContent" in calls[0][0]) is expected_stream
    assert calls[0][1] is not None
    record.assert_awaited_once()
    api.get_antigravity_stream2nostream.assert_awaited_once()
    api.get_antigravity_flash_non_stream_mode.assert_awaited_once()


@pytest.mark.parametrize("mode", ["native", "stream_collect"])
@pytest.mark.parametrize("status", [400, 401])
async def test_error_does_not_fallback(monkeypatch, mode, status):
    calls = await wire_http(monkeypatch, status=status)
    captured = context(antigravity_flash_non_stream_mode=mode)
    captured = replace(captured, resolution=replace(captured.resolution, dispatch_model="gemini-3.8-flash"))
    result = await api.non_stream_request({"model": "gemini-3.8-flash", "request": {}}, route_context=captured, record_logical=False)
    assert result.status_code == status
    assert len(calls) == 1


@pytest.mark.parametrize("mode", ["native", "stream_collect"])
async def test_transport_preserves_total_budget(monkeypatch, mode):
    calls = await wire_http(monkeypatch, stall=True)
    policy = limits.GenerationLimits(first=.04, idle=.04, total=.06, headers=.03)
    monkeypatch.setattr(limits.GenerationLimits, "load", classmethod(lambda cls: policy))
    monkeypatch.setattr(api, "get_antigravity_flash_non_stream_mode", AsyncMock(return_value=mode))
    result = await api.non_stream_request({"model": "gemini-3.8-flash", "request": {}}, record_logical=False)
    assert result.status_code == 504
    assert len(calls) == 1


@pytest.mark.parametrize("protocol", ["openai", "anthropic", "gemini"])
@pytest.mark.parametrize("request_mode", ["nonstream", "fake", "stream", "anti"])
@pytest.mark.parametrize("mode", ["inherit", "native", "stream_collect"])
@pytest.mark.parametrize("global_mode", [False, True])
@pytest.mark.parametrize("public,target,flash", [
    ("public-alpha", "gemini-3.8-flash-medium", True),
    ("gemini-9-flash", "claude-sonnet-4-6", False),
])
async def test_real_protocols_use_final_target(runtime, monkeypatch, protocol, request_mode, mode, global_mode, public, target, flash):
    app, state = runtime
    # Capture real helpers before fixture mocks; the wrapper is saved by runtime.
    monkeypatch.setattr(api, "non_stream_request", state["actual_nonstream"]["antigravity"])
    monkeypatch.setattr(api, "stream_request", _REAL_STREAM)
    calls = await wire_http(monkeypatch)
    _route(state, "antigravity", public, target)
    monkeypatch.setattr(config, "get_antigravity_stream2nostream", AsyncMock(return_value=global_mode))
    getter = AsyncMock(return_value=mode)
    monkeypatch.setattr(config, "get_antigravity_flash_non_stream_mode", getter)
    forbidden = AsyncMock(side_effect=AssertionError("transport reread captured settings"))
    monkeypatch.setattr(api, "get_antigravity_stream2nostream", forbidden)
    monkeypatch.setattr(api, "get_antigravity_flash_non_stream_mode", forbidden)
    requested = {"fake": "假流式/", "anti": "流式抗截断/"}.get(request_mode, "") + public
    result = await _request(app, "antigravity", protocol, request_mode, requested)
    assert result.status_code == 200, result.text
    assert "测试成功" in result.text
    assert "private-version-sentinel" not in result.text
    if request_mode == "nonstream":
        assert result.json()["modelVersion" if protocol == "gemini" else "model"] == requested
    else:
        assert result.headers["content-type"].startswith("text/event-stream")
        events = _events(result)
        assert events
        if protocol == "anthropic":
            assert [event["message"]["model"] for event in events
                    if event.get("type") == "message_start"] == [requested]
            assert any(event.get("type") == "content_block_delta" and
                       event.get("delta", {}).get("text") for event in events)
            assert any(event.get("type") == "message_stop" for event in events)
        else:
            identity = "modelVersion" if protocol == "gemini" else "model"
            content = "candidates" if protocol == "gemini" else "choices"
            business = [event for event in events if content in event]
            assert business and all(event[identity] == requested for event in business)
            assert "data: [DONE]" in result.text
    selected = global_mode if not flash or mode == "inherit" else mode == "stream_collect"
    expected_stream = request_mode in ("stream", "anti") or selected
    assert len(calls) == 1
    assert (":streamGenerateContent" in calls[0][0]) is expected_stream
    getter.assert_awaited_once()
    forbidden.assert_not_awaited()


_REAL_STREAM = api.stream_request



@pytest.mark.parametrize("channel", ["antigravity", "geminicli"])
@pytest.mark.parametrize("catalog", [False, True])
async def test_snapshot_capture_only_reads_flash_for_antigravity(runtime, monkeypatch, channel, catalog):
    from src.model_routing import prepare_catalog_context, prepare_route_context
    getter = AsyncMock(return_value="native")
    monkeypatch.setattr(config, "get_antigravity_flash_non_stream_mode", getter)
    if catalog:
        _, _, snapshot = await prepare_catalog_context(channel)
    else:
        captured = await prepare_route_context(channel, "gemini", "synthetic", {"contents": []})
        snapshot = captured.feature_snapshot
    assert snapshot.antigravity_flash_non_stream_mode == ("native" if channel == "antigravity" else "inherit")
    assert getter.await_count == (1 if channel == "antigravity" else 0)


@pytest.mark.parametrize("mode", ["native", "stream_collect"])
async def test_retry_does_not_reread_flash_mode(monkeypatch, mode):
    calls = await wire_http(monkeypatch)
    getter = AsyncMock(side_effect=[mode, AssertionError("retry must retain selection")])
    monkeypatch.setattr(api, "get_antigravity_flash_non_stream_mode", getter)
    count = 0
    async def post(**kwargs):
        nonlocal count
        count += 1
        if count == 1:
            raise httpx.ConnectTimeout("synthetic")
        return httpx.Response(200, json=_payload())
    async def stream(**kwargs):
        nonlocal count
        count += 1
        if count == 1:
            raise httpx.ConnectTimeout("synthetic")
        yield _sse(_payload())
        yield b"data: [DONE]\n\n"
    monkeypatch.setattr(api, "post_async", post)
    monkeypatch.setattr(api, "stream_post_async", stream)
    result = await api.non_stream_request({"model": "gemini-3.8-flash", "request": {}}, record_logical=False)
    assert result.status_code == 200
    assert count == 2
    getter.assert_awaited_once()
