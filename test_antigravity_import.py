import io
import json
from unittest.mock import AsyncMock

import pytest
from fastapi import UploadFile
from src.credential_manager import CredentialManager, CredentialStorageError
from src.panel import creds


@pytest.fixture
def manager(monkeypatch):
    manager = CredentialManager()
    manager._initialized = True
    manager._storage_adapter = AsyncMock()
    manager._storage_adapter.import_antigravity_credential.return_value = True
    monkeypatch.setattr(creds, 'credential_manager', manager)
    return manager


@pytest.mark.parametrize('failure', [False, RuntimeError('synthetic-sensitive-error')])
async def test_antigravity_store_failure_is_safe(manager, failure):
    if isinstance(failure, Exception):
        manager._storage_adapter.import_antigravity_credential.side_effect = failure
    else:
        manager._storage_adapter.import_antigravity_credential.return_value = failure
    with pytest.raises(CredentialStorageError, match='凭证存储失败') as exc:
        await manager.add_antigravity_credential('test.json', {})
    assert 'synthetic-sensitive' not in str(exc.value)


@pytest.mark.parametrize('outcomes,status,count', [([False],400,0), ([True,False],200,1), ([True],200,1)])
async def test_upload_counts_only_persisted_files(manager, outcomes, status, count):
    manager._storage_adapter.import_antigravity_credential.side_effect = outcomes
    files = [UploadFile(filename=f'{i}.json', file=io.BytesIO(b'{}')) for i in range(len(outcomes))]
    response = await creds.upload_credentials_common(files, mode='antigravity')
    body = json.loads(response.body)
    assert response.status_code == status
    assert body['uploaded_count'] == count
    assert body['failed_count'] == len(outcomes) - count
    assert len(body['results']) == len(outcomes)
    for item, ok in zip(body['results'], outcomes):
        assert item['status'] == ('success' if ok else 'error')
        if not ok:
            assert item['error_code'] == 'credential_store_failed'


async def test_refresh_import_stops_before_metadata_on_store_failure(manager, monkeypatch):
    manager._storage_adapter.import_antigravity_credential.return_value = False
    exchange = AsyncMock(return_value={'access_token': 'synthetic', 'refresh_token': 'synthetic'})
    monkeypatch.setattr(creds, '_exchange_refresh_token_to_credential', exchange)
    monkeypatch.setattr(creds, 'fetch_project_id_and_tier', AsyncMock(return_value=('project', 'pro')))
    monkeypatch.setattr(creds, 'get_antigravity_api_url', AsyncMock(return_value='https://example.test'))
    result = await creds._add_credential_by_refresh_token('synthetic', None, None, None, 'test', 'antigravity')
    assert result['success'] is False
    assert result['error_code'] == 'credential_store_failed'
    manager._storage_adapter.update_credential_state.assert_not_awaited()


async def test_refresh_metadata_is_atomic_initial_state_without_post_write(manager, monkeypatch):
    manager._storage_adapter.update_credential_state.return_value = False
    monkeypatch.setattr(creds, '_exchange_refresh_token_to_credential', AsyncMock(return_value={'access_token':'synthetic'}))
    monkeypatch.setattr(creds, 'fetch_project_id_and_tier', AsyncMock(return_value=('project', 'pro')))
    monkeypatch.setattr(creds, 'get_antigravity_api_url', AsyncMock(return_value='https://example.test'))
    result = await creds._add_credential_by_refresh_token('synthetic', None, None, None, 'test', 'antigravity')
    assert result['success'] is True
    assert result['warnings'] == []
    manager._storage_adapter.update_credential_state.assert_not_awaited()
    assert manager._storage_adapter.import_antigravity_credential.await_args.kwargs['initial_state'] == {'tier': 'pro'}
