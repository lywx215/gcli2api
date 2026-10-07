// Offline UI/transport regression tests. All requests and credential names are synthetic.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync('front/common.js', 'utf8');
const CAPS = ['antigravity.model_access.family_filter', 'antigravity.cooldown.group_filter'];
const tick = () => new Promise(resolve => setImmediate(resolve));
const page = (names = [], caps = CAPS) => ({items: names.map(filename => ({filename})), total: names.length, panel_capabilities: caps, stats: {}});
const success = filename => ({filename, success: true});

function harness({render = false} = {}) {
    const elements = new Map(), requests = [], timers = new Map(), intervals = new Map(), modals = [], statuses = [];
    let timerId = 0;
    const escaped = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    class Element {
        constructor(id = '') { this.id = id; this.dataset = {}; this.style = {}; this.children = []; this.attrs = {}; this.options = [];
            this.value = 'all'; this.disabled = false; this.hidden = false; this.checked = false; this.parentElement = null; this.root = false;
            this.classes = new Set(); this._html = ''; this.textContent = ''; this.listeners = {};
            this.classList = {add: x => this.classes.add(x), remove: x => this.classes.delete(x), contains: x => this.classes.has(x),
                toggle: x => { if (this.classes.has(x)) { this.classes.delete(x); return false; } this.classes.add(x); return true; }};
        }
        get className() { return [...this.classes].join(' '); }
        set className(value) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
        get innerHTML() { return this._html || escaped(this.textContent); }
        set innerHTML(value) { for (const child of this.children) child.parentElement = null; this.children = []; this._html = value; this.textContent = ''; }
        get isConnected() { return this.root || !!this.parentElement?.isConnected; }
        appendChild(child) { child.remove(); this.children.push(child); child.parentElement = this; return child; }
        remove() { if (this.parentElement) { const siblings = this.parentElement.children; siblings.splice(siblings.indexOf(this), 1); this.parentElement = null; } }
        replaceWith(child) { const parent = this.parentElement; if (!parent) return; child.remove(); const index = parent.children.indexOf(this); parent.children[index] = child; child.parentElement = parent; this.parentElement = null; }
        setAttribute(name, value) { this.attrs[name] = String(value); }
        getAttribute(name) { if (name === 'data-filename') return this.attrs[name] ?? this.dataset.filename ?? null; return this.attrs[name] ?? null; }
        addEventListener(name, fn) { this.listeners[name] = fn; }
        all() { return this.children.flatMap(child => [child, ...child.all()]); }
        querySelectorAll(selector) {
            if (selector === '.cred-details .cred-content') return this.all().filter(e => e.classes.has('cred-content') && e.parentElement?.classes.has('cred-details'));
            if (selector.startsWith('.')) return this.all().filter(e => e.classes.has(selector.slice(1)));
            if (selector.startsWith('#')) return this.all().filter(e => e.id === selector.slice(1));
            if (/^\[([^\]]+)\]$/.test(selector)) return this.all().filter(e => e.getAttribute(selector.slice(1, -1)) !== null);
            return [];
        }
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
        getBoundingClientRect() { return {top: 0, bottom: 10, left: 0, width: 100, height: 10}; }
    }
    const el = id => { const e = new Element(id); e.root = true; elements.set(id, e); return e; };
    for (const m of fs.readFileSync('front/control_panel.html', 'utf8').matchAll(/\bid="([^"]+)"/g)) el(m[1]);
    const document = {hidden: false, body: new Element(), documentElement: {clientHeight: 800},
        getElementById: id => elements.get(id) || [...elements.values()].flatMap(e => e.all()).find(e => e.id === id) || null,
        createElement: () => new Element(),
        querySelectorAll: selector => [...elements.values()].flatMap(e => e.querySelectorAll(selector)),
        querySelector: () => null, addEventListener() {}, removeEventListener() {}};
    document.body.root = true;
    const window = {location: {href: 'https://synthetic.invalid/', hash: '#antigravity-manage'}, innerHeight: 800,
        localStorage: {getItem: () => null, setItem() {}, removeItem() {}}, addEventListener() {}};
    const c = {window, document, URL, URLSearchParams, Set, Map, Date, Promise, console, AbortController,
        btoa: value => Buffer.from(value, 'binary').toString('base64'), requestAnimationFrame() {},
        setTimeout: (fn, ms) => {const id = ++timerId; timers.set(id, {fn, ms}); return id;}, clearTimeout: id => timers.delete(id),
        setInterval: (fn, ms) => {const id = ++timerId; intervals.set(id, {fn, ms}); return id;}, clearInterval: id => intervals.delete(id),
        confirm: () => true, fetch: (url, options = {}) => new Promise((resolve, reject) => requests.push({url, options, resolve, reject}))};
    vm.createContext(c);
    vm.runInContext(source + '\nglobalThis.state = AppState;', c);
    c.showStatus = (...args) => statuses.push(args);
    c.showMessageModal = (...args) => modals.push(args);
    c.state.sessionEpoch = 1; c.state.sessionReady = true; c.state.authToken = 'synthetic';
    const ag = c.state.antigravityCreds;
    ag.applyCapabilities(CAPS); ag.updatePagination = () => {}; ag.updateStatsDisplay = () => {};
    const realRender = ag.renderList;
    if (!render) ag.renderList = () => ag.updateBatchControls();
    c.createCredCard = (info, manager) => {
        const card = new Element(); card.dataset.filename = info.filename; card.className = 'cred-card';
        for (const cls of ['cred-header', 'cred-actions']) { const part = new Element(); part.className = cls; part.textContent = String(info.status?.disabled); card.appendChild(part); }
        const badges = new Element(); badges.setAttribute('data-model-access-badges', ''); card.appendChild(badges);
        const pathId = 'ag_' + c.btoa(encodeURIComponent(info.filename)).replace(/[+/=]/g, '_');
        for (const kind of ['details', 'errors', 'quota']) {
            const detail = new Element(kind + '-' + pathId); detail.className = kind === 'quota' ? 'cred-quota-details' : 'cred-details'; detail.style.display = 'none';
            const content = new Element(); content.className = kind === 'quota' ? 'cred-quota-content' : 'cred-content';
            content.setAttribute('data-filename', info.filename); content.setAttribute('data-loaded', 'false'); detail.appendChild(content); card.appendChild(detail);
        }
        return card;
    };
    const reply = (i, data, status = 200) => requests[i].resolve({ok: status >= 200 && status < 300, status, json: async () => data});
    const replyBatch = (i, transform = success) => reply(i, {results: JSON.parse(requests[i].options.body).filenames.map(transform)});
    const select = count => { ag.selectedFiles = new Set(Array.from({length: count}, (_, i) => `synthetic-${i}.json`)); ag.updateBatchControls(); };
    const loadCards = names => { ag.filteredData = ag.data = Object.fromEntries(names.map(filename => [filename, {filename, status: {disabled: false}}])); ag.totalCount = names.length; realRender.call(ag); };
    elements.get('antigravity-manageTab').classList.add('active');
    return {c, ag, elements, requests, timers, intervals, modals, statuses, reply, replyBatch, select, loadCards, Element};
}

