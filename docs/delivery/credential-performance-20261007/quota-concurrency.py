"""Synthetic concurrency-only benchmark; no app import, DB or network calls.
Current wrapper source: d9b65ba (same wrapper at local f1ddd67).
Prior path represents parent of afbcd21: outer batch Semaphore(5), no shared wrapper.
"""
import ast, asyncio, pathlib, sys, types, time, json
repo=pathlib.Path(r'G:\code\gemini30\gcli2api-master-integration')
p=repo/'src/api/antigravity.py'
node=next(n for n in ast.parse(p.read_text(encoding='utf-8')).body if isinstance(n,ast.AsyncFunctionDef) and n.name=='fetch_quota_info')
module=types.ModuleType('src.antigravity_access_runtime')
sys.modules[module.__name__]=module
ns={'Dict':dict,'Any':object}
active=peak=0
async def fake(*a,**kw):
    global active,peak
    active+=1; peak=max(peak,active)
    await asyncio.sleep(.1)
    active-=1
    return {}
ns['_fetch_quota_info']=fake
exec(compile(ast.Module(body=[node],type_ignores=[]),str(p),'exec'),ns)
async def run(shared):
    global active,peak
    active=peak=0
    module.model_access_service=types.SimpleNamespace(_slots=asyncio.Semaphore(2))
    outer=asyncio.Semaphore(5)
    async def one():
        async with outer:
            await (ns['fetch_quota_info']('synthetic') if shared else fake())
    t=time.perf_counter(); await asyncio.gather(*(one() for _ in range(20)))
    return {'case':'current_shared_2' if shared else 'prior_outer_5','n':20,'fake_io_s':.1,'elapsed_s':round(time.perf_counter()-t,3),'peak_io':peak}
results=[asyncio.run(run(False)),asyncio.run(run(True))]
print(json.dumps({'results':results,'elapsed_ratio':round(results[1]['elapsed_s']/results[0]['elapsed_s'],3)},indent=2))
