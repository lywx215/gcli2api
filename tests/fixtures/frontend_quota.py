"""Execute production pure projections/coroutine with synthetic dependencies only.

AST loading deliberately avoids application imports and initialization. Canonical
fixture group names make the injected group_for identity function exact.
"""
import ast
import asyncio
import copy
import json
import math
from pathlib import Path
import sys
import types

ROOT = Path(__file__).resolve().parents[2]
policy = ast.parse((ROOT / 'src/antigravity_quota.py').read_text(encoding='utf-8'))
names = {'InvalidQuotaState', 'finite_quota_deadline', 'decode_quota_fields', 'quota_summary', 'public_state'}
ns = dict(copy=copy, json=json, math=math, GROUPS=('claude-gpt-shared', 'gemini-shared'), group_for=lambda model: model)
exec(compile(ast.Module(body=[n for n in policy.body if isinstance(n, (ast.ClassDef, ast.FunctionDef)) and n.name in names], type_ignores=[]), '<production quota projections>', 'exec'), ns)
future = 4070908800

def snapshot(state, timer=False):
    return ns['public_state']({'quota_group_states': {'gemini-shared': {'state': state, 'revision': 1}},
        'model_cooldowns': {'gemini-shared': future} if timer else {}, 'quota_credential_generation': 'synthetic'})

families = {'claude-opus-5-5': {'state': 'unavailable', 'reason': 'directory_query_failed'}}
class Backend:
    model_access_storage_ready = True
    async def model_access_observe(self, *args, **kwargs): return True
    async def model_access_public(self, *args): return {}
    async def model_access_family_public(self, *args): return families
    async def manual_sync_quota(self, *args, **kwargs): raise AssertionError('failure must not sync quota')
async def prepare(filename, events):
    return types.SimpleNamespace(_backend=Backend()), {}, {'access_token': 'synthetic'}
async def fetch(*args, **kwargs):
    return {'success': False, 'upstream_status': 403, 'error': 'synthetic denied', 'response_source': 'google'}
pkg = types.ModuleType('synthetic_panel'); pkg.__path__ = []
p = types.ModuleType('synthetic_panel.creds'); p.fetch_quota_info = fetch; pkg.creds = p
sys.modules['synthetic_panel'] = pkg; sys.modules['synthetic_panel.creds'] = p
manual = ast.parse((ROOT / 'src/panel/antigravity_manual.py').read_text(encoding='utf-8'))
manualns = {'__package__': 'synthetic_panel', 'prepare': prepare}
exec(compile(ast.Module(body=[n for n in manual.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name in {'quota', 'failed_update'}], type_ignores=[]), '<production manual quota>', 'exec'), manualns)
print(json.dumps({
    'blocked': snapshot('blocked_unknown'), 'combined': snapshot('blocked_unknown', True),
    'override': snapshot('manual_override', True),
    'cached': {**ns['quota_summary']({'gemini-shared': future}, {'claude-gpt-shared': {'state': 'blocked_unknown', 'revision': 1}}, 100), 'model_access_families': families},
    'invalid': ns['quota_summary']({}, 'corrupt', 100),
    'failed': asyncio.run(manualns['quota']('synthetic.json', sync=True)),
}))