test('same-key refresh is one exact promise; query/page changes abort and reject stale writes', async () => {
    const h = harness(); const first = h.ag.refresh(), joined = h.ag.refresh();
    assert.equal(first, joined); assert.equal(h.requests.length, 1);
    h.ag.currentPage = 2; const next = h.ag.refresh(); assert.equal(h.requests[0].options.signal.aborted, true);
    h.reply(0, page(['old.json'])); await first; assert.equal(h.elements.get('antigravityCredsLoading').style.display, 'block');
    h.reply(1, page(['new.json'])); await next; assert.deepEqual(Object.keys(h.ag.data), ['new.json']);
});

test('afterMutation never joins a pre-write GET; an expected abort is silent', async () => {
    const h = harness(); const old = h.ag.refresh(); const after = h.ag.refresh({afterMutation: true, silent: true});
    assert.notEqual(old, after); assert.equal(h.requests.length, 2); assert.equal(h.requests[0].options.signal.aborted, true);
    h.requests[0].reject(Object.assign(new Error('cancelled'), {name: 'AbortError'})); await old;
    h.reply(1, page(['fresh.json'])); await after; assert.deepEqual(Object.keys(h.ag.data), ['fresh.json']); assert.equal(h.statuses.length, 0);
});

test('capability recovery is one replacement request, even with unchanged filter URL', async () => {
    for (const status of [200, 501]) {
        const h = harness(); const pending = h.ag.refresh();
        h.reply(0, status === 200 ? page([], []) : {capability: CAPS[0]}, status); await tick();
        assert.equal(h.requests.length, 2);
        h.reply(1, {capability: CAPS[1]}, 501); await pending; assert.equal(h.requests.length, 2);
    }
});

