import asyncio
import json

import httpx
import pytest
from fastapi import Response

from src.antigravity_completion import Completion, validate_json
from src.api import antigravity
from src.router.model_api_errors import ModelApiErrorException


def candidate(parts=None, finish="STOP", index=0):
    result = {"index": index, "content": {"parts": parts if parts is not None else [{"text": "synthetic answer"}]}}
    if finish:
        result["finishReason"] = finish
    return {"candidates": [result]}


def event(payload):
    return "data: " + json.dumps(payload) + "\n\n"


@pytest.mark.parametrize("parts", [[{"text": "answer"}], [{"functionCall": {"name": "tool", "args": {"x": 1}}}], [{"inlineData": {"mimeType": "image/png", "data": "synthetic"}}], [{"fileData": {"fileUri": "https://example.invalid/media"}}]])
@pytest.mark.parametrize("finish", ["STOP", "MAX_TOKENS"])
def test_complete_text_tools_media(parts, finish):
    payload = candidate(parts, finish)
    assert validate_json(json.dumps(payload)) == payload


@pytest.mark.parametrize("payload", [candidate(finish=None), candidate([]), candidate([{"text": "thinking", "thought": True}]), {"usageMetadata": {"totalTokenCount": 10}}, {}, candidate(finish="UNKNOWN"), candidate([{"functionCall": {"name": "f", "args": "half-json"}}])])
def test_incomplete_is_not_success(payload):
    with pytest.raises(ModelApiErrorException):
        validate_json(json.dumps(payload))


def test_all_raw_candidates_and_terminal_then_error():
    completion = Completion()
    completion.json(json.dumps(candidate()))
    second = candidate(finish=None, index=1)
    completion.json(json.dumps(second))
    with pytest.raises(ModelApiErrorException):
        completion.finish()
    with pytest.raises(ModelApiErrorException):
        completion.json(json.dumps({"error": {"code": 503, "message": "synthetic"}}))
    assert validate_json(json.dumps({"promptFeedback": {"blockReason": "SAFETY"}}))


@pytest.fixture
async def client(monkeypatch):
    successes, failures, calls = [], [], []
    class Manager:
        async def get_valid_credential(self, **kwargs):
            return "synthetic.json", {"access_token": "synthetic", "project_id": "synthetic", "_quota_generation": "one"}
        async def quota_admit(self, *args):
            return {"generation": "one", "revision": 0, "group": "gemini-shared", "purpose": "business"}
    async def endpoint(): return "https://example.invalid"
    async def retry(): return {"max_retries": 3, "retry_interval": 0, "retry_enabled": True}
    async def disabled(): return []
    async def wrap(request, *args): return {"request": request}, "synthetic"
    async def success(*args, **kwargs): successes.append(kwargs)
    async def failure(*args, **kwargs): failures.append(kwargs)
    async def no_collection(): return False
    monkeypatch.setattr(antigravity, "credential_manager", Manager())
    monkeypatch.setattr(antigravity, "get_antigravity_api_url", endpoint)
    monkeypatch.setattr(antigravity, "get_retry_config", retry)
    monkeypatch.setattr(antigravity, "get_auto_ban_error_codes", disabled)
    monkeypatch.setattr(antigravity, "wrap_cli_request", wrap)
    monkeypatch.setattr(antigravity, "record_api_call_success", success)
    monkeypatch.setattr(antigravity, "record_api_call_error", failure)
    monkeypatch.setattr(antigravity, "get_antigravity_stream2nostream", no_collection)
    monkeypatch.setattr(antigravity, "is_smart_429_protection_enabled", lambda: False)
    return successes, failures, calls


@pytest.mark.parametrize("frames", [[], ["data: [DONE]\n\n"], [event(candidate(finish=None))], [event(candidate([{"text": "thinking", "thought": True}]))], [event({"usageMetadata": {"totalTokenCount": 2}})], ["data: {\n\n"]])
async def test_invalid_stream_never_replays(monkeypatch, client, frames):
    successes, failures, calls = client
    async def upstream(**kwargs):
        calls.append(kwargs)
        for frame in frames:
            yield frame
    monkeypatch.setattr(antigravity, "stream_post_async", upstream)
    with pytest.raises(ModelApiErrorException):
        _ = [chunk async for chunk in antigravity.stream_request({"model": "gemini-test", "request": {}})]
    assert len(calls) == 1
    assert not successes and len(failures) == 1


