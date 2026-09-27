"""Fusion regressions: deadline ownership must not weaken protected errors/stats."""
import asyncio
import json
from unittest.mock import AsyncMock

import pytest

from src import antigravity_limits as limits
from src.api import antigravity
from src.router import stream_passthrough as passthrough
from src.router.model_api_errors import (
    ErrorKind, ErrorOrigin, ModelApiErrorException, make_model_api_error,
    protect_streaming_response, render_error, render_error_event,
)

BODY = b'data: {"candidates":[{"content":{"parts":[{"text":"synthetic"}]}}]}\n\n'
MODEL = "gemini-3.7-flash-medium"
PROTOCOLS = ["openai", "claude", "gemini"]


@pytest.fixture
def policy(monkeypatch):
    setting = limits.GenerationLimits(first=.04, idle=.04, total=.06, headers=.02)
    monkeypatch.setattr(limits.GenerationLimits, "load", classmethod(lambda cls: setting))
    counter = AsyncMock()
    monkeypatch.setattr(passthrough, "record_logical_request", counter)
    return setting, counter


def error(kind):
    return make_model_api_error(origin=ErrorOrigin.UPSTREAM, kind=kind)


async def response(source, protocol, **kwargs):
    return await passthrough.build_streaming_response_or_error(
        source, model_name=MODEL, mode="antigravity",
        protected=True, protocol=protocol, **kwargs,
    )


@pytest.mark.parametrize("protocol", PROTOCOLS)
@pytest.mark.parametrize("non_stream", [False, True])
async def test_precommit_budget_has_fixed_protocol_error(policy, protocol, non_stream):
    closed = asyncio.Event()
    async def source():
        try:
            await asyncio.sleep(5)
            yield BODY
        finally:
            closed.set()
    result = await response(source(), protocol, non_stream=non_stream)
    expected = render_error(error(ErrorKind.TIMEOUT), protocol)
    assert result.status_code == 504
    assert result.body == expected.body
    assert closed.is_set()
    policy[1].assert_awaited_once_with(MODEL, "antigravity", False)


@pytest.mark.parametrize("protocol", PROTOCOLS)
async def test_postcommit_budget_has_single_fixed_terminal_event(policy, protocol):
    closed = asyncio.Event()
    async def source():
        try:
            yield BODY
            while True:
                await asyncio.sleep(.005)
                yield b": heartbeat\n\n"
        finally:
            closed.set()
    result = await response(source(), protocol)
    result = await protect_streaming_response(result, protocol)
    chunks = [chunk async for chunk in result.body_iterator]
    assert chunks[0] == BODY
    assert chunks[-1] == render_error_event(error(ErrorKind.TIMEOUT), protocol)
    assert b"".join(chunks).count(b'"error":') == 1
    assert b"".join(chunks).count(b"[DONE]") == (protocol == "openai")
    assert closed.is_set()
    policy[1].assert_awaited_once_with(MODEL, "antigravity", False)


@pytest.mark.parametrize("protocol", PROTOCOLS)
async def test_empty_protected_stream_is_502_not_204(policy, protocol):
    async def source():
        if False:
            yield BODY
    result = await response(source(), protocol)
    assert result.status_code == 502
    assert result.body == render_error(error(ErrorKind.BAD_FORMAT), protocol).body
    policy[1].assert_awaited_once_with(MODEL, "antigravity", False)


@pytest.mark.parametrize("protocol", PROTOCOLS)
async def test_metadata_does_not_extend_first_budget(policy, protocol):
    metadata = b'data: {"usageMetadata":{"totalTokenCount":1}}\n\n'
    async def source():
        while True:
            yield metadata
            await asyncio.sleep(.005)
    result = await response(source(), protocol)
    chunks = [chunk async for chunk in result.body_iterator]
    assert chunks[-1] == render_error_event(error(ErrorKind.TIMEOUT), protocol)
    policy[1].assert_awaited_once_with(MODEL, "antigravity", False)