test('logout aborts list GET and old finally cannot hide a new session loader', async () => {
    const h = harness(); const old = h.ag.refresh(); h.c.stopPanelSession();
    assert.equal(h.requests[0].options.signal.aborted, true);
    h.c.beginPanelSession('new-synthetic'); const fresh = h.ag.refresh();
    h.reply(0, page(['old.json'])); await old; assert.equal(h.elements.get('antigravityCredsLoading').style.display, 'block');
    h.reply(1, page(['new.json'])); await fresh; assert.deepEqual(Object.keys(h.ag.data), ['new.json']);
});

test('23 frozen unique filenames run 10/10/3 sequentially and results precede one final fresh GET', async () => {
    const h = harness(); h.select(23);
    const pending = h.c.batchRefreshCooldownSelectedAntigravityCredentials();
    assert.equal(h.requests.length, 1); assert.equal(JSON.parse(h.requests[0].options.body).filenames.length, 10);
    h.ag.selectedFiles.clear(); h.ag.currentStatusFilter = 'disabled'; h.ag.invalidateFilters();
    assert.equal(h.elements.get('antigravityBatchRefreshCooldownBtn').disabled, true);
    await h.c.batchRefreshCooldownSelectedAntigravityCredentials(); assert.equal(h.requests.length, 1);
    h.replyBatch(0); await tick(); assert.equal(h.requests.length, 2); assert.equal(JSON.parse(h.requests[1].options.body).filenames.length, 10);
    h.replyBatch(1); await tick(); assert.equal(h.requests.length, 3); assert.equal(JSON.parse(h.requests[2].options.body).filenames.length, 3);
    h.replyBatch(2); await pending;
    assert.equal(h.modals.length, 1); assert.equal(h.requests.length, 4); assert.match(h.requests[3].url, /creds\/status/);
    assert.equal(h.c.antigravityBatchCounts(h.ag.quotaBatch).success, 23);
    assert.match(h.elements.get('antigravityBatchQuotaProgressText').textContent, /23\/23/);
    assert.equal(h.elements.get('antigravityBatchQuotaProgress').hidden, false);
    h.reply(3, page()); await tick(); assert.equal(h.statuses.length, 0);
});

test('batch input deduplicates without changing filename spelling', async () => {
    const h = harness(); h.ag.selectedFiles = ['one.json', 'one.json', ' with spaces.json'];
    const pending = h.c.runAntigravityQuotaBatch(h.ag);
    assert.deepEqual(JSON.parse(h.requests[0].options.body).filenames, ['one.json', ' with spaces.json']);
    h.replyBatch(0); await pending; h.reply(1, page()); await tick();
});

