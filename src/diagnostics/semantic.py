"""Allowlisted, DEBUG-only observations; never used by business decisions."""
import asyncio
import json
import sys
import time

from .propagation import new_id
from .runtime import active_server, current_attempt, debug_server

MAX_INT = 9007199254740991


def integer(value):
    return value if type(value) is int and 0 <= value <= MAX_INT else None


def usage(raw=None, protocol='gemini', source='upstream'):
    raw = raw if isinstance(raw, dict) else {}
    keys = {'gemini': ('promptTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount', 'totalTokenCount', 'cachedContentTokenCount'),
            'openai_chat': ('prompt_tokens', 'completion_tokens', 'reasoning_tokens', 'total_tokens'),
            'claude': ('input_tokens', 'output_tokens')}[protocol]
    clean = {k: integer(raw[k]) for k in keys if k in raw}
    details = raw.get('completion_tokens_details')
    if protocol == 'openai_chat' and isinstance(details, dict) and 'reasoning_tokens' in details:
        clean['reasoning_tokens'] = integer(details['reasoning_tokens'])
    def metric(key):
        value = clean.get(key)
        return dict(value=value, present=value is not None, source=source if value is not None else 'unknown')
    # No new sum/subtraction: totalTokenCount includes input; candidate and
    # reasoning remain separate. Gemini has no directly observed outputTotal.
    output_key = 'completion_tokens' if protocol == 'openai_chat' else ('output_tokens' if protocol == 'claude' else '')
    return dict(protocol=protocol, input=metric(keys[0]), candidate=metric('candidatesTokenCount'),
                reasoning=metric('thoughtsTokenCount' if protocol == 'gemini' else 'reasoning_tokens'),
                outputTotal=metric(output_key), basis=('converted' if source == 'converted' else 'provider_cumulative') if any(v is not None for v in clean.values()) else 'unknown',
                reasoningIncludedInOutput=False if source == 'converted' and protocol in ('openai_chat', 'claude') and clean.get(output_key) is not None else None, raw=clean)


def structure(request):
    contents = request.get('contents', [])
    if not isinstance(contents, list):
        contents = []
    result = dict(messageCount=len(contents), emptyMessageCount=0, toolCallCount=0, toolResponseCount=0, tail=[], complete=len(contents) <= 1024)
    for i, content in enumerate(contents[:1024]):
        parts = content.get('parts', []) if isinstance(content, dict) else []
        parts = parts if isinstance(parts, list) else []
        kinds, size, effective = [], 0, False
        if len(parts) > 1024:
            result['complete'] = False
        for part in parts[:1024]:
            if not isinstance(part, dict):
                continue
            kind = 'other'
            if isinstance(part.get('text'), str):
                kind = 'thought' if part.get('thought') else 'text'
                size += len(part['text'].encode('utf8'))
                effective |= bool(part['text'].strip())
            elif 'functionCall' in part or 'function_call' in part:
                kind, effective = 'tool_call', True
                result['toolCallCount'] += 1
            elif 'functionResponse' in part:
                kind, effective = 'tool_response', True
                result['toolResponseCount'] += 1
            elif 'inlineData' in part or 'fileData' in part:
                kind, effective = 'media', True
            if kind not in kinds and len(kinds) < 8:
                kinds.append(kind)
        result['emptyMessageCount'] += not effective
        if i >= len(contents) - 4:
            role = content.get('role') if isinstance(content, dict) else None
            if role not in ('user', 'model', 'assistant', 'system', 'tool', None):
                role = 'unknown'
            result['tail'].append(dict(index=i, role=role, partKinds=kinds, textUtf8Bytes=size))
    if not result['complete']:
        for k in ('emptyMessageCount', 'toolCallCount', 'toolResponseCount'):
            result[k] = None
    return result


def normalization_start(request):
    server = active_server()
    if server:
        server.antigravity = True
    return structure(request) if debug_server() else None


def normalization_end(before, request, transformations):
    server = debug_server()
    if server and before is not None:
        server.emit('request.normalized', dict(before=before, after=structure(request), transformations=transformations[:16], requestedModelAlias=None, effectiveModelAlias=None))


