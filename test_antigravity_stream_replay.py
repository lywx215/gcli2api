import pytest

from src.api import antigravity


class _CredentialManager:
    async def get_valid_credential(self, **kwargs):
        return (
            "synthetic.json",
            {"access_token": "synthetic-access", "project_id": "synthetic-project"},
        )


async def _configure_stream(monkeypatch, stream_factory):
    async def fake_endpoint():
        return "https://antigravity.invalid"

    async def fake_wrap(request, model_name, project_id, enable_credit):
        return {"project": project_id, "request": request}, model_name

    async def fake_retry_config():
        return {
            "max_retries": 1,
            "retry_interval": 0,
            "retry_enabled": True,
            "smart_429": False,
        }

    async def fake_disable_codes():
        return []

    async def no_op(*args, **kwargs):
        return None

    monkeypatch.setattr(antigravity, "credential_manager", _CredentialManager())
    monkeypatch.setattr(antigravity, "get_antigravity_api_url", fake_endpoint)
    monkeypatch.setattr(antigravity, "wrap_cli_request", fake_wrap)
    monkeypatch.setattr(antigravity, "get_retry_config", fake_retry_config)
    monkeypatch.setattr(antigravity, "get_auto_ban_error_codes", fake_disable_codes)
    monkeypatch.setattr(antigravity, "record_api_call_success", no_op)
    monkeypatch.setattr(antigravity, "record_api_call_error", no_op)
    monkeypatch.setattr(antigravity, "is_smart_429_protection_enabled", lambda: False)
    monkeypatch.setattr(antigravity, "stream_post_async", stream_factory)


async def test_stream_exception_before_body_is_retried(monkeypatch):
    calls = 0

    async def fake_stream(**kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("synthetic pre-body failure")
        yield "data: synthetic-body"

    await _configure_stream(monkeypatch, fake_stream)

    chunks = [
        chunk
        async for chunk in antigravity.stream_request(
            {"model": "gemini-3.7-flash", "request": {}}
        )
    ]

    assert chunks == ["data: synthetic-body"]
    assert calls == 2


async def test_stream_exception_after_body_is_not_replayed(monkeypatch):
    calls = 0

    async def fake_stream(**kwargs):
        nonlocal calls
        calls += 1
        yield "data: synthetic-body"
        raise RuntimeError("synthetic post-body failure")

    await _configure_stream(monkeypatch, fake_stream)
    stream = antigravity.stream_request(
        {"model": "gemini-3.7-flash", "request": {}}
    )

    assert await anext(stream) == "data: synthetic-body"
    with pytest.raises(RuntimeError, match="post-body"):
        await anext(stream)
    assert calls == 1


async def test_empty_heartbeat_and_done_chunks_do_not_block_retry(monkeypatch):
    calls = 0

    async def fake_stream(**kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            yield ""
            yield ": heartbeat"
            yield "data: [DONE]"
            raise RuntimeError("synthetic metadata-only failure")
        yield "data: synthetic-body"

    await _configure_stream(monkeypatch, fake_stream)

    chunks = [
        chunk
        async for chunk in antigravity.stream_request(
            {"model": "gemini-3.7-flash", "request": {}}
        )
    ]

    assert chunks == ["", ": heartbeat", "data: [DONE]", "data: synthetic-body"]
    assert calls == 2


async def test_closing_downstream_stream_closes_upstream_generator(monkeypatch):
    upstream_closed = False

    async def fake_stream(**kwargs):
        nonlocal upstream_closed
        try:
            yield "data: synthetic-body"
            yield "data: second-body"
        finally:
            upstream_closed = True

    await _configure_stream(monkeypatch, fake_stream)
    stream = antigravity.stream_request(
        {"model": "gemini-3.7-flash", "request": {}}
    )

    assert await anext(stream) == "data: synthetic-body"
    await stream.aclose()
    assert upstream_closed is True
