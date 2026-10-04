from copy import deepcopy
from dataclasses import replace
import json

import pytest
from fastapi import Response
from fastapi.responses import StreamingResponse

from src.converter.anti_truncation import AntiTruncationStreamProcessor, apply_anti_truncation
from src.router.model_api_errors import ModelApiErrorException, attach_model_api_error, error_from_http_status
from test_model_routing_transport import context


def event(payload):
    return ('data: ' + json.dumps(payload) + '\n\n').encode()


@pytest.mark.parametrize('protocol,explicit,expected', [
    ('gemini', False, True), ('openai', False, True),
    ('claude', False, False), ('claude', True, True),
])
def test_route_snapshot_does_not_implicitly_change_claude_finish_boundary(protocol, explicit, expected):
    processor = AntiTruncationStreamProcessor(
        None, {'request': {}}, defer_intermediate_finish=explicit,
        route_context=replace(context(), protocol=protocol),
    )
    assert processor.defer_intermediate_finish is expected


def test_signed_request_parts_not_cleaned_or_mutated():
    payload = {'model': 'synthetic', 'request': {'contents': [{'role': 'model', 'parts': [
        {'text': '18岁的 [done]', 'thoughtSignature': 'synthetic'},
        {'text': '18岁的 ordinary'},
    ]}]}}
    original = deepcopy(payload)
    result = apply_anti_truncation(payload, route_context=context())
    assert payload == original
    assert result['request']['contents'][0]['parts'][0] == original['request']['contents'][0]['parts'][0]
    assert result['request']['contents'][0]['parts'][1]['text'] == ' ordinary'


async def test_unreferenced_single_candidate_continuation_remains_valid():
    calls, closed = [], []
    base = {'model': 'synthetic', 'request': {'contents': [{'role': 'user', 'parts': [{'text': 'prompt'}]}]}}
    original = deepcopy(base)
    async def request(payload):
        calls.append(deepcopy(payload))
        turn = len(calls)
        async def source():
            try:
                yield event({'candidates': [{'content': {'parts': [{'text': 'first' if turn == 1 else 'second [done]'}]}, 'finishReason': 'STOP'}]})
                yield b'data: [DONE]\n\n'
            finally:
                closed.append(turn)
        return StreamingResponse(source())
    processor = AntiTruncationStreamProcessor(request, base, route_context=context())
    result = [x async for x in processor.process_stream()]
    data = [json.loads(x[6:]) for x in result if x.startswith(b'data: {')]
    assert len(calls) == 2 and closed == [1, 2]
    assert data[0]['candidates'][0].get('finishReason') is None
    assert [p['text'] for obj in data for c in obj['candidates'] for p in c.get('content', {}).get('parts', [])] == ['first', 'second']
    assert calls[1]['request']['contents'][1]['parts'] == [{'text': 'first'}]
    assert base == original
    assert result.count(b'data: [DONE]\n\n') == 1


@pytest.mark.parametrize('sensitive', ['signature', 'grounding', 'citation', 'multi'])
async def test_unprovable_continuation_is_blocked_before_second_call(sensitive):
    candidate = {'content': {'parts': [{'text': 'first'}]}, 'finishReason': 'STOP'}
    if sensitive == 'signature':
        candidate['content']['parts'][0]['thoughtSignature'] = 'synthetic'
    if sensitive == 'grounding':
        candidate['groundingMetadata'] = {'groundingChunks': [{'web': {'uri': 'https://example.com'}}]}
    if sensitive == 'citation':
        candidate['citationMetadata'] = {'citations': [{'startIndex': 0, 'endIndex': 5}]}
    candidates = [dict(candidate, index=0)]
    if sensitive == 'multi':
        candidates.append(dict(candidate, index=1))
    calls, closed = [], []
    async def request(payload):
        calls.append(payload)
        async def source():
            try:
                yield event({'candidates': candidates})
                yield b'data: [DONE]\n\n'
            finally:
                closed.append(True)
        return StreamingResponse(source())
    processor = AntiTruncationStreamProcessor(request, {'request': {}}, route_context=context())
    with pytest.raises(ModelApiErrorException) as error:
        _ = [x async for x in processor.process_stream()]
    assert error.value.error.status == 502 and len(calls) == 1 and closed == [True]


