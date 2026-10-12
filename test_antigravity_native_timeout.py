"""Offline native timeout contracts. All storage is synthetic or under tmp_path."""
import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock
import httpx
import pytest
from fastapi import HTTPException
import config
from src.models import ConfigSaveRequest
from src.panel import config_routes
from src.api import antigravity as api
from src import antigravity_limits as limits
from src.router import stream_passthrough
from test_antigravity_flash_config import isolated_config, storage
from test_antigravity_flash_transport import wire_http
from test_model_routing_transport import context
from test_model_routing_integration import _payload

KEY = 'antigravity_native_timeout_seconds'
INVALID = [None, True, False, 29, 3601, 480.0, 30.5, '480', '', [], {}]

async def test_default_and_no_environment_override(monkeypatch):
    monkeypatch.setenv('ANTIGRAVITY_NATIVE_TIMEOUT_SECONDS', '900')
    assert await config.get_antigravity_native_timeout_seconds() == 480
    assert KEY not in config.ENV_MAPPINGS.values()

@pytest.mark.parametrize('value', INVALID)
async def test_invalid_history_and_atomic_validation(storage, value):
    config._config_cache[KEY] = value
    storage.values[KEY] = value
    assert await config.get_antigravity_native_timeout_seconds() == 480
    payload = json.loads((await config_routes.get_config(token='synthetic')).body)
    assert payload['config'][KEY] == 480
    assert 'antigravity.native.timeout' in payload['capabilities']
    with pytest.raises(HTTPException) as error:
        await config_routes.save_config(ConfigSaveRequest(config={'debug_mode': True, KEY: value}), token='synthetic')
    assert error.value.status_code == 400
    assert storage.writes == []

@pytest.mark.parametrize('value', [30, 480, 3600])
async def test_boundary_save_and_refresh(storage, value):
    await config_routes.save_config(ConfigSaveRequest(config={KEY: value}), token='synthetic')
    assert storage.values[KEY] == value
    assert await config.get_antigravity_native_timeout_seconds() == value
    assert json.loads((await config_routes.get_config(token='synthetic')).body)['config'][KEY] == value

async def test_real_sqlite_persistence_after_restart(tmp_path, monkeypatch):
    from src.storage.sqlite_manager import SQLiteManager
    monkeypatch.setenv('CREDENTIALS_DIR', str(tmp_path))
    manager = SQLiteManager()
    await manager.initialize()
    class Adapter:
        _backend = manager
        async def set_config(self, key, value): return await self._backend.set_config(key, value)
        async def get_all_config(self): return await self._backend.get_all_config()
    adapter = Adapter()
    monkeypatch.setattr(config_routes, 'get_storage_adapter', AsyncMock(return_value=adapter))
    monkeypatch.setattr('src.storage_adapter.get_storage_adapter', AsyncMock(return_value=adapter))
    monkeypatch.setattr('src.smart_429.smart_429_service.reconfigure', AsyncMock())
    try:
        await config_routes.save_config(ConfigSaveRequest(config={KEY: 900}), token='synthetic')
        assert await config.get_antigravity_native_timeout_seconds() == 900
    finally:
        await manager.close()
    reopened = SQLiteManager()
    await reopened.initialize()
    adapter._backend = reopened
    try:
        config._config_cache = {}
        config._config_initialized = False
        await config.reload_config()
        assert await config.get_antigravity_native_timeout_seconds() == 900
        assert (await reopened.get_all_config())[KEY] == 900
    finally:
        await reopened.close()

async def test_inflight_transport_and_timeout_frozen_new_requests_update(storage, monkeypatch):
    await wire_http(monkeypatch)
    monkeypatch.setattr(api, 'get_antigravity_stream2nostream', config.get_antigravity_stream2nostream)
    monkeypatch.setattr(api, 'get_antigravity_flash_non_stream_mode', config.get_antigravity_flash_non_stream_mode)
    started, resume = asyncio.Event(), asyncio.Event()
    seen = []
    async def post(**kwargs):
        budget = limits.current_budget.get()
        seen.append((budget, kwargs['response_header_timeout']))
        started.set()
        await resume.wait()
        return httpx.Response(200, json=_payload())
    monkeypatch.setattr(api, 'post_async', post)
    config._config_cache.update({'antigravity_stream2nostream':False, KEY:480})
    task = asyncio.create_task(api.non_stream_request({'model':'gemini-3-pro','request':{}},record_logical=False))
    await started.wait()
    await config_routes.save_config(ConfigSaveRequest(config={KEY:900,'antigravity_stream2nostream':True}),token='synthetic')
    new = await api.create_non_stream_budget('gemini-3-pro')
    assert new.stream_collect is True and new.limits.total == 300
    assert seen[0][0].stream_collect is False and seen[0][0].limits.total == 480
    resume.set()
    assert (await task).status_code == 200
    config._config_cache['antigravity_stream2nostream'] = False
    assert (await api.create_non_stream_budget('gemini-3-pro')).limits.total == 900