test('cancel prevents future groups, waits for current POST and never passes an abort signal', async () => {
    const h = harness(); h.select(23); const pending = h.c.runAntigravityQuotaBatch(h.ag);
    h.c.cancelAntigravityQuotaBatch(); assert.equal(h.ag.quotaBatch.busy, true); assert.equal(h.modals.length, 0);
    assert.equal(h.requests[0].options.signal, undefined);
    assert.match(h.elements.get('antigravityBatchQuotaProgressText').textContent, /等待当前批次/);
    h.replyBatch(0); await pending;
    const counts = h.c.antigravityBatchCounts(h.ag.quotaBatch); assert.equal(counts.success, 10); assert.equal(counts.unexecuted, 13);
    assert.equal(h.requests.filter(r => r.options.method === 'POST').length, 1); h.reply(1, page()); await tick();
});

test('missing and duplicate rows become unknown; network loss never retries an uncertain POST', async () => {
    for (const failure of ['missing', 'duplicate', 'network', 'bad-json']) {
        const h = harness(); h.select(23); const pending = h.c.runAntigravityQuotaBatch(h.ag);
        if (failure === 'network') h.requests[0].reject(new Error('offline'));
        else if (failure === 'bad-json') h.requests[0].resolve({ok: true, json: async () => {throw new Error('invalid JSON');}});
        else {
            const names = JSON.parse(h.requests[0].options.body).filenames;
            const results = names.slice(1).map(success);
            if (failure === 'duplicate') results.push(success(names[0]), success(names[0]));
            h.reply(0, {results});
        }
        await pending; const counts = h.c.antigravityBatchCounts(h.ag.quotaBatch);
        assert.equal(counts.unknown, ['network', 'bad-json'].includes(failure) ? 10 : 1); assert.equal(counts.unexecuted, 13);
        assert.equal(h.requests.filter(r => r.options.method === 'POST').length, 1); h.reply(1, page()); await tick();
    }
});

test('started=false is unexecuted; started=true queue-full failures count toward 50% stop threshold', async () => {
    for (const fullCount of [4, 5]) {
        const h = harness(); h.select(11); const pending = h.c.runAntigravityQuotaBatch(h.ag);
        h.replyBatch(0, (filename, index) => index < fullCount ? {filename, success: false, started: index % 2 === 0, error_code: 'quota_queue_full'} : success(filename));
        await tick();
        if (fullCount === 4) { assert.equal(h.requests[1].options.method, 'POST'); h.replyBatch(1); }
        await pending; const counts = h.c.antigravityBatchCounts(h.ag.quotaBatch);
        assert.equal(counts.failure, Math.ceil(fullCount / 2));
        assert.equal(h.requests.filter(r => r.options.method === 'POST').length, fullCount === 5 ? 1 : 2);
        h.reply(h.requests.length - 1, page()); await tick();
    }
});

test('one configuration error stops future batches; response-wide no-start is not unknown', async () => {
    for (const whole of [false, true]) {
        const h = harness(); h.select(23); const pending = h.c.runAntigravityQuotaBatch(h.ag);
        if (whole) h.reply(0, {started: false, error_code: 'quota_budget_configuration'}, 503);
        else h.replyBatch(0, (filename, index) => index ? success(filename) : {filename, success: false, started: false, error_code: 'quota_budget_configuration'});
        await pending; const counts = h.c.antigravityBatchCounts(h.ag.quotaBatch);
        assert.equal(counts.unknown, 0); assert.equal(counts.unexecuted, whole ? 23 : 14);
        assert.match(h.ag.quotaBatch.stopReason, /配置/); h.reply(1, page()); await tick();
    }
});