class Summary:
    """Bounded numeric state. No model text, tool argument or provider reason retained."""
    def __init__(self):
        self.raw = {}
        self.output = dict(candidateCount=0, ordinaryTextUtf8Bytes=0, thoughtUtf8Bytes=0, validToolCalls=0, mediaParts=0, ordinaryTextNonWhitespaceChars=0)
        self.terminal = False
        self.parsed = True
        self.seen = False
        self.error = self.blocked = False
        self.valid_end = False
        self.status = None

    def observe(self, obj):
        if not isinstance(obj, dict):
            self.parsed = False
            return
        obj = obj.get('response', obj)
        if not isinstance(obj, dict):
            self.parsed = False
            return
        self.seen = True
        if 'error' in obj:
            self.error = True
            err = obj['error']
            code = err.get('code') if isinstance(err, dict) else None
            self.status = code if type(code) is int and 400 <= code <= 599 else None
        raw = obj.get('usageMetadata')
        if isinstance(raw, dict):
            self.raw.update(usage(raw)['raw'])
        feedback = obj.get('promptFeedback')
        if isinstance(feedback, dict) and feedback.get('blockReason'):
            self.blocked = self.terminal = True
        candidates = obj.get('candidates', [])
        if not isinstance(candidates, list):
            self.parsed = False
            return
        self.output['candidateCount'] = max(self.output['candidateCount'], len(candidates))
        if len(candidates) > 64:
            self.parsed = False
        for candidate in candidates[:64]:
            if not isinstance(candidate, dict):
                self.parsed = False
                continue
            reason = candidate.get('finishReason')
            if reason:
                self.terminal = True
                self.valid_end |= reason == 'STOP'
                self.blocked |= reason in ('SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY')
            content = candidate.get('content', {})
            parts = content.get('parts', []) if isinstance(content, dict) else []
            if not isinstance(parts, list):
                self.parsed = False
                continue
            if len(parts) > 1024:
                self.parsed = False
            for part in parts[:1024]:
                if not isinstance(part, dict):
                    self.parsed = False
                    continue
                text = part.get('text')
                if isinstance(text, str):
                    key = 'thoughtUtf8Bytes' if part.get('thought') else 'ordinaryTextUtf8Bytes'
                    self.output[key] += len(text.encode('utf8'))
                    if not part.get('thought'):
                        self.output['ordinaryTextNonWhitespaceChars'] += sum(not c.isspace() for c in text)
                tool = part.get('functionCall', part.get('function_call'))
                if isinstance(tool, dict) and isinstance(tool.get('name'), str) and tool['name'] and isinstance(tool.get('args', {}), dict):
                    self.output['validToolCalls'] += 1
                media = part.get('inlineData', part.get('fileData'))
                if isinstance(media, dict) and (media.get('data') or media.get('fileUri')):
                    self.output['mediaParts'] += 1

    def result(self):
        if self.error:
            return 'error'
        if self.blocked:
            return 'blocked'
        if not self.seen or not self.parsed or not self.terminal or not self.valid_end:
            return 'incomplete'
        effective = any(self.output[k] for k in ('ordinaryTextNonWhitespaceChars', 'validToolCalls', 'mediaParts'))
        return 'success' if effective else 'empty'