@pytest.mark.parametrize('model', ['gemini-3.8-high','gemini-3.8-flash-high','gemini-3-pro','claude-sonnet-4-6','gemini-2.5-flash-image'])
async def test_all_native_families_ignore_old_header_total_caps(monkeypatch, model):
    monkeypatch.setenv('ANTIGRAVITY_TIMEOUT_HEADERS','1')
    monkeypatch.setenv('ANTIGRAVITY_TIMEOUT_TOTAL','2')
    b = await api.create_non_stream_budget(model, context(antigravity_stream2nostream=False))
    assert (b.limits.headers,b.limits.total,b.limits.connect,b.limits.write) == (480,480,15,30)
    b2 = await api.create_non_stream_budget(model, context(antigravity_stream2nostream=True))
    assert (b2.limits.headers,b2.limits.total) == (1,2)

@pytest.mark.parametrize('elapsed,status', [(61,200),(301,200),(479,200),(480,504)])
async def test_virtual_delayed_headers_and_total_deadline(monkeypatch, elapsed, status):
    await wire_http(monkeypatch)
    async def post(**kwargs):
        b = limits.current_budget.get()
        assert 479 < kwargs['response_header_timeout'] <= 480
        monkeypatch.setattr(limits,'time',SimpleNamespace(monotonic=lambda:b.started+elapsed))
        return httpx.Response(200,json=_payload())
    monkeypatch.setattr(api,'post_async',post)
    result = await api.non_stream_request({'model':'gemini-3-pro','request':{}},record_logical=False)
    assert result.status_code == status

async def test_retries_share_remaining_deadline(monkeypatch):
    await wire_http(monkeypatch)
    calls=[]
    async def post(**kwargs):
        b=limits.current_budget.get()
        calls.append((b,kwargs['response_header_timeout']))
        if len(calls)==1:
            monkeypatch.setattr(limits,'time',SimpleNamespace(monotonic=lambda:b.started+450))
            raise httpx.ConnectTimeout('synthetic retry')
        monkeypatch.setattr(limits,'time',SimpleNamespace(monotonic=lambda:b.started+481))
        return httpx.Response(200,json=_payload())
    monkeypatch.setattr(api,'post_async',post)
    result=await api.non_stream_request({'model':'gemini-3-pro','request':{}},record_logical=False)
    assert result.status_code==504
    assert len(calls)==2 and calls[0][0] is calls[1][0]
    assert calls[1][1] == 30

async def test_fake_outer_uses_snapshot_and_inherits_native_budget(monkeypatch):
    await wire_http(monkeypatch)
    monkeypatch.setattr(stream_passthrough,'record_logical_request',AsyncMock())
    captured=context(antigravity_stream2nostream=False,antigravity_native_timeout_seconds=900)
    async def post(**kwargs):
        b=limits.current_budget.get()
        assert b.limits.total==900 and b.stream_collect is False
        monkeypatch.setattr(limits,'time',SimpleNamespace(monotonic=lambda:b.started+601))
        return httpx.Response(200,json=_payload())
    monkeypatch.setattr(api,'post_async',post)
    async def fake():
        yield await api.non_stream_request({'model':'synthetic-target','request':{}},record_logical=False,route_context=captured)
    response=await stream_passthrough.build_streaming_response_or_error(fake(),mode='antigravity',model_name='gemini-3-pro',non_stream=True,route_context=captured)
    assert response.status_code==200

async def test_expiry_cancels_pending_native_and_closes_resource(monkeypatch):
    await wire_http(monkeypatch)
    closed = asyncio.Event()
    durations = []
    real_timeout = asyncio.timeout
    def accelerated_timeout(seconds):
        durations.append(seconds)
        return real_timeout(seconds / 10000)
    monkeypatch.setattr(limits, 'asyncio', SimpleNamespace(timeout=accelerated_timeout))
    async def post(**kwargs):
        try:
            await asyncio.sleep(5)
        finally:
            closed.set()
    monkeypatch.setattr(api, 'post_async', post)
    result = await api.non_stream_request({'model':'gemini-3-pro','request':{}},record_logical=False)
    assert result.status_code == 504
    assert closed.is_set() and 479 < durations[0] <= 480