test('pending overlays query success/failure and schedules only one 30-second read, never another POST', async () => {
    const h = harness(); h.select(2); const pending = h.c.runAntigravityQuotaBatch(h.ag);
    h.replyBatch(0, (filename, index) => ({filename, success: index === 0, state_update: {quota: {status: 'pending'}}})); await pending;
    const counts = h.c.antigravityBatchCounts(h.ag.quotaBatch); assert.equal(counts.success, 1); assert.equal(counts.failure, 1); assert.equal(counts.pending, 2);
    const timer = [...h.timers.values()].find(t => t.ms === 30000); assert(timer); h.reply(1, page()); await tick();
    timer.fn(); assert.equal(h.requests.length, 3); assert.equal(h.requests.filter(r => r.options.method === 'POST').length, 1);
    h.reply(2, page()); await tick(); assert.equal(h.ag.quotaBatchFollowupTimer, null);
});

test('new batch clears pending followup; even a queued old callback cannot refresh its successor', async () => {
    const h = harness(); h.select(1); let pending = h.c.runAntigravityQuotaBatch(h.ag);
    h.replyBatch(0, filename => ({filename, success: true, model_access_update: {status: 'pending'}})); await pending;
    const oldTimerId = h.ag.quotaBatchFollowupTimer, oldCallback = h.timers.get(oldTimerId).fn;
    h.reply(1, page()); await tick(); pending = h.c.runAntigravityQuotaBatch(h.ag);
    assert.equal(h.timers.has(oldTimerId), false); const before = h.requests.length; oldCallback(); assert.equal(h.requests.length, before);
    h.replyBatch(2); await pending; h.reply(3, page()); await tick();
});

test('logout while POST is pending stops future batches and old finally cannot unlock a new batch', async () => {
    const h = harness(); h.select(23); const old = h.c.runAntigravityQuotaBatch(h.ag);
    h.c.stopPanelSession(); h.c.beginPanelSession('new-synthetic'); h.select(1); const fresh = h.c.runAntigravityQuotaBatch(h.ag);
    h.replyBatch(0); await old; assert.equal(h.requests.length, 2); assert.equal(h.ag.quotaBatch.busy, true); assert.equal(h.modals.length, 0);
    h.replyBatch(1); await fresh; assert.equal(h.modals.length, 1); h.reply(2, page()); await tick();
});

test('keyed refresh preserves open card/quota nodes and an in-flight quota response can render', async () => {
    const h = harness({render: true}); h.loadCards(['one.json', 'removed.json']);
    const list = h.elements.get('antigravityCredsList'), card = list.children[0], quota = card.querySelector('.cred-quota-details');
    const content = quota.querySelector('.cred-quota-content'); const pathId = quota.id.slice('quota-'.length);
    const pending = h.c._toggleQuotaDetails(pathId, 'antigravity'); assert.equal(h.requests.length, 1);
    const refresh = h.ag.refresh({silent: true}); h.reply(1, page(['one.json', 'new.json'])); await refresh;
    assert.equal(list.children[0], card); assert.equal(card.querySelector('.cred-quota-details'), quota); assert.equal(content.isConnected, true);
    assert.equal(list.children[1].dataset.filename, 'new.json'); assert.equal(list.children.length, 2);
    h.reply(0, {success: true, models: {}, quota_groups: {}, quota_group_states: {}}); await pending;
    assert.match(content.innerHTML, /本次未返回可展示额度/); assert.equal(quota.style.display, 'block');
});

test('preserved content cache is invalidated and pre-refresh content completion cannot make it loaded again', async () => {
    const h = harness({render: true}); h.loadCards(['one.json']);
    const card = h.elements.get('antigravityCredsList').children[0], detail = card.querySelector('.cred-details'), content = detail.querySelector('.cred-content');
    const pathId = detail.id.slice('details-'.length); const read = h.c.toggleCredDetailsCommon(pathId, h.ag);
    const refresh = h.ag.refresh({silent: true}); h.reply(1, page(['one.json'])); await refresh;
    assert.equal(detail.isConnected, true); h.reply(0, {content: {synthetic: true}}); await read;
    assert.match(content.textContent, /synthetic/); assert.equal(content.getAttribute('data-loaded'), 'false');
    await h.c.toggleCredDetailsCommon(pathId, h.ag); const fresh = h.c.toggleCredDetailsCommon(pathId, h.ag);
    assert.equal(h.requests.length, 3); h.reply(2, {content: {fresh: true}}); await fresh; assert.equal(content.getAttribute('data-loaded'), 'true');
    const again = h.ag.refresh({silent: true}); h.reply(3, page(['one.json'])); await again; assert.equal(content.getAttribute('data-loaded'), 'false');
});