class Attempt:
    def __init__(self, number, credential):
        self.server = active_server()
        self.id, self.number = new_id(), number
        self.started = time.perf_counter()
        self.summary = Summary() if self.server and self.server.debug() else None
        self.credential = self.server.rt.credential(credential) if self.summary else None
        self.eof = False
        self.http_eof = False
        self.http_observed = False
        self.http_status = None
        self.http_calls = self.http_eofs = 0
        self.buffer = b''
        self.done = False
        self.done_frame = False
        if self.summary is not None:
            with self.server.lock:
                if not self.server.sealed:
                    self.server.open_attempts[self.id] = self

    def enabled(self):
        return self.summary is not None and self.server.debug()

    def line(self, line):
        if not self.enabled():
            self.buffer = b''
            return
        if isinstance(line, bytes):
            try:
                line = line.decode('utf8')
            except UnicodeError:
                self.summary.parsed = False
                return
        if not isinstance(line, str) or not line.startswith('data:'):
            return
        payload = line[5:].strip()
        if payload == '[DONE]':
            self.done_frame = True
            return  # Transport completion alone cannot prove valid model output.
        if len(payload) > 65536 or len(payload.encode('utf8')) > 65536:
            self.summary.parsed = False
            return
        try:
            self.summary.observe(json.loads(payload))
        except (ValueError, TypeError, RecursionError):
            self.summary.parsed = False

    def chunk(self, chunk, native):
        if not self.enabled():
            self.buffer = b''
            return
        if hasattr(chunk, 'status_code'):
            self.summary.error = True
            self.summary.status = chunk.status_code
            self.http_status = chunk.status_code
            return
        if not native:
            self.line(chunk)
            return
        # Observe after the existing read, bounded to one SSE line. Never pre-read.
        if not isinstance(chunk, bytes) or len(chunk) + len(self.buffer) > 65536:
            self.summary.parsed = False
            self.buffer = b''
            return
        self.buffer += chunk
        while b'\n' in self.buffer:
            line, self.buffer = self.buffer.split(b'\n', 1)
            self.line(line)

    def finish(self, failure=None):
        if self.server is None:
            self.done = True
            self.buffer = b''
            return
        with self.server.lock:
            if self.done:
                return
            self.done = True
            try:
                self._finish_observation(failure)
            finally:
                self.server.open_attempts.pop(self.id, None)

    def _finish_observation(self, failure):
        if not self.enabled():
            self.buffer = b''
            return
        if self.buffer:
            self.line(self.buffer)
            self.buffer = b''
        summary = self.summary
        # The business iterator may end before the HTTP stream. Only use its
        # exhaustion as fallback when no HTTP observation exists (e.g. mocks).
        eof = self.http_eof if self.http_observed else self.eof
        result = 'cancelled' if failure == 'cancelled' else ('error' if failure else summary.result())
        semantic_result = result
        if result == 'success' and not eof:
            result = 'incomplete'
        error = failure or {'success': 'none', 'blocked': 'blocked', 'empty': 'empty', 'incomplete': 'incomplete'}.get(result, 'other')
        if result == 'error' and summary.status == 429:
            error = 'resource_exhausted_unknown'
        elif result == 'error' and summary.status == 400:
            error = 'invalid_request'
        timing = dict(firstUpstreamByteMs=None, firstEffectiveOutputMs=None, responseCommitMs=None,
                      firstDownstreamEffectiveOutputMs=None, timingSource='server_monotonic')
        origin, stage = 'upstream', 'unknown'
        if result == 'success': origin, stage = 'none', 'none'
        elif failure == 'cancelled': origin, stage = ('client' if getattr(self.server, 'disconnected', False) else 'unknown'), 'read'
        elif failure: stage = 'read'
        elif self.http_status is not None and self.http_status >= 400: stage = 'dispatch'
        elif not summary.parsed: stage = 'parse'
        elif summary.error: stage = 'unknown'
        elif not eof and semantic_result == 'success': origin, stage = 'local', 'read'
        elif not eof and semantic_result == 'incomplete' and not self.done_frame: origin, stage = 'unknown', 'read'
        self.server.emit('upstream.attempt_finished', dict(resultClass=result, failureOrigin=origin,
                         failureStage=stage, errorClass=error,
                         usage=usage(summary.raw), output=summary.output, terminalSeen=summary.terminal, eofSeen=eof,
                         parserFinishOk=summary.parsed and summary.seen, totalMs=round((time.perf_counter() - self.started) * 1000, 3),
                         credentialRef=self.credential, credentialRefScope='boot' if self.credential else 'unknown', timing=timing), attempt=self)


async def observe_post(awaitable, attempt):
    token = current_attempt.set(attempt)
    failure = None
    try:
        response = await awaitable
        attempt.eof = True
        observe_buffered_response(attempt, response)
        return response
    except asyncio.CancelledError:
        failure = 'cancelled'
        raise
    except BaseException:
        failure = 'transport_error'
        raise
    finally:
        current_attempt.reset(token)
        safe_finish(attempt, failure)


async def observe_stream(iterator, attempt, native=False):
    failure = None
    try:
        while True:
            token = current_attempt.set(attempt)
            try:
                chunk = await anext(iterator)
            except StopAsyncIteration:
                attempt.eof = True
                break
            finally:
                current_attempt.reset(token)
            safe_chunk(attempt, chunk, native)
            yield chunk
    except asyncio.CancelledError:
        failure = 'cancelled'
        raise
    except GeneratorExit:
        # Early generator close is not proof the client cancelled.
        raise
    except BaseException:
        failure = 'transport_error'
        raise
    finally:
        pending = sys.exc_info()[0]
        try:
            close = getattr(iterator, 'aclose', None)
            if close:
                await close()
        except asyncio.CancelledError:
            if pending in (None, GeneratorExit):
                failure = 'cancelled'
                raise
        except BaseException:
            # Preserve an already propagating transport exception/cancellation.
            if pending is None:
                failure = 'transport_error'
                raise
        finally:
            safe_finish(attempt, failure)


