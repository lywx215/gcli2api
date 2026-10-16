"""Other Antigravity refresh paths: synthetic IO and isolated SQLite only."""
import copy
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from src.credential_manager import CredentialManager
from src.google_oauth_api import Credentials
from src.panel import creds as panel
from src.storage.antigravity_quota import credential_version
from test_antigravity_refresh_preservation import backend, refreshed, uploaded, assert_preserved, ABSENT, NAME
from test_antigravity_manual import reply


def manager_for(backend):
    manager=CredentialManager()
    manager._initialized=True
    manager._storage_adapter=SimpleNamespace(_backend=backend)
    return manager


@pytest.fixture
def panel_backend(backend,monkeypatch):
    adapter=SimpleNamespace(_backend=backend,get_credential=backend.get_credential,
        get_credential_state=backend.get_credential_state)
    monkeypatch.setattr(panel,'get_storage_adapter',AsyncMock(return_value=adapter))
    monkeypatch.setattr(panel,'get_antigravity_api_url',AsyncMock(return_value='https://example.invalid'))
    monkeypatch.setattr(panel,'fetch_quota_info',AsyncMock(return_value={'success':False,'models':{},'error':'synthetic'}))
    monkeypatch.setattr(panel,'record_logical_request',AsyncMock())
    return adapter


@pytest.mark.parametrize('credit',[ABSENT,False,True])
@pytest.mark.parametrize('alias',[False,True])
async def test_automatic_refresh_keeps_raw_fields_and_runtime_credit(backend,refreshed,credit,alias):
    original=uploaded(credit,alias)
    receipt=await backend.import_antigravity_credential_with_receipt(NAME,original)
    selected=await backend.quota_current_credential(NAME,receipt.generation)
    untouched=copy.deepcopy(selected)
    manager=manager_for(backend)
    result=await manager._refresh_token(selected,NAME,'antigravity')
    assert result
    saved=await backend.get_credential(NAME,'antigravity')
    assert_preserved(original,saved)
    assert selected==untouched
    assert result['enable_credit'] is False
    assert result['_quota_credential_version']==credential_version(saved)
    assert (await backend.quota_credential_fence(NAME))['quota_credential_generation']==receipt.generation
    assert await backend.quota_admit(NAME,'gemini-pro-agent','business',receipt.generation,result['_quota_credential_version'])


@pytest.mark.parametrize('change',['generation','version'])
async def test_stale_automatic_refresh_does_not_call_oauth(backend,monkeypatch,change):
    receipt=await backend.import_antigravity_credential_with_receipt(NAME,uploaded(True))
    selected=await backend.quota_current_credential(NAME,receipt.generation)
    replacement={'access_token':'synthetic-replacement','custom_upload_metadata':{'keep':True}}
    if change=='generation':
        await backend.import_antigravity_credential_with_receipt(NAME,replacement)
    else:
        assert await backend.quota_refresh_credential(NAME,receipt.generation,replacement,receipt.credential_version)
    refresh=AsyncMock(side_effect=AssertionError('stale OAuth forbidden'))
    monkeypatch.setattr(Credentials,'refresh',refresh)
    assert await manager_for(backend)._refresh_token(selected,NAME,'antigravity') is None
    refresh.assert_not_awaited()
    assert await backend.get_credential(NAME,'antigravity')==replacement


@pytest.mark.parametrize('found',[False,True])
async def test_legacy_project_refresh_preserves_upload(backend,panel_backend,refreshed,monkeypatch,found):
    original=uploaded(True)
    await backend.import_antigravity_credential_with_receipt(NAME,original)
    monkeypatch.setattr(panel,'fetch_project_id_and_tier',AsyncMock(return_value=
        ('synthetic-verified-project','pro',None) if found else (None,None,None)))
    response=await panel.verify_credential_project_common(NAME,'antigravity')
    assert response.status_code==(200 if found else 400)
    expected={**original,'project_id':'synthetic-verified-project'} if found else original
    assert_preserved(expected,await backend.get_credential(NAME,'antigravity'))


@pytest.mark.parametrize('needs_refresh',[False,True])
async def test_legacy_quota_refresh_preserves_upload_and_skips_noop(backend,panel_backend,refreshed,monkeypatch,needs_refresh):
    original=uploaded(True)
    if not needs_refresh:
        original['expiry']='2099-01-01T00:00:00Z'
    await backend.import_antigravity_credential_with_receipt(NAME,original)
    write=AsyncMock(wraps=backend.quota_refresh_credential)
    monkeypatch.setattr(backend,'quota_refresh_credential',write)
    await panel._fetch_quota_for_credential(NAME,'antigravity')
    saved=await backend.get_credential(NAME,'antigravity')
    if needs_refresh:
        assert_preserved(original,saved)
        write.assert_awaited_once()
    else:
        assert saved==original
        write.assert_not_awaited()


async def test_legacy_model_test_refresh_preserves_upload(backend,panel_backend,refreshed,monkeypatch):
    original=uploaded(True)
    await backend.import_antigravity_credential_with_receipt(NAME,original)
    post=AsyncMock(return_value=httpx.Response(200,json=reply()))
    monkeypatch.setattr('src.httpx_client.post_async',post)
    response=await panel.test_credential_common(NAME,mode='antigravity',origin='legacy')
    assert response.status_code==200
    post.assert_awaited_once()
    assert_preserved(original,await backend.get_credential(NAME,'antigravity'))


async def test_automatic_raw_read_honors_deadline(backend,monkeypatch):
    import asyncio
    import time
    from src.antigravity_directory_runtime import QuotaWorkError
    original=uploaded(True)
    receipt=await backend.import_antigravity_credential_with_receipt(NAME,original)
    selected=await backend.quota_current_credential(NAME,receipt.generation)
    async def stalled(*args,**kwargs):
        await asyncio.Event().wait()
    monkeypatch.setattr(backend,'quota_current_credential',stalled)
    refresh=AsyncMock(side_effect=AssertionError('expired budget must not call OAuth'))
    monkeypatch.setattr(Credentials,'refresh',refresh)
    with pytest.raises(QuotaWorkError) as error:
        await manager_for(backend)._refresh_token(selected,NAME,'antigravity',deadline=time.monotonic()+.02)
    assert error.value.code=='quota_timeout'
    refresh.assert_not_awaited()
    assert await backend.get_credential(NAME,'antigravity')==original