test('detached and previous-session content/error responses cannot overwrite later UI', async () => {
    for (const kind of ['details', 'errors']) {
        const h = harness({render: true}); h.loadCards(['one.json']); const card = h.elements.get('antigravityCredsList').children[0];
        const detail = card.children.find(e => e.id.startsWith(kind + '-')); const content = detail.querySelector('.cred-content');
        const fn = kind === 'details' ? h.c.toggleCredDetailsCommon : h.c.toggleErrorDetailsCommon;
        const pending = fn(detail.id.slice(kind.length + 1), h.ag); h.c.stopPanelSession(); const before = content.innerHTML;
        h.reply(0, kind === 'details' ? {content: {old: true}} : {error_codes: [], error_messages: {}}); await pending;
        assert.equal(content.innerHTML, before); assert.equal(content.isConnected, false);
    }
});

test('legacy successful batch rows work; only valid family projections contribute to access summary', async () => {
    const h = harness(); h.select(3); const pending = h.c.runAntigravityQuotaBatch(h.ag);
    h.replyBatch(0, (filename, index) => ({filename, success: true, status_code: 200,
        ...(index === 0 ? {model_access_families: {'claude-opus-5-5': {state: 'supported', checked_at: Date.now()/1000}}} : {})}));
    await pending; assert.equal(h.c.antigravityBatchCounts(h.ag.quotaBatch).success, 3);
    assert.match(h.modals[0][1], /1 项有效权限记录/); assert.doesNotMatch(h.modals[0][1], /Opus 4\.6/); h.reply(1, page()); await tick();
});

test('desktop and mobile share persistent progress controls and correct cancellation binding', () => {
    for (const file of ['front/control_panel.html', 'front/control_panel_mobile.html']) {
        const html = fs.readFileSync(file, 'utf8');
        for (const id of ['antigravityBatchQuotaProgress', 'antigravityBatchQuotaProgressText', 'antigravityBatchQuotaProgressBar', 'antigravityBatchQuotaCancelBtn']) {
            assert.equal((html.match(new RegExp('id="' + id + '"', 'g')) || []).length, 1);
        }
        assert.match(html, /id="antigravityBatchQuotaCancelBtn"[^>]*onclick="cancelAntigravityQuotaBatch\(\)"/);
        assert.match(html, /id="antigravityBatchQuotaProgressText"[^>]*aria-live="polite"/);
    }
});


test('query/page failure leaves no old-scope actions; late aborted GET cannot restore old cards', async () => {
    for (const changed of ['remark', 'page']) {
        const h = harness({render: true}); h.loadCards(['old.json']);
        const list = h.elements.get('antigravityCredsList'), card = list.children[0];
        const same = h.ag.refresh({silent: true}); h.reply(0, {detail: 'temporary'}, 503); await same;
        assert.equal(list.children[0], card, 'same successful scope can remain visible during a failed refresh');
        const old = h.ag.refresh({silent: true});
        if (changed === 'remark') h.ag.currentRemarkFilter = 'different'; else h.ag.currentPage = 2;
        const current = h.ag.refresh();
        assert.equal(h.requests[1].options.signal.aborted, true);
        assert.equal(list.children.length, 0); assert.equal(card.isConnected, false);
        assert.deepEqual(Object.keys(h.ag.data), []);
        assert.equal(h.elements.get('antigravityPaginationContainer').style.display, 'none');
        h.reply(2, {detail: 'busy'}, changed === 'remark' ? 503 : 504); await current;
        h.reply(1, page(['old.json'])); await old;
        assert.equal(list.children.length, 0); assert.deepEqual(Object.keys(h.ag.data), []);
        assert.equal(h.ag.displayedListScope, null);
    }
});

