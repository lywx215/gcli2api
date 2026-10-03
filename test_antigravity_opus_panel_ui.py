"""Run the panel's actual quota rendering and probe functions without a browser."""
from pathlib import Path
import shutil
import subprocess

import pytest


def test_retired_opus_cards_probes_and_historical_stats():
    node = shutil.which("node")
    if not node:
        pytest.skip("Node runtime unavailable")
    source = (Path(__file__).parent / "front/common.js").read_text(encoding="utf-8")
    quota_start = source.index("async function _toggleQuotaDetails(")
    quota_end = source.index("\nasync function ", quota_start + 1)
    stats_start = source.index("const MODEL_FAMILY_DISPLAY =")
    stats_end = source.index("async function refreshTodayStats(", stats_start)
    helpers_start = source.index("function isRetiredAntigravityOpusModel(")
    script = r'''
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
    const live = Object.fromEntries(['low', 'medium', 'high'].map((tier, i) => {
        const name = `claude-opus-5-5-${tier}`;
        return [name, {remaining: (i + 1) / 4, public: true, testModel: name}];
    }));
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
    const onlyOld = await render({'claude-opus-4-6': {remaining: 0.9}});
    assert.ok(!onlyOld.includes('onclick="testModelQuota'));
    assert.ok(!onlyOld.includes('claude-opus-5-5'));
    const cli = await render({'claude-opus-4-6': {remaining: 0.9}}, 'geminicli');
    assert.ok(cli.includes('claude-opus-4-6'));

    const button = {textContent: '测试', disabled: false, style: {}};
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