async def test_statistics_do_not_treat_ordinary_text_as_retirement(policy):
    text = "An example is no longer available; please switch to another example."
    frame = ("data: " + json.dumps({"choices": [{"delta": {"content": text}}]}) + "\n\n").encode()
    async def source():
        yield frame
    result = await response(source(), "openai")
    assert [chunk async for chunk in result.body_iterator] == [frame]
    policy[1].assert_awaited_once_with(MODEL, "antigravity", True)


async def test_typed_failure_before_first_chunk_counted_once(policy):
    async def source():
        raise ModelApiErrorException(error(ErrorKind.BAD_FORMAT))
        yield BODY
    with pytest.raises(ModelApiErrorException):
        await response(source(), "gemini")
    policy[1].assert_awaited_once_with(MODEL, "antigravity", False)


@pytest.mark.parametrize("cancel_headers", [False, True])
async def test_protected_disconnect_closes_source_without_outcome(policy, cancel_headers):
    closed = asyncio.Event()
    async def source():
        try:
            yield BODY
            await asyncio.sleep(5)
        finally:
            closed.set()
    result = await response(source(), "openai")
    result = await protect_streaming_response(result, "openai")
    if cancel_headers:
        async def send(message):
            raise asyncio.CancelledError()
        with pytest.raises(asyncio.CancelledError):
            await result({"type": "http", "asgi": {"spec_version": "2.4"}}, AsyncMock(), send)
    else:
        assert await anext(result.body_iterator) == BODY
        task = asyncio.create_task(anext(result.body_iterator))
        await asyncio.sleep(.005)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    assert closed.is_set()
    policy[1].assert_not_awaited()


async def test_api_continuations_inherit_one_budget_and_event_mode(policy, monkeypatch):
    budgets = []
    async def upstream(body, native=False, headers=None, events=False):
        assert events is True
        budgets.append(limits.current_budget.get())
        if len(budgets) > 1:
            await asyncio.sleep(5)
        yield b'data: {"usageMetadata":{"totalTokenCount":1}}\n\n'
    monkeypatch.setattr(antigravity, "_stream_request", upstream)
    async def continuation():
        for _ in range(3):
            async for chunk in antigravity.stream_request({"model": MODEL}, events=True):
                yield chunk
    result = await response(continuation(), "openai")
    chunks = [chunk async for chunk in result.body_iterator]
    assert len(budgets) == 2
    assert budgets[0] is budgets[1]
    assert chunks[-1] == render_error_event(error(ErrorKind.TIMEOUT), "openai")
    policy[1].assert_awaited_once_with(MODEL, "antigravity", False)


async def test_collector_preserves_protected_flag_and_total_budget(policy, monkeypatch):
    seen = []
    async def collect(body, headers=None, protected=False):
        seen.append((protected, limits.current_budget.get().non_stream))
        await asyncio.sleep(5)
    monkeypatch.setattr(antigravity, "_non_stream_request", collect)
    result = await antigravity.non_stream_request(
        {"model": MODEL}, protected=True, record_logical=False,
    )
    assert seen == [(True, True)]
    assert result.status_code == 504


@pytest.mark.parametrize("protocol", PROTOCOLS)
async def test_fake_stream_total_cap_survives_continuous_progress(policy, protocol):
    async def source():
        while True:
            yield BODY
            await asyncio.sleep(.005)
    result = await response(source(), protocol, non_stream=True)
    chunks = [chunk async for chunk in result.body_iterator]
    assert chunks[0] == BODY
    assert chunks[-1] == render_error_event(error(ErrorKind.TIMEOUT), protocol)
    policy[1].assert_awaited_once_with(MODEL, "antigravity", False)


@pytest.mark.parametrize("protocol", PROTOCOLS)
async def test_private_typed_failure_after_body_keeps_504_and_one_count(policy, protocol):
    async def source():
        yield BODY
        raise ModelApiErrorException(error(ErrorKind.TIMEOUT))
    result = await response(source(), protocol)
    result = await protect_streaming_response(result, protocol)
    chunks = [chunk async for chunk in result.body_iterator]
    assert chunks == [BODY, render_error_event(error(ErrorKind.TIMEOUT), protocol)]
    policy[1].assert_awaited_once_with(MODEL, "antigravity", False)
