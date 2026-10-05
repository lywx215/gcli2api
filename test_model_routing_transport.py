"""Offline transport boundaries: actual helpers, synthetic upstream attempts."""
import json
from unittest.mock import AsyncMock

import pytest
from fastapi import Response

from src import httpx_client
from src.model_routing.stream_runtime import CandidateIdentityState, dispatch_request_body
from src.model_routing.types import (
    FeatureSnapshot, ModelRouteContext, RequestProjection, ResolutionOutcome,
)
from src.router.model_api_errors import ModelApiErrorException, ModelApiProtocol


def context(channel="antigravity", **feature_values):
    return ModelRouteContext(channel, ModelApiProtocol.GEMINI, "public-alpha-high",
        RequestProjection(ModelApiProtocol.GEMINI), FeatureSnapshot(**feature_values),
        ResolutionOutcome("public-alpha-high", "synthetic-target", "public-alpha", explicit_target=True), "config", "policy")


async def chunks(*values):
    for value in values:
        yield value


@pytest.mark.parametrize("step", [1, 2, 3, 7, 64, 1000])
async def test_utf8_multiline_multi_event_arbitrary_bytes(step):
    raw = ': beat\r\nevent: message\r\ndata: {"text":\r\ndata: "你好\u2028中文"}\r\n\r\ndata: [DONE]\r\n\r\n'.encode()
    result = [x async for x in httpx_client.normalize_sse_events(chunks(*(raw[i:i + step] for i in range(0, len(raw), step))))]
    assert json.loads(result[0][6:]) == {"text": "你好\u2028中文"}
    assert result[-1] == b"data: [DONE]\n\n"


@pytest.mark.parametrize("raw", [b'data: {"text":', b'data: {"text":"\xe4\xbd', b'data: {"text":"\xff"}\n\n'])
async def test_truncated_frame_is_typed_and_closed(raw):
    closed = []
    async def source():
        try:
            yield raw
        finally:
            closed.append(True)
    with pytest.raises(ModelApiErrorException) as error:
        _ = [x async for x in httpx_client.normalize_sse_events(source())]
    assert error.value.error.status == 502
    assert closed == [True]


@pytest.mark.parametrize("raw", [b'data: "' + b'x' * 130, b': ' + b'x' * 130 + b'\n', b'data: {}\n' * 20])
async def test_event_and_unfinished_buffer_limit(monkeypatch, raw):
    assert httpx_client.MAX_SSE_EVENT_BYTES == 32 * 1024 * 1024
    monkeypatch.setattr(httpx_client, "MAX_SSE_EVENT_BYTES", 128)
    with pytest.raises(ModelApiErrorException):
        _ = [x async for x in httpx_client.normalize_sse_events(chunks(raw))]


async def test_total_stream_larger_than_event_limit_is_allowed(monkeypatch):
    monkeypatch.setattr(httpx_client, "MAX_SSE_EVENT_BYTES", 32)
    result = [x async for x in httpx_client.normalize_sse_events(chunks(b'data: {}\n\n' * 100))]
    assert len(result) == 100


async def test_actual_32_mib_event_boundary_and_independent_retirement_limit():
    from src.router.model_retirement import MAX_BUFFERED_EVENT_BYTES
    limit = httpx_client.MAX_SSE_EVENT_BYTES
    assert MAX_BUFFERED_EVENT_BYTES == 16 * 1024 * 1024
    prefix, suffix = b'data: {"text":"', b'"}\n\n'
    body = b'x' * (limit - len(prefix) - len(suffix))
    result = [x async for x in httpx_client.normalize_sse_events(chunks(prefix, body, suffix))]
    assert len(result) == 1 and len(json.loads(result[0][6:])["text"]) == len(body)
    with pytest.raises(ModelApiErrorException):
        _ = [x async for x in httpx_client.normalize_sse_events(chunks(prefix, body, b'x', suffix))]


def test_context_pins_dispatch_and_does_not_mutate_request():
    body = {"model": "synthetic-target", "request": {"contents": []}}
    pinned = dispatch_request_body(body, context())
    assert pinned["model"] == "synthetic-target"
    pinned["request"]["contents"].append("mutated")
    assert body == {"model": "synthetic-target", "request": {"contents": []}}
    assert dispatch_request_body(body, None) is body


def test_explicit_dispatch_mismatch_is_local_503():
    with pytest.raises(ModelApiErrorException) as error:
        dispatch_request_body({"model": "wrong-normalized-target"}, context())
    assert error.value.error.origin.value == 'local' and error.value.error.status == 503


