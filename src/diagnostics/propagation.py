"""Framework-field W3C Level 1 propagation and exact local peer policy.

Inputs retain field multiplicity. This module never reads sockets, logs header
values, authenticates callers or makes routing decisions.
"""
import ipaddress
import json
import re
import secrets
from urllib.parse import urlsplit


def new_id(size=16):
    return secrets.token_hex(size)


def fields(headers):
    return [(k.decode('latin1') if isinstance(k, bytes) else k,
             v.decode('latin1') if isinstance(v, bytes) else v) for k, v in headers]


def values(headers, name):
    return [v for k, v in fields(headers) if k.lower() == name]


def custom_id(vals, trace=False):
    if not vals:
        return None, 'none'
    if len(vals) != 1:
        return None, 'duplicate'
    value = vals[0]
    if ',' in value:
        return None, 'duplicate'
    if len(value.encode('utf-8')) > 128:
        return None, 'too_long'
    pattern = r'[0-9a-f]{32}' if trace else r'[A-Za-z0-9._:/-]{1,128}'
    if not re.fullmatch(pattern, value) or (trace and value == '0' * 32):
        return None, 'invalid'
    return value, 'none'


def trace_state(vals):
    value = ','.join(vals)
    if not value or len(value) > 512 or not value.isascii():
        return None
    members, keys = [], set()
    for item in value.split(','):
        item = item.strip(' \t')
        if not item:
            continue
        key, sep, val = item.partition('=')
        valid_key = re.fullmatch(r'[a-z][a-z0-9_*/-]{0,255}|[a-z0-9][a-z0-9_*/-]{0,240}@[a-z][a-z0-9_*/-]{0,13}', key)
        if (not sep or not valid_key or key in keys or not 1 <= len(val) <= 256
                or not re.fullmatch(r'[\x20-\x2b\x2d-\x3c\x3e-\x7e]*[\x21-\x2b\x2d-\x3c\x3e-\x7e]', val)):
            return None
        keys.add(key)
        members.append(item)
    return ','.join(members) if 0 < len(members) <= 32 else None


def extract(headers, authenticated=False, configured_inbound_adapter=False):
    parents = values(headers, 'traceparent')
    p = parents[0] if len(parents) == 1 else ''
    match = re.fullmatch(r'([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(.*)', p)
    accepted = bool(match and len(p) <= 512 and ',' not in p
                    and all(32 <= ord(c) <= 126 for c in p)
                    and match[1] != 'ff' and int(match[2], 16) and int(match[3], 16)
                    and (not match[5] or (match[1] != '00' and match[5].startswith('-'))))
    out = dict(contextSource='accepted' if accepted else ('invalid_replaced' if parents else 'generated'),
               traceId=match[2] if accepted else new_id(), parentSpanId=match[3] if accepted else None,
               outputFlags=f'{int(match[4], 16) & 1:02x}' if accepted else '00',
               tracestate=trace_state(values(headers, 'tracestate')) if accepted else None,
               callerRequestId=None, callerHeader=None, callerTrust='none', rejected='none')
    names = ['x-diag-request-id', 'x-request-id'] if authenticated and configured_inbound_adapter else ['x-request-id']
    for name in names:
        value, reason = custom_id(values(headers, name))
        if reason != 'none' and out['rejected'] == 'none':
            out['rejected'] = reason
        if value is not None:
            out.update(callerRequestId=value, callerHeader=name,
                       callerTrust='configured_peer' if name == 'x-diag-request-id' else ('authenticated' if authenticated else 'unverified'))
            break
    return out


def clean(headers, owned=False, automatic=False):
    """Clean only proven automatic copies or our own request-local injection."""
    return [(k, v) for k, v in headers if not k.lower().startswith('x-diag-')
            and not ((owned or automatic) and k.lower() in ('traceparent', 'tracestate'))]


def outbound(headers, *, allowed, owned, request_id, trace_id, span_id, flags='00', state=None, response=False):
    result = clean(fields(headers), owned=(owned or allowed) and not response)
    if response:
        result += [('x-diag-request-id', request_id), ('x-diag-trace-id', trace_id)]
        return result, False
    if allowed:
        result.append(('traceparent', f'00-{trace_id}-{span_id}-{flags}'))
        if state:
            result.append(('tracestate', state))
        result.append(('x-diag-request-id', request_id))
    return result, bool(allowed)


