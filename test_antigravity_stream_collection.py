import json

import pytest

from src.api.utils import collect_streaming_response


def _grounding(label: str = "current") -> dict:
    answer = "Search result"
    return {
        "webSearchQueries": [f"{label} query"],
        "groundingChunks": [
            {
                "web": {
                    "title": f"{label} source 0",
                    "uri": f"https://example.com/{label}/0",
                }
            },
            {
                "web": {
                    "title": f"{label} source 1",
                    "uri": f"https://example.com/{label}/1",
                }
            },
        ],
        "groundingSupports": [
            {
                "segment": {"startIndex": 0, "endIndex": len(answer), "text": answer},
                "groundingChunkIndices": [0, 1],
            }
        ],
        "searchEntryPoint": {"renderedContent": f"<div>{label}</div>"},
    }


async def _sse_stream(*events, as_bytes: bool = False):
    for event in events:
        line = f"data: {json.dumps(event)}\n\n"
        yield line.encode("utf-8") if as_bytes else line
    done = "data: [DONE]\n\n"
    yield done.encode("utf-8") if as_bytes else done


def _response_json(response) -> dict:
    body = response.body.decode("utf-8") if isinstance(response.body, bytes) else response.body
    return json.loads(body)


@pytest.mark.asyncio
@pytest.mark.parametrize("wrapped", [False, True])
@pytest.mark.parametrize("candidates", [None, []])
async def test_candidate_free_terminal_metadata_is_preserved(wrapped, candidates):
    usage = {"promptTokenCount": 1000, "candidatesTokenCount": 87, "totalTokenCount": 1087}
    terminal = {"usageMetadata": usage, "modelVersion": "gemini-test", "responseId": "test-id"}
    if candidates is not None:
        terminal["candidates"] = candidates
    if wrapped:
        terminal = {"response": terminal}

    response = await collect_streaming_response(
        _sse_stream(
            {"candidates": [{"content": {"parts": [{"text": "short answer"}]}, "finishReason": "STOP"}]},
            terminal,
        )
    )

    payload = _response_json(response)
    assert response.status_code == 200
    assert payload["usageMetadata"] == usage
    assert payload["modelVersion"] == "gemini-test"
    assert payload["responseId"] == "test-id"
    assert payload["candidates"][0]["finishReason"] == "STOP"
    assert payload["candidates"][0]["content"]["parts"] == [{"text": "short answer"}]


@pytest.mark.asyncio
async def test_missing_usage_is_not_fabricated_as_zero():
    response = await collect_streaming_response(
        _sse_stream({"candidates": [{"content": {"parts": [{"text": "x" * 322}]}}]})
    )
    payload = _response_json(response)
    assert response.status_code == 200
    assert "usageMetadata" not in payload
    assert payload["candidates"][0]["finishReason"] is None
    assert payload["candidates"][0]["content"]["parts"][0]["text"] == "x" * 322


@pytest.mark.asyncio
async def test_prompt_block_without_candidates_is_preserved():
    feedback = {"blockReason": "SAFETY", "safetyRatings": [{"category": "test", "blocked": True}]}
    response = await collect_streaming_response(
        _sse_stream({"response": {"promptFeedback": feedback, "usageMetadata": {"promptTokenCount": 12}}})
    )
    payload = _response_json(response)
    assert response.status_code == 200
    assert payload["promptFeedback"] == feedback
    assert payload["usageMetadata"] == {"promptTokenCount": 12}


@pytest.mark.asyncio
@pytest.mark.parametrize("wrapped", [False, True])
@pytest.mark.parametrize("after_text", [False, True])
@pytest.mark.parametrize("code, expected_status", [(429, 429), (503, 503), (200, 502), (None, 502)])
async def test_error_frames_are_not_returned_as_success(wrapped, after_text, code, expected_status):
    error = {"code": code, "message": "synthetic upstream error"}
    terminal = {"error": error}
    if wrapped:
        terminal = {"response": terminal}
    events = []
    if after_text:
        events.append({"candidates": [{"content": {"parts": [{"text": "partial answer"}]}}]})
    events.append(terminal)

    response = await collect_streaming_response(_sse_stream(*events))
    assert response.status_code == expected_status
    assert _response_json(response) == {"error": error}


@pytest.mark.asyncio
async def test_sse_data_without_optional_space_is_collected():
    async def stream():
        yield b'data:{"candidates":[{"content":{"parts":[{"text":"answer"}]},"finishReason":"STOP"}]}\n'
        yield b'data:{"usageMetadata":{"candidatesTokenCount":87}}\n'
        yield b'data:[DONE]\n'

    response = await collect_streaming_response(stream())
    payload = _response_json(response)
    assert response.status_code == 200
    assert payload["usageMetadata"] == {"candidatesTokenCount": 87}
    assert payload["candidates"][0]["content"]["parts"] == [{"text": "answer"}]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "terminal, status, field",
    [
        ({"usageMetadata": {"candidatesTokenCount": 87}}, 200, "usageMetadata"),
        ({"promptFeedback": {"blockReason": "SAFETY"}}, 200, "promptFeedback"),
        ({"error": {"code": 503, "message": "synthetic error"}}, 503, "error"),
    ],
)
async def test_antigravity_non_stream_retains_terminal_outcome(monkeypatch, terminal, status, field):
    from src.api import antigravity as antigravity_api

    async def enabled():
        return True

    async def fake_stream_request(*args, **kwargs):
        async for item in _sse_stream(
            {"response": {"candidates": [{"content": {"parts": [{"text": "answer"}]}}]}},
            {"response": terminal},
        ):
            yield item

    monkeypatch.setattr(antigravity_api, "get_antigravity_stream2nostream", enabled)
    monkeypatch.setattr(antigravity_api, "stream_request", fake_stream_request)
    response = await antigravity_api.non_stream_request(
        body={"model": "gemini-test", "request": {"contents": []}}
    )
    assert response.status_code == status
    assert _response_json(response)[field] == terminal[field]


