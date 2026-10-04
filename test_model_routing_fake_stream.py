from copy import deepcopy

import pytest

from src.converter.fake_stream import build_gemini_fake_stream_chunks
from src.router.model_api_errors import ModelApiErrorException


@pytest.mark.parametrize('wrapped', [False, True])
def test_full_native_answer_is_emitted_once_without_reconstruction(wrapped):
    payload = {
        'candidates': [
            {'index': 7, 'content': {'parts': [
                {'text': 'answer', 'thoughtSignature': 'synthetic'},
                {'thoughtSignature': 'signature-only'},
                {'functionCall': {'name': 'lookup', 'args': {'model': 'tool-model'}}},
            ]}, 'finishReason': 'STOP', 'groundingMetadata': {'groundingChunks': [], 'flag': False}},
            {'index': 2, 'content': {'parts': [{'inlineData': {'mimeType': 'image/png', 'data': 'synthetic'}}]}, 'finishReason': 'STOP'},
        ],
        'usageMetadata': {'candidatesTokenCount': 0}, 'modelVersion': 'synthetic-target',
    }
    original = deepcopy(payload)
    result = build_gemini_fake_stream_chunks('would duplicate', 'would lose signature', 'STOP', full_response={'response': payload} if wrapped else payload)
    assert result == [original]
    result[0]['candidates'][0]['content']['parts'].clear()
    assert payload == original


@pytest.mark.parametrize('payload,status', [({'error': {'code': 429, 'message': 'synthetic-target'}}, 429), ({'response': {'error': {'code': 404}}}, 404), ({'response': []}, 502)])
def test_full_response_opt_in_keeps_typed_errors(payload, status):
    with pytest.raises(ModelApiErrorException) as error:
        build_gemini_fake_stream_chunks('', '', 'STOP', full_response=payload)
    assert error.value.error.status == status


def test_default_chunking_remains_unchanged():
    result = build_gemini_fake_stream_chunks('x' * 101, '', 'STOP')
    assert len(result) == 3
    assert ''.join(x['candidates'][0]['content']['parts'][0]['text'] for x in result) == 'x' * 101