def test_legacy_prediction_never_overwrites_actual_normalizer_or_rejects():
    from dataclasses import replace
    legacy = replace(context(), resolution=ResolutionOutcome('public', 'predicted', 'public', accepted=False))
    assert dispatch_request_body({'model': 'actual-legacy'}, legacy)['model'] == 'actual-legacy'


def test_missing_index_unique_identity_and_mixed_history():
    state = CandidateIdentityState()
    assert state.normalize({"candidates": [{"index": 7}]})["candidates"][0]["index"] == 7
    assert state.normalize({"candidates": [{}]})["candidates"][0]["index"] == 7
    state.normalize({"candidates": [{"index": 4}]})
    with pytest.raises(ModelApiErrorException):
        state.normalize({"candidates": [{"index": 4}, {}]})
    with pytest.raises(ModelApiErrorException):
        state.normalize({"candidates": [{}]})


@pytest.mark.parametrize("candidates", [[{}, {}], [{"index": True}], [{"index": -1}], [{"index": 1}, {"index": 1}], [{"index": 1}, {}]])
def test_candidate_identity_rejects_ambiguous_or_invalid(candidates):
    with pytest.raises(ModelApiErrorException):
        CandidateIdentityState().normalize({"candidates": candidates})


async def test_cli_http_error_after_delivered_data_never_retries(monkeypatch):
    from src.api import geminicli as api
    monkeypatch.setattr(api, "credential_manager", type("Credentials", (), {
        "get_valid_credential": AsyncMock(return_value=("synthetic.json", {"token": "synthetic", "project_id": "synthetic"}))})())
    monkeypatch.setattr(api, "prepare_request_headers_and_payload", AsyncMock(return_value=({}, {}, "https://synthetic.invalid")))
    monkeypatch.setattr(api, "get_code_assist_endpoint", AsyncMock(return_value="https://synthetic.invalid"))
    monkeypatch.setattr(api, "get_retry_config", AsyncMock(return_value={"max_retries": 2, "retry_interval": 0, "retry_enabled": True}))
    monkeypatch.setattr(api, "get_auto_ban_error_codes", AsyncMock(return_value=[]))
    monkeypatch.setattr(api, "record_api_call_success", AsyncMock())
    retry = AsyncMock(return_value=True)
    monkeypatch.setattr(api, "handle_error_with_retry", retry)
    monkeypatch.setattr(api, "is_smart_429_protection_enabled", lambda: False)
    calls = []
    async def stream(**kwargs):
        calls.append(kwargs)
        yield b'data: {"candidates":[{"content":{"parts":[{"text":"body"}]}}]}\n\n'
        yield Response(status_code=429)
    monkeypatch.setattr(api, "stream_post_async", stream)
    result = [x async for x in api.stream_request({"model": "synthetic-target"}, events=True, route_context=context("geminicli"))]
    assert len(calls) == 1 and len(result) == 2 and result[-1].status_code == 429
    retry.assert_not_awaited()
    assert api.credential_manager.get_valid_credential.await_args.kwargs["model_name"] == "synthetic-target"


@pytest.mark.parametrize('stream2nostream', [False, True])
async def test_ag_feature_snapshot_does_not_reread_runtime_toggle(monkeypatch, stream2nostream):
    from src.api import antigravity as api
    getter = AsyncMock(side_effect=AssertionError('must use captured feature snapshot'))
    monkeypatch.setattr(api, 'get_antigravity_stream2nostream', getter)
    calls = []
    async def stream(**kwargs):
        calls.append(kwargs)
        yield b'data: {"candidates":[{"index":7,"content":{"parts":[{"text":"body"}]},"finishReason":"STOP"}]}\n\n'
        yield b'data: [DONE]\n\n'
    monkeypatch.setattr(api, 'stream_request', stream)
    monkeypatch.setattr(api, '_capacity_breaker_response', lambda model: Response(status_code=503))
    captured = context(antigravity_stream2nostream=stream2nostream)
    response = await api.non_stream_request({'model': 'synthetic-target'}, record_logical=False, protected=True, route_context=captured)
    getter.assert_not_awaited()
    if stream2nostream:
        assert response.status_code == 200 and calls[0]['route_context'] is captured and calls[0]['events'] is True
    else:
        assert response.status_code == 503 and calls == []


