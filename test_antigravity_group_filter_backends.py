"""Exercise real summary implementations against isolated SQL/Mongo driver doubles."""
import copy
import json
import re
from collections import Counter
from contextlib import asynccontextmanager

import pytest
from src.storage.psql_manager import PSQLManager
from src.storage.mysql_manager import MySQLManager
from src.storage.mongodb_manager import MongoDBManager
from test_antigravity_group_filter import NOW, C, G, policy


def rows():
    result = []
    for i, (cooldowns, states, disabled, permanent) in enumerate([
        ({'claude-opus-4-6': NOW + 100}, {}, False, False),
        ({}, {G: policy()}, False, False),
        ({}, {G: policy('manual_override')}, False, False),
        ({'independent': NOW + 200}, {}, False, False),
        ({}, 'corrupt-json', False, False),
        ({C: NOW + 100}, {}, True, False),
        ({G: NOW + 100}, {}, False, True),
    ]):
        result.append(dict(filename=f'{i}.json', disabled=disabled, permanent_disabled=permanent,
            model_cooldowns=cooldowns, quota_group_states=states, error_codes=[403],
            error_messages={}, last_success=None, user_email='', rotation_order=i,
            tier='pro', remark='blue', enable_credit=False, success_count=0, failure_count=0,
            cycle_stats={}, last_cycle_stats={}))
    return result


class Cursor:
    def __init__(self, data): self.data = data
    def __aiter__(self):
        async def iterate():
            for row in self.data: yield copy.deepcopy(row)
        return iterate()
    def sort(self, *args): return self
    async def to_list(self, length=None): return copy.deepcopy(self.data)


class Driver:
    def __init__(self, data, engine): self.data, self.engine, self.queries = data, engine, []
    @asynccontextmanager
    async def acquire(self): yield self
    @asynccontextmanager
    async def cursor(self, *args): yield self
    async def execute(self, query, params=()):
        self.pending = await self.fetch(query, *params)
    async def fetchall(self): return self.pending
    async def fetch(self, query, *params):
        self.queries.append(query)
        assert query.strip().upper().startswith('SELECT'), 'summary must be read-only'
        assert 'credential_data' not in query
        if self.engine == 'mysql':
            assert 'server_name = %s' in query and params[0] == 'isolated'
        if 'GROUP BY' in query:
            fields = ['disabled', 'permanent_disabled'] if 'permanent_disabled' in query else ['disabled']
            counts = Counter(tuple(r[k] for k in fields) for r in self.data)
            return [tuple(key) + (n,) if self.engine == 'mysql' else dict(zip(fields, key), cnt=n)
                    for key, n in counts.items()]
        selected = self.data
        where = query.split('WHERE', 1)[-1].split('ORDER BY')[0] if 'WHERE' in query else ''
        for key in ('disabled', 'permanent_disabled'):
            if re.search(rf'(?<![\w]){key}(?:,\s*(?:0|FALSE)\))?\s*=\s*(0|FALSE)', where):
                selected = [r for r in selected if not r[key]]
            elif re.search(rf'(?<![\w]){key}(?:,\s*(?:0|FALSE)\))?\s*=\s*(1|TRUE)', where):
                selected = [r for r in selected if r[key]]
        fields = [s.strip() for s in query.split('SELECT', 1)[1].split('FROM', 1)[0].split(',')]
        projected = [{k: json.dumps(r[k]) if isinstance(r.get(k), (dict, list)) else r.get(k)
                      for k in fields} for r in selected]
        return [tuple(r[k] for k in fields) for r in projected] if self.engine == 'mysql' else projected
    def aggregate(self, pipeline):
        group = pipeline[0]['$group']['_id']
        if isinstance(group, dict):
            keys = list(group)
            counts = Counter(tuple(r[k] for k in keys) for r in self.data)
            return Cursor([{'_id': dict(zip(keys,k)), 'count': n} for k,n in counts.items()])
        counts = Counter(r['disabled'] for r in self.data)
        return Cursor([{'_id': k, 'count': n} for k,n in counts.items()])
    def find(self, query, projection=None):
        self.queries.append((query, projection))
        if projection: assert 'credential_data' not in projection
        def matches(row, conditions):
            for key, value in conditions.items():
                if key == '$and':
                    if not all(matches(row, x) for x in value): return False
                elif key == '$or':
                    if not any(matches(row, x) for x in value): return False
                elif isinstance(value, dict):
                    if '$ne' in value and row.get(key) == value['$ne']: return False
                    if '$in' in value and not any(x in value['$in'] for x in (row.get(key) if isinstance(row.get(key), list) else [row.get(key)])): return False
                elif row.get(key) != value: return False
            return True
        return Cursor([r for r in self.data if matches(r, query)])


