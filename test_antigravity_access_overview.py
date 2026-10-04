"""Cached permission overview, filtering across pages, and batch selection."""
import copy
import json
from pathlib import Path
import shutil
import subprocess
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from src.antigravity_model_access import MODELS, VALID_FOR, display_status, filter_summaries
from src.panel import creds
from test_antigravity_model_access import access_store, observe, NAME
from test_antigravity_quota_backends import backend


def entries(states, now=100000):
    return {model: {"state": state, "checked_at": now}
            for model, state in zip(MODELS, states)}


@pytest.mark.parametrize("states,expected", [
    (("supported", "supported", "supported"), ("supported", "supported")),
    (("supported", "unavailable", "unknown"), ("supported", "unavailable")),
    (("unknown", "unavailable", "unknown"), ("unknown", "unavailable")),
    (("unavailable", "unavailable", "unavailable"), ("unavailable", "unavailable")),
    (("unknown", "unknown", "unknown"), ("unknown", "unknown")),
])
def test_partial_evidence_aggregation(states, expected):
    data = entries(states)
    assert display_status(data, "any", 100001) == expected[0]
    assert display_status(data, "all_tiers", 100001) == expected[1]
    for tier, state in zip(("low", "medium", "high"), states):
        assert display_status(data, tier, 100001) == state


def test_expiry_future_and_pause_do_not_manufacture_permissions():
    positive = entries(["supported"] * 3)
    assert display_status(positive, now=100000 + VALID_FOR - 1) == "supported"
    assert display_status(positive, now=100000 + VALID_FOR) == "unknown"
    assert display_status(positive, now=99999) == "unknown"
    negative = entries(["unavailable"] * 3)
    assert display_status(negative, now=100000 + 100 * VALID_FOR) == "unavailable"


def test_hundreds_filter_before_pagination_and_counts_before_access_filter():
    items = [{"filename": f"synthetic-{i}.json"} for i in range(601)]
    states = {item["filename"]: entries(["supported" if i % 3 == 0 else
              "unavailable" if i % 3 == 1 else "unknown"] * 3)
              for i, item in enumerate(items)}
    source = {"items": items, "total": 601, "stats": {"total": 777}}
    result = filter_summaries(source, states, offset=25, limit=25,
                              status="supported", tier="high", now=100001)
    assert result["total"] == 201
    assert [i["filename"] for i in result["items"]] == [f"synthetic-{i}.json" for i in range(75, 150, 3)]
    assert result["model_access_summary"]["counts"]["high"] == {
        "supported": 201, "unavailable": 200, "unknown": 200}
    assert result["model_access_summary"]["total"] == 601
    assert result["stats"] == {"total": 777}
    assert "model_access_state" not in source["items"][0]


async def test_real_list_disabled_corrupt_replaced_and_no_secret_projection(access_store):
    store = access_store
    await observe(store, MODELS)
    await store.update_credential_state(NAME, {"disabled": True}, "antigravity")
    await store.store_credential("unknown.json", {"refresh_token": "synthetic-only"}, "antigravity")
    states = await store.model_access_list_public()
    assert display_status(states[NAME]) == "supported"  # include disabled in the overview
    assert display_status(states["unknown.json"]) == "unknown"
    serialized = json.dumps(states)
    for private in ("refresh_token", "synthetic-only", "identity", "revision", "lease", "credential_data"):
        assert private not in serialized
    # Replacing credential contents invalidates previously saved permission evidence.
    await store.store_credential(NAME, {"refresh_token": "different-synthetic-account"}, "antigravity")
    assert display_status((await store.model_access_list_public())[NAME]) == "unknown"
    import aiosqlite
    async with aiosqlite.connect(store._db_path) as conn:
        await conn.execute("UPDATE antigravity_credentials SET model_access_state = 'invalid' WHERE filename = ?", (NAME,))
        await conn.commit()
    assert display_status((await store.model_access_list_public())[NAME]) == "unknown"
    store.model_access_storage_ready = False
    assert await store.model_access_list_public() == {}


