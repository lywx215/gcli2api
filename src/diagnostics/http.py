"""Observe httpx after request hooks without replacing transports or mounts.

The two private client seams are tested against the installed httpx version.
No response body is read by a hook. EOF/close/error/cancel settles one handle.
"""
import asyncio
import inspect
import httpx

from .propagation import clean, custom_id, fields, outbound, peer_response, values
from .runtime import CAPABILITIES, active_server, current_attempt, runtime

OWNED = 'gcli.diagnostics.owned'
REDIRECT = 'gcli.diagnostics.redirect'


class Call:
    def __init__(self, span, peer, kind):
        self.span = span
        self.finished = False
        if span.attempt:
            span.attempt.http_observed = True
            span.attempt.http_calls += 1
            span.attempt.http_eof = False
        self.data = dict(targetAlias=peer['alias'] if peer else None, peerConfigured=bool(peer),
                         peerService=peer['service'] if peer else None, peerDeploymentId=peer['deploymentId'] if peer else None,
                         callKind=kind, upstreamStatus=None, peerRequestId=None, peerTraceId=None,
                         peerIdRejected='none', providerRequestId=None)

    def response(self, response):
        self.data['upstreamStatus'] = response.status_code
        if self.span.attempt:
            self.span.attempt.http_status = response.status_code
        self.data.update(peer_response(response.headers.multi_items(), self.data['peerConfigured']))
        self.data['providerRequestId'], _ = custom_id(values(response.headers.multi_items(), 'x-request-id'))

    def finish(self, reason):
        if self.finished:
            return
        self.finished = True
        try:
            if reason == 'eof' and self.span.attempt:
                self.span.attempt.http_eofs += 1
                self.span.attempt.http_eof = self.span.attempt.http_eofs == self.span.attempt.http_calls
            self.span.emit('diag.call', dict(self.data, endReason=reason, totalMs=self.span.elapsed()), terminal=True)
        except Exception:
            pass  # Diagnostic settlement cannot replace a transport outcome.


class ObservedStream(httpx.AsyncByteStream):
    def __init__(self, stream, call):
        self.stream, self.call = stream, call

    async def __aiter__(self):
        try:
            async for chunk in self.stream:
                yield chunk
        except asyncio.CancelledError:
            self.call.finish('cancelled')
            raise
        except GeneratorExit:
            self.call.finish('closed_early')
            raise
        except BaseException:
            self.call.finish('read_error')
            raise
        else:
            self.call.finish('eof')

    async def aclose(self):
        try:
            await self.stream.aclose()
        except asyncio.CancelledError:
            self.call.finish('cancelled')
            raise
        except BaseException:
            self.call.finish('read_error')
            raise
        finally:
            self.call.finish('closed_early')


class DiagnosticAsyncClient(httpx.AsyncClient):
    async def _send_single_request(self, request):
        server = active_server()
        # Clone even when unobserved: X-Diag-* never goes to a nonpeer.
        sent = httpx.Request(request.method, request.url, headers=request.headers,
                             stream=request.stream, extensions=dict(request.extensions))
        peer = runtime().peers.match(str(sent.url)) if server else None
        attempt = current_attempt.get()
        span = server.call(attempt) if server else None
        call = None
        if span:
            kind = 'redirect' if sent.extensions.get(REDIRECT) else ('model' if attempt else 'other')
            call = Call(span, peer, kind)
            headers, owned = outbound(sent.headers.raw, allowed=bool(peer), owned=bool(sent.extensions.get(OWNED)),
                                      request_id=server.request_id, trace_id=server.context['traceId'], span_id=span.span_id,
                                      flags=server.context['outputFlags'], state=server.context['tracestate'])
        else:
            headers, owned = clean(fields(sent.headers.raw), bool(sent.extensions.get(OWNED))), False
        sent.headers = raw_headers(headers)
        sent.extensions[OWNED] = owned
        try:
            response = await super()._send_single_request(sent)
        except asyncio.CancelledError:
            if call:
                call.finish('cancelled')
            raise
        except BaseException:
            if call:
                call.finish('transport_error')
            raise
        if call:
            try:
                call.response(response)
            except Exception:
                pass
            if response.is_stream_consumed:
                call.finish('eof')
            else:
                response.stream = ObservedStream(response.stream, call)
        return response

    def _build_redirect_request(self, request, response):
        # httpx otherwise rebuilds from the pre-injection request. Use the actual
        # sent copy so ownership and the overwritten business fields agree.
        redirected = super()._build_redirect_request(response.request, response)
        redirected.headers = raw_headers(clean(fields(redirected.headers.raw), bool(redirected.extensions.get(OWNED))))
        redirected.extensions = dict(redirected.extensions, **{OWNED: False, REDIRECT: True})
        return redirected


def raw_headers(headers):
    # latin1 is the exact inverse of fields(): retain bytes, casing and duplicates.
    return httpx.Headers([(k.encode('latin1'), v.encode('latin1')) for k, v in headers])


def compatible_httpx(client, version):
    try:
        if version != '0.28.1':
            return False
        expected = {'_send_single_request': ('self', 'request'),
                    '_build_redirect_request': ('self', 'request', 'response')}
        for name, names in expected.items():
            method = getattr(client, name)
            parameters = list(inspect.signature(method).parameters.values())
            if tuple(p.name for p in parameters) != names or any(p.kind != p.POSITIONAL_OR_KEYWORD or p.default != p.empty for p in parameters):
                return False
        return inspect.iscoroutinefunction(client._send_single_request) and not inspect.iscoroutinefunction(client._build_redirect_request)
    except (AttributeError, TypeError, ValueError):
        return False


if not compatible_httpx(httpx.AsyncClient, httpx.__version__):
    DiagnosticAsyncClient = httpx.AsyncClient
    if 'http_outbound' in CAPABILITIES:
        CAPABILITIES.remove('http_outbound')
