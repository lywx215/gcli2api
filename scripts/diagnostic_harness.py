"""DIAG-07 local-only service harness using real routers/API/converters/httpx.

Only the credential provider is synthetic. No diagnostic records are fabricated.
Run one fake upstream and two gcli processes with distinct --root directories.
"""
import argparse
import asyncio
import ipaddress
import json
import os
from pathlib import Path
import sys
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def isolated_environment(root, upstream, debug, collected):
    parsed = urlsplit(upstream)
    if parsed.scheme != 'http' or not ipaddress.ip_address(parsed.hostname).is_loopback or parsed.username or parsed.query or parsed.fragment:
        raise ValueError('Harness upstream must be a literal loopback HTTP origin')
    root = Path(root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    # A dedicated new harness directory is mandatory. Never open existing state.
    if any(root.iterdir()):
        raise ValueError('Harness root must be empty')
    (root/'credentials').mkdir()
    for key in ('REDIS_URL','MONGODB_URI','POSTGRESQL_URI','MYSQL_URI','DATABASE_URL','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy','PROXY','KEEPALIVE_URL'):
        os.environ[key] = ''
    os.environ.update(ENABLE_LOG='1', LOG_LEVEL='debug' if debug else 'info', NO_PROXY='*',
                      LOG_FILE=str(root/'service.log'), CREDENTIALS_DIR=str(root/'credentials'),
                      API_PASSWORD='synthetic-local-password', ANTIGRAVITY_API_URL=upstream,
                      ANTIGRAVITY_STREAM2NOSTREAM='true' if collected else 'false',
                      RETRY_429_INTERVAL='0', RETRY_429_MAX_RETRIES='2', RETRY_429_ENABLED='true',
                      SMART_429_PROTECTION_ENABLED='false', AUTO_BAN='false')


class SyntheticCredentials:
    def __init__(self):
        self.number = 0
    async def get_valid_credential(self, **kwargs):
        self.number += 1
        n = self.number % 2
        return f'synthetic-{n}.json', dict(access_token=f'synthetic-token-{n}', project_id='synthetic-project')
    async def record_api_call_result(self, *args, **kwargs): pass
    async def set_cred_disabled(self, *args, **kwargs): pass


def service_app():
    from fastapi import FastAPI
    from src.api import antigravity
    from src.router.antigravity.gemini import router as gemini
    from src.router.antigravity.openai import router as openai
    from src.router.antigravity.anthropic import router as claude
    from src.diagnostics.asgi import DiagnosticsMiddleware
    # Fixture dependency only. The production API functions and HTTP client are
    # the actual implementation; no replaced parser, retry, converter or logger.
    antigravity.credential_manager = SyntheticCredentials()
    app = FastAPI()
    for router in (gemini, openai, claude): app.include_router(router)
    return app, DiagnosticsMiddleware


def upstream_app(scenario):
    from fastapi import FastAPI, Request
    from fastapi.responses import JSONResponse, StreamingResponse
    app = FastAPI()
    calls = 0

    @app.post('/v1internal:{operation}')
    async def generate(operation: str, request: Request):
        nonlocal calls
        calls += 1
        await request.json()
        if (scenario == 'retry' and calls <= 2) or (scenario == 'anti_nested' and calls % 2 == 1) or scenario in ('http429', 'http503'):
            status = 429 if scenario == 'http429' else 503
            return JSONResponse({'error':{'code':status,'message':'synthetic retry'}}, status_code=status)
        parts = [{'text':'synthetic answer'}]
        if scenario == 'anti_nested' and calls >= 4: parts = [{'text':'synthetic continuation\n[done]'}]
        if scenario == 'tool': parts = [{'functionCall':{'name':'synthetic_tool','args':{}}}]
        if scenario == 'media': parts = [{'inlineData':{'mimeType':'image/png','data':'AA=='}}]
        if scenario == 'empty': parts = [{'text':'   '}]
        candidate = {'content':{'parts':parts,'role':'model'}}
        if scenario != 'incomplete': candidate['finishReason'] = 'STOP'
        if scenario == 'blocked': candidate['finishReason'] = 'SAFETY'
        first = {'response':{'candidates':[candidate]}}
        raw = {'promptTokenCount':10,'candidatesTokenCount':0 if scenario=='zero' else 87,'thoughtsTokenCount':13 if scenario == 'thought13' else 2}
        if scenario in ('thought2', 'thought13'):
            first['response']['usageMetadata'] = raw
        tail = {'response':{'usageMetadata':raw}}
        if operation == 'generateContent':
            if scenario != 'missing': first['response']['usageMetadata'] = raw
            if scenario == 'error': first = {'error':{'code':503,'message':'synthetic frame'}}
            return JSONResponse(first)
        async def stream():
            yield 'data: ' + json.dumps(first) + '\n\n'
            if scenario == 'slow': await asyncio.sleep(30)
            if scenario == 'error':
                yield 'data: ' + json.dumps({'error':{'code':503,'message':'synthetic frame'}}) + '\n\n'
            elif scenario != 'missing':
                yield 'data: ' + json.dumps(tail) + '\n\n'
                yield 'data: ' + json.dumps(tail) + '\n\n'  # repeated cumulative metadata
            if scenario != 'eof': yield 'data: [DONE]\n\n'
        return StreamingResponse(stream(), media_type='text/event-stream')
    return app


async def run(args):
    isolated_environment(args.root, args.upstream, args.debug, not args.nonstream_upstream)
    from hypercorn.asyncio import serve
    from hypercorn.config import Config
    import log
    stop = asyncio.Event()
    if args.mode == 'gcli':
        app, wrapper = service_app()
    else:
        app, wrapper = upstream_app(args.scenario), lambda app: app
    @app.get('/__health')
    async def health(): return {'ready':True}
    @app.post('/__shutdown')
    async def shutdown():
        stop.set()
        return {'stopping':True}
    config = Config()
    config.bind = [f'127.0.0.1:{args.port}']
    config.accesslog = None
    try:
        await serve(wrapper(app), config, shutdown_trigger=stop.wait)
    finally:
        from src.storage_adapter import close_storage_adapter
        await close_storage_adapter()
        log.log.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['gcli','upstream'])
    parser.add_argument('--root', required=True)
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--upstream', default='http://127.0.0.1:19090')
    parser.add_argument('--debug', action='store_true')
    parser.add_argument('--nonstream-upstream', action='store_true')
    parser.add_argument('--scenario', choices=['success','zero','missing','error','retry','slow','tool','media','empty','blocked','incomplete','eof','thought2','thought13','anti_nested','http429','http503'], default='success')
    asyncio.run(run(parser.parse_args()))


if __name__ == '__main__': main()