test('successful ZIP upload rebuilds only replaced names and old quota/content cannot write replacement nodes', async () => {
    const h = harness({render: true}); h.loadCards(['replace.json', 'keep.json']);
    const list = h.elements.get('antigravityCredsList'), oldCard = list.children[0], keptCard = list.children[1];
    const oldQuota = oldCard.querySelector('.cred-quota-details'), oldQuotaContent = oldQuota.querySelector('.cred-quota-content');
    const oldDetail = oldCard.querySelector('.cred-details'), oldContent = oldDetail.querySelector('.cred-content');
    const pathId = oldQuota.id.slice('quota-'.length);
    const quotaRequest = h.c._toggleQuotaDetails(pathId, 'antigravity');
    const contentRequest = h.c.toggleCredDetailsCommon(pathId, h.ag);
    const ordinary = h.ag.refresh({afterMutation: true, silent: true}); h.reply(2, page(['replace.json', 'keep.json'])); await ordinary;
    assert.equal(list.children[0], oldCard); assert.equal(oldQuotaContent.isConnected, true);
    let upload;
    h.c.FormData = class {append() {}};
    h.c.XMLHttpRequest = class {constructor() {this.upload = {}; upload = this;} open() {} setRequestHeader() {} send() {}};
    h.c.state.antigravityUploadFiles.selectedFiles = [{name: 'archive.zip'}];
    await h.c.state.antigravityUploadFiles.upload();
    upload.status = 200;
    upload.responseText = JSON.stringify({uploaded_count: 1, results: [
        {filename: 'replace.json', status: 'success'}, {filename: 'keep.json', status: 'error'}]});
    upload.onload();
    assert.equal(h.requests.length, 4); assert.match(h.requests[3].url, /creds\/status/);
    assert.equal(oldCard.isConnected, false); assert.equal(list.children[0], keptCard);
    assert.equal(h.ag.credentialDetailGenerations.get('replace.json'), 1);
    h.reply(3, page(['replace.json', 'keep.json'])); await tick();
    const replacement = list.children[0]; assert.notEqual(replacement, oldCard); assert.equal(list.children[1], keptCard);
    const freshQuota = replacement.querySelector('.cred-quota-details'), freshContent = replacement.querySelector('.cred-content');
    assert.notEqual(freshQuota, oldQuota); assert.equal(freshQuota.style.display, 'none');
    const before = freshQuota.querySelector('.cred-quota-content').innerHTML;
    h.reply(0, {success: true, models: {}, quota_groups: {}, quota_group_states: {}});
    h.reply(1, {content: {superseded: true}}); await Promise.all([quotaRequest, contentRequest]);
    assert.equal(freshQuota.querySelector('.cred-quota-content').innerHTML, before);
    assert.doesNotMatch(freshContent.textContent, /superseded/);
    assert.equal(freshContent.getAttribute('data-loaded'), 'false');
    assert.equal(oldContent.isConnected, false);
});

test('legacy import without names invalidates all visible details even when its list refresh fails', async () => {
    const h = harness({render: true}); h.loadCards(['old.json']);
    const old = h.elements.get('antigravityCredsList').children[0];
    h.c.refreshAntigravityAfterImport({uploaded_count: 1}, h.ag.sessionEpoch());
    assert.equal(old.isConnected, false); h.reply(0, {detail: 'busy'}, 503); await tick();
    assert.equal(h.elements.get('antigravityCredsList').children.length, 0);
    const before = h.requests.length; h.c.stopPanelSession();
    h.c.refreshAntigravityAfterImport({success_count: 1, results: [{filename: 'old.json', success: true}]}, 1);
    assert.equal(h.requests.length, before, 'old-session import completion must not refresh a new session');
});