async def test_signed_text_marker_preserved_exactly_on_complete_answer():
    part = {'text': 'answer [done] ', 'thoughtSignature': 'synthetic'}
    async def request(payload):
        async def source():
            yield event({'candidates': [{'content': {'parts': [part]}, 'finishReason': 'STOP'}]})
            yield b'data: [DONE]\n\n'
        return StreamingResponse(source())
    result = [x async for x in AntiTruncationStreamProcessor(request, {'request': {}}, route_context=context()).process_stream()]
    assert json.loads(result[0][6:])['candidates'][0]['content']['parts'] == [part]


async def test_body_then_exception_never_replays_and_retains_type():
    calls = []
    async def request(payload):
        calls.append(payload)
        async def source():
            yield event({'candidates': [{'content': {'parts': [{'text': 'first'}]}}]})
            yield attach_model_api_error(Response(status_code=429), error_from_http_status(429))
        return StreamingResponse(source())
    with pytest.raises(ModelApiErrorException) as error:
        _ = [x async for x in AntiTruncationStreamProcessor(request, {'request': {}}, route_context=context()).process_stream()]
    assert error.value.error.status == 429 and len(calls) == 1


async def test_early_signature_then_same_turn_done_is_preserved_without_retry():
    calls = []
    signed = {'thought': True, 'text': 'synthetic thought', 'thoughtSignature': 'synthetic'}
    async def request(payload):
        calls.append(payload)
        async def source():
            yield event({'candidates': [{'content': {'parts': [signed]}}]})
            yield event({'candidates': [{'content': {'parts': [{'text': 'answer [done]'}]}, 'finishReason': 'STOP'}]})
            yield b'data: [DONE]\n\n'
        return StreamingResponse(source())
    result = [x async for x in AntiTruncationStreamProcessor(request, {'request': {}}, route_context=context()).process_stream()]
    assert len(calls) == 1 and json.loads(result[0][6:])['candidates'][0]['content']['parts'] == [signed]
    assert result.count(b'data: [DONE]\n\n') == 1


@pytest.mark.parametrize('tail', ['grounding', 'signature'])
async def test_late_scoped_metadata_after_marker_cleaning_never_claims_success(tail):
    calls = []
    late = {'groundingMetadata': {'groundingSupports': [{'segment': {'text': 'answer [done]'}}]}} if tail == 'grounding' else {'content': {'parts': [{'thoughtSignature': 'synthetic'}]}}
    async def request(payload):
        calls.append(payload)
        async def source():
            yield event({'candidates': [{'content': {'parts': [{'text': 'answer [done]'}]}, 'finishReason': 'STOP'}]})
            yield event({'candidates': [late]})
            yield b'data: [DONE]\n\n'
        return StreamingResponse(source())
    outputs = []
    with pytest.raises(ModelApiErrorException):
        async for item in AntiTruncationStreamProcessor(request, {'request': {}}, route_context=context()).process_stream():
            outputs.append(item)
    assert len(calls) == 1 and b'data: [DONE]\n\n' not in outputs
    assert all('finishReason' not in json.loads(item[6:])['candidates'][0] for item in outputs)


async def test_usage_tail_attached_to_deferred_final_terminal_without_fabrication():
    usage = {'promptTokenCount': 0, 'candidatesTokenCount': 7}
    async def request(payload):
        async def source():
            yield event({'candidates': [{'content': {'parts': [{'text': 'answer [done]'}]}, 'finishReason': 'STOP'}]})
            yield event({'usageMetadata': usage})
            yield b'data: [DONE]\n\n'
        return StreamingResponse(source())
    outputs = [x async for x in AntiTruncationStreamProcessor(request, {'request': {}}, route_context=context()).process_stream()]
    terminal = json.loads(outputs[-2][6:])
    assert terminal['usageMetadata'] == usage and terminal['candidates'][0]['finishReason'] == 'STOP'
