import asyncio
from copy import deepcopy
import json

import pytest
from fastapi import Response

from src.api.utils import collect_streaming_response
from src.router.model_api_errors import get_attached_model_api_error


async def stream(*payloads, wrapped=False, byte_step=None):
    raw = b''.join(('data: ' + json.dumps({'response': p} if wrapped else p, ensure_ascii=False) + '\n\n').encode() for p in payloads)
    raw += b'data: [DONE]\n\n'
    for i in range(0, len(raw), byte_step or len(raw)):
        yield raw[i:i + (byte_step or len(raw))]


@pytest.mark.parametrize('wrapped', [False, True])
@pytest.mark.parametrize('byte_step', [None, 1, 7])
async def test_multicandidate_parts_grounding_usage_and_false_values(wrapped, byte_step):
    parts = [
        {'text': '你好', 'thoughtSignature': 'synthetic-signature', 'extra': False},
        {'thoughtSignature': 'synthetic-signature-only'},
        {'functionCall': {'name': 'lookup', 'args': {'model': 'tool-model'}}, 'extra': 0},
        {'inlineData': {'mimeType': 'image/png', 'data': 'synthetic-image'}},
        {'text': '', 'thought': False},
    ]
    first_grounding = {'groundingChunks': [{'web': {'uri': 'https://example.com/early'}}]}
    last_grounding = {
        'webSearchQueries': ['synthetic query'],
        'groundingChunks': [{'web': {'uri': 'https://example.com/final'}}],
        'groundingSupports': [{'segment': {'partIndex': 0, 'startIndex': 0, 'endIndex': 2, 'text': '你好'}, 'groundingChunkIndices': [0]}],
    }
    frames = [
        {'candidates': [
            {'index': 7, 'content': {'role': 'model', 'parts': parts}, 'groundingMetadata': first_grounding, 'avgLogprobs': 0},
            {'index': 3, 'content': {'role': 'model', 'parts': [{'text': 'other'}]}, 'flag': False},
        ]},
        {'candidates': [
            {'index': 3, 'content': {'parts': [{'text': ' tail'}]}, 'finishReason': 'STOP'},
            {'index': 7, 'finishReason': 'STOP', 'groundingMetadata': last_grounding, 'safetyRatings': []},
        ]},
        {'candidates': [{'index': 7, 'groundingMetadata': {}}], 'usageMetadata': {'promptTokenCount': 0, 'cached': False}, 'responseId': '', 'flag': False},
        {'usageMetadata': {'candidatesTokenCount': 0}, 'createTime': 0},
    ]
    originals = deepcopy(frames)
    response = await collect_streaming_response(stream(*frames, wrapped=wrapped, byte_step=byte_step), protected=True)
    assert response.status_code == 200
    body = json.loads(response.body)
    a, b = body['candidates']
    assert [a['index'], b['index']] == [7, 3]
    assert a['content']['parts'] == parts
    assert a['groundingMetadata'] == last_grounding
    support = a['groundingMetadata']['groundingSupports'][0]
    assert a['content']['parts'][support['segment']['partIndex']]['text'] == support['segment']['text']
    assert a['groundingMetadata']['groundingChunks'][support['groundingChunkIndices'][0]]['web']['uri'].endswith('/final')
    assert a['avgLogprobs'] == 0 and b['flag'] is False
    assert b['content']['parts'] == [{'text': 'other'}, {'text': ' tail'}]
    assert body['usageMetadata'] == {'promptTokenCount': 0, 'cached': False, 'candidatesTokenCount': 0}
    assert body['responseId'] == '' and body['createTime'] == 0 and body['flag'] is False
    assert frames == originals


@pytest.mark.parametrize('first,tail', [
    ([{}, {}], []),
    ([{'index': 1}, {'index': 2}], [{'index': 1}, {}]),
    ([{'index': 1}, {'index': 2}], [{}]),
    ([{'index': True}], []),
    ([{'index': -1}], []),
    ([{'index': '1'}], []),
    ([{'index': 1}, {'index': 1}], []),
])
async def test_ambiguous_candidate_identity_is_safe_502(first, tail):
    def body(candidates):
        return {'candidates': [dict(candidate, content={'parts': [{'text': 'body'}]}, finishReason='STOP') for candidate in candidates]}
    response = await collect_streaming_response(stream(body(first), body(tail)), protected=True)
    assert response.status_code == 502 and get_attached_model_api_error(response).status == 502


@pytest.mark.parametrize('first_index', [None, 0, 7])
async def test_sole_candidate_default_index_keeps_stable_identity(first_index):
    first = {'content': {'parts': [{'text': 'body'}]}}
    if first_index is not None:
        first['index'] = first_index
    response = await collect_streaming_response(stream({'candidates': [first]}, {'candidates': [{'finishReason': 'STOP'}]}), protected=True)
    assert response.status_code == 200
    assert json.loads(response.body)['candidates'][0]['index'] == (first_index or 0)


async def test_metadata_tail_is_consumed_and_usage_not_fabricated():
    response = await collect_streaming_response(stream(
        {'candidates': [{'content': {'parts': [{'text': 'body'}]}, 'finishReason': 'STOP'}]},
        {'modelVersion': 'synthetic', 'responseId': 'tail'},
    ), protected=True)
    assert response.status_code == 200
    assert 'usageMetadata' not in json.loads(response.body)
    assert json.loads(response.body)['responseId'] == 'tail'


async def test_grounding_scope_across_unindexed_part_deltas_fails_safely():
    response = await collect_streaming_response(stream(
        {'candidates': [{'content': {'parts': [{'text': 'first'}]}}]},
        {'candidates': [{'content': {'parts': [{'text': 'second'}]}, 'finishReason': 'STOP'}]},
        {'candidates': [{'groundingMetadata': {'groundingSupports': [{'segment': {'partIndex': 0, 'startIndex': 0, 'endIndex': 11, 'text': 'firstsecond'}, 'groundingChunkIndices': [0]}], 'groundingChunks': [{'web': {'uri': 'https://example.com'}}]}}]},
    ), protected=True)
    assert response.status_code == 502 and get_attached_model_api_error(response).status == 502


@pytest.mark.parametrize('exit_kind', ['done', 'response', 'error', 'cancel'])
async def test_collector_closes_upstream_on_every_exit(exit_kind):
    closed = []
    response_error = Response(status_code=429)
    async def source():
        try:
            if exit_kind == 'cancel':
                raise asyncio.CancelledError()
            if exit_kind == 'response':
                yield response_error
            else:
                yield b'data: {"candidates":[{"content":{"parts":[{"text":"body"}]},"finishReason":"STOP"}]}\n\n'
                yield b'data: {"error":{"code":429,"message":"synthetic-target"}}\n\n' if exit_kind == 'error' else b'data: [DONE]\n\n'
                raise AssertionError('must not consume after terminal')
        finally:
            closed.append(True)
    if exit_kind == 'cancel':
        with pytest.raises(asyncio.CancelledError):
            await collect_streaming_response(source(), protected=True)
    else:
        response = await collect_streaming_response(source(), protected=True)
        if exit_kind == 'response':
            assert response is response_error
        if exit_kind == 'error':
            assert response.status_code == 429 and b'synthetic-target' not in response.body
    assert closed == [True]
