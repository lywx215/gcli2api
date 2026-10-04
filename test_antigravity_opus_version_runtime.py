"""Synthetic runtime tests for strict Opus versions; never call Google."""
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import Response

from src.api import antigravity as api
from src.antigravity_models import resolve_antigravity_opus_model
from src.converter.antigravity_fix import _normalize_antigravity_request
from src.httpx_client import _retirement_checked_events, normalize_sse_events
from src.router.model_api_errors import ModelApiErrorException

OPUS46 = "claude-opus-4-6-thinking"
OPUS55 = "claude-opus-5-5-high"
NOTICE = "Claude Opus 4.6 is no longer available. Please switch to Claude Opus 5.5."


def candidate(text="synthetic answer", finish="STOP"):
    result = {"content": {"parts": [{"text": text}]}}
    if finish:
        result["finishReason"] = finish
    return {"candidates": [result]}


def frame(value):
    return ("data: " + json.dumps(value) + "\n\n").encode()


@pytest.mark.parametrize("requested,expected", [
    ("claude-opus-4-6", OPUS46), ("claude-opus-4.6-thinking", OPUS46),
    ("claude-opus-5-5", "claude-opus-5-5-medium"), (OPUS55, OPUS55),
])
def test_alias_resolution_keeps_requested_version(requested, expected):
    assert resolve_antigravity_opus_model(requested) == expected


@pytest.mark.parametrize("model,budget", [(OPUS46, 1024), (OPUS55, None)])
def test_opus_versions_keep_distinct_thinking_parameters(model, budget):
    config = {"thinkingConfig": {"thinkingBudget": 2048, "thinkingLevel": "HIGH"}}
    result = {"contents": [{"role": "user", "parts": [{"text": "hi"}]}]}
    actual = _normalize_antigravity_request(result, model, config, True)
    assert actual == model
    thinking = config["thinkingConfig"]
    assert thinking.get("thinkingBudget") == budget
    assert "thinkingLevel" not in thinking
    assert thinking["includeThoughts"] is True


@pytest.fixture
def runtime(monkeypatch):
    selection, admissions, observations = [], [], []
    class Manager:
        async def get_valid_credential(self, **kwargs):
            selection.append(kwargs)
            name = "second.json" if kwargs.get("excluded_credentials") else "first.json"
            return name, {"access_token": name, "project_id": name,
                          "_quota_generation": name, "_quota_credential_version": "synthetic-v1"}
        async def quota_admit(self, filename, model, *args):
            admissions.append((filename, model))
            return {"generation": filename, "revision": 0, "group": "claude-gpt-shared", "purpose": "business"}
        async def model_access_generation_result(self, filename, admission, model, status):
            observations.append((filename, model, status))
    async def wrap(request, model, project, credit):
        return {"model": model, "project": project, "request": request}, "synthetic"
    monkeypatch.setattr(api, "credential_manager", Manager())
    monkeypatch.setattr(api, "get_antigravity_api_url", AsyncMock(return_value="https://synthetic.invalid"))
    monkeypatch.setattr(api, "get_retry_config", AsyncMock(return_value={"max_retries": 2, "retry_interval": 0, "retry_enabled": False}))
    monkeypatch.setattr(api, "get_auto_ban_error_codes", AsyncMock(return_value=[404]))
    monkeypatch.setattr(api, "get_antigravity_stream2nostream", AsyncMock(return_value=False))
    monkeypatch.setattr(api, "is_smart_429_protection_enabled", lambda: False)
    monkeypatch.setattr(api, "wrap_cli_request", wrap)
    success, failure = AsyncMock(), AsyncMock()
    monkeypatch.setattr(api, "record_api_call_success", success)
    monkeypatch.setattr(api, "record_api_call_error", failure)
    return SimpleNamespace(selection=selection, admissions=admissions, observations=observations, success=success, failure=failure)


