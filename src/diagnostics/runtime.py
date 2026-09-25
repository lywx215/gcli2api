"""Worker identity, request-owned spans, independent gated structured records."""
import contextvars
import json
import os
import re
import threading
import time
import uuid
from datetime import datetime, timezone

import log as logging
from .propagation import Peers, extract, label, new_id

current_server = contextvars.ContextVar('diagnostic_server', default=None)
current_attempt = contextvars.ContextVar('diagnostic_attempt', default=None)
CAPABILITIES = ['http_inbound', 'http_outbound', 'normalization', 'attempt_result', 'conversion']


def resource(config, platform_id=None, service='gcli2api'):
    """platform_id is accepted only from a confirmed local platform adapter.

    Production currently has no confirmed replica UID adapter; hostname, service
    ID and Zeabur project ID deliberately do not enter this function.
    """
    instance = platform_id if label(platform_id, 128) else config.get('instanceId')
    source = 'platform' if label(platform_id, 128) else 'configured'
    if not label(instance, 128):
        instance, source = str(uuid.uuid4()), 'ephemeral'
    return dict(environment=config.get('environment') if label(config.get('environment')) else 'unassigned',
                deploymentId=config.get('deploymentId') if label(config.get('deploymentId')) else 'unassigned',
                nodeLabel=config.get('nodeLabel') if label(config.get('nodeLabel')) else None,
                instanceId=instance, instanceIdentitySource=source, service=service, bootId=str(uuid.uuid4()))


class Runtime:
    def __init__(self):
        self.pid = os.getpid()
        config = {key: os.getenv(env) for key, env in [('environment', 'DIAG_ENVIRONMENT'), ('deploymentId', 'DIAG_DEPLOYMENT_ID'), ('nodeLabel', 'DIAG_NODE_LABEL'), ('instanceId', 'DIAG_INSTANCE_ID')]}
        self.resource = resource(config)
        self.resource['buildCommit'] = None
        self.invalid_resource = any(v not in (None, '') and not label(v, 128 if k == 'instanceId' else 64) for k, v in config.items())
        self.process_seq = 0
        self.revision = 0
        self.snapshot = None
        self.peers = Peers([])
        self.credentials = {}
        self.lock = threading.RLock()

    def refresh(self):
        snapshot = (os.getenv('DIAG_PEERS', ''), logging.diagnostic_switches())
        with self.lock:
            if self.snapshot != snapshot:
                first = self.snapshot is None
                self.snapshot = snapshot
                self.revision += 1
                self.peers = Peers(snapshot[0])
                access, debug, _, _ = snapshot[1]
                if access:
                    self.process_seq += 1
                    record = envelope(self, None, 'process', None, None, None)
                    record.update(logSeq=self.process_seq, event='diag.process', recordKind='basic', level='INFO',
                                  data=dict(pid=self.pid, reason='startup' if first else 'config_changed', accessEnabled=access,
                                            debugEnabled=debug, configRevision=str(self.revision), contractVersion='1.0.0-rc.1',
                                            capabilities=CAPABILITIES, sinkDroppedTotal=logging._diag_dropped,
                                            configStatus='config_invalid' if self.invalid_resource or self.peers.status != 'valid' else ('valid' if snapshot[0] else 'defaults')))
                    write_record(record)
        return self

    def credential(self, value):
        # Bounded boot-local random aliases; never hashes or emits a filename.
        with self.lock:
            if value not in self.credentials:
                if len(self.credentials) >= 1024:
                    return None
                self.credentials[value] = 'credential-' + new_id(8)
            return self.credentials[value]


_runtime = None


def runtime():
    global _runtime
    if _runtime is None or _runtime.pid != os.getpid():
        _runtime = Runtime()
    return _runtime.refresh()


def envelope(rt, server, kind, span_id, parent_id, call_no):
    return dict(diagnosticSchema='ai-proxy-diagnostics/1', ts=datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
                **rt.resource, spanKind=kind, traceId=server.context['traceId'] if server else None,
                spanId=span_id, parentSpanId=parent_id, serverSpanId=server.span_id if server else None,
                requestId=server.request_id if server else None, contextSource=server.context['contextSource'] if server else None,
                callerRequestId=server.context['callerRequestId'] if server else None, callerAlias=None, callerAliasScope='unknown',
                callerIdSource=dict(header=server.context['callerHeader'] if server else None,
                                    trust=server.context['callerTrust'] if server else 'none', rejected=server.context['rejected'] if server else 'none'),
                attemptId=None, attemptNo=None, retryScope=None, callNo=call_no)