async def test_panel_combines_existing_filters_without_upstream_or_writes(access_store, monkeypatch):
    store = access_store
    for name, tier, models in ((NAME, "pro", [MODELS[0]]),
                               ("yes.json", "pro", MODELS), ("no.json", "free", [])):
        if name != NAME:
            await store.store_credential(name, {"access_token": "synthetic"}, "antigravity")
        await store.update_credential_state(name, {"tier": tier, "remark": "group"}, "antigravity")
        await observe(store, models, name=name)
    async def info(): return {"backend_type": "sqlite"}
    async def adapter(): return SimpleNamespace(_backend=store, get_backend_info=info)
    monkeypatch.setattr(creds, "get_storage_adapter", adapter)
    before = await store.model_access_list_public()
    response = await creds.get_creds_status_common(0, 25, "enabled", "antigravity",
        tier_filter="pro", remark_filter="group", model_access_filter="supported", model_access_tier="high")
    data = json.loads(response.body)
    assert data["total"] == 1 and data["items"][0]["filename"] == "yes.json"
    assert data["model_access_summary"]["total"] == 2
    assert data["model_access_summary"]["counts"]["high"]["unavailable"] == 1
    assert not data["has_more"] and data["limit"] == 25
    assert "access_token" not in response.body.decode()
    assert await store.model_access_list_public() == before
    response = await creds.get_creds_status_common(25, 25, "all", "antigravity", model_access_filter="unknown")
    assert json.loads(response.body)["total"] == 0


@pytest.mark.parametrize("kwargs", [
    {"model_access_filter": "invalid"}, {"model_access_tier": "invalid"},
    {"mode": "geminicli", "model_access_filter": "supported"},
])
async def test_invalid_access_filters_rejected_before_storage(kwargs, monkeypatch):
    async def fail(): raise AssertionError("must not read storage")
    monkeypatch.setattr(creds, "get_storage_adapter", fail)
    with pytest.raises(HTTPException) as error:
        await creds.get_creds_status_common(0, 25, "all", **kwargs)
    assert error.value.status_code == 400


async def test_list_without_support_keeps_unknown_not_denied(monkeypatch):
    async def summary(**kwargs):
        assert kwargs["limit"] is None and kwargs["offset"] == 0
        return {"items": [{"filename": "unknown.json", "user_email": "", "disabled": False,
                  "error_codes": [], "last_success": None}], "total": 1}
    async def info(): return {}
    async def adapter(): return SimpleNamespace(_backend=SimpleNamespace(get_credentials_summary=summary), get_backend_info=info)
    monkeypatch.setattr(creds, "get_storage_adapter", adapter)
    response = await creds.get_creds_status_common(0, 25, "all", "antigravity", model_access_filter="unknown")
    data = json.loads(response.body)
    assert data["total"] == 1 and data["model_access_summary"]["counts"]["any"]["unknown"] == 1


async def test_all_backend_cached_projection_includes_disabled_and_tenant_fence(backend):
    store, db = backend
    store.model_access_storage_ready = True  # initialization is covered by the protection suite
    snapshot = await store.model_access_snapshot(db.row["filename"])
    await store.model_access_observe(db.row["filename"], snapshot, MODELS)
    db.row["disabled"] = True
    if store.QUOTA_ENGINE == "mongo":
        def find(query, projection):
            assert query == {}
            assert set(projection) == {"filename", "credential_data", "quota_credential_generation", "model_access_state"}
            class Cursor:
                async def to_list(self, length): return [copy.deepcopy(db.row)]
            return Cursor()
        db.find = find
    states = await store.model_access_list_public()
    assert display_status(states[db.row["filename"]]) == "supported"
    assert "identity" not in json.dumps(states) and "revision" not in json.dumps(states)
    if store.QUOTA_ENGINE != "mongo":
        query = db.queries[-1]
        assert "SELECT *" not in query
        if store.QUOTA_ENGINE == "mysql": assert "WHERE server_name = %s" in query


