"""Run the panel's actual quota rendering and probe functions without a browser."""
import json
from pathlib import Path
import shutil
import subprocess

import pytest

from src.api import antigravity as antigravity_api


async def _backend_quota_fixtures(monkeypatch):
    """Exercise production metadata conversion; never supply public/UI flags."""
    current = {
        f"claude-opus-5-5-{tier}": {"quotaInfo": {
            "remainingFraction": (index + 1) / 4,
            "resetTime": f"2026-10-0{index + 4}T00:00:00Z",
        }} for index, tier in enumerate(("low", "medium", "high"))
    }
    retired = {"claude-opus-4-6-thinking": {"quotaInfo": {
        "remainingFraction": 0.99, "resetTime": "2026-10-07T00:00:00Z",
    }}}
    internal = {"gemini-3.8-flash-tiered": {
        # Labels do not establish the actual routing ID or an available Opus tier.
        "displayName": "Claude Opus 5.5 (High)", "model": "claude-opus-5-5-high",
        "quotaInfo": {"remainingFraction": 0.13, "resetTime": "2026-10-08T00:00:00Z"},
    }}
    upstream = {}

    class Response:
        status_code = 200
        headers = {}

        def json(self):
            return {"models": upstream}

    async def fake_post_async(**kwargs):
        assert kwargs["url"] == "https://antigravity.invalid/v1internal:fetchAvailableModels"
        return Response()

    async def fake_url():
        return "https://antigravity.invalid"

    monkeypatch.setattr(antigravity_api, "post_async", fake_post_async)
    monkeypatch.setattr(antigravity_api, "get_antigravity_api_url", fake_url)
    fixtures = {}
    for name, upstream in {
        "live": current,
        "mixed": {**retired, **current, **internal},
        "onlyOld": retired,
        "empty": {},
        "internal": internal,
        "missing": {"claude-opus-5-5-low": current["claude-opus-5-5-low"],
                    "claude-opus-5-5-medium": {}},
        **{f"only_{tier}": {f"claude-opus-5-5-{tier}": current[f"claude-opus-5-5-{tier}"]}
           for tier in ("low", "medium", "high")},
    }.items():
        response = await antigravity_api.fetch_quota_info("synthetic-access-token")
        assert response["success"] is True
        assert set(response["models"]) == set(upstream)
        for model, raw in upstream.items():
            entry = response["models"][model]
            quota = raw.get("quotaInfo", {})
            assert entry["rawModelId"] == model
            assert entry["testModel"] == model
            assert entry["remaining"] == quota.get("remainingFraction")
            assert entry["resetTimeRaw"] == quota.get("resetTime", "")
        fixtures[name] = response
    assert fixtures["mixed"]["models"]["claude-opus-4-6-thinking"]["visible"] is True
    assert fixtures["mixed"]["models"]["gemini-3.8-flash-tiered"]["public"] is False
    return fixtures