async def test_terminal_is_withheld_until_tail_error_checked(monkeypatch, client):
    successes, failures, calls = client
    async def upstream(**kwargs):
        calls.append(kwargs)
        yield event(candidate(finish=None))
        yield event({"candidates": [{"finishReason": "STOP"}]})
        yield event({"error": {"code": 503, "message": "synthetic"}})
    monkeypatch.setattr(antigravity, "stream_post_async", upstream)
    seen = []
    with pytest.raises(ModelApiErrorException):
        async for chunk in antigravity.stream_request({"model": "gemini-test", "request": {}}):
            seen.append(chunk)
    assert len(calls) == len(seen) == 1
    assert "finishReason" not in seen[0]
    assert not successes


@pytest.mark.parametrize("ending", ["eof", "done"])
async def test_success_once_after_terminal_and_usage(monkeypatch, client, ending):
    successes, failures, calls = client
    async def upstream(**kwargs):
        calls.append(kwargs)
        yield event(candidate(finish=None))
        assert not successes
        yield event({"candidates": [{"finishReason": "STOP"}]})
        assert not successes
        yield event({"usageMetadata": {"totalTokenCount": 123}})
        if ending == "done":
            yield "data: [DONE]\n\n"
    monkeypatch.setattr(antigravity, "stream_post_async", upstream)
    result = [chunk async for chunk in antigravity.stream_request({"model": "gemini-test", "request": {}})]
    assert len(successes) == 1 and not failures
    assert "123" in "".join(result)


async def test_consumer_abandon_and_cancel_do_not_record_success(monkeypatch, client):
    successes, failures, calls = client
    async def upstream(**kwargs):
        yield event(candidate(finish=None))
        await asyncio.Event().wait()
    monkeypatch.setattr(antigravity, "stream_post_async", upstream)
    stream = antigravity.stream_request({"model": "gemini-test", "request": {}})
    await anext(stream)
    await stream.aclose()
    assert not successes
    stream = antigravity.stream_request({"model": "gemini-test", "request": {}})
    await anext(stream)
    pending = asyncio.create_task(anext(stream))
    await asyncio.sleep(0)
    pending.cancel()
    with pytest.raises(asyncio.CancelledError):
        await pending
    assert not successes


@pytest.mark.parametrize("raw", [b"", b"{", json.dumps(candidate(finish=None)).encode(), json.dumps(candidate([{"text": "only thought", "thought": True}])).encode()])
async def test_nonstream_invalid_200_never_replays(monkeypatch, client, raw):
    successes, failures, calls = client
    async def upstream(**kwargs):
        calls.append(kwargs)
        return httpx.Response(200, content=raw)
    monkeypatch.setattr(antigravity, "post_async", upstream)
    result = await antigravity.non_stream_request({"model": "gemini-test", "request": {}}, record_logical=False, protected=True)
    assert result.status_code == 502
    assert len(calls) == 1 and not successes


async def test_final_admission_prevents_prefetched_dispatch(monkeypatch, client):
    successes, failures, calls = client
    async def denied(*args): return None
    async def upstream(**kwargs):
        calls.append(kwargs)
        yield event(candidate())
    monkeypatch.setattr(antigravity.credential_manager, "quota_admit", denied)
    monkeypatch.setattr(antigravity, "stream_post_async", upstream)
    result = [item async for item in antigravity.stream_request({"model": "gemini-test", "request": {}})]
    assert isinstance(result[0], Response) and result[0].status_code == 500
    assert not calls


@pytest.mark.parametrize("parts", [[{"functionCall": {"name": "tool", "args": {}}}], [{"fileData": {"fileUri": "https://example.invalid/media"}}]])
async def test_nonstream_logical_success_for_tools_and_media(monkeypatch, client, parts):
    import src.logical_request_stats as stats
    outcomes = []
    async def record(model, mode, success): outcomes.append(success)
    async def upstream(**kwargs): return httpx.Response(200, json=candidate(parts))
    monkeypatch.setattr(stats, "record_logical_request", record)
    monkeypatch.setattr(antigravity, "post_async", upstream)
    response = await antigravity.non_stream_request({"model": "gemini-test", "request": {}})
    assert response.status_code == 200 and outcomes == [True]


def test_invalid_tool_cannot_hide_behind_valid_text_and_finish():
    with pytest.raises(ModelApiErrorException):
        validate_json(json.dumps(candidate([{"text": "answer"}, {"functionCall": {"name": "tool", "args": "half-json"}}])))