def observe_buffered_response(attempt, response):
    if attempt.enabled():
        attempt.http_status = response.status_code
        attempt.summary.status = response.status_code
        attempt.summary.error = response.status_code >= 400
        if len(response.content) <= 65536:
            try:
                attempt.summary.observe(response.json())
            except (ValueError, TypeError, RecursionError):
                attempt.summary.parsed = False
        else:
            attempt.summary.parsed = False


def delivery_summary(delivered, protocol):
    if protocol == 'gemini':
        summary = Summary()
        summary.observe(delivered)
        return summary.output
    output = dict(candidateCount=0, ordinaryTextUtf8Bytes=0, thoughtUtf8Bytes=0, validToolCalls=0, mediaParts=0, ordinaryTextNonWhitespaceChars=0)
    def text(value, thought=False):
        if isinstance(value, str):
            output['thoughtUtf8Bytes' if thought else 'ordinaryTextUtf8Bytes'] += len(value.encode('utf8'))
            if not thought:
                output['ordinaryTextNonWhitespaceChars'] += sum(not c.isspace() for c in value)
    if protocol == 'openai_chat':
        choices = delivered.get('choices', [])
        output['candidateCount'] = len(choices)
        for choice in choices:
            message = choice.get('message', choice.get('delta', {}))
            text(message.get('content'))
            text(message.get('reasoning_content'), True)
            # Streaming argument fragments do not prove a valid tool call.
            if 'delta' in choice and message.get('tool_calls'):
                output['validToolCalls'] = None
            elif output['validToolCalls'] is not None:
                for tool in message.get('tool_calls', []):
                    function = tool.get('function', {})
                    try:
                        arguments = json.loads(function.get('arguments', ''))
                        output['validToolCalls'] += bool(function.get('name')) and isinstance(arguments, dict)
                    except (ValueError, TypeError):
                        pass
    else:
        output['candidateCount'] = 1
        for part in delivered.get('content', []):
            if part.get('type') == 'text': text(part.get('text'))
            elif part.get('type') == 'thinking': text(part.get('thinking'), True)
            elif part.get('type') == 'tool_use' and part.get('name') and isinstance(part.get('input'), dict): output['validToolCalls'] += 1
            elif part.get('type') == 'image': output['mediaParts'] += 1
    return output


def converted(upstream, delivered, protocol='gemini', mode='nonstream', streaming=False, observed=None):
    server = debug_server()
    if not server or not getattr(server, 'antigravity', False):
        return
    collected = getattr(server, 'collected_summary', None)
    summary = observed or collected or Summary()
    if observed is None and collected is None:
        summary.observe(upstream)
    if summary.error:
        # Error-only bodies can reach a nonstream converter from a pseudo-stream
        # route. That converter is not evidence of the actual delivery protocol.
        return
    if not isinstance(delivered, dict):
        return
    raw = delivered.get('usageMetadata' if protocol == 'gemini' else 'usage')
    if collected is not None and mode == 'nonstream':
        mode = 'collected'
    output = delivery_summary(delivered, protocol)
    server.emit('response.converted', dict(inputProtocol='gemini', outputProtocol=protocol,
                clientStreaming=streaming, upstreamStreaming=mode in ('collected', 'stream'), deliveryMode=mode,
                upstreamUsage=usage(summary.raw), deliveredUsage=usage(raw, protocol, 'converted'),
                output=output, resultClass=delivered_result(summary.result(), output)))


def delivered_result(result, output):
    if result != 'success':
        return result
    evidence = [output[k] for k in ('ordinaryTextNonWhitespaceChars', 'validToolCalls', 'mediaParts')]
    if any(value is not None and value > 0 for value in evidence):
        return 'success'
    return 'incomplete' if any(value is None for value in evidence) else 'empty'


def collector_observer():
    server = debug_server()
    return Summary() if server and getattr(server, 'antigravity', False) else None


def collector_parsed(summary, obj=None, invalid=False):
    if summary is not None and debug_server():
        if invalid:
            summary.parsed = False
        else:
            summary.observe(obj)


def collected_response(summary):
    server = debug_server()
    if server and summary is not None:
        server.collected_summary = summary


def conversion_state(protocol):
    server = debug_server()
    if not server or not getattr(server, 'antigravity', False):
        return None
    if not hasattr(server, 'conversions'):
        server.conversions = {}
    if protocol not in server.conversions:
        server.conversions[protocol] = dict(upstream=Summary(), raw={}, output=None, terminal=False)
    return server.conversions[protocol]