async def test_opus_version_cards_probes_and_historical_stats(monkeypatch):
    node = shutil.which("node")
    if not node:
        pytest.skip("Node runtime unavailable")
    fixtures = await _backend_quota_fixtures(monkeypatch)
    source = (Path(__file__).parent / "front/common.js").read_text(encoding="utf-8")
    quota_start = source.index("function modelAccessStatus(")
    quota_end = source.index("\nasync function ", source.index("async function _toggleQuotaDetails(") + 1)
    stats_start = source.index("const MODEL_FAMILY_DISPLAY =")
    stats_end = source.index("async function refreshTodayStats(", stats_start)
    helpers_start = source.index("function isVisibleAntigravityQuotaModel(")
    group_helpers = source[source.index("function formatCooldownTime("):source.index("function formatErrorCodeLabel(")]
    manual_helpers = source[source.index("function manualResultSummary("):source.index("async function testAntigravityCredential(")]
    script = "const backend = " + json.dumps(fixtures) + ";\n" + r'''
const assert = require('node:assert/strict');
let payload, status, responseOk = true, fetches = [];
const content = {innerHTML: '', getAttribute: () => 'synthetic.json',
    querySelectorAll: () => [], insertAdjacentHTML(position, html) {
        assert.equal(position, 'afterbegin');
        this.innerHTML = html + this.innerHTML;
    }};
const details = {isConnected: true, style: {display: 'none'}, querySelector: () => content};
global.AppState = {antigravityCreds:{data:{}}};
global.document = {getElementById: id => id === 'antigravity-manageTab' ? {classList: {contains: () => true}} : details};
global.window = {innerHeight: 800, innerWidth: 1200};
global.requestAnimationFrame = () => {};
content.isConnected = true;
content.querySelector = () => null;
global.fetch = async (url) => {fetches.push(url); return {ok: responseOk, status: responseOk ? 200 : 403, json: async () => payload};};
global.getAuthHeaders = () => ({});
global.escapeHtml = global.escapeHtmlAttribute = String;
global.showStatus = (text, tone) => {status = {text, tone};};
global.showMessageModal = () => {};
global.setTimeout = (callback) => callback();
''' + group_helpers + manual_helpers + source[quota_start:quota_end] + "\n" + source[stats_start:stats_end] + "\n" + source[helpers_start:] + r'''
(async () => {
    async function renderResponse(data, mode = 'antigravity', ok = true) {
        details.style.display = 'none';
        payload = data;
        responseOk = ok;
        fetches = [];
        await _toggleQuotaDetails('synthetic', mode);
        // Rendering notices must not probe a model or dispatch a management action.
        assert.deepEqual(fetches, [`./creds/quota/synthetic.json?mode=${mode}`]);
        assert.doesNotMatch(content.innerHTML, /网络错误/);
        return content.innerHTML;
    }
    async function render(models, mode = 'antigravity') {
        return renderResponse({success: true, models}, mode);
    }
    const access = Object.fromEntries(['claude-opus-5-5', 'claude-opus-4-6'].map(family => [family, {
        state: 'unavailable', reason: 'directory_missing', checked_at: 1791082800,
        next_check_at: 1791126000, blocked_until: 1791169200
    }]));
    const accessEmpty = await renderResponse({success: true, models: {}, model_access_families: access});
    assert.match(accessEmpty, /data-model-access/);
    assert.doesNotMatch(accessEmpty, /Low|Medium|High/);
    assert.equal((accessEmpty.match(/最近检查/g) || []).length, 2);
    assert.match(accessEmpty, /最近检查|下次复查|暂停期限/);
    assert.match(accessEmpty, /到期仍需目录确认/);
    assert.doesNotMatch(accessEmpty, /onclick="testModelQuota/);
    const failedAccess = Object.fromEntries(Object.entries(access).map(([id, value]) => [id, {...value, reason: 'directory_query_failed'}]));
    const accessFailed = await renderResponse({success: false, error: 'query failed', model_access_families: failedAccess}, 'antigravity', false);
    assert.match(accessFailed, /data-model-access/);
    assert.match(accessFailed, /目录查询失败，保留原限制/);
    assert.doesNotMatch(accessFailed, /已恢复/);
    const live = backend.live.models;
    const cardStart = /<div\b[^>]*\bdata-quota-card(?=[\s=>])(?:="[^"]*")?[^>]*>/;
    function modelCards(html) {
        return html.split(cardStart).slice(1).map(card => card.split(/<div[^>]*data-quota-model-group=/)[0].split(/<details[^>]*data-quota-extra/)[0]);
    }
    const mixedBefore = JSON.stringify(backend.mixed);
    const mixedHtml = await render(backend.mixed.models);
    assert.doesNotMatch(mixedHtml, /data-opus-catalog-notice/);
    assert.doesNotMatch(await renderResponse(backend.live), /data-opus-catalog-notice/);
    const publicHtml = mixedHtml.split('data-quota-model-group="public"')[1]
        .split('data-quota-model-group="compatible"')[0];
    const compatibleHtml = mixedHtml.split('data-quota-model-group="compatible"')[1];
    assert.match(publicHtml, /终端可选模型/);
    assert.equal(modelCards(publicHtml).length, 4);
    assert.doesNotMatch(publicHtml, /内部\/兼容|data-model-availability=/);
    assert.match(mixedHtml, /claude-opus-4-6/);
    assert.match(mixedHtml, /99%/);
    assert.match(compatibleHtml, /gemini-3.8-flash-tiered/);
    assert.match(compatibleHtml, /data-model-availability="compatible"/);
    assert.doesNotMatch(publicHtml, /gemini-3.8-flash-tiered/);
    assert.equal(JSON.stringify(backend.mixed), mixedBefore);
    const button = {textContent: '测试', disabled: false, style: {}};
    for (const [index, tier] of ['low', 'medium', 'high'].entries()) {
        const model = `claude-opus-5-5-${tier}`;
        const display = `Claude Opus 5.5 (${tier[0].toUpperCase() + tier.slice(1)})`;
        const card = modelCards(publicHtml).find(card => card.includes(`(原始: ${model})`));
        assert.ok(card, `Missing public card for ${model}`);
        assert.ok(card.includes(display));
        assert.ok(card.includes(`剩余${(index + 1) * 25}% - 10-0${index + 4} 08:00`));
        assert.doesNotMatch(card, /data-model-availability=|内部\/兼容/);
        const onclick = card.match(/onclick="([^"]+)"/)[1];
        fetches = [];
        payload = {success: true};
        // Execute the generated button handler, not a manually chosen model ID.
        const click = new Function('testModelQuota', `return function () { return ${onclick}; };`)(testModelQuota);
        await click.call(button);
        assert.deepEqual(fetches, [`./creds/test/synthetic.json?mode=antigravity&model=${model}`]);
        assert.equal(button.disabled, false);
    }
    const missingHtml = await render(backend.missing.models);
    assert.equal(modelCards(missingHtml).length, 2);
    assert.doesNotMatch(missingHtml, /data-opus-catalog-notice/);
    assert.match(missingHtml, /data-quota-model-group="public"/);
    assert.doesNotMatch(missingHtml.split(/<details[^>]*data-quota-extra/)[0], /claude-opus-5-5-high|内部\/兼容/);
    const unknownCard = modelCards(missingHtml).find(card => card.includes('Claude Opus 5.5 (Medium)'));
    assert.match(unknownCard, /剩余未知 - N\/A/);
    assert.equal(backend.missing.models['claude-opus-5-5-medium'].remaining, null);
    assert.equal(backend.missing.models['claude-opus-5-5-medium'].resetTimeRaw, '');
    for (const tier of ['low', 'medium', 'high']) {
        const html = await renderResponse(backend[`only_${tier}`]);
        const missingLabels = ['Low', 'Medium', 'High'].filter(label => label.toLowerCase() !== tier).join('、');
        assert.doesNotMatch(html, /data-opus-catalog-notice/);
        assert.equal(modelCards(html).length, 1);
        assert.equal((html.match(/onclick="testModelQuota/g) || []).length, 1);
        assert.ok(html.includes(`'claude-opus-5-5-${tier}', 'antigravity'`));
    }
    for (const legacy of [
        {'claude-opus-4-6-thinking': {remaining: 0.99}},
        {'legacy-raw-card': {remaining: 0.99, rawModelId: 'claude-opus-4-6-thinking', visible: true}},
        {'legacy-test-card': {remaining: 0.99, testModel: 'claude-opus-4-6-thinking'}},
    ]) {
        const models = {...legacy, ...live, 'hidden-card': {remaining: 0.9, visible: false}};
        const before = JSON.stringify(models);
        const html = await render(models);
        assert.equal((html.match(/onclick="testModelQuota/g) || []).length, 4);
        for (const name of Object.keys(legacy)) assert.ok(html.includes(name));
        assert.ok(!html.includes('hidden-card'));
        assert.ok(html.includes('99%'));
        assert.equal(JSON.stringify(models), before);
    }
    for (const scenario of ['onlyOld', 'empty', 'internal']) {
        const before = JSON.stringify(backend[scenario]);
        const html = await renderResponse(backend[scenario]);
        const notice = html.match(/<div\b[^>]*data-opus-catalog-notice[^>]*>([^<]+)<\/div>/)[1];
        assert.equal(notice, '本次 Google 官方模型目录未返回 Claude Opus 5.5，暂无对应额度或可测试模型。');
        if (scenario !== 'onlyOld') assert.doesNotMatch(html, /testModelQuota\(this, 'synthetic.json', 'claude-opus/);
        assert.equal(modelCards(html).length, scenario === 'empty' ? 0 : 1);
        assert.equal(JSON.stringify(backend[scenario]), before);
        if (scenario === 'internal') {
            assert.match(html, /data-model-availability="compatible"/);
            assert.match(html, /gemini-3\.8-flash-tiered/);
        }
    }
    // Missing/invalid model maps and failed responses cannot establish catalog absence.
    for (const models of [undefined, null, []]) {
        assert.doesNotMatch(await renderResponse({success: true, models}), /data-opus-catalog-notice/);
    }
    for (const [ok, success] of [[true, false], [false, false], [false, true]]) {
        const html = await renderResponse({success, models: {}, error: 'synthetic failure'}, 'antigravity', ok);
        assert.match(html, /获取额度信息失败/);
        assert.doesNotMatch(html, /data-opus-catalog-notice|目录未返回|账号/);
    }
    const cli = await render({'claude-opus-4-6': {remaining: 0.9}}, 'geminicli');
    assert.ok(cli.includes('claude-opus-4-6'));
    assert.doesNotMatch(cli, /data-opus-catalog-notice|data-quota-card|data-quota-extra|ag-quota-view/);
    assert.match(cli, /background: linear-gradient/);

    fetches = [];
    payload = {success: true};
    for (const model of [...Object.keys(live), 'claude-opus-4-6-thinking']) await testModelQuota(button, 'synthetic.json', model, 'antigravity');
    assert.equal(fetches.length, 4);
    assert.ok(fetches[3].endsWith('model=claude-opus-4-6-thinking'));
    assert.equal(button.disabled, false);

    const table = {innerHTML: ''};
    _renderModelStatsRows({'claude-opus-4-6': {success: 2, total: 2},
        'claude-opus-5-5': {success: 3, total: 3}}, table, false);
    assert.match(table.innerHTML, /Claude Opus 4.6/);
    assert.match(table.innerHTML, /Claude Opus 5.5/);
    assert.equal((table.innerHTML.match(/<tr /g) || []).length, 2);
})().catch(error => {console.error(error); process.exitCode = 1;});
'''
    result = subprocess.run([node, "-"], input=script, text=True, encoding="utf-8", capture_output=True)
    assert result.returncode == 0, result.stderr