@pytest.mark.parametrize('separators', ['\u0085', '\u2028', '\u2029', '\u0085\u2028\u2029'])
@pytest.mark.parametrize('chunk_size', [1, 65536])
async def test_unicode_separators_survive_actual_retirement_and_completion(monkeypatch, separators, chunk_size):
    from src.antigravity_completion import Completion, separate_terminal, finalize_terminal_usage
    from src.antigravity_limits import meaningful_frame
    from src.logical_request_stats import stream_item_has_body, stream_item_is_error
    from src.router import stream_passthrough
    from src.router.stream_passthrough import _protected_item_state

    payload = {'candidates': [{'index': 7, 'content': {'parts': [
        {'text': '你好' + separators + '中文', 'thoughtSignature': 'synthetic' + separators}]},
        'finishReason': 'STOP'}]}
    raw = ('data: ' + json.dumps(payload, ensure_ascii=False) + '\n\n').encode('utf-8')
    assert _protected_item_state(raw) == (True, False)
    assert httpx_client._normalized_event_payload(raw) == payload
    raw_completion = Completion()
    raw_completion.event(raw)
    raw_completion.finish()
    early, late = separate_terminal(raw)
    frames = finalize_terminal_usage([early, late], {'totalTokenCount': 1})
    assert meaningful_frame(early) and stream_item_has_body(early)
    assert not stream_item_is_error(early)
    assert stream_item_is_error(('data: ' + json.dumps({'error': {'message': separators}},
                                                               ensure_ascii=False) + '\n\n').encode())
    outcomes = []
    async def record(*args):
        outcomes.append(args)
    monkeypatch.setattr(stream_passthrough, 'record_logical_request', record)
    response = await stream_passthrough.build_streaming_response_or_error(
        chunks(*frames), model_name='synthetic-target', mode='antigravity', protected=False)
    assert [event async for event in response.body_iterator] == frames
    assert outcomes == [('synthetic-target', 'antigravity', True)]
    source = chunks(*(raw[i:i + chunk_size] for i in range(0, len(raw), chunk_size)))
    result = [event async for event in httpx_client._retirement_checked_events(
        httpx_client.normalize_sse_events(source))]
    assert len(result) == 1
    assert json.loads(result[0][6:]) == payload
    rewritten = CandidateIdentityState().event(result[0])
    completion = Completion()
    completion.event(rewritten)
    completion.finish()
    assert json.loads(rewritten[6:]) == payload


@pytest.mark.parametrize('separator', ['\u0085', '\u2028', '\u2029', '\u0085\u2028\u2029'])
async def test_gemini_unwrap_preserves_unicode_progress_and_public_output(monkeypatch, separator):
    from dataclasses import replace
    from src.antigravity_limits import GenerationBudget
    from src.api import antigravity as api
    from src.converter import antigravity_fix
    from src.models import GeminiRequest
    from src.router.antigravity import gemini
    from src.router import stream_passthrough

    captured = context()
    captured = replace(captured, resolution=replace(captured.resolution, features={
        'fake_streaming': False, 'anti_truncation': False, 'normalization_model': 'synthetic-target'}))
    monkeypatch.setattr(gemini, 'prepare_route_context', AsyncMock(return_value=captured))
    async def normalize(body, **kwargs):
        return dict(body)
    monkeypatch.setattr(antigravity_fix, 'normalize_antigravity_request', normalize)
    payload = {'candidates': [{'index': 7, 'content': {'parts': [{
        'text': '正文' + separator, 'thoughtSignature': 'synthetic' + separator}]}, 'finishReason': 'STOP'}]}
    async def upstream(**kwargs):
        yield ('data: ' + json.dumps({'response': payload}, ensure_ascii=True) + '\n\n').encode()
        yield b'data: [DONE]\n\n'
    monkeypatch.setattr(api, 'stream_request', upstream)
    outcomes, progress = [], []
    async def record(*args):
        outcomes.append(args)
    monkeypatch.setattr(stream_passthrough, 'record_logical_request', record)
    original_observe = GenerationBudget.observe
    def observe(self, item):
        original_observe(self, item)
        if b'candidates' in item:
            progress.append(self.progress is not None)
    monkeypatch.setattr(GenerationBudget, 'observe', observe)
    response = await gemini.stream_generate_content(
        GeminiRequest(contents=[{'role': 'user', 'parts': [{'text': 'synthetic prompt'}]}]),
        model=captured.requested_model)
    body = b''.join([event async for event in response.body_iterator])
    decoded = [json.loads(line[6:]) for line in body.decode().split('\n') if line.startswith('data: {')]
    assert decoded[0]['candidates'] == payload['candidates']
    assert progress == [True]
    assert outcomes == [('synthetic-target', 'antigravity', True)]
    assert not any(char.encode() in body for char in '\u0085\u2028\u2029')
