"""DIAG-01 regression cases; all prompts, tool data and errors are synthetic."""

import copy
import json
import os
from pathlib import Path
import subprocess
import sys
from unittest.mock import AsyncMock

import pytest
from fastapi.responses import JSONResponse

import config
from src.converter.antigravity_fix import normalize_antigravity_request


NO_PREFILL_MODELS = [
    "claude-opus-4-6-thinking",
    "claude-sonnet-4-6",
    "gemini-3.6-flash",
    "gemini-3.7-flash",
    "gemini-3.8-flash",
]


def message(role, text):
    return {"role": role, "parts": [{"text": text}]}


@pytest.fixture(autouse=True)
def isolated_config(monkeypatch):
    monkeypatch.setattr(config, "get_return_thoughts_to_frontend", AsyncMock(return_value=True))


async def normalize(contents, model="gemini-3.7-flash"):
    return await normalize_antigravity_request({"model": model, "contents": copy.deepcopy(contents)})


@pytest.mark.parametrize("model", NO_PREFILL_MODELS)
async def test_normal_multiturn_preserves_user_and_model_history(model):
    contents = [message("user", "question"), message("model", "answer"), message("user", "next")]
    result = await normalize(contents, model)
    assert [item["role"] for item in result["contents"]] == ["user", "model", "user"]
    assert result["contents"][0] == contents[0]
    assert result["contents"][1]["parts"][-1] == {"text": "answer"}
    assert result["contents"][2] == contents[2]


@pytest.mark.parametrize("model", NO_PREFILL_MODELS)
@pytest.mark.parametrize("tail", [[], [message("user", "")], [message("user", " \t\r\n")]])
async def test_no_prefill_applies_after_empty_user_cleanup(model, tail):
    first = message("user", "question")
    result = await normalize([first, message("model", "answer"), *tail], model)
    assert result["contents"] == [first]


@pytest.mark.parametrize("model", NO_PREFILL_MODELS)
async def test_consecutive_empty_messages_cannot_hide_trailing_models(model):
    first = message("user", "question")
    result = await normalize([
        first, message("model", "answer"), message("user", ""),
        message("model", "second answer"), {"role": "user", "parts": []},
        message("model", ""), message("user", " \t"),
    ], model)
    assert result["contents"] == [first]


@pytest.mark.parametrize("text", ["", " \t\r\n", "\u3000\u00a0", [], [" ", "\t"], [{"text": " \n"}], None, {}])
async def test_empty_text_is_removed_after_normalization(text):
    first = message("user", "keep")
    result = await normalize([first, message("user", text)])
    assert result["contents"] == [first]


@pytest.mark.parametrize("text, expected", [
    ("  keep \t\n", "  keep"),
    ([{"type": "text", "text": "hello"}, "world \n"], "hello world"),
    (42, "42"),
])
async def test_text_conversion_preserves_content_and_leading_space(text, expected):
    result = await normalize([message("user", text)])
    assert result["contents"] == [message("user", expected)]


async def test_mixed_parts_keep_valid_text_and_non_text_payloads():
    image = {"inlineData": {"mimeType": "image/png", "data": "synthetic-base64"}}
    response = {"functionResponse": {"name": "lookup", "response": {"value": "synthetic"}}}
    mixed = {"text": " \t", **response}
    result = await normalize([{"role": "user", "parts": [
        {}, {"thought": True, "text": " \n"}, None, {"text": "keep \n"}, image, mixed,
    ]}])
    assert result["contents"] == [{"role": "user", "parts": [
        {"text": "keep"}, image, {"text": "", **response},
    ]}]


@pytest.mark.parametrize("model", ["claude-sonnet-4-6", "gemini-3.7-flash"])
@pytest.mark.parametrize("snake_case", [False, True])
async def test_tool_call_and_response_survive_cleanup(model, snake_case):
    call_key, response_key = ("function_call", "function_response") if snake_case else ("functionCall", "functionResponse")
    call = {"name": "lookup", "args": {"query": "synthetic-tool-argument"}}
    response = {"name": "lookup", "response": {"result": "synthetic-tool-result"}}
    result = await normalize([
        message("user", "question"),
        {"role": "model", "parts": [{"text": " \n"}, {call_key: call}]},
        {"role": "user", "parts": [{"text": " \t"}, {response_key: response}]},
        message("user", ""),
    ], model)
    assert [item["role"] for item in result["contents"]] == ["user", "model", "user"]
    actual_call = result["contents"][1]["parts"][0][call_key]
    actual_response = result["contents"][2]["parts"][0][response_key]
    assert actual_call["args"] == call["args"]
    assert actual_response["response"] == response["response"]
    if "claude" in model and not snake_case:
        assert actual_call["id"] == actual_response["id"]
        assert actual_call["id"].startswith("toolu_")


