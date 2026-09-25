"""Observe httpx after request hooks without replacing transports or mounts.

The two private client seams are tested against the installed httpx version.
No response body is read by a hook. EOF/close/error/cancel settles one handle.
"""
import asyncio
import httpx

from .propagation import clean, custom_id, outbound, peer_response, values
from .runtime import active_server, current_attempt, runtime

OWNED = 'gcli.diagnostics.owned'
REDIRECT = 'gcli.diagnostics.redirect'


class Call:
    def __init__(self, span, peer, kind):
        self.span = span
        self.data = dict(targetAlias=peer['alias'] if peer else None, peerConfigured=bool(peer),
                         peerService=peer['service'] if peer else None, peerDeploymentId=peer['deploymentId'] if peer else None,
                         callKind=kind, upstreamStatus=None, peerRequestId=None, peerTraceId=None,
                         peerIdRejected='none', providerRequestId=None)

    def response(self, response):
        self.data['upstreamStatus'] = response.status_code
        self.data.update(peer_response(response.headers.multi_items(), self.data['peerConfigured']))
        self.data['providerRequestId'], _ = custom_id(values(response.headers.multi_items(), 'x-request-id'))

    def finish(self, reason):
        self.span.emit('diag.call', dict(self.data, endReason=reason, totalMs=self.span.elapsed()), terminal=True)


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
            headers, owned = outbound(sent.headers.multi_items(), allowed=bool(peer), owned=bool(sent.extensions.get(OWNED)),
                                      request_id=server.request_id, trace_id=server.context['traceId'], span_id=span.span_id,
                                      flags=server.context['outputFlags'], state=server.context['tracestate'])
        else:
            headers, owned = clean(sent.headers.multi_items(), bool(sent.extensions.get(OWNED))), False
        sent.headers = httpx.Headers(headers)
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
            call.response(response)
            if response.is_stream_consumed:
                call.finish('eof')
            else:
                response.stream = ObservedStream(response.stream, call)
        return response

    def _build_redirect_request(self, request, response):
        # httpx otherwise rebuilds from the pre-injection request. Use the actual
        # sent copy so ownership and the overwritten business fields agree.
        redirected = super()._build_redirect_request(response.request, response)
        redirected.headers = httpx.Headers(clean(redirected.headers.multi_items(), bool(redirected.extensions.get(OWNED))))
        redirected.extensions = dict(redirected.extensions, **{OWNED: False, REDIRECT: True})
        return redirected