def conversion_input(obj, protocol, mode='stream'):
    state = conversion_state(protocol)
    if state is not None:
        state['mode'] = mode
        state['upstream'].observe(obj)


def conversion_output(obj, protocol):
    state = conversion_state(protocol)
    if state is None:
        return
    if not isinstance(obj, dict):
        state['upstream'].parsed = False
        return
    if protocol == 'gemini':
        obj = obj.get('response', obj)
        raw = obj.get('usageMetadata')
        state['terminal'] |= any(c.get('finishReason') for c in obj.get('candidates', []) if isinstance(c, dict))
        output = delivery_summary(obj, protocol)
    elif protocol == 'claude':
        kind = obj.get('type')
        raw = obj.get('usage', obj.get('message', {}).get('usage'))
        parts = []
        if kind == 'content_block_delta':
            delta = obj.get('delta', {})
            if delta.get('type') == 'text_delta': parts = [dict(type='text', text=delta.get('text'))]
            elif delta.get('type') == 'thinking_delta': parts = [dict(type='thinking', thinking=delta.get('thinking'))]
        elif kind == 'content_block_start':
            parts = [obj.get('content_block', {})]
        projected = dict(content=parts)
        if kind == 'message_stop': state['terminal'] = True
        output = delivery_summary(projected, protocol)
        if any(p.get('type') == 'tool_use' for p in parts):
            output['validToolCalls'] = None  # Later input_json_delta fragments are not validated here.
    else:
        raw = obj.get('usage')
        state['terminal'] |= any(choice.get('finish_reason') for choice in obj.get('choices', []))
        output = delivery_summary(obj, protocol)
    if isinstance(raw, dict):
        state['raw'].update(usage(raw, protocol, 'converted')['raw'])
    if state['output'] is None:
        state['output'] = output
    else:
        for key, value in output.items():
            previous = state['output'][key]
            state['output'][key] = None if value is None or previous is None else (max(previous, value) if key == 'candidateCount' else previous + value)


def finish_conversions(server):
    if not server.debug():
        return
    for protocol, state in getattr(server, 'conversions', {}).items():
        summary = state['upstream']
        result = summary.result()
        if result == 'success' and not state['terminal']:
            result = 'incomplete'
        output = state['output'] or {k:None for k in summary.output}
        server.emit('response.converted', dict(inputProtocol='gemini', outputProtocol=protocol,
                    clientStreaming=True, upstreamStreaming=state.get('mode', 'stream') == 'stream' or hasattr(server, 'collected_summary'), deliveryMode=state.get('mode', 'stream'),
                    upstreamUsage=usage(summary.raw), deliveredUsage=usage(state['raw'], protocol, 'converted'),
                    output=output, resultClass=delivered_result(result, output)))


def finish_attempts(server, cancelled=False):
    # Settle numeric observations only. Do not close, drain, or cancel a business
    # iterator. A later HTTP close still settles its independent call span.
    with server.lock:
        for attempt in tuple(server.open_attempts.values()):
            safe_finish(attempt, 'cancelled' if cancelled else None)


def _best_effort(function):
    """Malformed observations must never alter a model response or cancellation."""
    from functools import wraps
    @wraps(function)
    def observed(*args, **kwargs):
        try:
            return function(*args, **kwargs)
        except Exception:
            # No payload/exception output. Surface a bounded known observation
            # loss in the owning span's eventual coverage.
            server = active_server()
            if args and isinstance(args[0], Attempt) and args[0].summary is not None:
                args[0].summary.parsed = False
            if server and server.debug():
                with server.lock:
                    if not getattr(server, 'observation_failed', False):
                        server.observation_failed = True
                        server.dropped += 1
            return None
    return observed


normalization_start = _best_effort(normalization_start)
normalization_end = _best_effort(normalization_end)
converted = _best_effort(converted)
conversion_input = _best_effort(conversion_input)
conversion_output = _best_effort(conversion_output)
finish_conversions = _best_effort(finish_conversions)
finish_attempts = _best_effort(finish_attempts)
collector_parsed = _best_effort(collector_parsed)
collected_response = _best_effort(collected_response)
observe_buffered_response = _best_effort(observe_buffered_response)
safe_chunk = _best_effort(Attempt.chunk)
safe_finish = _best_effort(Attempt.finish)
