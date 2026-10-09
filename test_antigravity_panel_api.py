"""Legacy list and batch boundaries for the optimized Antigravity path."""
import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from src.panel import creds
from src.models import CredFileBatchTestRequest
from src.storage.antigravity_panel import PanelListBusy, PanelListChanged
from src.antigravity_panel_budget import PanelBudgetConfigError

pytestmark = pytest.mark.asyncio


def summary():
    return {"items": [], "total": 0, "stats": {"total": 0},
            "model_access_summary": {"total": 0}, "quota_group_filter_supported": True}


async def install(monkeypatch, reader):
    backend = SimpleNamespace(SUPPORTS_QUOTA_GROUP_FILTER=True,
                              model_access_storage_ready=True,
                              get_antigravity_panel_summary=reader,
                              model_access_list_family_public=AsyncMock(side_effect=AssertionError("full family read")),
                              model_access_list_public=AsyncMock(side_effect=AssertionError("full native read")),
                              get_credentials_summary=AsyncMock(side_effect=AssertionError("legacy full read")))
    adapter = SimpleNamespace(_backend=backend, get_backend_info=AsyncMock(return_value={"backend_type": "synthetic"}))
    monkeypatch.setattr(creds, "get_storage_adapter", AsyncMock(return_value=adapter))
    return backend


async def test_optimized_route_has_no_full_read_and_preserves_filters(monkeypatch):
    reader = AsyncMock(return_value=summary())
    await install(monkeypatch, reader)
    response = await creds.get_creds_status_common(25, 25, "enabled", "antigravity",
        error_code_filter="403", cooldown_filter="all", tier_filter="pro", remark_filter="blue",
        model_access_filter="supported", model_access_family="claude-opus-4-6")
    assert response.status_code == 200
    reader.assert_awaited_once()
    assert reader.call_args.kwargs == dict(offset=25, limit=25, status_filter="enabled",
        error_code_filter="403", cooldown_filter=None, preview_filter=None, tier_filter="pro",
        remark_filter="blue", model_access_filter="supported", model_access_tier="any",
        model_access_family="claude-opus-4-6")
    assert "antigravity.model_access.family_filter" in json.loads(response.body)["panel_capabilities"]


@pytest.mark.parametrize("error,status,code", [
    (PanelListBusy(), 503, "credential_list_queue_full"),
    (PanelListChanged(), 503, "credential_list_changed"),
    (TimeoutError(), 504, "credential_list_timeout"),
    (PanelBudgetConfigError("private-value"), 503, "credential_list_budget_configuration"),
])
async def test_safe_list_failures_are_not_capability_downgrades(monkeypatch,error,status,code):
    await install(monkeypatch, AsyncMock(side_effect=error))
    response = await creds.get_creds_status_common(0, 25, "all", "antigravity")
    assert response.status_code == status
    data = json.loads(response.body)
    assert data["error_code"] == code and "stats" not in data and "capability" not in data
    assert b"private-value" not in response.body


async def test_entry_budget_includes_adapter_initialization(monkeypatch):
    from src import antigravity_panel_budget
    entered = asyncio.Event()
    async def slow():
        entered.set()
        await asyncio.sleep(1)
    monkeypatch.setattr(creds, "get_storage_adapter", slow)
    monkeypatch.setattr(antigravity_panel_budget, "panel_list_budget", lambda: .01)
    response = await creds.get_creds_status_common(0, 25, "all", "antigravity")
    assert entered.is_set() and response.status_code == 504


async def test_invalid_chain_never_initializes_storage(monkeypatch):
    monkeypatch.setenv("ANTIGRAVITY_PANEL_CHAIN_TIMEOUT_SECONDS", "10")
    init = AsyncMock(side_effect=AssertionError("must not read"))
    monkeypatch.setattr(creds, "get_storage_adapter", init)
    response = await creds.get_creds_status_common(0, 25, "all", "antigravity")
    assert response.status_code == 503
    init.assert_not_called()


async def test_batch_passes_disconnect_request_and_keeps_result_order(monkeypatch):
    from src.panel import antigravity_manual
    names = ["b.json", "a.json", "b.json"]
    rows = [{"filename": name, "success": False, "started": False,
             "error_code": "quota_timeout", "status_code": 504} for name in names]
    reader = AsyncMock(return_value=rows)
    monkeypatch.setattr(antigravity_manual, "batch_quota", reader)
    monkeypatch.setattr(creds, "get_storage_adapter", AsyncMock(side_effect=AssertionError("extra read")))
    connection = object()
    response = await creds.batch_refresh_cooldown(CredFileBatchTestRequest(filenames=names),
        mode="antigravity", _token="synthetic", http_request=connection)
    reader.assert_awaited_once_with(names, request=connection)
    data = json.loads(response.body)
    assert [row["filename"] for row in data["results"]] == names
    assert data["total_count"] == 3 and data["failure_count"] == 3
    assert data["model_access_summary"]["total"] == 0