@pytest.mark.parametrize("model", [OPUS46, OPUS55])
@pytest.mark.parametrize("stream", [False, True])
@pytest.mark.parametrize("failure_type", ["http404", "error200", "retirement"])
async def test_404_and_retirement_retry_another_credential_without_changing_version(monkeypatch, runtime, model, stream, failure_type):
    calls = []
    error = candidate(NOTICE) if failure_type == "retirement" else {"error": {"code": 404, "message": "synthetic"}}
    async def post(**kwargs):
        calls.append(kwargs["json"])
        return httpx.Response(404 if len(calls) == 1 and failure_type == "http404" else 200,
                              json=error if len(calls) == 1 else candidate())
    async def upstream(**kwargs):
        calls.append(dict(kwargs["body"]))
        if len(calls) == 1 and failure_type == "http404":
            yield Response(json.dumps(error), status_code=404)
            return
        async def raw():
            yield frame(error if len(calls) == 1 else candidate())
        async for event in _retirement_checked_events(normalize_sse_events(raw())):
            yield event
    monkeypatch.setattr(api, "post_async", post)
    monkeypatch.setattr(api, "stream_post_async", upstream)
    if stream:
        result = [chunk async for chunk in api.stream_request({"model": model, "request": {}})]
        assert "synthetic answer" in "".join(chunk.decode() if isinstance(chunk, bytes) else chunk for chunk in result)
    else:
        result = await api.non_stream_request({"model": model, "request": {}}, record_logical=False)
        assert result.status_code == 200
    assert len(calls) == 2
    assert {call["model"] for call in calls} == {model}
    assert {item["model_name"] for item in runtime.selection} == {model}
    assert runtime.admissions == [("first.json", model), ("second.json", model)]
    assert runtime.observations == [("first.json", model, 404)]
    assert runtime.success.await_count == runtime.failure.await_count == 1


@pytest.mark.parametrize("model", [OPUS46, OPUS55])
async def test_error_after_content_does_not_replay_or_switch_version(monkeypatch, runtime, model):
    calls = []
    async def upstream(**kwargs):
        calls.append(kwargs)
        async def raw():
            yield frame(candidate("partial answer", finish=None))
            yield frame({"error": {"message": NOTICE}})
        async for event in _retirement_checked_events(normalize_sse_events(raw())):
            yield event
    monkeypatch.setattr(api, "stream_post_async", upstream)
    seen = []
    with pytest.raises(ModelApiErrorException) as caught:
        async for chunk in api.stream_request({"model": model, "request": {}}):
            seen.append(chunk)
    assert caught.value.error.status == 404
    assert seen and len(calls) == len(runtime.selection) == 1
    assert NOTICE not in "".join(chunk.decode() if isinstance(chunk, bytes) else chunk for chunk in seen)
    assert NOTICE not in str(caught.value)
    assert runtime.success.await_count == 0


@pytest.mark.parametrize("model", [OPUS46, OPUS55])
@pytest.mark.parametrize("retired", [False, True])
async def test_manual_credential_test_preserves_explicit_version(monkeypatch, model, retired):
    from src.panel import antigravity_manual as manual, creds
    backend = SimpleNamespace(manual_record_result=AsyncMock(return_value={}),
                              model_access_observe=AsyncMock(return_value=True),
                              model_access_public=AsyncMock(return_value={}))
    prepare = AsyncMock(return_value=(SimpleNamespace(_backend=backend), {},
                                      {"access_token": "synthetic", "project_id": "synthetic"}))
    monkeypatch.setattr(manual, "prepare", prepare)
    monkeypatch.setattr(creds, "get_antigravity_api_url", AsyncMock(return_value="https://synthetic.invalid"))
    monkeypatch.setattr(creds, "check_should_auto_ban", AsyncMock(return_value=True))
    monkeypatch.setattr(creds, "record_logical_request", AsyncMock())
    text = NOTICE if retired else creds.ANTIGRAVITY_MODEL_TEST_EXPECTED_REPLY
    post = AsyncMock(return_value=httpx.Response(200, json=candidate(text)))
    monkeypatch.setattr("src.httpx_client.post_async", post)
    response = await manual.test("chosen-synthetic.json", model)
    assert response.status_code == (404 if retired else 200)
    prepare.assert_awaited_once()
    assert prepare.await_args.args[0] == "chosen-synthetic.json"
    assert post.await_count == 1
    assert post.await_args.kwargs["json"]["model"] == model
    assert backend.manual_record_result.await_args.args[0] == "chosen-synthetic.json"
    assert backend.manual_record_result.await_args.args[2] == model
    if retired:
        assert backend.manual_record_result.await_args.kwargs["auto_ban"] is False


@pytest.mark.parametrize("status", [400, 500])
@pytest.mark.parametrize("stream", [False, True])
@pytest.mark.parametrize("model", [OPUS46, OPUS55])
async def test_non200_retirement_envelope_retries_same_version(monkeypatch, runtime, status, stream, model):
    calls = []
    error = {"response": {"error": {"message": NOTICE}}}
    async def post(**kwargs):
        calls.append(dict(kwargs["json"]))
        return httpx.Response(status if len(calls) == 1 else 200,
                              json=error if len(calls) == 1 else candidate())
    async def upstream(**kwargs):
        calls.append(dict(kwargs["body"]))
        if len(calls) == 1:
            yield Response(json.dumps(error), status_code=status)
        else:
            yield frame(candidate())
    monkeypatch.setattr(api, "post_async", post)
    monkeypatch.setattr(api, "stream_post_async", upstream)
    if stream:
        result = [chunk async for chunk in api.stream_request({"model": model, "request": {}})]
        assert all(not isinstance(chunk, Response) for chunk in result)
    else:
        result = await api.non_stream_request({"model": model, "request": {}}, record_logical=False)
        assert result.status_code == 200
    assert len(calls) == 2
    assert {call["model"] for call in calls} == {model}
    assert runtime.observations == [("first.json", model, 404)]
    assert runtime.success.await_count == runtime.failure.await_count == 1


