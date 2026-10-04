import json

import pytest
from fastapi import Response
from fastapi.responses import StreamingResponse

from src.model_routing.public_response import adapt_public_response, rewrite_success_identity
from src.router.model_api_errors import (
    ErrorOrigin, ModelApiErrorException, attach_model_api_error, error_from_http_status,
    get_rendered_error_event, is_rendered_model_api_error, local_retry_response, parse_model_response,
    render_error, render_error_event,
)
from test_model_routing_identity import ctx


@pytest.mark.parametrize('payload,status', [
    ({'error': {'code': 429, 'message': 'synthetic-target'}}, 429),
    ({'response': {'error': {'code': 404, 'message': 'synthetic-target'}}}, 404),
    ({'response': {'response': {'error': {'code': 403}}}}, 403),
    ({'response': []}, 502),
])
@pytest.mark.parametrize('protocol', ['gemini', 'openai', 'claude'])
async def test_http200_error_never_becomes_public_success(payload, status, protocol):
    with pytest.raises(ModelApiErrorException) as error:
        await adapt_public_response(Response(json.dumps(payload)), route_context=ctx(protocol))
    assert error.value.error.status == status
    assert b'synthetic-target' not in render_error(error.value.error, protocol).body


@pytest.mark.parametrize('protocol', ['gemini', 'openai', 'claude'])
async def test_late_http200_upstream_error_is_one_fixed_terminal(protocol):
    async def source():
        yield b': heartbeat\n\n'
        yield b'data: {"response":{"error":{"code":429,"message":"synthetic-target"}}}\n\n'
    response = await adapt_public_response(StreamingResponse(source()), route_context=ctx(protocol))
    body = b''.join([x async for x in response.body_iterator])
    assert body.count(b'data: {') == 1 and b'synthetic-target' not in body
    assert body == b': heartbeat\n\n' + render_error_event(error_from_http_status(429), protocol)
    assert (body.count(b'data: [DONE]') == 1) == (protocol == 'openai')


async def test_http200_trusted_attached_error_keeps_local_retry():
    response = attach_model_api_error(Response('{}'), local_retry_response(retry_after=7, status_code=503)._model_api_error_description)
    adapted = await adapt_public_response(response, route_context=ctx())
    assert adapted.status_code == 503 and adapted.headers['retry-after'] == '7'
    assert is_rendered_model_api_error(adapted)


def test_renderer_event_private_provenance_never_serialized_and_default_bytes_same():
    error = error_from_http_status(429, origin=ErrorOrigin.UPSTREAM)
    for protocol in ('gemini', 'openai', 'claude'):
        event = render_error_event(error, protocol)
        assert get_rendered_error_event(event) is error
        assert get_rendered_error_event(bytes(event)) is None
        assert b'render_marker' not in event and b'Retry-After' not in event
        assert isinstance(event, bytes)


@pytest.mark.parametrize('raw,status', [
    ('{"error":{"code":429,"message":"synthetic-target"}}', 429),
    ('{"response":{"error":{"code":404}}}', 404),
    ('not-json synthetic-target', 502),
    ('{"response":[]}', 502),
])
def test_manual_probe_shared_parse_contract_unchanged(raw, status):
    with pytest.raises(ModelApiErrorException) as error:
        parse_model_response(raw)
    assert error.value.error.status == status and str(error.value) == ''


def test_retirement_notice_is_checked_before_identity_addition():
    payload = {'candidates': [{'content': {'parts': [{'text': 'Gemini synthetic-model is no longer available.'}]}}]}
    with pytest.raises(ModelApiErrorException) as error:
        rewrite_success_identity(payload, protocol='gemini', requested_model='public-alpha')
    assert error.value.error.status == 404


@pytest.mark.parametrize('source_protocol,target_protocol', [
    ('gemini', 'openai'), ('gemini', 'claude'), ('openai', 'gemini'),
    ('openai', 'claude'), ('claude', 'gemini'), ('claude', 'openai'),
])
async def test_trusted_error_at_protocol_boundary_keeps_type_and_correct_wire(source_protocol, target_protocol):
    error = error_from_http_status(429)
    async def source():
        yield b': heartbeat\n\n'
        yield render_error_event(error, source_protocol)
    response = await adapt_public_response(StreamingResponse(source()), route_context=ctx(target_protocol))
    body = b''.join([x async for x in response.body_iterator])
    assert body == b': heartbeat\n\n' + render_error_event(error, target_protocol)
