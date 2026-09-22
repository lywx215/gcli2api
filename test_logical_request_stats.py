import asyncio
import json
import sqlite3
import unittest
from unittest.mock import patch

import httpx
import pytest
from fastapi import Response

from src import httpx_client
from src.api import geminicli as geminicli_api
from src.logical_request_stats import (
    response_has_valid_body,
    stream_item_has_body,
    stream_item_is_error,
)
from src.panel import creds as credential_routes
from src.router import stream_passthrough
from src.storage._stats_common import normalize_logical_request_model_family
from src.storage.sqlite_manager import SQLiteManager


@pytest.mark.parametrize(
    ("model_name", "expected"),
    [
        ("gemini-3.6-flash-preview", "3.6-flash"),
        ("gemini-3.7-pro", "3.7-pro"),
        ("gemini-3.8-flash", "3.8-flash"),
        ("gemini-3.1-pro-preview", "3.1-pro"),
        ("gemini-3.1-flash-image-preview", "3.1-flash-image"),
        ("gemini-3.1-flash-lite-preview", "3.1-flash-lite-preview"),
        ("claude-sonnet-4-6", "claude-sonnet-4-6"),
        ("claude-opus-4-6-thinking", "claude-opus-4-6"),
        ("gpt-oss-120b", "gpt-oss-120b"),
        ("gemini-pro-agent", "3.1-pro"),
        ("gemini-3-flash-preview", "3-flash"),
        ("custom/model@@id", "modelid"),
    ],
)
def test_logical_request_model_family_is_specific_and_safe(model_name, expected):
    assert normalize_logical_request_model_family(model_name) == expected


@pytest.mark.asyncio
async def test_sqlite_logical_requests_use_dedicated_tables_and_metadata(tmp_path, monkeypatch):
    monkeypatch.setenv("CREDENTIALS_DIR", str(tmp_path))
    manager = SQLiteManager()
    await manager.initialize()
    try:
        # Legacy attempt history must not leak into logical-request endpoints.
        manager._bump_stats_buffer("gemini-3.1-pro", "geminicli", True)
        await manager.record_logical_request("gemini-3.1-pro-preview", "geminicli", True)
        await manager.record_logical_request("gemini-3.1-pro-preview", "geminicli", False)
        await manager.record_logical_request("", "geminicli", True)

        today = await manager.get_today_stats("geminicli")
        assert today["success_count"] == 1
        assert today["failure_count"] == 1
        assert today["metric"] == "logical_requests"
        assert today["since"].endswith("Z")
        assert "upstream-attempt" in today["description"]

        by_model = await manager.get_today_stats_by_model("geminicli")
        assert by_model["by_family"]["3.1-pro"] == {
            "success": 1, "failure": 1, "total": 2, "rpm": 2,
        }

        await manager._flush_stats_to_db()
        connection = sqlite3.connect(manager._db_path)
        try:
            assert connection.execute("SELECT COUNT(*) FROM daily_stats").fetchone()[0] == 1
            assert connection.execute("SELECT success_count, failure_count FROM request_daily_stats").fetchone() == (1, 1)
            assert connection.execute("SELECT value FROM request_stats_metadata WHERE key = 'logical_requests_enabled_at'").fetchone()
        finally:
            connection.close()
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_logical_stats_reject_blank_model_without_creating_bucket(tmp_path, monkeypatch):
    monkeypatch.setenv("CREDENTIALS_DIR", str(tmp_path))
    manager = SQLiteManager()
    await manager.initialize()
    try:
        await manager.record_logical_request(None, "geminicli", True)
        await manager._flush_stats_to_db()
        assert (await manager.get_today_stats_by_model("geminicli"))["by_family"] == {}
    finally:
        await manager.close()
async def _consume(response):
    async for _ in response.body_iterator:
        pass


