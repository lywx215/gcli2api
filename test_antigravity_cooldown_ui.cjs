// Run with: node --test test_antigravity_cooldown_ui.cjs
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('front/common.js', 'utf8');
function section(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }
function context() {
    const elements = new Map();
    const c = {URL, URLSearchParams, Set, Map, Date, Promise, console,
        document: {getElementById: id => elements.get(id), querySelectorAll: () => []},
        window: {location: {href:'https://example.invalid/'}},
        getAuthHeaders: () => ({}), showStatus: () => {}, escapeHtml: String, escapeHtmlAttribute: String};
    vm.createContext(c);
    vm.runInContext(section('function createCredsManager(', 'function createUploadManager(') +
        section('function formatCooldownTime(', 'function formatErrorCodeLabel(') +
        section('function updateCooldownDisplays()', '// ====================================================================='), c);
    return {c, elements};
}
test('capabilities disable unsupported filters and stats do not fabricate ready', () => {
    const {c, elements} = context();
    const manager = c.createCredsManager('antigravity');
    const filter = {options: [{value:'all'}, {value:'gemini_restricted'}], value:'gemini_restricted'};
    elements.set('antigravityCooldownFilter', filter);
    for (const suffix of ['Total','Normal','Disabled','NoCooldown','InCooldown','BlockedUnknown','QuotaInvalid']) elements.set('antigravityStat'+suffix, {});
    manager.updateCooldownCapability([]);
    manager.updateStatsDisplay();
    assert.equal(filter.options[1].disabled, true);
    assert.equal(elements.get('antigravityStatNoCooldown').textContent, '暂不可用');
    manager.updateCooldownCapability(['antigravity.cooldown.group_filter']);
    manager.currentCooldownFilter = 'gemini_restricted';
    assert.equal(filter.options[1].disabled, false);
    assert.match(manager.getStatusUrl(0,25), /cooldown_filter=gemini_restricted/);
    const cli = c.createCredsManager('geminicli');
    cli.currentCooldownFilter='pro_no_cooldown';
    assert.match(cli.getStatusUrl(0,25), /cooldown_filter=pro_no_cooldown/);
});
test('named group badges show independent state and unknown group detail', () => {
    const {c} = context();
    const html = c.quotaGroupBadges({filename:'same.json', quota_groups:{
        'gemini-shared':{restricted:false}, 'claude-gpt-shared':{blockedUnknown:true,restricted:true},
        custom:{restricted:true, cooldownUntil:Date.now()/1000+100}}},true);
    assert.match(html, /Gemini：额度未受限/);
    assert.match(html, /Claude \/ GPT-OSS：额度受限（恢复时间未知）/);
    assert.match(html, /<details>/);
    assert.match(html, /data-cooldown-mode="antigravity"/);
    assert.match(html, /data-cooldown-filename="same.json"/);
    assert.match(c.quotaGroupBadges({},false), /暂不可用/);
});
test('timer scopes same filenames, preserves unknown block and coalesces failed refresh', async () => {
    const {c} = context();
    const now=Date.now()/1000;
    let refreshes=0;
    const badge = mode => ({dataset:{cooldownMode:mode,cooldownFilename:'same.json',cooldownGroup: mode==='antigravity'?'gemini-shared':'gemini-pro'}});
    const agBadge=badge('antigravity'), cliBadge=badge('geminicli');
    c.document.querySelectorAll = () => [agBadge,cliBadge];
    const ag=c.createCredsManager('antigravity');
    ag.cooldownGroupCapability=true;
    ag.data={'same.json':{quota_groups:{'gemini-shared':{cooldownUntil:now-1,blockedUnknown:true,restricted:true}}}};
    ag.refresh=async () => {refreshes++; throw new Error('offline');};
    c.AppState={antigravityCreds:ag,creds:{data:{'same.json':{model_cooldowns:{'gemini-pro':now+300}}},renderList:()=>{}}};
    c.updateCooldownDisplays(); c.updateCooldownDisplays();
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(refreshes,1);
    assert.match(agBadge.textContent,/恢复时间未知/);
    assert.match(cliBadge.textContent,/pro:/);
    c.updateCooldownDisplays();
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(refreshes,1);
    assert.ok(ag.cooldownRefreshAfter>=now+15);
});
test('all matching selection carries the exact group filter over pages', async () => {
    const {c} = context();
    const manager=c.createCredsManager('antigravity');
    manager.cooldownGroupCapability=true; manager.currentCooldownFilter='claude_gpt_unrestricted';
    manager.updateBatchControls=()=>{};
    const urls=[];
    c.fetch=async url => {urls.push(new URL(url));return {ok:true,json:async()=>({items:[{filename:'file'+urls.length}],has_more:urls.length===1})};};
    await manager.selectAllMatching();
    assert.equal(manager.selectedFiles.size,2);
    assert.ok(urls.every(url=>url.searchParams.get('cooldown_filter')==='claude_gpt_unrestricted'));
    assert.equal(urls[1].searchParams.get('offset'),'1');
});
test('empty quota model response renders group restriction and release control', async () => {
    const {c} = context();
    vm.runInContext(section('function modelAccessSummary(', '\nasync function toggleErrorDetails('),c);
    let html='';
    const content={getAttribute:()=> 'empty.json',get innerHTML(){return html;},set innerHTML(value){html=value;},querySelectorAll:()=>[],insertAdjacentHTML:(_,value)=>{html=value+html;}};
    c.document.getElementById=()=>({style:{display:'none'},querySelector:()=>content});
    c.manualResultSummary=()=>'';c.manualUpdateIncomplete=()=>false;
    c.fetch=async()=>({ok:true,json:async()=>({success:true,models:{},quota_groups:{'gemini-shared':{cooldownUntil:0,blockedUnknown:true}},quota_group_states:{'gemini-shared':{state:'blocked_unknown'}}})});
    await c._toggleQuotaDetails('empty','antigravity');
    assert.match(html,/恢复时间未知/);
    assert.match(html,/data-release-quota="gemini-shared"/);
    assert.match(html,/Claude \/ GPT-OSS/);
});
test('both real templates expose only group filters with safe initial capability state',()=>{
    for(const file of ['front/control_panel.html','front/control_panel_mobile.html']) {
        const html=fs.readFileSync(file,'utf8');
        const select=html.match(/<select id="antigravityCooldownFilter"[\s\S]*?<\/select>/)[0];
        assert.equal((select.match(/<option /g)||[]).length,7);
        assert.equal((select.match(/ disabled/g)||[]).length,6);
        assert.doesNotMatch(select,/pro_no_cooldown|flash_no_cooldown/);
        assert.match(html,/antigravityStatBlockedUnknown/);
    }
});
test('hidden Antigravity tab never polls cached status', async()=>{
    const {c,elements}=context();
    let refreshes=0;
    const ag=c.createCredsManager('antigravity');
    ag.cooldownGroupCapability=true; ag.refresh=async()=>{refreshes++;};
    ag.data={x:{quota_groups:{'gemini-shared':{cooldownUntil:1}}}};
    c.AppState={creds:{data:{}},antigravityCreds:ag};
    elements.set('antigravity-manageTab',{classList:{contains:()=>false}});
    c.updateCooldownDisplays();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(refreshes,0);
});
test('failed quota lookup retains returned unknown and timed group protection',async()=>{
    const {c}=context();
    vm.runInContext(section('function modelAccessSummary(', '\nasync function toggleErrorDetails('),c);
    let html='';
    const content={getAttribute:()=> 'failure.json',get innerHTML(){return html;},set innerHTML(v){html=v;},insertAdjacentHTML:(_,v)=>{html=v+html;}};
    c.document.getElementById=()=>({style:{display:'none'},querySelector:()=>content});
    c.manualResultSummary=()=>'';
    c.fetch=async()=>({ok:false,json:async()=>({success:false,error:'upstream unavailable',quota_groups:{'gemini-shared':{cooldownUntil:Date.now()/1000+100},'claude-gpt-shared':{blockedUnknown:true}},quota_state_invalid:true})});
    await c._toggleQuotaDetails('failure','antigravity');
    assert.match(html,/查询失败未解除/);assert.match(html,/恢复时间未知/);assert.match(html,/计时冷却/);assert.match(html,/禁止派发/);
});
test('explicit group release refreshes cached list without another quota request',async()=>{
    const {c}=context();
    vm.runInContext(section('function modelAccessSummary(', '\nasync function toggleErrorDetails('),c);
    let handler,removed=false,refreshes=0;
    const label={};
    const button={dataset:{releaseQuota:'gemini-shared'},addEventListener:(_,callback)=>{handler=callback;},parentElement:{querySelector:()=>label},remove:()=>{removed=true;}};
    const content={innerHTML:'',getAttribute:()=> 'release.json',querySelectorAll:()=>[button],insertAdjacentHTML:()=>{}};
    c.document.getElementById=()=>({style:{display:'none'},querySelector:()=>content});
    c.manualResultSummary=()=>'';c.manualUpdateIncomplete=()=>false;
    c.AppState={antigravityCreds:{refresh:async()=>{refreshes++;}}};
    const urls=[];
    c.fetch=async(url,options)=>{urls.push(url);if(options.method==='POST'){assert.equal(JSON.parse(options.body).group,'gemini-shared');return {ok:true};}
        return {ok:true,json:async()=>({success:true,models:{},quota_groups:{'gemini-shared':{cooldownUntil:Date.now()/1000+100,blockedUnknown:true}},quota_group_states:{'gemini-shared':{state:'blocked_unknown'}}})};};
    await c._toggleQuotaDetails('release','antigravity');await handler();
    assert.equal(refreshes,1);assert.equal(removed,true);assert.match(label.textContent,/计时冷却仍有效/);
    assert.equal(urls.filter(url=>url.startsWith('./creds/quota/')).length,1);
});
test('successful expiry refresh clears expired timer so subsequent ticks do not poll', async()=>{
    const {c,elements}=context();
    let refreshes=0;
    const ag=c.createCredsManager('antigravity');
    ag.cooldownGroupCapability=true;
    ag.data={x:{quota_groups:{'gemini-shared':{cooldownUntil:1,blockedUnknown:true,restricted:true}}}};
    ag.refresh=async()=>{refreshes++;ag.data.x.quota_groups['gemini-shared'].cooldownUntil=0;return true;};
    c.AppState={creds:{data:{}},antigravityCreds:ag};
    elements.set('antigravity-manageTab',{classList:{contains:()=>true}});
    c.updateCooldownDisplays();c.updateCooldownDisplays();
    await new Promise(resolve=>setImmediate(resolve));
    ag.cooldownRefreshAfter=0;
    c.updateCooldownDisplays();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(refreshes,1);
    assert.equal(ag.data.x.quota_groups['gemini-shared'].blockedUnknown,true);
});
test('empty filtered page refreshes once when global next expiry arrives', async()=>{
    const {c,elements}=context();
    let refreshes=0;
    const ag=c.createCredsManager('antigravity');
    ag.cooldownGroupCapability=true; ag.data={}; ag.statsData={quota_next_expiry:1};
    ag.refresh=async()=>{refreshes++;ag.statsData.quota_next_expiry=0;return true;};
    c.AppState={creds:{data:{}},antigravityCreds:ag};
    elements.set('antigravity-manageTab',{classList:{contains:()=>true}});
    c.updateCooldownDisplays();c.updateCooldownDisplays();
    await new Promise(resolve=>setImmediate(resolve));
    ag.cooldownRefreshAfter=0;
    c.updateCooldownDisplays();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(refreshes,1);
});
test('invalid quota groups remain explicitly restricted on cards and timer ticks',()=>{
    const {c}=context();
    const info={filename:'invalid.json',quota_state_invalid:true,quota_groups:{'gemini-shared':{cooldownUntil:0,restricted:true},'claude-gpt-shared':{cooldownUntil:0,restricted:true}}};
    const html=c.quotaGroupBadges(info,true);
    assert.match(html,/Gemini：额度受限（状态异常）/);
    assert.match(html,/Claude \/ GPT-OSS：额度受限（状态异常）/);
    assert.doesNotMatch(html,/等待状态更新/);
    const badge={dataset:{cooldownMode:'antigravity',cooldownFilename:info.filename,cooldownGroup:'gemini-shared'}};
    c.document.querySelectorAll=()=>[badge];
    c.AppState={creds:{data:{}},antigravityCreds:{data:{[info.filename]:info},cooldownGroupCapability:true}};
    c.updateCooldownDisplays();
    assert.match(badge.textContent,/额度受限（状态异常）/);
});
test('cross-page selection synchronizes visible checkboxes using actual template IDs',async()=>{
    for(const file of ['front/control_panel.html','front/control_panel_mobile.html']) {
        const {c,elements}=context();
        const html=fs.readFileSync(file,'utf8');
        const selectAllId=html.match(/id="([^"]+)"[^>]*onchange="toggleSelectAllAntigravity\(\)"/)[1];
        const manager=c.createCredsManager('antigravity');
        manager.cooldownGroupCapability=true;manager.currentCooldownFilter='any_restricted';
        const header={checked:false};
        elements.set(selectAllId,header);
        elements.set('antigravitySelectedCount',{});
        const boxes=['first.json','second.json'].map(filename=>({checked:false,getAttribute:()=>filename}));
        c.document.querySelectorAll=selector=>{
            assert.equal(selector,'.'+manager.getElementId('file-checkbox'));
            return boxes;
        };
        c.fetch=async()=>({ok:true,json:async()=>({items:[{filename:'first.json'},{filename:'second.json'},{filename:'off-page.json'}],has_more:false})});
        await manager.selectAllMatching();
        assert.equal(elements.get('antigravitySelectedCount').textContent,'已选择 3 项');
        assert.ok(boxes.every(box=>box.checked));assert.equal(header.checked,true);assert.equal(header.indeterminate,false);
        manager.selectedFiles.delete('second.json');manager.updateBatchControls();
        assert.equal(header.indeterminate,true);assert.equal(boxes[1].checked,false);assert.equal(boxes[0].checked,true);
        assert.equal(manager.selectedFiles.has('off-page.json'),true);
    }
});
