/* Dedicated editor: drafts stay in memory; authentication is shared with common.js. */
(() => {
    'use strict';

    const CHANNELS = ['geminicli', 'antigravity'];
    const CHANNEL_LABELS = { geminicli: 'Gemini CLI', antigravity: 'Antigravity' };
    const REASONS = {
        DUPLICATE_PUBLIC_NAME: '同渠道公开名称重复',
        PUBLIC_ID_COLLISION: '公开名称与已有入口冲突',
        PROTECTED_ENTRY_CAPTURE: '路由会接管受保护的原名或入口',
        UNSUPPORTED_CHANNEL: '不支持该渠道',
        INVALID_STRUCTURE: '配置结构无效',
        INVALID_FIELD_TYPE: '字段类型无效',
        UNKNOWN_FIELD: '存在不支持的字段，请删除该行后重新添加',
        INVALID_NAME: '名称为空或包含禁止字符',
        RESERVED_SUFFIX: '公开名称使用了保留的功能后缀',
        INVALID_IDENTITY_ROUTE: '同名路由并非恒等映射',
        AMBIGUOUS_COMPATIBILITY: '无法证明目标兼容性',
        AMBIGUOUS_TARGET_NAME: '目标名称会被再次解析',
        UNSTABLE_TARGET_DISPATCH: '目标不能保持稳定分派'
    };
    const state = {
        channel: 'geminicli', rows: [], baseline: '[]', issues: [],
        loaded: false, busy: false, forceDirty: false, recovery: false
    };
    const $ = id => document.getElementById(id);
    const copyRows = rows => rows.map(row => ({ ...row }));
    const dirty = () => state.forceDirty || JSON.stringify(state.rows) !== state.baseline;
    const beforeUnload = event => {
        if (!dirty()) return;
        event.preventDefault();
        event.returnValue = '';
    };
    let unloadInstalled = false;

    function status(message, kind = 'info') {
        $('routingStatus').textContent = message;
        $('routingStatus').dataset.kind = kind;
    }

    function syncControls() {
        const changed = dirty();
        $('draftState').textContent = changed ? '有未保存的修改' : '未修改';
        $('draftState').dataset.dirty = String(changed);
        $('saveRoutes').disabled = state.busy || !changed;
        $('reloadRoutes').disabled = state.busy;
        $('addRoute').disabled = state.busy || (!state.loaded && !state.recovery);
        $('repairRoutes').hidden = !state.recovery;
        $('repairRoutes').disabled = state.busy;
        $('routingLogout').disabled = state.busy;
        document.querySelectorAll('[data-channel], #routeRows input, #routeRows button').forEach(element => {
            element.disabled = state.busy;
        });
        if (changed && !unloadInstalled) {
            window.addEventListener('beforeunload', beforeUnload);
            unloadInstalled = true;
        } else if (!changed && unloadInstalled) {
            window.removeEventListener('beforeunload', beforeUnload);
            unloadInstalled = false;
        }
    }

    function authenticated(visible) {
        $('routingLogin').hidden = visible;
        $('routingEditor').hidden = !visible;
    }

    function authenticationExpired() {
        clearStoredAuthToken();
        AppState.authToken = '';
        authenticated(false);
        status('登录已失效，请重新登录。当前草稿仍保留。', 'error');
        $('routingPassword').focus();
    }

    async function api(method, body) {
        const response = await fetch('./config/model-routing', {
            method,
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AppState.authToken}` },
            cache: 'no-store',
            ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
        let data = null;
        try { data = await response.json(); } catch (_) { /* A failed response need not be JSON. */ }
        if (response.status === 401 || response.status === 403) authenticationExpired();
        return { response, data };
    }

    function getIssues(data) {
        const collected = data?.error?.issues || data?.issues;
        if (Array.isArray(collected)) return collected;
        const issues = CHANNELS.flatMap(channel => data?.validation?.[channel]?.issues || []);
        return [...new Map(issues.map(issue => [JSON.stringify(issue), issue])).values()];
    }

    function checkedRows(data) {
        if (!Array.isArray(data?.routes)) throw new Error('Invalid routing response');
        return data.routes.map(row => {
            // Historical invalid values remain editable, without silently changing
            // their type or dropping a row. Uneditable structure requires explicit repair.
            if (!row || typeof row !== 'object' || Array.isArray(row) || !CHANNELS.includes(row.channel)) throw new Error('Invalid routing response');
            return { ...row };
        });
    }

    function acceptTable(data) {
        state.rows = checkedRows(data);
        state.baseline = JSON.stringify(state.rows);
        state.forceDirty = false;
        state.loaded = true;
        state.recovery = false;
        state.issues = getIssues(data);
        render();
    }

    async function load() {
        state.busy = true;
        syncControls();
        status('正在加载模型路由…');
        try {
            const { response, data } = await api('GET');
            if (response.ok) {
                acceptTable(data);
                status(state.issues.length ? '已加载配置；请修正标出的错误后保存。' : '已加载全部路由。', state.issues.length ? 'error' : 'info');
            } else if (response.status !== 401 && response.status !== 403) {
                state.recovery = !state.loaded && response.status === 503;
                status('配置暂时无法读取。可重新加载；若配置已损坏，可用空表重新编辑并保存修复。当前草稿已保留。', 'error');
            }
        } catch (_) {
            status('加载失败，请检查连接后重试。当前草稿已保留。', 'error');
        } finally {
            state.busy = false;
            syncControls();
        }
    }

    function issueRows(issue) {
        return [...new Set([issue.row, ...(issue.related_rows || [])])].filter(index => Number.isInteger(index) && index >= 0 && index < state.rows.length);
    }

    function issueText(issue) {
        const related = (issue.related_rows || []).filter(index => Number.isInteger(index)).map(index => index + 1);
        return `${REASONS[issue.reason] || '路由校验失败'}${issue.field ? `（${issue.field}）` : ''}${related.length ? `；相关行：${related.join('、')}` : ''} [${issue.reason || 'INVALID_STRUCTURE'}]`;
    }

    function renderErrors() {
        CHANNELS.forEach(channel => {
            const count = state.issues.filter(issue => issue.channel === channel ||
                (issue.channel == null && issueRows(issue).length === 0) ||
                issueRows(issue).some(index => state.rows[index].channel === channel)).length;
            $(`errors-${channel}`).hidden = count === 0;
            $(`errors-${channel}`).textContent = String(count);
            $(`tab-${channel}`).setAttribute('aria-label', `${CHANNEL_LABELS[channel]}${count ? `，${count} 个错误` : ''}`);
        });
        const summary = $('validationSummary');
        summary.replaceChildren();
        summary.hidden = state.issues.length === 0;
        if (state.issues.length) {
            const heading = document.createElement('p');
            heading.textContent = `全部路由共有 ${state.issues.length} 个校验问题。行号按完整表计算，切换渠道可查看相关行。`;
            summary.appendChild(heading);
            state.issues.filter(issue => issueRows(issue).length === 0).forEach(issue => {
                const line = document.createElement('p');
                line.textContent = issueText(issue);
                summary.appendChild(line);
            });
        }
        state.rows.forEach((row, index) => {
            const container = $(`route-${index}`);
            if (!container) return;
            const issues = state.issues.filter(issue => issueRows(issue).includes(index));
            container.classList.toggle('has-errors', issues.length > 0);
            const messages = $(`row-errors-${index}`);
            messages.replaceChildren();
            messages.hidden = issues.length === 0;
            issues.forEach(issue => {
                const line = document.createElement('p');
                line.textContent = `${issue.row === index ? '' : '相关行：'}${issueText(issue)}`;
                messages.appendChild(line);
            });
            ['public_name', 'upstream_name', 'enabled'].forEach(field => {
                const element = $(`row-${index}-${field}`);
                const invalid = issues.some(issue => issue.row !== index || !issue.field || issue.field === field);
                element.setAttribute('aria-invalid', String(invalid));
                if (issues.length) element.setAttribute('aria-describedby', messages.id);
                else element.removeAttribute('aria-describedby');
            });
        });
    }

    function changed(index) {
        // Editing either side of a related-row error invalidates that diagnostic.
        state.issues = state.issues.filter(issue => issueRows(issue).length && !issueRows(issue).includes(index));
        renderErrors();
        syncControls();
        status('草稿已修改，保存会提交两个渠道的完整表。');
    }

    function field(index, name, label) {
        const wrapper = document.createElement('div');
        wrapper.className = 'name-field';
        const caption = document.createElement('label');
        caption.className = 'field-label';
        caption.htmlFor = `row-${index}-${name}`;
        caption.textContent = label;
        const input = document.createElement('input');
        input.id = caption.htmlFor;
        input.type = 'text';
        const value = state.rows[index][name];
        input.value = typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value);
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.setAttribute('aria-label', `第 ${index + 1} 行${label}`);
        input.addEventListener('input', () => {
            state.rows[index][name] = input.value;
            changed(index);
        });
        wrapper.append(caption, input);
        return wrapper;
    }

    function render() {
        CHANNELS.forEach(channel => {
            const selected = channel === state.channel;
            $(`tab-${channel}`).setAttribute('aria-selected', String(selected));
            $(`tab-${channel}`).tabIndex = selected ? 0 : -1;
        });
        $('routePanel').setAttribute('aria-labelledby', `tab-${state.channel}`);
        $('channelTitle').textContent = `${CHANNEL_LABELS[state.channel]} 路由`;
        $('exampleTitle').textContent = `${CHANNEL_LABELS[state.channel]} 示例`;
        const example = state.channel === 'geminicli' ? 'public-alpha-high-search' : 'public-alpha';
        $('routingExample').textContent = `请求 model: ${example}\n响应 model: ${example}`;
        $('channelHint').textContent = state.channel === 'geminicli'
            ? '精确匹配公开名称后，可沿用现有功能后缀。功能工具仍按原有协议处理。'
            : '仅匹配完整名称；-search 不会自动联网。需要 public-alpha-search 时请单独配置该完整名称。';
        const rows = $('routeRows');
        rows.replaceChildren();
        state.rows.forEach((row, index) => {
            if (row.channel !== state.channel) return;
            const container = document.createElement('div');
            container.id = `route-${index}`;
            container.className = 'route-row';
            const number = document.createElement('span');
            number.className = 'row-number';
            number.textContent = `第 ${index + 1} 行`;
            const fields = document.createElement('div');
            fields.className = 'route-fields';
            fields.append(field(index, 'public_name', '公开名称'), field(index, 'upstream_name', '目标名称'));
            const toggle = document.createElement('label');
            toggle.className = 'toggle';
            const enabled = document.createElement('input');
            enabled.type = 'checkbox';
            enabled.id = `row-${index}-enabled`;
            enabled.checked = row.enabled === true;
            enabled.setAttribute('aria-label', `启用第 ${index + 1} 行`);
            enabled.addEventListener('change', () => { row.enabled = enabled.checked; changed(index); });
            const enabledLabel = document.createElement('span');
            enabledLabel.className = 'field-label';
            enabledLabel.textContent = '启用';
            toggle.append(enabled, enabledLabel);
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'delete-route';
            remove.textContent = '删除';
            remove.setAttribute('aria-label', `删除第 ${index + 1} 行`);
            remove.addEventListener('click', () => {
                state.rows.splice(index, 1);
                state.issues = [];
                render();
                status('路由已从草稿删除，保存后生效。');
            });
            fields.append(toggle, remove);
            const errors = document.createElement('div');
            errors.className = 'row-errors';
            errors.id = `row-errors-${index}`;
            errors.hidden = true;
            container.append(number, fields, errors);
            rows.appendChild(container);
        });
        const empty = rows.children.length === 0;
        $('emptyRoutes').hidden = !empty;
        document.querySelector('.route-columns').hidden = empty;
        renderErrors();
        syncControls();
    }

    function focusFirstError() {
        const issue = state.issues.find(item => issueRows(item).length);
        if (!issue) { $('validationSummary').focus(); return; }
        const index = issueRows(issue)[0];
        state.channel = state.rows[index].channel;
        render();
        const name = ['public_name', 'upstream_name', 'enabled'].includes(issue.field) ? issue.field : 'public_name';
        const input = $(`row-${index}-${name}`);
        input.focus();
        input.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }

    async function save() {
        if (state.busy || !dirty()) return;
        state.busy = true;
        syncControls();
        status('正在校验并保存全部路由…');
        let focusError = false;
        try {
            const { response, data } = await api('PUT', { routes: copyRows(state.rows) });
            if (response.ok) {
                acceptTable(data);
                status('全部路由已保存。', 'success');
            } else if (response.status === 400) {
                state.issues = getIssues(data);
                renderErrors();
                focusError = true;
                status('保存未生效。请修正校验错误，两个渠道的草稿均已保留。', 'error');
            } else if (response.status >= 500) {
                status('保存结果无法确认，配置可能已经生效，请重新加载核对；草稿保留。', 'error');
            } else if (response.status !== 401 && response.status !== 403) {
                status('保存失败，两个渠道的草稿均已保留。可重试或重新加载核对配置。', 'error');
            }
        } catch (_) {
            status('保存结果无法确认，请检查连接后重新加载核对。两个渠道的草稿均已保留。', 'error');
        } finally {
            state.busy = false;
            syncControls();
            if (focusError) focusFirstError();
        }
    }

    function askDiscard(message) {
        const dialog = $('discardDialog');
        if (dialog.open) return Promise.resolve(false);
        $('discardMessage').textContent = message;
        dialog.returnValue = 'cancel';
        return new Promise(resolve => {
            dialog.addEventListener('close', () => resolve(dialog.returnValue === 'discard'), { once: true });
            dialog.showModal();
        });
    }

    async function confirmDiscard() {
        return !dirty() || await askDiscard('有未保存的修改，确定丢弃两个渠道的草稿吗？');
    }

    async function login(event) {
        event.preventDefault();
        const password = $('routingPassword').value;
        if (!password) return;
        $('routingLoginButton').disabled = true;
        try {
            const response = await fetch('./auth/login', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password })
            });
            const data = await response.json();
            if (!response.ok || typeof data.token !== 'string' || !data.token) {
                status('登录失败，请检查控制面板访问密码。', 'error');
                return;
            }
            AppState.authToken = data.token;
            writeStoredAuthToken(data.token);
            $('routingPassword').value = '';
            authenticated(true);
            if (state.loaded || dirty()) status('登录成功，原草稿已保留。');
            else await load();
        } catch (_) { status('登录失败，请检查连接后重试。', 'error'); }
        finally { $('routingLoginButton').disabled = false; }
    }

    document.addEventListener('DOMContentLoaded', async () => {
        $('routingLoginForm').addEventListener('submit', login);
        document.querySelectorAll('[data-channel]').forEach(button => {
            button.addEventListener('click', () => { state.channel = button.dataset.channel; render(); });
            button.addEventListener('keydown', event => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                state.channel = event.key === 'Home' ? CHANNELS[0] : event.key === 'End' ? CHANNELS[1] : CHANNELS[1 - CHANNELS.indexOf(state.channel)];
                render();
                $(`tab-${state.channel}`).focus();
            });
        });
        $('addRoute').addEventListener('click', () => {
            state.rows.push({ channel: state.channel, public_name: '', upstream_name: '', enabled: true });
            render();
            $(`row-${state.rows.length - 1}-public_name`).focus();
        });
        $('saveRoutes').addEventListener('click', save);
        $('reloadRoutes').addEventListener('click', async () => { if (await confirmDiscard()) await load(); });
        $('repairRoutes').addEventListener('click', async () => {
            if (!await askDiscard('保存空表将替换全部模型路由。确定以空表重新编辑配置吗？')) return;
            state.rows = [];
            state.issues = [];
            state.forceDirty = true;
            render();
            status('已建立空表草稿。可新增路由，或保存空表撤销全部映射。');
        });
        $('backToPanel').addEventListener('click', async event => {
            if (state.busy) { event.preventDefault(); return; }
            if (!dirty()) return;
            event.preventDefault();
            if (!await confirmDiscard()) return;
            state.forceDirty = false;
            state.baseline = JSON.stringify(state.rows);
            syncControls();
            window.location.assign($('backToPanel').href);
        });
        $('routingLogout').addEventListener('click', async () => {
            if (!await confirmDiscard()) return;
            clearStoredAuthToken();
            AppState.authToken = '';
            state.rows = [];
            state.baseline = '[]';
            state.forceDirty = false;
            state.loaded = false;
            state.recovery = false;
            state.issues = [];
            render();
            authenticated(false);
            status('已退出登录。');
        });
        render();
        AppState.authToken = readStoredAuthToken() || '';
        authenticated(Boolean(AppState.authToken));
        if (AppState.authToken) await load();
        else status('请输入控制面板访问密码。');
    });
})();