class LogicalRequestStreamTests(unittest.TestCase):
    def test_metadata_frames_and_done_do_not_count_as_body(self):
        self.assertFalse(stream_item_has_body(b"data: [DONE]\n\n"))
        self.assertFalse(stream_item_has_body(b"data: {\"candidates\": []}\n\n"))
        self.assertFalse(stream_item_has_body(b"event: ping\n\n"))
        self.assertTrue(
            stream_item_has_body(
                b'event: content_block_delta\ndata: {"delta":{"text":"answer"}}\n\n'
            )
        )

    def test_stream_records_one_success_after_real_body(self):
        async def source():
            yield b'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n'
            yield b'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n'
            yield b"data: [DONE]\n\n"

        recorded = []

        async def record(model, mode, success):
            recorded.append((model, mode, success))

        async def build_and_consume():
            response = await (
                stream_passthrough.build_streaming_response_or_error(
                    source(), model_name="gemini-3.1-pro", mode="geminicli"
                )
            )
            await _consume(response)

        with patch.object(stream_passthrough, "record_logical_request", record):
            asyncio.run(build_and_consume())

        self.assertEqual(recorded, [("gemini-3.1-pro", "geminicli", True)])

    def test_terminal_error_after_body_records_one_failure(self):
        async def source():
            yield b'data: {"delta":{"text":"partial"}}\n\n'
            yield b'data: {"error":{"message":"upstream failed"}}\n\n'

        recorded = []

        async def record(*args):
            recorded.append(args)

        async def build_and_consume():
            response = await (
                stream_passthrough.build_streaming_response_or_error(
                    source(), model_name="gemini-3-flash", mode="antigravity"
                )
            )
            await _consume(response)

        with patch.object(stream_passthrough, "record_logical_request", record):
            asyncio.run(build_and_consume())

        self.assertEqual(recorded, [("gemini-3-flash", "antigravity", False)])

    def test_stream_exception_records_one_failure(self):
        async def source():
            yield b'data: {"delta":{"text":"partial"}}\n\n'
            raise RuntimeError("transport dropped")

        recorded = []

        async def record(*args):
            recorded.append(args)

        async def build_and_consume():
            response = await (
                stream_passthrough.build_streaming_response_or_error(
                    source(), model_name="gemini-2.5-pro", mode="geminicli"
                )
            )
            await _consume(response)

        with patch.object(stream_passthrough, "record_logical_request", record):
            with self.assertRaisesRegex(RuntimeError, "transport dropped"):
                asyncio.run(build_and_consume())

        self.assertEqual(recorded, [("gemini-2.5-pro", "geminicli", False)])

    def test_cancelled_stream_without_final_result_is_not_counted(self):
        async def source():
            yield b'data: {"delta":{"text":"partial"}}\n\n'
            yield b'data: {"delta":{"text":"later"}}\n\n'

        recorded = []

        async def record(*args):
            recorded.append(args)

        async def start_then_cancel():
            response = await stream_passthrough.build_streaming_response_or_error(
                source(), model_name="gemini-2.5-flash", mode="antigravity"
            )
            await response.body_iterator.__anext__()
            await response.body_iterator.aclose()

        with patch.object(stream_passthrough, "record_logical_request", record):
            asyncio.run(start_then_cancel())

        self.assertEqual(recorded, [])

    def test_prefetched_error_records_one_failure(self):
        async def source():
            yield Response(status_code=503)

        recorded = []

        async def record(*args):
            recorded.append(args)

        with patch.object(stream_passthrough, "record_logical_request", record):
            response = asyncio.run(
                stream_passthrough.build_streaming_response_or_error(
                    source(), model_name="gemini-2.0-flash", mode="geminicli"
                )
            )

        self.assertEqual(response.status_code, 503)
        self.assertEqual(recorded, [("gemini-2.0-flash", "geminicli", False)])

    def test_nonstream_requires_a_real_generated_body(self):
        self.assertFalse(response_has_valid_body(Response(content=b"{}", status_code=200)))
        self.assertFalse(response_has_valid_body(Response(content=b'{"error": {}}', status_code=200)))
        retired = (
            "Gemini 3.5 Flash is no longer available. "
            "Please switch to Gemini 3.7 Flash in the latest version of Antigravity."
        )
        retired_frame = json.dumps(
            {"response": {"candidates": [{"content": {"parts": [{"text": retired}]}}]}}
        ).encode()
        self.assertFalse(response_has_valid_body(Response(content=retired_frame, status_code=200)))
        retired_stream = b"data: " + retired_frame + b"\n\n"
        self.assertFalse(stream_item_has_body(retired_stream))
        self.assertTrue(stream_item_is_error(retired_stream))
        self.assertTrue(
            response_has_valid_body(
                Response(
                    content=b'{"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}}',
                    status_code=200,
                )
            )
        )

    def test_nonstream_retry_success_and_final_failure_each_record_once(self):
        records = []

        async def record(*args):
            records.append(args)

        async def retry_then_success(*_args, **_kwargs):
            # The implementation has already consumed failed upstream attempts
            # before exposing this final successful response to the wrapper.
            return Response(
                content=b'{"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}}',
                status_code=200,
            )

        async def final_failure(*_args, **_kwargs):
            return Response(content=b'{"error":{"message":"exhausted"}}', status_code=503)

        with patch("src.logical_request_stats.record_logical_request", record):
            with patch.object(geminicli_api, "_non_stream_request", retry_then_success):
                asyncio.run(geminicli_api.non_stream_request({"model": "gemini-2.5-pro"}))
            with patch.object(geminicli_api, "_non_stream_request", final_failure):
                asyncio.run(geminicli_api.non_stream_request({"model": "gemini-2.5-pro"}))

        self.assertEqual(
            records,
            [
                ("gemini-2.5-pro", "geminicli", True),
                ("gemini-2.5-pro", "geminicli", False),
            ],
        )

    def test_anti_truncation_continuations_are_one_logical_request(self):
        async def anti_truncation_output():
            # The first completion plus two continuation chunks are still one
            # client request, not three separate upstream attempts.
            yield b'data: {"delta":{"text":"first"}}\n\n'
            yield b'data: {"delta":{"text":"continued"}}\n\n'
            yield b'data: {"delta":{"text":"finished"}}\n\n'
            yield b"data: [DONE]\n\n"

        recorded = []

        async def record(*args):
            recorded.append(args)

        async def build_and_consume():
            response = await stream_passthrough.build_streaming_response_or_error(
                anti_truncation_output(), model_name="gemini-3.1-pro", mode="antigravity"
            )
            await _consume(response)

        with patch.object(stream_passthrough, "record_logical_request", record):
            asyncio.run(build_and_consume())

        self.assertEqual(recorded, [("gemini-3.1-pro", "antigravity", True)])

    def test_strict_panel_probe_treats_http_200_retired_reply_as_failure(self):
        class Credentials:
            async def refresh_if_needed(self):
                return False

        class Backend:
            def __init__(self):
                self.failures = []

            async def record_failure(self, *args, **kwargs):
                self.failures.append((args, kwargs))

        class Storage:
            def __init__(self):
                self._backend = Backend()

            async def get_credential(self, filename, mode):
                return {
                    "access_token": "test-token",
                    "project_id": "test-project",
                }

        storage = Storage()
        recorded = []

        async def get_storage():
            return storage

        async def post(*_args, **_kwargs):
            return httpx.Response(
                200,
                json={
                    "response": {
                        "candidates": [
                            {"content": {"parts": [{"text": "retired model"}]}}
                        ]
                    }
                },
            )

        async def record(*args):
            recorded.append(args)

        with (
            patch.object(credential_routes, "get_storage_adapter", get_storage),
            patch.object(credential_routes.Credentials, "from_dict", return_value=Credentials()),
            patch.object(credential_routes, "get_antigravity_api_url", return_value="https://example.test"),
            patch.object(httpx_client, "post_async", post),
            patch.object(credential_routes, "record_logical_request", record),
        ):
            response = asyncio.run(
                credential_routes.test_credential_common(
                    "fixture.json", mode="antigravity", model="gemini-3.1-pro"
                )
            )

        self.assertEqual(response.status_code, 424)
        self.assertEqual(recorded, [("gemini-3.1-pro", "antigravity", False)])
        self.assertEqual(len(storage._backend.failures), 1)