def record_issues(record):
    """Cheap producer cross-field checks, independent of the offline oracle."""
    issues = []
    kind, event = record['spanKind'], record['event']
    span, parent, owner = record['spanId'], record['parentSpanId'], record['serverSpanId']
    if kind == 'server':
        if span != owner:
            issues.append('server_owner')
        if bool(parent is not None) != (record['contextSource'] == 'accepted'):
            issues.append('context_parent')
    if kind == 'call' and parent != owner:
        issues.append('call_owner')
    if span is not None and span == parent:
        issues.append('self_parent')
    data = record['data']
    if event in ('diag.server', 'diag.call') and data['coverage']['expectedLastLogSeq'] != record['logSeq']:
        issues.append('terminal_sequence')
    if event == 'upstream.attempt_finished' and data['resultClass'] == 'success':
        known_finish = all(data[name] for name in ('terminalSeen', 'eofSeen', 'parserFinishOk'))
        effective = any((data['output'][name] or 0) > 0 for name in ('ordinaryTextNonWhitespaceChars', 'validToolCalls', 'mediaParts'))
        if not known_finish or not effective:
            issues.append('success_evidence')
    return sorted(issues)


def write_record(record):
    truncated = False
    try:
        if record_issues(record):
            raise ValueError('invalid diagnostic relationships')
        line = json.dumps(record, ensure_ascii=True, separators=(',', ':'), allow_nan=False)
        if len(line.encode('utf8')) + 1 > 4096:
            raise OverflowError
    except (ValueError, TypeError, OverflowError) as exc:
        record = dict(record, event='diag.truncated', data=dict(originalEvent=record['event'], originalRecordKind=record['recordKind'], reason='line_limit' if isinstance(exc, OverflowError) else 'serialization_failure'))
        line = json.dumps(record, separators=(',', ':'))
        truncated = True
    if len(line.encode('utf8')) + 1 > 4096:
        logging._diag_note_loss()
        return False, truncated
    try:
        return logging.write_diagnostic(line, record['bootId'], record['recordKind'] == 'basic'), truncated
    except Exception:
        logging._diag_note_loss()
        return False, truncated


class Span:
    def __init__(self, rt, server=None, call_no=None, attempt=None):
        self.rt, self.server = rt, server or self
        self.span_id = new_id(8)
        self.call_no, self.attempt = call_no, attempt
        self.started = time.perf_counter()
        self.switches = logging.diagnostic_switches()
        self.seq = self.dropped = self.truncated = 0
        self.sealed = False
        self.lock = threading.RLock()

    def debug(self):
        now = logging.diagnostic_switches()
        return not self.sealed and self.switches[1] and now[1] and self.switches[3] == now[3]

    def coverage(self):
        now = logging.diagnostic_switches()
        return dict(expectedLastLogSeq=self.seq, droppedForSpan=self.dropped,
                    sinkDroppedTotal=logging._diag_dropped, truncatedEvents=self.truncated,
                    debugCapture='none' if not self.switches[1] else ('enabled_throughout' if self.switches[3] == now[3] else 'interrupted'),
                    accessCapture=('enabled_throughout' if self.switches[0] else 'none') if self.switches[2] == now[2] else 'interrupted')

    def emit(self, event, data, *, terminal=False, attempt=None):
        self.rt.refresh()
        basic = event.startswith('diag.')
        with self.lock:
            if self.sealed:
                return
            allowed = logging.diagnostic_switches()[0] if basic else self.debug()
            if allowed:
                self.seq += 1
                kind = 'call' if self.call_no else 'server'
                parent = self.server.span_id if self.call_no else self.context['parentSpanId']
                record = envelope(self.rt, self.server, kind, self.span_id, parent, self.call_no)
                owner = attempt or self.attempt
                if owner:
                    record.update(attemptId=owner.id, attemptNo=owner.number, retryScope='antigravity')
                if terminal:
                    data = dict(data, coverage=self.coverage())
                record.update(event=event, recordKind='basic' if basic else 'debug', level='INFO' if basic else 'DEBUG', logSeq=self.seq, data=data)
                accepted, truncated = write_record(record)
                self.dropped += not accepted
                self.truncated += truncated
            if terminal:
                self.sealed = True

    def elapsed(self):
        return round((time.perf_counter() - self.started) * 1000, 3)


class Server(Span):
    def __init__(self, headers):
        super().__init__(runtime())
        self.context = extract(headers)
        # No existing ASGI request ID exists. Provider payload requestId remains untouched.
        self.request_id = str(uuid.uuid4())
        self.calls = 0
        self.open_attempts = {}

    def call(self, attempt=None):
        with self.lock:
            if self.sealed or self.rt.pid != os.getpid():
                return None
            self.calls += 1
            return Span(self.rt, self, self.calls, attempt)


def active_server():
    server = current_server.get()
    return server if server and not server.sealed and server.rt.pid == os.getpid() else None


def debug_server():
    server = active_server()
    return server if server and server.debug() else None
