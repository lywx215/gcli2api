"""Antigravity-only generation deadlines; no changes to other providers' defaults."""
import asyncio
from contextvars import ContextVar
from dataclasses import dataclass, field
import json
import math
import os
import time

import httpx
from fastapi.responses import JSONResponse


def positive_setting(name, default, *, integer=False):
    raw = os.getenv('ANTIGRAVITY_' + name, str(default))
    try:
        value = int(raw) if integer else float(raw)
        if not math.isfinite(value) or value <= 0:
            raise ValueError
        return value
    except (TypeError, ValueError, OverflowError):
        raise ValueError(f'ANTIGRAVITY_{name} must be a positive finite number') from None


@dataclass(frozen=True)
class GenerationLimits:
    connect: float = 15
    write: float = 30
    headers: float = 60
    first: float = 180
    idle: float = 120
    total: float = 300

    @classmethod
    def load(cls):
        return cls(**{key: positive_setting('TIMEOUT_' + key.upper(), default)
                      for key, default in cls().__dict__.items()})

    def http_timeout(self):
        return httpx.Timeout(connect=self.connect, write=self.write,
                             pool=self.connect, read=None)


class GenerationTimeout(TimeoutError):
    pass


current_budget = ContextVar('antigravity_generation_budget', default=None)


def meaningful_frame(item):
    """Recognize model progress without letting transport metadata reset deadlines."""
    if not isinstance(item, (bytes, str)):
        return False
    text = item.decode('utf-8', errors='replace') if isinstance(item, bytes) else item
    for line in text.splitlines():
        line = line.strip()
        if line.startswith('data:'):
            line = line[5:].strip()
        if not line or line.startswith(':') or line == '[DONE]':
            continue
        try:
            payload = json.loads(line)
        except (ValueError, TypeError):
            continue
        if isinstance(payload, dict) and not payload.get('error') and _has_progress(payload):
            return True
    return False


def _has_progress(value):
    if isinstance(value, list):
        return any(_has_progress(part) for part in value)
    if not isinstance(value, dict):
        return False
    # Gemini raw and OpenAI/Anthropic converted streams, including tool-only replies.
    for key in ('text', 'thinking', 'reasoning_content', 'reasoning', 'partial_json'):
        if isinstance(value.get(key), str) and value[key].strip():
            return True
    if any(value.get(key) for key in ('functionCall', 'function_call', 'tool_calls',
                                     'inlineData', 'inline_data', 'fileData')):
        return True
    if value.get('type') == 'tool_use' and value.get('name'):
        return True
    if isinstance(value.get('content'), str) and value['content'].strip():
        return True
    return any(_has_progress(value.get(key)) for key in
               ('response', 'candidates', 'content', 'parts', 'choices', 'delta',
                'message', 'content_block'))


@dataclass
class GenerationBudget:
    limits: GenerationLimits
    non_stream: bool = False
    started: float = field(default_factory=time.monotonic)
    progress: float | None = None
    streams: list = field(default_factory=list)
    timers: list = field(default_factory=list)
    expired: bool = False
    streaming: bool = False

    @property
    def deadline(self):
        stream_deadline = (self.progress + self.limits.idle if self.progress is not None
                           else self.started + self.limits.first)
        if self.non_stream:
            total_deadline = self.started + self.limits.total
            return min(total_deadline, stream_deadline) if self.streaming else total_deadline
        return stream_deadline

    async def run(self, awaitable):
        if self.expired or self.deadline <= time.monotonic():
            self.expired = True
            closer = getattr(awaitable, "close", None)
            if closer:
                closer()
            raise GenerationTimeout()
        token = current_budget.set(self)
        timer = asyncio.timeout(max(0, self.deadline - time.monotonic()))
        try:
            async with timer:
                self.timers.append(timer)
                result = await awaitable
                if self.expired or self.deadline <= time.monotonic():
                    raise GenerationTimeout()
                return result
        except TimeoutError as exc:
            self.expired = True
            raise GenerationTimeout('Antigravity generation deadline exceeded') from exc
        finally:
            if timer in self.timers:
                self.timers.remove(timer)
            current_budget.reset(token)

    def observe(self, item):
        if meaningful_frame(item):
            self.progress = time.monotonic()
            for timer in self.timers:
                if not timer.expired():
                    timer.reschedule(asyncio.get_running_loop().time() + max(0, self.deadline - time.monotonic()))

    async def close(self):
        for stream in reversed(self.streams[:]):
            try:
                await stream.aclose()
            except (RuntimeError, GeneratorExit):
                pass
        self.streams.clear()


def timeout_response():
    return JSONResponse(status_code=504, content={'error': {
        'code': 504, 'status': 'DEADLINE_EXCEEDED', 'type': 'timeout_error',
        'message': 'Antigravity 请求超时'}})


def timeout_event(protocol):
    error = {'type': 'timeout_error', 'message': 'Antigravity 请求超时'}
    if protocol == 'anthropic':
        return ('event: error\ndata: ' + json.dumps({'type': 'error', 'error': error}) + '\n\n').encode()
    if protocol == 'gemini':
        error.update(code=504, status='DEADLINE_EXCEEDED')
    else:
        error['code'] = 'upstream_timeout'
    return ('data: ' + json.dumps({'error': error}) + '\n\n').encode()