@pytest.mark.parametrize('search,mode,status', [('a'*256,'antigravity',400),('1621','geminicli',400)])
async def test_search_validation_rejects_before_storage(monkeypatch,search,mode,status):
    init=AsyncMock(side_effect=AssertionError('must not read storage'))
    monkeypatch.setattr(creds,'get_storage_adapter',init)
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc:
        await creds.get_creds_status_common(0,25,'all',mode,search=search)
    assert exc.value.status_code == status
    init.assert_not_awaited()


async def test_search_normalizes_optimized_reader_and_empty_legacy_geminicli(monkeypatch):
    result={'items':[], 'total':0, 'stats':{'total':99}, 'model_access_summary':{'total':0}}
    reader=AsyncMock(return_value=result)
    backend=SimpleNamespace(get_antigravity_panel_summary=reader)
    adapter=SimpleNamespace(_backend=backend,get_backend_info=AsyncMock(return_value={'backend_type':'synthetic'}))
    monkeypatch.setattr(creds,'get_storage_adapter',AsyncMock(return_value=adapter))
    response=await creds.get_creds_status_common(0,25,'all','antigravity',search=' 001 ')
    assert reader.await_args.kwargs['search']=='001'
    assert 'antigravity.credentials.search' in json.loads(response.body)['panel_capabilities']
    backend.get_credentials_summary=AsyncMock(return_value=result)
    response=await creds.get_creds_status_common(0,25,'all','geminicli',search='   ')
    assert response.status_code==200
    assert 'search' not in backend.get_credentials_summary.await_args.kwargs


@pytest.mark.parametrize('search,expected', [('1621',['1621_one.json']),('ALPHA',['1621_one.json','16210_two.json']),('001',['001_three.json']),('%_',['001_three.json'])])
async def test_legacy_search_before_page_and_opus_summary_preserves_global_stats(monkeypatch,search,expected):
    rows=[{'filename':'1621_one.json','user_email':'Alpha@example.test'},
          {'filename':'16210_two.json','user_email':'ALPHA@other.test'},
          {'filename':'001_three.json','user_email':'a%_b@example.test'}]
    rows=[{**row,'disabled':False,'error_codes':[],'last_success':None} for row in rows]
    backend=SimpleNamespace(model_access_storage_ready=True,model_access_list_family_public=AsyncMock(return_value={}),
        get_credentials_summary=AsyncMock(return_value={'items':rows,'total':3,'stats':{'total':99}}))
    adapter=SimpleNamespace(_backend=backend,get_backend_info=AsyncMock(return_value={'backend_type':'synthetic'}))
    monkeypatch.setattr(creds,'get_storage_adapter',AsyncMock(return_value=adapter))
    response=await creds.get_creds_status_common(0,25,'all','antigravity',search=search)
    data=json.loads(response.body)
    assert [item['filename'] for item in data['items']]==expected
    assert data['total']==data['model_access_summary']['total']==len(expected)
    assert data['stats']['total']==99
    assert backend.get_credentials_summary.await_args.kwargs['offset']==0
    assert backend.get_credentials_summary.await_args.kwargs['limit'] is None
    assert 'antigravity.credentials.search' in data['panel_capabilities']

async def test_large_page_builds_email_annotations_once(monkeypatch):
    rows=[{"filename":f"credential-{i}.json","user_email":None,"disabled":False,
           "error_codes":[],"last_success":None} for i in range(1000)]
    reader=AsyncMock(return_value={"items":rows,"total":1000,"stats":{"total":1000},
                                  "model_access_summary":{"total":1000}})
    backend=SimpleNamespace(get_antigravity_panel_summary=reader)
    adapter=SimpleNamespace(_backend=backend,get_backend_info=AsyncMock(return_value={"backend_type":"synthetic"}))
    monkeypatch.setattr(creds,"get_storage_adapter",AsyncMock(return_value=adapter))
    calls=[]
    def annotations(filenames):
        calls.append(list(filenames))
        return {"credential-500.json":{"email_enrichment_status":"queued", "email_enrichment_reason":None}}
    def individual(filename):
        raise AssertionError("page must not scan the registry once per row")
    service=SimpleNamespace(annotations=annotations,annotate=individual,supports=lambda backend:False)
    monkeypatch.setattr(creds,"email_enrichment_service",service)
    response=await creds.get_creds_status_common(0,1000,"all","antigravity")
    assert len(calls)==1 and calls[0]==[row["filename"] for row in rows]
    result=json.loads(response.body)
    assert len(result["items"])==1000
    assert result["items"][500]["email_enrichment_status"]=="queued"
    assert "email_enrichment_status" not in result["items"][499]