@pytest.mark.parametrize("model", ["gemini-2.5-flash", "gemini-3.5-flash", "gemini-3.1-pro-preview", "gpt-oss-120b-medium", "claude-haiku"])
async def test_other_models_keep_trailing_model_after_empty_user_cleanup(model):
    result = await normalize([message("user", "question"), message("model", "answer"), message("user", " \n")], model)
    assert [item["role"] for item in result["contents"]] == ["user", "model"]
    assert result["contents"][-1]["parts"][-1] == {"text": "answer"}


@pytest.mark.parametrize("contents", [
    [], [message("user", " \t")], [message("model", "answer"), message("user", "")],
    [message("user", ""), message("model", " \n"), {"role": "user", "parts": []}],
])
@pytest.mark.parametrize("model", NO_PREFILL_MODELS)
async def test_all_removed_stays_empty_without_fabricated_prompt(contents, model):
    result = await normalize(contents, model)
    assert result["contents"] == []


@pytest.mark.parametrize("streaming", [False, True])
async def test_empty_cleanup_uses_existing_gemini_route_error_path(monkeypatch, streaming):
    from src.api import antigravity
    from src.models import GeminiRequest
    from src.router.antigravity import gemini
    from src.router import stream_passthrough

    upstream_error = JSONResponse(status_code=400, content={
        "error": {"code": 400, "status": "INVALID_ARGUMENT", "message": "synthetic empty contents"}
    })
    seen = []

    async def reject_empty(body, **kwargs):
        seen.append(body)
        assert body["request"]["contents"] == []
        return upstream_error

    async def reject_empty_stream(body, **kwargs):
        yield await reject_empty(body, **kwargs)

    monkeypatch.setattr(antigravity, "non_stream_request", reject_empty)
    monkeypatch.setattr(antigravity, "stream_request", reject_empty_stream)
    monkeypatch.setattr(stream_passthrough, "record_logical_request", AsyncMock())
    request = GeminiRequest(contents=[message("model", "answer"), message("user", " \n")])
    route = gemini.stream_generate_content if streaming else gemini.generate_content
    response = await route(request, model="gemini-3.7-flash", api_key="synthetic")
    assert response.status_code == 400
    assert response.body == upstream_error.body
    assert len(seen) == 1


def test_cleanup_warning_output_contains_only_structural_metadata(tmp_path):
    """Enable the real logger only in a child with an isolated log file and cwd."""
    marker = "DIAG01_SYNTHETIC_PRIVATE_VALUE"
    payload = {"model": "gemini-3.7-flash", "contents": [
        {"role": "user", "parts": [
            {"text": [{"text": marker}, marker]},
            {"text": {"private_argument": marker}},
            {marker: None},
            {"functionCall": {"name": marker, "args": {"query": marker}}},
        ]},
        {"role": marker, "parts": [{"text": " \n"}]},
        message("model", marker),
        message("user", ""),
    ]}
    log_path = tmp_path / "cleanup.log"
    env = os.environ.copy()
    env.update(ENABLE_LOG="1", LOG_LEVEL="warning", LOG_FILE=str(log_path),
               PYTHONPATH=str(Path(__file__).resolve().parent))
    script = """
import asyncio, json, sys
from unittest.mock import AsyncMock
import config
config.get_return_thoughts_to_frontend = AsyncMock(return_value=True)
from src.converter.antigravity_fix import normalize_antigravity_request
from log import log
asyncio.run(normalize_antigravity_request(json.load(sys.stdin)))
log.close()
"""
    completed = subprocess.run([sys.executable, "-c", script], input=json.dumps(payload),
                               text=True, encoding="utf-8", capture_output=True,
                               cwd=tmp_path, env={**env, "PYTHONIOENCODING": "utf-8"}, timeout=30)
    assert completed.returncode == 0, completed.stderr
    output = log_path.read_text(encoding="utf-8")
    assert marker not in output + completed.stdout + completed.stderr
    assert "private_argument" not in output
    assert "content_index=0, part_index=0, type=list, length=2" in output
    assert "content_index=0, part_index=1, type=dict" in output
    assert "content_index=0, part_index=2, field_count=1" in output
    assert "content_index=1, part_count=1" in output
    assert "移除了 1 条末尾 model 消息" in output