@pytest.fixture(params=['postgres', 'mysql', 'mongo'])
def summary_backend(request, monkeypatch):
    engine = request.param
    cls = {'postgres': PSQLManager, 'mysql': MySQLManager, 'mongo': MongoDBManager}[engine]
    manager = cls.__new__(cls)
    seed = rows()
    # MySQL has no permanent_disabled column; its persisted equivalent is disabled.
    if engine == 'mysql': seed[-1]['disabled'] = True
    driver = Driver(seed, engine)
    manager._initialized = True
    manager._pool = driver
    manager._server_name = 'isolated'
    manager._db = {'antigravity_credentials': driver}
    monkeypatch.setattr('time.time', lambda: NOW)
    return manager, driver


@pytest.mark.parametrize('filter_name,expected', [
    ('any_restricted', ['0.json','1.json','3.json','4.json','5.json','6.json']),
    ('gemini_restricted', ['1.json','4.json','6.json']),
    ('claude_gpt_restricted', ['0.json','4.json','5.json']),
    ('gemini_unrestricted', ['0.json','2.json','3.json','5.json']),
    ('claude_gpt_unrestricted', ['1.json','2.json','3.json','6.json']),
    ('all_unrestricted', ['2.json']),
])
async def test_remote_summary_real_method_filters_metadata_and_global_stats(summary_backend, filter_name, expected):
    manager, driver = summary_backend
    before = copy.deepcopy(driver.data)
    result = await manager.get_credentials_summary(mode='antigravity', cooldown_filter=filter_name,
                                                   offset=1, limit=2, tier_filter='pro', remark_filter='blue')
    assert result.get('quota_group_filter_supported') is True
    assert result['total'] == len(expected)
    assert [r['filename'] for r in result['items']] == expected[1:3]
    assert result['stats']['quota_state_invalid'] == 1
    for item in result['items']:
        assert 'quota_groups' in item and 'quota_state_invalid' in item
    assert driver.data == before
    assert driver.queries


@pytest.mark.parametrize('status', ['all','enabled','disabled'])
async def test_remote_new_stats_global_enabled_nonpermanent_even_under_filters(summary_backend, status):
    manager, _ = summary_backend
    result = await manager.get_credentials_summary(mode='antigravity',status_filter=status,
        cooldown_filter='gemini_restricted',remark_filter='does-not-match',error_code_filter='403',limit=25)
    assert result['quota_group_filter_supported']
    assert result['total'] == 0
    assert {k: result['stats'][k] for k in ('quota_restricted','quota_unrestricted','quota_blocked_unknown','quota_state_invalid')} == {
        'quota_restricted':4,'quota_unrestricted':1,'quota_blocked_unknown':1,'quota_state_invalid':1}


@pytest.mark.parametrize('deadline', [float('nan'),float('inf'),10**400])
async def test_remote_corrupt_numeric_summary_safe_for_wire(summary_backend, deadline):
    manager, driver = summary_backend
    driver.data[2]['model_cooldowns'] = {G:deadline}
    result=await manager.get_credentials_summary(mode='antigravity',cooldown_filter='any_restricted')
    assert result['quota_group_filter_supported']
    item=next(i for i in result['items'] if i['filename']=='2.json')
    assert item['quota_state_invalid']
    assert item['model_cooldowns']=={}
    json.dumps(result,allow_nan=False)


@pytest.mark.parametrize('disabled', [False,True])
async def test_remote_empty_unrestricted_filter_retains_candidate_expiry(summary_backend,monkeypatch,disabled):
    manager,driver=summary_backend
    candidate=driver.data[0]
    candidate.update(disabled=disabled,permanent_disabled=False,quota_group_states={},
        model_cooldowns={'claude-opus-4-6':NOW+10,'claude-opus-5-5-high':NOW+100,G:NOW+80})
    driver.data=[candidate]
    for now,expiry,total in ((NOW,NOW+80,0),(NOW+80,NOW+100,0),(NOW+100,0,1)):
        monkeypatch.setattr('time.time',lambda:now)
        result=await manager.get_credentials_summary(mode='antigravity',status_filter='disabled' if disabled else 'enabled',
            cooldown_filter='all_unrestricted',limit=25)
        assert result['total']==total
        assert result['stats']['quota_next_expiry']==expiry
        assert result['stats']['quota_restricted']==(0 if disabled or total else 1)
