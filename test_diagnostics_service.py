"""Real loopback HTTP → FastAPI routes → Antigravity → httpx → fake upstream."""
import contextlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time

import httpx
import pytest

from test_diagnostics_runtime import VALIDATOR
from src.diagnostics.runtime import record_issues


def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0))
        return sock.getsockname()[1]


@contextlib.contextmanager
def running(tmp_path, name, mode, upstream=None, scenario='success', instance=None, nonstream=False):
    number = port()
    root = tmp_path/name
    env = os.environ.copy()
    env.update(PYTHONUTF8='1', DIAG_ENVIRONMENT='test', DIAG_DEPLOYMENT_ID='harness', DIAG_INSTANCE_ID=instance or name)
    if upstream:
        env['DIAG_PEERS'] = json.dumps([dict(alias='fake-upstream',origin=upstream,pathPrefix='/',service='gcli2api',deploymentId=None)])
    command = [sys.executable,'scripts/diagnostic_harness.py',mode,'--root',str(root),'--port',str(number),'--scenario',scenario,'--debug']
    if upstream: command += ['--upstream',upstream]
    if nonstream: command += ['--nonstream-upstream']
    with (tmp_path/(name+'.console')).open('w',encoding='utf8') as output:
        process = subprocess.Popen(command,env=env,stdout=output,stderr=subprocess.STDOUT)
        origin = f'http://127.0.0.1:{number}'
        try:
            with httpx.Client(trust_env=False,timeout=2) as client:
                deadline = time.monotonic()+15
                while True:
                    if process.poll() is not None:
                        pytest.fail((tmp_path/(name+'.console')).read_text(encoding='utf8')[-3000:])
                    try:
                        if client.get(origin+'/__health').status_code==200: break
                    except httpx.HTTPError: pass
                    assert time.monotonic()<deadline, 'harness startup timeout'
                    time.sleep(.05)
                yield origin, root
        finally:
            try:
                httpx.post(origin+'/__shutdown',timeout=3,trust_env=False)
                process.wait(timeout=10)
            except (httpx.HTTPError, subprocess.TimeoutExpired):
                process.kill()
                process.wait(timeout=5)
            assert process.returncode == 0, (tmp_path/(name+'.console')).read_text(encoding='utf8')[-3000:]


def read_records(root):
    records = []
    for path in root.glob('*.jsonl'):
        for line in path.read_text(encoding='utf8').splitlines():
            assert len(line.encode())+1<=4096
            record = json.loads(line)
            VALIDATOR.validate(record)
            assert not record_issues(record)
            records.append(record)
    return records


def payload(protocol, stream=False):
    if protocol=='gemini':
        return '/antigravity/v1beta/models/gemini-3.7-flash:'+('streamGenerateContent' if stream else 'generateContent'), {'contents':[{'role':'user','parts':[{'text':'synthetic prompt'}]}]}
    return ('/antigravity/v1/chat/completions' if protocol=='openai' else '/antigravity/v1/messages'), dict(model='gemini-3.7-flash',messages=[dict(role='user',content='synthetic prompt')],stream=stream,max_tokens=128)


@pytest.mark.parametrize('scenario', ['success','zero','missing','error','retry','incomplete','tool','media'])
def test_real_service_semantic_cases(tmp_path, scenario):
    with running(tmp_path,'fake','upstream',scenario=scenario) as (fake,_):
        with running(tmp_path,'gcli','gcli',fake) as (origin,root):
            path,body = payload('gemini')
            response=httpx.post(origin+path,json=body,headers={'authorization':'Bearer synthetic-local-password','x-request-id':'caller-1'},trust_env=False,timeout=10)
            assert response.status_code == (503 if scenario=='error' else 200), response.text
            request_id=response.headers['x-diag-request-id']
    records=[r for r in read_records(root) if r['requestId']==request_id]
    attempts=[r for r in records if r['event']=='upstream.attempt_finished']
    calls=[r for r in records if r['event']=='diag.call']
    assert len(attempts)==len(calls)==(3 if scenario=='retry' else 1)
    assert all(r['data']['peerConfigured'] for r in calls)
    assert len({r['attemptId'] for r in attempts})==len(attempts)
    if scenario=='retry': assert len({r['data']['credentialRef'] for r in attempts})==2
    data=attempts[-1]['data']
    # The real collector stops at [DONE], without draining the HTTP reader to
    # EOF. Do not manufacture EOF merely because model termination is valid.
    assert data['resultClass']==('error' if scenario=='error' else 'incomplete')
    metric=data['usage']['candidate']
    if scenario=='missing': assert metric==dict(value=None,present=False,source='unknown')
    elif scenario!='error': assert metric['value']==(0 if scenario=='zero' else 87)
    assert records[-1]['event']=='diag.server'
    assert records[-1]['data']['coverage']['expectedLastLogSeq']==records[-1]['logSeq']
    assert 'synthetic prompt' not in json.dumps(records)
    assert 'synthetic-token' not in json.dumps(records)


