import json

import pytest

from src.httpx_client import _retirement_checked_events, normalize_sse_events
from src.router.model_api_errors import ErrorKind, ModelApiErrorException
from src.router.stream_passthrough import build_streaming_response_or_error


async def chunks(values):
    for value in values:
        yield value


async def collect(values):
    return [item async for item in normalize_sse_events(chunks(values))]


@pytest.mark.asyncio
async def test_sse_normalizes_crlf_no_space_multidata_and_controls():
    result = await collect(
        [
            b": heartbeat\r\n",
            b"event: message\r\n",
            b"id: 1\r\n",
            b"data:{\"text\":\"hel",
            "lo".encode("utf-8"),
            b"\"}\r\n\r\n",
        ]
    )
    assert result == [b'data: {"text":"hello"}\n\n']


@pytest.mark.asyncio
async def test_sse_supports_utf8_split_and_eof_flush():
    raw = 'data: {"text":"你好"}'
    encoded = raw.encode("utf-8")
    result = await collect([encoded[:9], encoded[9:12], encoded[12:]])
    assert json.loads(result[0].splitlines()[0][6:]) == {"text": "你好"}


@pytest.mark.asyncio
async def test_sse_done_is_normalized_and_control_only_events_are_ignored():
    result = await collect([b"event: ping\nid: 2\n\n", b"data: [DONE]\n\n"])
    assert result == [b"data: [DONE]\n\n"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "payload",
    [b"data: []\n\n", b"data: \"text\"\n\n", b"data: {bad}\n\n"],
)
async def test_sse_rejects_non_object_or_invalid_json(payload):
    with pytest.raises(ModelApiErrorException) as caught:
        await collect([payload])
    assert caught.value.error.kind == ErrorKind.BAD_FORMAT
    assert caught.value.error.status == 502


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "payload,expected_status",
    [
        (b'data: {"error":{}}\n\n', 502),
        (b'data: {"error":"sentinel"}\n\n', 502),
        (b'data: {"error":{"code":true}}\n\n', 502),
        (b'data: {"error":{"code":429}}\n\n', 429),
    ],
)
async def test_sse_error_is_typed_and_never_forwarded(payload, expected_status):
    with pytest.raises(ModelApiErrorException) as caught:
        await collect([payload])
    assert caught.value.error.status == expected_status
    assert "sentinel" not in str(caught.value)


@pytest.mark.asyncio
async def test_sse_event_error_has_error_priority_and_does_not_become_success():
    with pytest.raises(ModelApiErrorException) as caught:
        await collect([b'event: error\ndata: {"error":{"code":403}}\n\n'])
    assert caught.value.error.status == 403


@pytest.mark.asyncio
async def test_sse_response_wrapper_error_is_not_forwarded():
    with pytest.raises(ModelApiErrorException) as caught:
        await collect([b'data: {"response":{"error":{"code":404}}}\n\n'])
    assert caught.value.error.status == 404


async def collect_checked(values):
    normalized = normalize_sse_events(chunks(values))
    return [item async for item in _retirement_checked_events(normalized)]


@pytest.mark.asyncio
async def test_event_mode_retirement_notice_is_typed_and_not_forwarded():
    notice = "Gemini gemini-2.5-pro/preview is no longer available."
    with pytest.raises(ModelApiErrorException) as caught:
        await collect_checked(
            [
                (
                    'data: {"candidates":[{"content":{"parts":[{"text":%s}]}}]}\n\n'
                    % json.dumps(notice)
                ).encode(),
                b"data: [DONE]\n\n",
            ]
        )
    assert caught.value.error.status == 404
    assert notice not in str(caught.value)


@pytest.mark.asyncio
async def test_event_mode_flushes_ordinary_buffer_before_done():
    result = await collect_checked(
        [
            b'data: {"candidates":[{"content":{"parts":[{"text":"Gemini old"}]}}]}\n\n',
            b"data: [DONE]\n\n",
        ]
    )
    assert len(result) == 2
    assert result[-1] == b"data: [DONE]\n\n"


@pytest.mark.asyncio
async def test_protected_empty_stream_is_fixed_502_before_headers():
    async def empty():
        if False:
            yield b""

    response = await build_streaming_response_or_error(
        empty(), model_name="gemini-test", mode="geminicli", protected=True, protocol="openai"
    )
    assert response.status_code == 502
    assert b"gemini-test" not in response.body


@pytest.mark.asyncio
async def test_protected_usage_only_event_is_not_reclassified_as_empty():
    async def usage_only():
        yield b'data: {"usageMetadata":{"totalTokenCount":1}}\n\n'
        yield b"data: [DONE]\n\n"

    response = await build_streaming_response_or_error(
        usage_only(), model_name="gemini-test", mode="geminicli", protected=True, protocol="gemini"
    )
    body = [item async for item in response.body_iterator]
    assert body[-1] == b"data: [DONE]\n\n"
    assert all(b"INVALID_SERVICE_RESPONSE" not in item for item in body if isinstance(item, bytes))


async def test_retirement_buffer_flushes_at_eof_without_done():
    payload = {'candidates': [{'content': {'parts': [{'text': 'Gemini old'}]}}]}
    result = await collect_checked([('data: ' + json.dumps(payload)).encode()])
    assert len(result) == 1
    assert json.loads(result[0].splitlines()[0][6:]) == payload


@pytest.mark.parametrize('payload,status', [
    ({'error': {'code': 429}, 'response': {'candidates': []}}, 429),
    ({'response': {'response': {'error': {'code': 404}}}}, 404),
    ({'response': []}, 502),
])
async def test_nested_error_precedence(payload, status):
    with pytest.raises(ModelApiErrorException) as caught:
        await collect_checked([('data: ' + json.dumps(payload) + '\n\n').encode()])
    assert caught.value.error.status == status


async def test_event_error_done_is_not_success():
    with pytest.raises(ModelApiErrorException) as caught:
        await collect([b'event: error\ndata: [DONE]\n\n'])
    assert caught.value.error.status == 502


async def test_usage_tail_survives_recognizer_finish_reason_flush():
    frames = [
        {'response': {'candidates': [{'content': {'parts': [{'text': '   '}]}, 'finishReason': 'STOP'}]}},
        {'response': {'usageMetadata': {'candidatesTokenCount': 87}}},
    ]
    values = [('data: ' + json.dumps(x) + '\n\n').encode() for x in frames]
    result = await collect_checked(values + [b'data: [DONE]\n\n'])
    assert len(result) == 3
    assert json.loads(result[1].splitlines()[0][6:]) == frames[1]