def peer_response(headers, configured):
    out = dict(peerRequestId=None, peerTraceId=None, peerIdRejected='none')
    if configured:
        for key, header, trace in [('peerRequestId', 'x-diag-request-id', False), ('peerTraceId', 'x-diag-trace-id', True)]:
            out[key], reason = custom_id(values(headers, header), trace)
            if out['peerIdRejected'] == 'none':
                out['peerIdRejected'] = reason
    return out


def label(value, maximum=64):
    return isinstance(value, str) and bool(re.fullmatch(r'[A-Za-z0-9._-]{1,' + str(maximum) + '}', value))


def origin(url, configuration=False):
    if not isinstance(url, str) or not url.isascii() or any(ord(c) <= 32 or ord(c) >= 127 for c in url) or '\\' in url:
        raise ValueError('origin')
    parsed = urlsplit(url)
    if parsed.scheme not in ('http', 'https') or not parsed.netloc or parsed.username is not None or parsed.password is not None:
        raise ValueError('origin')
    if '%' in parsed.netloc or parsed.fragment or '#' in url:
        raise ValueError('origin')
    if configuration and (parsed.path not in ('', '/') or '?' in url):
        raise ValueError('origin')
    host = parsed.hostname
    if not host or host.endswith('.'):
        raise ValueError('host')
    try:
        address = ipaddress.ip_address(host)
        host = str(address)
    except ValueError:
        if ':' in host or re.fullmatch(r'[0-9.]+', host) or re.fullmatch(r'(?:0x[0-9a-f]+|[0-9]+)(?:\.(?:0x[0-9a-f]+|[0-9]+))*', host, re.I):
            raise ValueError('numeric host')
        if len(host) > 253 or any(not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', part) for part in host.lower().split('.')):
            raise ValueError('host')
        host = host.lower()
    port = parsed.port
    if parsed.netloc.endswith(':') or (port is not None and not 1 <= port <= 65535):
        raise ValueError('port')
    return (parsed.scheme, host, port or (443 if parsed.scheme == 'https' else 80)), parsed.path or '/'


def safe_path(path):
    return (path == '/' or (isinstance(path, str) and path.startswith('/')
            and all(part not in ('', '.', '..') and re.fullmatch(r'[A-Za-z0-9._~-]+', part) for part in path[1:].split('/'))))


def within(path, prefix):
    return prefix == '/' or path == prefix or path.startswith(prefix + '/')


def safe_target(path):
    # Target paths are broader than configured prefixes (Gemini's :method is
    # legitimate). The contract suppresses encoded, dot and empty segments,
    # backslashes and controls, rather than imposing the prefix token grammar.
    if not path.startswith('/') or any(ord(c) < 33 or ord(c) > 126 for c in path) or '%' in path or '\\' in path:
        return False
    parts = path[1:].split('/')
    if parts[-1] == '':
        parts.pop()
    return all(part not in ('', '.', '..') for part in parts)


def _unique_object(pairs):
    result = {}
    for k, v in pairs:
        if k in result:
            raise ValueError('duplicate key')
        result[k] = v
    return result


class Peers:
    def __init__(self, config):
        self.entries = ()
        self.status = 'valid'
        try:
            if isinstance(config, str):
                config = json.loads(config or '[]', object_pairs_hook=_unique_object)
            if not isinstance(config, list) or len(config) > 64:
                raise ValueError('shape')
            entries, aliases = [], set()
            for entry in config:
                if not isinstance(entry, dict) or set(entry) != {'alias', 'origin', 'pathPrefix', 'service', 'deploymentId'}:
                    raise ValueError('shape')
                if (not label(entry['alias']) or entry['alias'] in aliases
                        or entry['service'] not in ('cliproxyapi', 'gcli2api', 'aitoapi')
                        or (entry['deploymentId'] is not None and not label(entry['deploymentId']))
                        or not isinstance(entry['pathPrefix'], str) or len(entry['pathPrefix']) > 256
                        or not safe_path(entry['pathPrefix'])):
                    raise ValueError('entry')
                canonical, _ = origin(entry['origin'], True)
                for previous in entries:
                    if previous[0] == canonical and (within(entry['pathPrefix'], previous[1]['pathPrefix']) or within(previous[1]['pathPrefix'], entry['pathPrefix'])):
                        raise ValueError('overlap')
                aliases.add(entry['alias'])
                entries.append((canonical, dict(entry)))
            self.entries = tuple(entries)
        except (ValueError, TypeError, RecursionError):
            self.status = 'config_invalid'

    def match(self, url):
        try:
            canonical, path = origin(url)
            if not safe_target(path):
                return None
            for expected, entry in self.entries:
                if canonical == expected and within(path, entry['pathPrefix']):
                    return entry
        except (ValueError, TypeError):
            pass
        return None