def test_frontend_filters_badges_and_cross_page_selection():
    node = shutil.which("node")
    if not node: pytest.skip("Node runtime unavailable")
    source = Path("front/common.js").read_text()
    manager = source[source.index("function createCredsManager("):source.index("function createUploadManager(")]
    helpers = source[source.index("function modelAccessStatus("):source.index("async function _toggleQuotaDetails(")]
    card = source[source.index("function createCredCard("):source.index("async function updateCredRemark(")]
    script = manager + helpers + card + r'''
const assert = require('node:assert/strict');
const elements = new Map();
global.document = {getElementById(id) {
    if (!elements.has(id)) elements.set(id, {style: {}, innerHTML: '', value: 'all', textContent: ''});
    return elements.get(id);
}, querySelectorAll: () => [], createElement: () => ({innerHTML: '', querySelectorAll: () => []})};
global.window = {location: {href: 'http://localhost/control_panel'}};
global.getAuthHeaders = () => ({});
global.escapeHtml = global.escapeHtmlAttribute = String;
global.showStatus = () => {};
const now = Date.now() / 1000;
const mixed = {'claude-opus-5-5-low': {state: 'supported', checked_at: now},
    'claude-opus-5-5-medium': {state: 'unavailable'},
    'claude-opus-5-5-high': {state: 'supported', checked_at: now - 43200}};
assert.equal(modelAccessStatus(mixed, 'low'), 'supported');
assert.equal(modelAccessStatus(mixed, 'medium'), 'unavailable');
assert.equal(modelAccessStatus(mixed, 'high'), 'unknown');
assert.match(modelAccessBadges(mixed), /Low · 目录支持/);
assert.match(modelAccessBadges(mixed), /Medium · 暂不可用/);
assert.match(modelAccessBadges(mixed), /High · 待确认/);
assert.match(modelAccessResultText({success:false, model_access_state:mixed}), /查询失败.*已有证据/);
const batch = modelAccessBatchText([{success:true,model_access_state:mixed}, {success:false}]);
assert.match(batch, /至少一档：目录支持 1 \/ 暂不可用 0 \/ 待确认 1/);
assert.match(batch, /High：目录支持 0 \/ 暂不可用 0 \/ 待确认 2/);
const ag = createCredsManager('antigravity');
ag.currentModelAccessFilter = 'supported'; ag.currentModelAccessTier = 'high';
ag.currentRemarkFilter = 'group & 1';
let url = new URL(ag.getStatusUrl(25, 25), window.location.href);
assert.equal(url.searchParams.get('model_access_filter'), 'supported');
assert.equal(url.searchParams.get('model_access_tier'), 'high');
assert.equal(url.searchParams.get('remark_filter'), 'group & 1');
const legacy = createCredsManager('geminicli');
assert.ok(!legacy.getStatusUrl(0,25).includes('model_access'));
const info = {filename:'synthetic.json',status:{error_codes:[]},model_access_state:mixed};
assert.match(createCredCard(info, ag).innerHTML, /data-model-access-badges/);
assert.ok(!createCredCard(info, legacy).innerHTML.includes('data-model-access-badges'));
(async () => {
    const offsets = [];
    ag.selectedFiles.add('previous-selection.json');
    global.fetch = async request => {
        const u = new URL(request); const offset = Number(u.searchParams.get('offset'));
        offsets.push(offset);
        assert.equal(u.searchParams.get('model_access_tier'), 'high');
        return {ok:true, json:async () => ({items:Array.from({length:offset === 0 ? 1000 : 5}, (_,i) => ({filename:`synthetic-${offset+i}.json`})), has_more:offset===0})};
    };
    await ag.selectAllMatching();
    assert.deepEqual(offsets, [0,1000]);
    assert.equal(ag.selectedFiles.size,1005);
    assert.ok(!ag.selectedFiles.has('previous-selection.json'));
    const selected = [...ag.selectedFiles];
    global.fetch = async () => ({ok:false, json:async () => ({detail:'synthetic failure'})});
    await ag.selectAllMatching();
    assert.deepEqual([...ag.selectedFiles],selected);
    global.fetch = async () => ({ok:true, json:async () => ({items:[{filename:'fresh.json',error_codes:[],model_access_state:mixed}], total:1,
        model_access_summary:{total:5,counts:{high:{supported:1,unavailable:2,unknown:2}}},stats:{total:5}})});
    ag.renderList = ag.updatePagination = ag.updateStatsDisplay = () => {};
    await ag.refresh();
    assert.deepEqual(ag.data['fresh.json'].model_access_state, mixed);
    assert.match(elements.get('antigravityModelAccessOverview').textContent, /High：目录支持 1 \/ 暂不可用 2 \/ 待确认 2/);
    document.getElementById('antigravityModelAccessFilter').value='unknown';
    document.getElementById('antigravityModelAccessTier').value='medium';
    ag.refresh=()=>{}; ag.currentPage=5; ag.applyStatusFilter();
    assert.equal(ag.currentPage,1); assert.equal(ag.currentModelAccessFilter,'unknown'); assert.equal(ag.currentModelAccessTier,'medium');
})().catch(error => {console.error(error);process.exitCode=1;});
'''
    # Pass the extracted frontend through stdin, not Windows' bounded argv.
    result = subprocess.run([node], input=script, capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stdout + result.stderr
