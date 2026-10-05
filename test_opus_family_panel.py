"""Synthetic family permission panel contracts; no credential or network access."""
import json
import time
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from src.panel import creds
from src.models import CredFileBatchTestRequest

F55, F46 = 'claude-opus-5-5', 'claude-opus-4-6'
CAP = 'antigravity.model_access.family_filter'


def supported():
    return {'state': 'supported', 'checked_at': time.time()}


async def install_backend(monkeypatch, *, ready=True, reader=True):
    items = [dict(filename=name, user_email='', disabled=False, error_codes=[], last_success=None)
             for name in ['only55.json', 'only46.json', 'both.json']]
    states = {
        'only55.json': {F55: supported(), F46: {'state': 'unavailable'}},
        'only46.json': {F55: {'state': 'unavailable'}, F46: supported()},
        'both.json': {F55: supported(), F46: supported()},
    }
    for index in range(19):
        name = f'both-extra-{index}.json'
        items.append(dict(filename=name, user_email='', disabled=False, error_codes=[], last_success=None))
        states[name] = {F55: supported(), F46: supported()}
    async def summary(**kwargs):
        assert kwargs['offset'] == 0 and kwargs['limit'] is None
        return {'items': items, 'total': len(items)}
    async def families(): return states
    async def info(): return {'backend_type': 'synthetic'}
    backend = SimpleNamespace(model_access_storage_ready=ready, get_credentials_summary=summary)
    if reader:
        backend.model_access_list_family_public = families
    async def adapter(): return SimpleNamespace(_backend=backend, get_backend_info=info)
    monkeypatch.setattr(creds, 'get_storage_adapter', adapter)
    return states


@pytest.mark.parametrize('family,first', [(None, 'only55.json'), (F55, 'only55.json'), (F46, 'only46.json')])
async def test_family_filter_is_applied_before_pagination_and_counts_are_global(monkeypatch, family, first):
    await install_backend(monkeypatch)
    kwargs = {'model_access_family': family} if family else {}
    page1 = json.loads((await creds.get_creds_status_common(0, 20, 'all', 'antigravity',
        model_access_filter='supported', **kwargs)).body)
    page2 = json.loads((await creds.get_creds_status_common(20, 20, 'all', 'antigravity',
        model_access_filter='supported', **kwargs)).body)
    assert page1['total'] == page2['total'] == 21
    assert page1['items'][0]['filename'] == first
    assert page2['items'][0]['filename'] == 'both-extra-18.json'
    assert page1['has_more'] and not page2['has_more']
    assert CAP in page1['panel_capabilities']
    assert set(page1['items'][0]['model_access_families']) == {F55, F46}
    assert 'model_access_state' in page1['items'][0]
    summary = page1['model_access_summary']
    assert summary['total'] == 22
    assert summary['family_counts'] == {
        family: {'supported': 21, 'unavailable': 1, 'unknown': 0} for family in [F55, F46]}


@pytest.mark.parametrize('ready,reader', [(False, True), (True, False)])
async def test_missing_family_capability_fails_explicit_filter_without_fabrication(monkeypatch, ready, reader):
    await install_backend(monkeypatch, ready=ready, reader=reader)
    for kwargs in [{'model_access_family': F46}, {'model_access_filter': 'supported'}, {'model_access_filter': 'unknown'}]:
        response = await creds.get_creds_status_common(0, 25, 'all', 'antigravity', **kwargs)
        assert response.status_code == 501
        assert json.loads(response.body)['capability'] == CAP
    data = json.loads((await creds.get_creds_status_common(0, 25, 'all', 'antigravity')).body)
    assert CAP not in data['panel_capabilities']
    assert all('model_access_families' not in row for row in data['items'])


@pytest.mark.parametrize('kwargs', [{'model_access_family': 'all'}, {'mode': 'geminicli', 'model_access_family': F46}])
async def test_invalid_family_filters_do_not_read_storage(monkeypatch, kwargs):
    async def forbidden(): raise AssertionError('storage touched')
    monkeypatch.setattr(creds, 'get_storage_adapter', forbidden)
    with pytest.raises(HTTPException) as error:
        await creds.get_creds_status_common(0, 25, 'all', **kwargs)
    assert error.value.status_code == 400


