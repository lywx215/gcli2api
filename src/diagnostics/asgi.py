"""Pure ASGI lifecycle, including streaming tasks; no BaseHTTPMiddleware."""
import asyncio
import re

from .propagation import outbound
from .runtime import Server, current_server, runtime


class DiagnosticsMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            if scope['type'] == 'lifespan':
                runtime()
            return await self.app(scope, receive, send)
        try:
            server = Server(scope.get('headers', []))
        except Exception:
            return await self.app(scope, receive, send)
        token = current_server.set(server)
        committed, status, finished, disconnected = False, None, False, False
        end, delivery = 'unknown', 'unknown'

        async def observed_receive():
            nonlocal disconnected
            message = await receive()
            if message['type'] == 'http.disconnect':
                disconnected = True
                server.disconnected = True
            return message

        async def observed_send(message):
            nonlocal committed, status, finished
            if message['type'] == 'http.response.start':
                headers, _ = outbound(message.get('headers', []), allowed=False, owned=False,
                                      request_id=server.request_id, trace_id=server.context['traceId'], span_id=server.span_id, response=True)
                message = dict(message, headers=[(k.encode('latin1'), v.encode('latin1')) for k, v in headers])
                await send(message)
                committed, status = True, message['status']
            else:
                await send(message)
                if message['type'] == 'http.response.body' and not message.get('more_body', False):
                    finished = True
        try:
            await self.app(scope, observed_receive, observed_send)
            if finished:
                end, delivery = 'finished', 'local_finished'
            elif disconnected:
                end, delivery = 'client_cancel', 'cancelled'
        except asyncio.CancelledError:
            end, delivery = ('client_cancel' if disconnected else 'unknown'), 'cancelled'
            raise
        except BaseException:
            end, delivery = 'error', 'failed'
            raise
        finally:
            from .semantic import finish_conversions
            finish_conversions(server)
            route = getattr(scope.get('route'), 'path', None)
            if not isinstance(route, str) or not re.fullmatch(r'/[A-Za-z0-9_:/{}.*-]{0,127}', route):
                route = None
            try:
                server.emit('diag.server', dict(routeTemplate=route, headersCommitted=committed, wireStatus=status,
                                              endReason=end, deliveryState=delivery, totalMs=server.elapsed(), callCount=server.calls), terminal=True)
            except Exception:
                pass
            finally:
                current_server.reset(token)