def test_two_workers_restart_and_all_protocols(tmp_path):
    roots=[]
    with running(tmp_path,'fake','upstream') as (fake,_):
        with running(tmp_path,'worker1','gcli',fake,instance='same-replica') as (first,root1):
            with running(tmp_path,'worker2','gcli',fake,instance='same-replica',nonstream=True) as (second,root2):
                roots += [root1,root2]
                for origin in (first,second):
                    for protocol in ('gemini','openai','claude'):
                        for stream in (False,True):
                            path,body=payload(protocol,stream)
                            response=httpx.post(origin+path,json=body,headers={'authorization':'Bearer synthetic-local-password','traceparent':'00-'+'1'*32+'-'+'2'*16+'-01'},trust_env=False,timeout=10)
                            assert response.status_code==200, response.text
                            assert response.headers['x-diag-trace-id']=='1'*32
        with running(tmp_path,'restart','gcli',fake,instance='same-replica') as (origin,root3):
            roots.append(root3)
            path,body=payload('gemini')
            assert httpx.post(origin+path,json=body,headers={'authorization':'Bearer synthetic-local-password'},trust_env=False,timeout=10).status_code==200
    records=[read_records(root) for root in roots]
    boots=[{r['bootId'] for r in rows} for rows in records]
    assert all(len(ids)==1 for ids in boots)
    assert len(set.union(*boots))==3
    assert {r['instanceId'] for rows in records for r in rows}=={'same-replica'}
    for rows in records[:2]:
        assert len([r for r in rows if r['event']=='diag.server' and r['parentSpanId']=='2'*16])==6
        assert {'gemini','openai_chat','claude'} <= {r['data']['outputProtocol'] for r in rows if r['event']=='response.converted'}
        for server in (r for r in rows if r['event']=='diag.server' and r['parentSpanId']=='2'*16):
            assert any(r['event']=='response.converted' and r['serverSpanId']==server['spanId'] for r in rows)


def test_real_client_disconnect_and_duplicate_headers(tmp_path):
    with running(tmp_path,'fake','upstream',scenario='slow') as (fake,_):
        with running(tmp_path,'gcli','gcli',fake) as (origin,root):
            path,body=payload('gemini',True)
            trace='00-'+'1'*32+'-'+'2'*16+'-01'
            headers=[('authorization','Bearer synthetic-local-password'),('traceparent',trace),('TraceParent',trace)]
            with httpx.Client(trust_env=False,timeout=10) as client:
                with client.stream('POST',origin+path,json=body,headers=headers) as response:
                    request_id=response.headers['x-diag-request-id']
                    assert response.headers['x-diag-trace-id']!='1'*32
                    assert next(response.iter_bytes())
                # A failing auth request still gets local response IDs.
                rejected=client.post(origin+path,json=body)
                assert rejected.status_code in (401,403)
                assert rejected.headers['x-diag-request-id']!=request_id
                time.sleep(.2)
    rows=[r for r in read_records(root) if r['requestId']==request_id]
    servers=[r for r in rows if r['event']=='diag.server']
    calls=[r for r in rows if r['event']=='diag.call']
    assert len(servers)==len(calls)==1
    assert servers[0]['contextSource']=='invalid_replaced'
    assert servers[0]['data']['endReason']=='client_cancel'
    assert calls[0]['data']['endReason'] in ('cancelled','closed_early')