def _assert_support_indices_are_valid(grounding_metadata: dict) -> None:
    chunk_count = len(grounding_metadata["groundingChunks"])
    for support in grounding_metadata["groundingSupports"]:
        for index in support["groundingChunkIndices"]:
            assert 0 <= index < chunk_count


@pytest.mark.asyncio
async def test_collect_streaming_response_preserves_grounding_metadata():
    grounding = _grounding()
    response = await collect_streaming_response(
        _sse_stream(
            {
                "response": {
                    "candidates": [
                        {"content": {"role": "model", "parts": [{"text": "Search "}]}}
                    ]
                }
            },
            {
                "response": {
                    "candidates": [
                        {
                            "content": {"role": "model", "parts": [{"text": "result"}]},
                            "finishReason": "STOP",
                            "groundingMetadata": grounding,
                        }
                    ],
                    "usageMetadata": {"totalTokenCount": 12},
                }
            },
        )
    )

    payload = _response_json(response)
    candidate = payload["candidates"][0]

    assert response.status_code == 200
    assert candidate["content"]["parts"] == [{"text": "Search result"}]
    assert candidate["groundingMetadata"] == grounding
    assert payload["usageMetadata"]["totalTokenCount"] == 12
    _assert_support_indices_are_valid(candidate["groundingMetadata"])


@pytest.mark.asyncio
async def test_last_non_empty_grounding_snapshot_wins():
    first = _grounding("first")
    last = _grounding("last")

    response = await collect_streaming_response(
        _sse_stream(
            {"candidates": [{"groundingMetadata": first}]},
            {"candidates": [{"groundingMetadata": last}]},
            {"candidates": [{"groundingMetadata": {}}]},
        )
    )

    grounding = _response_json(response)["candidates"][0]["groundingMetadata"]
    assert grounding == last
    _assert_support_indices_are_valid(grounding)


@pytest.mark.asyncio
async def test_missing_grounding_does_not_materialize_empty_field():
    response = await collect_streaming_response(
        _sse_stream(
            {
                "candidates": [
                    {
                        "content": {"role": "model", "parts": [{"text": "No search"}]},
                        "finishReason": "STOP",
                    }
                ]
            }
        )
    )

    candidate = _response_json(response)["candidates"][0]
    assert "groundingMetadata" not in candidate


@pytest.mark.asyncio
async def test_grounding_is_collected_from_metadata_only_final_chunk():
    grounding = _grounding()
    response = await collect_streaming_response(
        _sse_stream(
            {"candidates": [{"content": {"role": "model", "parts": [{"text": "Result"}]}}]},
            {
                "candidates": [
                    {"content": {"role": "model", "parts": []}, "groundingMetadata": grounding}
                ]
            },
            as_bytes=True,
        )
    )

    candidate = _response_json(response)["candidates"][0]
    assert candidate["content"]["parts"] == [{"text": "Result"}]
    assert candidate["groundingMetadata"] == grounding


@pytest.mark.asyncio
async def test_grounding_preserves_existing_stream_collection_behavior():
    grounding = _grounding()
    citation = {"citations": [{"startIndex": 0, "endIndex": 6}]}
    function_call = {"functionCall": {"name": "lookup", "args": {"q": "news"}}}

    response = await collect_streaming_response(
        _sse_stream(
            {
                "response": {
                    "candidates": [
                        {
                            "content": {
                                "role": "model",
                                "parts": [
                                    {"text": "thinking", "thought": True},
                                    {"text": "Search result"},
                                    function_call,
                                ],
                            },
                            "finishReason": "STOP",
                            "safetyRatings": [{"category": "safe"}],
                            "citationMetadata": citation,
                            "groundingMetadata": grounding,
                        }
                    ],
                    "usageMetadata": {
                        "promptTokenCount": 3,
                        "candidatesTokenCount": 4,
                        "totalTokenCount": 7,
                    },
                }
            }
        )
    )

    payload = _response_json(response)
    candidate = payload["candidates"][0]

    assert candidate["content"]["parts"] == [
        {"text": "thinking", "thought": True},
        {"text": "Search result"},
        function_call,
    ]
    assert candidate["finishReason"] == "STOP"
    assert candidate["safetyRatings"] == [{"category": "safe"}]
    assert candidate["citationMetadata"] == citation
    assert candidate["groundingMetadata"] == grounding
    assert payload["usageMetadata"] == {
        "promptTokenCount": 3,
        "candidatesTokenCount": 4,
        "totalTokenCount": 7,
    }


@pytest.mark.asyncio
async def test_non_stream_request_returns_collected_grounding(monkeypatch):
    from src.api import antigravity as antigravity_api

    grounding = _grounding()

    async def stream_to_non_stream_enabled():
        return True

    async def fake_stream_request(*args, **kwargs):
        del args, kwargs
        async for item in _sse_stream(
            {
                "response": {
                    "candidates": [
                        {
                            "content": {
                                "role": "model",
                                "parts": [{"text": "Search result"}],
                            },
                            "groundingMetadata": grounding,
                        }
                    ]
                }
            }
        ):
            yield item

    monkeypatch.setattr(
        antigravity_api,
        "get_antigravity_stream2nostream",
        stream_to_non_stream_enabled,
    )
    monkeypatch.setattr(antigravity_api, "stream_request", fake_stream_request)

    response = await antigravity_api.non_stream_request(
        body={"model": "gemini-test", "request": {"contents": []}}
    )
    candidate = _response_json(response)["candidates"][0]

    assert candidate["groundingMetadata"] == grounding
