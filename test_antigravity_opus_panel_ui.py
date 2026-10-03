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
    internal = {"gemini-3.8-flash-tiered": {"quotaInfo": {
        "remainingFraction": 0.13, "resetTime": "2026-10-08T00:00:00Z",
    }}}
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
        "missing": {"claude-opus-5-5-low": current["claude-opus-5-5-low"],
                    "claude-opus-5-5-medium": {}},
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
    assert fixtures["mixed"]["models"]["claude-opus-4-6-thinking"]["visible"] is False
    assert fixtures["mixed"]["models"]["gemini-3.8-flash-tiered"]["public"] is False
    return fixtures


async def test_retired_opus_cards_probes_and_historical_stats(monkeypatch):
    node = shutil.which("node")
    if not node:
        pytest.skip("Node runtime unavailable")
    fixtures = await _backend_quota_fixtures(monkeypatch)
    source = (Path(__file__).parent / "front/common.js").read_text(encoding="utf-8")
    quota_start = source.index("async function _toggleQuotaDetails(")
    quota_end = source.index("\nasync function ", quota_start + 1)
    stats_start = source.index("const MODEL_FAMILY_DISPLAY =")
    stats_end = source.index("async function refreshTodayStats(", stats_start)
    helpers_start = source.index("function isRetiredAntigravityOpusModel(")
    script = "const backend = " + json.dumps(fixtures) + ";\n" + r'''
const assert = require('node:assert/strict');
let payload, status, fetches = [];
const content = {innerHTML: '', getAttribute: () => 'synthetic.json',
    querySelectorAll: () => [], insertAdjacentHTML: () => {}};
const details = {style: {display: 'none'}, querySelector: () => content};
global.document = {getElementById: () => details};
global.fetch = async (url) => {fetches.push(url); return {ok: true, status: 200, json: async () => payload};};
global.getAuthHeaders = () => ({});
global.escapeHtml = global.escapeHtmlAttribute = String;
global.manualResultSummary = () => '';
global.manualUpdateIncomplete = () => false;
global.showStatus = (text, tone) => {status = {text, tone};};
global.showMessageModal = () => {};
global.setTimeout = (callback) => callback();
''' + source[quota_start:quota_end] + "\n" + source[stats_start:stats_end] + "\n" + source[helpers_start:] + r'''
(async () => {
    const retired = ['claude-opus-4-6', 'claude-opus-4-6-thinking', 'claude-opus-4.6-high',
        ' CLAUDE-OPUS-4-6-LOW ', '假流式/claude-opus-4-6', '抗截断/claude-opus-4.6',
        '流式抗截断/ 假流式/ CLAUDE-OPUS-4-6-thinking ',
        'models/claude-opus-4-6-thinking', 'arbitrary/claude-opus-4.6-high',
        'models/ CLAUDE-OPUS-4-6 ', 'claude-opus-4-6/foo', 'claude-opus-4.6/',
        'prefix-claude-opus-4-6-thinking', 'notclaude-opus-4.6-high'];
    for (const model of retired) assert.equal(isRetiredAntigravityOpusModel(model), true);
    for (const model of ['claude-opus-4-60', 'models/prefix-claude-opus-4-60/foo',
        'notclaude-opus-4.60/', 'claude-sonnet-5-5', 'claude-opus-5-5-low',
        'claude-opus-5-5-medium', 'claude-opus-5-5-high']) {
        assert.equal(isRetiredAntigravityOpusModel(model), false);
    }

    async function render(models, mode = 'antigravity') {
        details.style.display = 'none';
        payload = {success: true, models};
        await _toggleQuotaDetails('synthetic', mode);
        assert.doesNotMatch(content.innerHTML, /网络错误/);
        return content.innerHTML;
    }
    const live = backend.live.models;
    const cardStart = '<div style="background: white; border-left:';
    function modelCards(html) {
        return html.split(cardStart).slice(1).map(card => card.split('<div data-quota-model-group=')[0]);
    }
    const mixedBefore = JSON.stringify(backend.mixed);
    const mixedHtml = await render(backend.mixed.models);
    const publicHtml = mixedHtml.split('data-quota-model-group="public"')[1]
        .split('data-quota-model-group="compatible"')[0];
    const compatibleHtml = mixedHtml.split('data-quota-model-group="compatible"')[1];
    assert.match(publicHtml, /终端可选模型/);
    assert.equal(modelCards(publicHtml).length, 3);
    assert.doesNotMatch(publicHtml, /内部\/兼容|data-model-availability=/);
    assert.doesNotMatch(mixedHtml, /claude-opus-4-6|99%/);
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
    assert.match(missingHtml, /data-quota-model-group="public"/);
    assert.doesNotMatch(missingHtml, /claude-opus-5-5-high|内部\/兼容/);
    const unknownCard = modelCards(missingHtml).find(card => card.includes('Claude Opus 5.5 (Medium)'));
    assert.match(unknownCard, /剩余未知 - N\/A/);
    assert.equal(backend.missing.models['claude-opus-5-5-medium'].remaining, null);
    assert.equal(backend.missing.models['claude-opus-5-5-medium'].resetTimeRaw, '');
    for (const legacy of [
        {'claude-opus-4-6-thinking': {remaining: 0.99}},
        {'claude-opus-4-6': {remaining: 0.99, visible: true, rawModelId: 'claude-opus-5-5-high'}},
        {'legacy-raw-card': {remaining: 0.99, rawModelId: 'claude-opus-4.6', visible: true}},
        {'legacy-test-card': {remaining: 0.99, testModel: '假流式/claude-opus-4-6-thinking'}},
        {'models/claude-opus-4-6-thinking': {remaining: 0.99}},
        {'legacy-path-card': {remaining: 0.99, testModel: 'arbitrary/claude-opus-4.6-high'}},
        {'legacy-suffix-card': {remaining: 0.99, rawModelId: 'claude-opus-4-6/foo'}},
        {'claude-opus-4.6/': {remaining: 0.99}},
        {'prefix-claude-opus-4-6-thinking': {remaining: 0.99}},
        {'legacy-keyword-card': {remaining: 0.99, testModel: 'notclaude-opus-4.6-high'}},
    ]) {
        const models = {...legacy, ...live, 'hidden-card': {remaining: 0.9, visible: false}};
        const before = JSON.stringify(models);
        const html = await render(models);
        assert.equal((html.match(/onclick="testModelQuota/g) || []).length, 3);
        for (const name of Object.keys(legacy)) assert.ok(!html.includes(name));
        assert.ok(!html.includes('hidden-card'));
        for (const name of Object.keys(live)) assert.ok(html.includes(name));
        for (const remaining of [25, 50, 75]) assert.ok(html.includes(`${remaining}%`));
        assert.ok(!html.includes('99%'));
        assert.equal(JSON.stringify(models), before);
    }
    const onlyOld = await render(backend.onlyOld.models);
    assert.ok(!onlyOld.includes('onclick="testModelQuota'));
    assert.ok(!onlyOld.includes('claude-opus-5-5'));
    const cli = await render({'claude-opus-4-6': {remaining: 0.9}}, 'geminicli');
    assert.ok(cli.includes('claude-opus-4-6'));

    fetches = [];
    for (const model of retired) await testModelQuota(button, 'synthetic.json', model, 'antigravity');
    assert.equal(fetches.length, 0);
    assert.match(status.text, /刷新.*Claude Opus 5.5/);
    assert.equal(button.disabled, false);
    payload = {success: true};
    for (const model of Object.keys(live)) await testModelQuota(button, 'synthetic.json', model, 'antigravity');
    await testModelQuota(button, 'synthetic.json', 'claude-opus-4-6', 'geminicli');
    assert.equal(fetches.length, 4);

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
