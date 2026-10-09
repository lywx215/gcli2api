// Run with: node --test test_antigravity_flash_ui.cjs
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('front/common.js', 'utf8');
const capability = 'antigravity.flash.non_stream_transport';
const key = 'antigravity_flash_non_stream_mode';
function context() {
    const elements = new Map();
    const element = id => {
        if (!elements.has(id)) {
            const classes = new Set();
            elements.set(id, {value:'', checked:false, disabled:false, style:{},
                classList:{add:x=>classes.add(x), remove:x=>classes.delete(x),
                    toggle:(x,on)=>on?classes.add(x):classes.delete(x), contains:x=>classes.has(x)}});
        }
        return elements.get(id);
    };
    const messages = [], posts = [], timers = [];
    const c = {AppState:{sessionEpoch:0, configLoadVersion:0, configCapabilities:new Set(),
        currentConfig:{}, envLockedFields:new Set(), securityConfig:{}},
        document:{getElementById:element}, getAuthHeaders:()=>({}),
        showStatus:message=>messages.push(message), setTimeout:fn=>timers.push(fn),
        updateEmbedConfigVisibility:()=>{}, updateManagementTokenStatus:()=>{}};
    vm.createContext(c);
    vm.runInContext(source.slice(source.indexOf('function resetConfigCapabilities()'),
        source.indexOf('function updateEmbedConfigVisibility()')),c);
    let payload = {config:{}, capabilities:[capability]};
    c.fetch = async (url,options) => {
        if (url === './config/save') {
            posts.push(JSON.parse(options.body).config);
            return {ok:true,json:async()=>({hot_updated:[key]})};
        }
        return {ok:true,json:async()=>payload};
    };
    return {c, element, messages, posts, timers, payload:value=>{payload=value;}};
}
test('templates have identical initially disabled select with inherit default',()=>{
    for (const path of ['front/control_panel.html','front/control_panel_mobile.html']) {
        const html=fs.readFileSync(path,'utf8');
        const select=html.match(/<select id="antigravityFlashNonStreamMode"[^>]*>[\s\S]*?<\/select>/g);
        assert.equal(select.length,1);
        assert.match(select[0],/ disabled>/);
        assert.deepEqual([...select[0].matchAll(/value="([^"]+)"/g)].map(m=>m[1]),['inherit','native','stream_collect']);
        assert.match(select[0],/value="inherit" selected/);
    }
});
test('supported load populates all modes; save preserves global checkbox and reports hot update',async()=>{
    const h=context();
    for (const mode of ['inherit','native','stream_collect']) {
        h.payload({config:{[key]:mode,antigravity_stream2nostream:false},capabilities:[capability]});
        await h.c.loadConfig();
        assert.equal(h.element('antigravityFlashNonStreamMode').value,mode);
        assert.equal(h.element('antigravityFlashNonStreamMode').disabled,false);
        await h.c.saveConfig();
        assert.equal(h.posts.at(-1)[key],mode);
        assert.equal(h.posts.at(-1).antigravity_stream2nostream,false);
        assert.match(h.messages.at(-1),/立即生效/);
    }
});
test('missing and malformed capability never sends key even when legacy server returns 200',async()=>{
    for (const caps of [undefined,null,capability,{},[capability,1],[]]) {
        const h=context();
        h.payload({config:{[key]:'native'},capabilities:caps});
        await h.c.loadConfig();
        assert.equal(h.element('antigravityFlashNonStreamMode').disabled,true);
        h.element('antigravityFlashNonStreamMode').value='native';
        await h.c.saveConfig();
        assert.equal(Object.hasOwn(h.posts[0],key),false);
        assert.equal(Object.hasOwn(h.posts[0],'antigravity_stream2nostream'),true);
    }
});
test('capability withdrawal, env lock and unlock are applied on each reload',async()=>{
    const h=context();
    await h.c.loadConfig();
    h.payload({config:{[key]:'native'},capabilities:[capability],env_locked:[key]});
    await h.c.loadConfig();
    assert.equal(h.element('antigravityFlashNonStreamMode').disabled,true);
    assert.equal(h.element('antigravityFlashNonStreamMode').value,'native');
    assert.match(h.element('antigravityFlashNonStreamStatus').textContent,/ANTIGRAVITY_FLASH_NON_STREAM_MODE/);
    await h.c.saveConfig(); assert.equal(Object.hasOwn(h.posts.at(-1),key),false);
    h.payload({config:{[key]:'stream_collect'},capabilities:[capability],env_locked:[]});
    await h.c.loadConfig();
    assert.equal(h.element('antigravityFlashNonStreamMode').disabled,false);
    assert.equal(h.element('antigravityFlashNonStreamMode').classList.contains('env-locked'),false);
    h.payload({config:{},capabilities:[]}); await h.c.loadConfig();
    await h.c.saveConfig(); assert.equal(Object.hasOwn(h.posts.at(-1),key),false);
});
test('invalid or missing configuration normalizes to inherit on populate and save',async()=>{
    const h=context();
    for (const value of [undefined,null,'unknown',true,{}]) {
        h.payload({config:{[key]:value},capabilities:[capability]}); await h.c.loadConfig();
        assert.equal(h.element('antigravityFlashNonStreamMode').value,'inherit');
        h.element('antigravityFlashNonStreamMode').value='invalid';
        await h.c.saveConfig(); assert.equal(h.posts.at(-1)[key],'inherit');
    }
});
test('failed reload revokes capability immediately and does not block legacy form save',async()=>{
    const h=context(); await h.c.loadConfig();
    const oldFetch=h.c.fetch;
    h.c.fetch=async url=>{if(url==='./config/get') throw Error('offline');};
    await h.c.loadConfig();
    assert.equal(h.element('antigravityFlashNonStreamMode').disabled,true);
    h.c.fetch=oldFetch; await h.c.saveConfig();
    assert.equal(Object.hasOwn(h.posts.at(-1),key),false);
});
test('overlapping load and session reset cannot revive stale capability',async()=>{
    const h=context(); let release;
    h.c.fetch=()=>new Promise(resolve=>{release=resolve;});
    const first=h.c.loadConfig();
    h.c.fetch=async()=>({ok:true,json:async()=>({config:{},capabilities:[]})});
    await h.c.loadConfig();
    release({ok:true,json:async()=>({config:{},capabilities:[capability]})}); await first;
    assert.equal(h.element('antigravityFlashNonStreamMode').disabled,true);
    h.c.fetch=()=>new Promise(resolve=>{release=resolve;});
    const stale=h.c.loadConfig();
    h.c.AppState.sessionEpoch++; h.c.AppState.configLoadVersion++; h.c.resetConfigCapabilities();
    release({ok:true,json:async()=>({config:{},capabilities:[capability]})}); await stale;
    assert.equal(h.element('antigravityFlashNonStreamMode').disabled,true);
    const stop=source.slice(source.indexOf('function stopPanelSession()'),source.indexOf('function beginPanelSession('));
    assert.match(stop,/resetConfigCapabilities\(\)/);
});

test('HTTP and malformed JSON failures revoke previous support',async()=>{
    for (const reply of [
        {ok:false,json:async()=>({detail:'denied'})},
        {ok:true,json:async()=>{throw Error('invalid JSON');}},
        {ok:true,json:async()=>({config:null,capabilities:[capability]})}
    ]) {
        const h=context(); await h.c.loadConfig();
        const oldFetch=h.c.fetch; h.c.fetch=async()=>reply;
        await h.c.loadConfig();
        assert.equal(h.element('antigravityFlashNonStreamMode').disabled,true);
        h.c.fetch=oldFetch; await h.c.saveConfig();
        assert.equal(Object.hasOwn(h.posts.at(-1),key),false);
    }
});