@pytest.mark.parametrize("status", [400, 500])
@pytest.mark.parametrize("stream", [False, True])
@pytest.mark.parametrize("quoted", [False, True])
async def test_non200_retirement_exhaustion_is_safe503_or_preserves_ordinary_error(monkeypatch, runtime, status, stream, quoted):
    from src.router import stream_passthrough
    from src.router.model_api_errors import error_from_response
    monkeypatch.setattr(api, "get_retry_config", AsyncMock(return_value={"max_retries": 0, "retry_interval": 0, "retry_enabled": False}))
    message = 'Example: "' + NOTICE + '"' if quoted else NOTICE
    error = {"error": {"code": status, "message": message}}
    post = AsyncMock(return_value=httpx.Response(status, json=error))
    async def upstream(**kwargs):
        yield Response(json.dumps(error), status_code=status)
    monkeypatch.setattr(api, "post_async", post)
    monkeypatch.setattr(api, "stream_post_async", upstream)
    logical = AsyncMock()
    monkeypatch.setattr("src.logical_request_stats.record_logical_request", logical)
    monkeypatch.setattr(stream_passthrough, "record_logical_request", logical)
    if stream:
        result = await stream_passthrough.build_streaming_response_or_error(
            api.stream_request({"model": OPUS46, "request": {}}),
            model_name=OPUS46, mode="antigravity", protected=True, protocol="gemini")
    else:
        result = await api.non_stream_request({"model": OPUS46, "request": {}}, protected=True)
    if quoted:
        assert error_from_response(result).status == status
        assert not runtime.observations
    else:
        assert result.status_code == 503
        assert NOTICE.encode() not in result.body
        assert runtime.observations == [("first.json", OPUS46, 404)]
    logical.assert_awaited_once_with(OPUS46, "antigravity", False)
    assert runtime.success.await_count == 0
    assert len(runtime.selection) == 1


@pytest.mark.parametrize("status", [400, 500])
@pytest.mark.parametrize("quoted", [False, True])
@pytest.mark.parametrize("origin", ["direct_manual", "manual"])
async def test_manual_non200_retirement_preserves_transport_status(monkeypatch, status, quoted, origin):
    from src.panel import antigravity_manual as manual, creds
    backend = SimpleNamespace(manual_record_result=AsyncMock(return_value={}),
                              model_access_observe=AsyncMock(return_value=True),
                              model_access_public=AsyncMock(return_value={}))
    monkeypatch.setattr(manual, "prepare", AsyncMock(return_value=(SimpleNamespace(_backend=backend), {},
                                      {"access_token": "synthetic", "project_id": "synthetic"})))
    monkeypatch.setattr(creds, "get_antigravity_api_url", AsyncMock(return_value="https://synthetic.invalid"))
    monkeypatch.setattr(creds, "check_should_auto_ban", AsyncMock(return_value=True))
    logical = AsyncMock()
    monkeypatch.setattr(creds, "record_logical_request", logical)
    message = 'Example: "' + NOTICE + '"' if quoted else NOTICE
    post = AsyncMock(return_value=httpx.Response(status, json={"error": {"message": message}}))
    monkeypatch.setattr("src.httpx_client.post_async", post)
    if origin == "direct_manual":
        response = await manual.test("chosen-synthetic.json", OPUS46)
    else:
        response = await creds.test_credential_common("chosen-synthetic.json", mode="antigravity", model=OPUS46, origin="manual")
    result = json.loads(response.body)
    assert response.status_code == (status if quoted else 404)
    assert result["upstream_status"] == status
    assert NOTICE.encode() not in response.body
    assert post.await_count == 1
    assert post.await_args.kwargs["json"]["model"] == OPUS46
    assert logical.await_count == 1 and logical.await_args.args[-1] is False
    if quoted:
        backend.model_access_observe.assert_not_called()
    else:
        assert backend.manual_record_result.await_args.kwargs["auto_ban"] is False
        assert backend.model_access_observe.await_count == 1