async def test_batch_family_counts_use_success_and_preserved_failure_evidence(monkeypatch):
    from src.panel import antigravity_manual
    await install_backend(monkeypatch)
    async def fallback(): return 10
    monkeypatch.setattr(creds, 'get_quota_fallback_cooldown_minutes', fallback)
    results = {
        'only55.json': {'success': True, 'model_access_families': {F55: supported(), F46: {'state': 'unavailable'}}},
        'only46.json': {'success': False, 'error': 'synthetic failure', 'model_access_families': {F55: {'state': 'unknown'}, F46: supported()}},
        # An old payload must not manufacture family support from native entries.
        'legacy.json': {'success': False, 'model_access_state': {'claude-opus-5-5-high': supported()}},
    }
    async def quota(filename, *, sync):
        assert sync is True
        return {'filename': filename, **results[filename]}
    monkeypatch.setattr(antigravity_manual, 'quota', quota)
    response = await creds.batch_refresh_cooldown(CredFileBatchTestRequest(filenames=list(results)), mode='antigravity', _token='synthetic')
    data = json.loads(response.body)
    assert data['success_count'] == 1 and data['failure_count'] == 2
    assert data['model_access_summary']['total'] == 3
    assert data['model_access_summary']['family_counts'] == {
        F55: {'supported': 1, 'unavailable': 0, 'unknown': 2},
        F46: {'supported': 1, 'unavailable': 1, 'unknown': 1},
    }


@pytest.mark.parametrize('entrypoint', ['legacy_quota', 'public_catalog'])
@pytest.mark.parametrize('same_contents', [False, True])
async def test_directory_results_cannot_cross_credential_replacement(tmp_path, monkeypatch, entrypoint, same_contents):
    from src.storage.sqlite_manager import SQLiteManager
    from src.antigravity_model_access import OPUS_46
    from src.api import antigravity as api
    monkeypatch.setenv('CREDENTIALS_DIR', str(tmp_path))
    store = SQLiteManager()
    await store.initialize()
    name = 'replacement-synthetic.json'
    original = {'access_token': 'synthetic-old', 'project_id': 'synthetic-old'}
    replacement = original if same_contents else {'access_token': 'synthetic-new', 'project_id': 'synthetic-new'}
    await store.store_credential(name, original, 'antigravity')
    async def replace():
        await store.import_antigravity_credential(name, replacement)
    async def adapter():
        return SimpleNamespace(_backend=store, get_credential=store.get_credential)
    monkeypatch.setattr(creds, 'get_storage_adapter', adapter)
    calls = []
    async def directory(token, **kwargs):
        calls.append(token)
        return {'success': True, 'models': {OPUS_46: {}}}
    try:
        if entrypoint == 'legacy_quota':
            class Credentials:
                @classmethod
                def from_dict(cls, data):
                    obj = cls(); obj.data = data; return obj
                async def refresh_if_needed(self):
                    await replace()
                    return False
                def to_dict(self): return self.data
            monkeypatch.setattr(creds, 'Credentials', Credentials)
            monkeypatch.setattr(creds, 'fetch_quota_info', directory)
            await creds._fetch_quota_for_credential(name, 'antigravity')
        else:
            async def select(**kwargs):
                old = await store.quota_current_credential(name, (await store.model_access_snapshot(name))['generation'])
                await replace()
                return name, old
            async def manager():
                return SimpleNamespace(_storage_adapter=SimpleNamespace(_backend=store), get_valid_credential=select)
            monkeypatch.setattr(api.credential_manager, '_get_or_create', manager)
            monkeypatch.setattr(api, 'fetch_quota_info', directory)
            assert not any(item['id'] == OPUS_46 for item in await api.fetch_available_models())
        assert calls == (['synthetic-old'] if entrypoint == 'legacy_quota' else [])
        assert (await store.model_access_family_public(name))[F46]['state'] == 'unknown'
        assert await store.quota_admit(name, OPUS_46) is None
    finally:
        await store.close()
