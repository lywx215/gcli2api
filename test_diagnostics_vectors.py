"""Frozen input/output vectors exercise production adapters, never the oracle."""
import hashlib
import json
from pathlib import Path
import uuid

import h11
import pytest

from src.diagnostics import propagation as p
from src.diagnostics.runtime import resource, record_issues

ROOT = Path(__file__).parent / 'contracts/diagnostics/v1'


def vectors(name):
    return json.loads((ROOT / 'vectors' / f'{name}.json').read_text(encoding='utf8'))


def expected_context(actual, expected):
    actual = dict(actual)
    if expected['traceId'] == '<generated>':
        assert len(actual['traceId']) == 32 and int(actual['traceId'], 16)
        actual['traceId'] = '<generated>'
    assert actual == expected


@pytest.mark.parametrize('case', vectors('headers'), ids=lambda c: c['id'])
def test_header_vectors(case):
    data = case['input']
    expected_context(p.extract(data['headers'], data.get('authenticated', False), data.get('configuredInboundAdapter', False)), case['expected'])


@pytest.mark.parametrize('case', vectors('http-ingress'), ids=lambda c: c['id'])
def test_real_h11_ingress(case):
    parser = h11.Connection(h11.SERVER)
    parser.receive_data(('GET / HTTP/1.1\r\nHost: localhost\r\n' + '\r\n'.join(case['input']['wireHeaderLines']) + '\r\n\r\n').encode('ascii'))
    request = parser.next_event()
    headers = [[k.decode(), v.decode()] for k, v in request.headers if k != b'host']
    assert headers == case['input']['headers']
    expected_context(p.extract(headers), case['expected'])


@pytest.mark.parametrize('case', vectors('peers'), ids=lambda c: c['id'])
def test_peer_vectors(case):
    peers = p.Peers(case['input']['config'])
    match = peers.match(case['input']['target'])
    assert dict(configStatus=peers.status, match=match['alias'] if match else None) == case['expected']


def grouped(headers):
    result = {}
    for k, v in headers:
        result.setdefault(k.lower(), []).append(v)
    return result


def send_headers(data, headers=None, owned=None):
    result, marker = p.outbound(data.get('headers', []) if headers is None else headers,
                               allowed=data['allowed'], owned=data.get('diagnosticOwned', False) if owned is None else owned,
                               request_id=data['requestId'], trace_id=data['traceId'], span_id=data['callSpanId'],
                               flags=data.get('flags', '00'), state=data.get('tracestate'), response=data.get('response', False))
    return dict(headers=grouped(result), diagnosticOwned=marker)


@pytest.mark.parametrize('case', vectors('outbound'), ids=lambda c: c['id'])
def test_outbound_vectors(case):
    assert send_headers(case['input']) == case['expected']


@pytest.mark.parametrize('case', vectors('redirects'), ids=lambda c: c['id'])
def test_redirect_vectors(case):
    data = case['input']
    peers, headers, owned, result = p.Peers(data['peers']), data['headers'], False, []
    for step in data['steps']:
        headers = p.clean(headers, owned)
        owned = False
        for k, v in step.get('businessHeaders', []):
            headers = [(old, value) for old, value in headers if old.lower() != k.lower()] + [(k, v)]
        assert bool(peers.match(step['target'])) == step['allowed']
        output = send_headers(step, headers, owned)
        result.append(output)
        owned = output['diagnosticOwned']
        headers = [(k, v) for k, vals in output['headers'].items() for v in vals]
    assert result == case['expected']


@pytest.mark.parametrize('case', vectors('copy-source'), ids=lambda c: c['id'])
def test_source_filter_vectors(case):
    assert [list(pair) for pair in p.clean(case['input']['headers'], automatic=True)] == case['expected']


@pytest.mark.parametrize('case', vectors('peer-response'), ids=lambda c: c['id'])
def test_peer_response_vectors(case):
    assert p.peer_response(case['input']['headers'], case['input']['peerConfigured']) == case['expected']


@pytest.mark.parametrize('case', vectors('resources'), ids=lambda c: c['id'])
def test_resource_vectors(case):
    data = case['input']
    result = resource(data['config'], data.get('platformId'), data['localService'])
    assert uuid.UUID(result['bootId']).version == 4
    result['bootId'] = '<new-uuid-per-worker>'
    if case['expected']['instanceId'] == '<random-uuid>':
        assert uuid.UUID(result['instanceId']).version == 4
        result['instanceId'] = '<random-uuid>'
    assert result == case['expected']


def test_frozen_manifest():
    manifest = (ROOT / 'SHA256SUMS').read_bytes()
    assert hashlib.sha256(manifest).hexdigest() == 'ddb202238cfdaabef1af11575dbfcac788fdbc5a457aea5e72b913afc5b478d4'
    for line in manifest.decode().splitlines():
        digest, relative = line.split('  ', 1)
        assert hashlib.sha256((ROOT / relative).read_bytes()).hexdigest() == digest, relative


def test_gemini_method_in_target_is_not_prefix_grammar():
    peers = p.Peers([dict(alias='gemini',origin='https://peer.test',pathPrefix='/antigravity/v1beta',service='gcli2api',deploymentId=None)])
    assert peers.match('https://peer.test/antigravity/v1beta/models/gemini:generateContent')
    assert not peers.match('https://peer.test/antigravity/v1beta//models/gemini:generateContent')
    assert not peers.match('https://peer.test/antigravity/v1beta/models/gemini%3AgenerateContent')


@pytest.mark.parametrize('case', vectors('semantic'), ids=lambda c: c['id'])
def test_producer_semantic_invariants(case):
    assert record_issues(case['input']['record']) == case['expected']
