// Isolated execution of production render/request functions; no browser or network.
// Run: node --test test_antigravity_quota_layout.cjs
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('front/common.js', 'utf8');
function section(start, end) {
    const from = source.indexOf(start), to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `Missing production section ${start}`);
    return source.slice(from, to);
}
const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function harness() {
    const frames = [], scrolls = [], requests = [], statuses = [];
    let active = true, rect = {top:900,bottom:930,left:0,right:200,width:200,height:30};
    const heading = {isConnected:true,getBoundingClientRect:()=>rect,scrollIntoView:options=>scrolls.push(options)};
    const content = {isConnected:true,innerHTML:'',getAttribute:()=> 'synthetic.json',
        querySelectorAll:()=>[], querySelector: selector => selector.includes('data-quota-card') && /data-quota-card[\s=>]/.test(content.innerHTML) ? heading : null,
        insertAdjacentHTML:(_, html)=>{content.innerHTML=html+content.innerHTML;}};
    const details = {isConnected:true,style:{display:'none'},querySelector:()=>content};
    const panel = {classList:{contains:()=>active}};
    const c = {URL,Date,Promise,Set,Map,console,AppState:{antigravityCreds:{data:{}}},
        document:{hidden:false,getElementById:id=>id === 'antigravity-manageTab' ? panel : details,documentElement:{clientHeight:800,clientWidth:1200}},
        window:{innerHeight:800,innerWidth:1200,requestAnimationFrame:callback=>frames.push(callback)},
        requestAnimationFrame:callback=>frames.push(callback),setTimeout:callback=>frames.push(callback),
        getAuthHeaders:()=>({}),escapeHtml:escape,escapeHtmlAttribute:escape,highlightHttpLinks:value=>value,
        showStatus:(...args)=>statuses.push(args),
        fetch:(url,options)=>new Promise((resolve,reject)=>requests.push({url,options,resolve,reject}))};
    vm.createContext(c);
    vm.runInContext(section('function formatCooldownTime(', 'function formatErrorCodeLabel(') +
        section('function manualResultSummary(', 'async function testAntigravityCredential(') +
        section('function modelAccessStatus(', '\nasync function toggleErrorDetails(') + '\n' +
        source.slice(source.indexOf('function isVisibleAntigravityQuotaModel(')), c);
    return {c,content,details,heading,frames,scrolls,requests,statuses,
        setActive:value=>{active=value;},setRect:value=>{rect={...rect,...value};},
        flush:()=>{while(frames.length)frames.shift()();},
        toggle:()=>c._toggleQuotaDetails('synthetic','antigravity'),
        resolve:(index,payload,ok=true)=>requests[index].resolve({ok,json:async()=>payload})};
}
const model = {displayName:'Claude Opus 5.5 (High)',rawModelId:'claude-opus-5-5-high',testModel:'claude-opus-5-5-high',public:true,remaining:0.25,resetTime:'10-08 08:00',resetTimeRaw:'2099-10-08T00:00:00Z'};
function payload(extra={}) {return {success:true,models:{'claude-opus-5-5-high':{...model}},quota_groups:{'gemini-shared':{restricted:false},'claude-gpt-shared':{restricted:false}},...extra};}
async function render(data,ok=true) {const h=harness();const task=h.toggle();h.resolve(0,data,ok);await task;assert.doesNotMatch(h.content.innerHTML,/网络错误/);return h;}
function front(html) {return html.split(/<details\b[^>]*data-quota-extra/)[0];}
function extra(html) {const match=html.match(/<details\b([^>]*data-quota-extra[^>]*)>([\s\S]*)<\/details>/);assert.ok(match,'native auxiliary details');assert.doesNotMatch(match[1],/\bopen\b/);assert.match(match[2],/<summary[^>]*>权限、冷却与查询详情<\/summary>/);return match[2];}

test('successful quota cards precede folded diagnostic evidence; details attach no requests',async()=>{
    const h=await render(payload({upstream_status:200,phase:'quota'})), html=h.content.innerHTML;
    assert.match(html,/class="ag-quota-view"/);assert.match(html,/class="ag-quota-grid"/);assert.match(html,/\bag-quota-card\b/);
    assert.ok(html.indexOf('ag-quota-heading') < html.indexOf('ag-quota-statuses'));
    assert.ok(html.indexOf('ag-quota-statuses') < html.indexOf('data-quota-card'));
    for(const text of ['Opus 5.5','Opus 4.6','Gemini','Claude / GPT-OSS']) assert.ok(front(html).includes(text),text);
    assert.match(front(html),/data-quota-card-heading/);assert.match(front(html),/25%/);
    assert.match(extra(html),/Google HTTP 200/);assert.match(extra(html),/data-model-access/);
    assert.doesNotMatch(front(html),/最近检查|下次复查|Google HTTP/);
    assert.equal(h.requests.length,1);h.flush();assert.equal(h.requests.length,1);
});
test('adding successful diagnostics cannot move or change the card region',async()=>{
    const a=await render(payload()), b=await render(payload({upstream_status:200,phase:'quota',phases:Array.from({length:30},()=>({phase:'project',upstream_status:200}))}));
    assert.equal(front(a.content.innerHTML),front(b.content.innerHTML));
});
test('empty and fully hidden model maps never synthesize quota cards',async()=>{
    for(const models of [{},{hidden:{...model,visible:false}}]) {
        const h=await render(payload({models}));assert.doesNotMatch(h.content.innerHTML,/data-quota-card[\s=>]/);
        assert.match(front(h.content.innerHTML),/暂无|未返回可展示额度/);assert.match(extra(h.content.innerHTML),/data-opus-catalog-notice/);
        h.flush();assert.equal(h.scrolls.length,0);
    }
});
test('unknown quotas and rolling 168h recovery remain honest',async()=>{
    const h=await render(payload({models:{'claude-opus-5-5-high':{...model,remaining:null,rolling168h:true}}}));
    assert.match(front(h.content.innerHTML),/剩余未知/);assert.match(front(h.content.innerHTML),/恢复时间未知（上游滚动 168h）/);
    assert.doesNotMatch(front(h.content.innerHTML),/⏱️/);
});
test('partial writes and invalid quota state warn before cards while unknown groups remain in details',async()=>{
    const h=await render(payload({upstream_status:200,quota_state_invalid:true,state_update:{quota:{status:'failed',reason:'state_update_failed'}},quota_groups:{custom:{blockedUnknown:true,restricted:true}}}));
    const html=h.content.innerHTML, prior=html.slice(0,html.indexOf('data-quota-card'));
    assert.match(prior,/更新|未完成/);assert.match(prior,/状态异常/);assert.match(extra(html),/custom/);assert.match(extra(html),/恢复时间未知/);
});
test('failed lookup leads with failure and retains saved protections and permission evidence',async()=>{
    const h=await render({success:false,error:'HTTP 403: {"error":{"message":"synthetic denied","code":403}}',upstream_status:403,quota_state_invalid:true,
        quota_groups:{'gemini-shared':{cooldownUntil:Date.now()/1000+3600},'claude-gpt-shared':{blockedUnknown:true}},
        model_access_families:{'claude-opus-5-5':{state:'unavailable',reason:'directory_query_failed'}}},false);
    assert.match(front(h.content.innerHTML),/获取额度信息失败/);assert.match(front(h.content.innerHTML),/查询失败未解除|已有证据|已保存证据|保留/);
    assert.match(h.content.innerHTML,/计时冷却/);assert.match(h.content.innerHTML,/恢复时间未知/);assert.match(h.content.innerHTML,/禁止派发/);
    assert.match(extra(h.content.innerHTML),/目录查询失败，保留原限制/);h.flush();assert.equal(h.scrolls.length,0);
});
test('scroll only when first card heading is outside viewport',async()=>{
    for(const [top,bottom,expected] of [[50,80,0],[790,820,1],[900,930,1],[-40,-10,1]]) {
        const h=await render(payload());h.setRect({top,bottom});h.flush();assert.equal(h.scrolls.length,expected,`${top}..${bottom}`);
    }
});
test('queued scrolling is cancelled on collapse, tab switch, or detached results',async()=>{
    for(const invalidate of [h=>h.toggle(),h=>h.setActive(false),h=>{h.c.document.hidden=true;},h=>{h.details.isConnected=false;},h=>{h.content.isConnected=false;h.heading.isConnected=false;},h=>{h.heading.isConnected=false;}]) {
        const h=await render(payload());await invalidate(h);h.flush();assert.equal(h.scrolls.length,0);
    }
});
test('collapse while loading prevents stale rendering and scrolling',async()=>{
    const h=harness(), task=h.toggle();await h.toggle();const collapsed=h.content.innerHTML;
    h.resolve(0,payload());await task;h.flush();assert.equal(h.details.style.display,'none');assert.equal(h.content.innerHTML,collapsed);assert.equal(h.scrolls.length,0);
});
test('reopening resolves newer response first without old response overwriting or scrolling',async()=>{
    const h=harness(), old=h.toggle();await h.toggle();const current=h.toggle();
    h.resolve(1,payload({models:{newer:{...model,displayName:'NEWER'}}}));await current;const latest=h.content.innerHTML;
    h.resolve(0,payload({models:{older:{...model,displayName:'OLDER'}}}));await old;h.flush();
    assert.equal(h.content.innerHTML,latest);assert.match(latest,/NEWER/);assert.doesNotMatch(latest,/OLDER/);assert.equal(h.scrolls.length,1);
});
test('tab switch during loading prevents automatic scroll',async()=>{
    const h=harness(), task=h.toggle();h.setActive(false);h.resolve(0,payload());await task;h.flush();assert.equal(h.scrolls.length,0);
});

test('reduced motion respects user preference for automatic scroll',async()=>{
    const h=await render(payload());h.c.window.matchMedia=()=>({matches:true});h.flush();
    assert.equal(h.scrolls.length,1);assert.equal(h.scrolls[0].behavior,'auto');assert.equal(h.scrolls[0].block,'nearest');
});

test('model order remains public then available then compatible with display-name ordering',async()=>{
    const h=await render(payload({models:{
        compat:{...model,public:false,availability:'compatible',displayName:'COMPATIBLE',testModel:'raw-compatible'},
        zpublic:{...model,displayName:'Z_PUBLIC'},
        available:{...model,public:false,availability:'available',displayName:'AVAILABLE'},
        apublic:{...model,displayName:'A_PUBLIC'},
    }}));
    const html=front(h.content.innerHTML);
    const names=['A_PUBLIC','Z_PUBLIC','AVAILABLE','COMPATIBLE'];
    for(let i=1;i<names.length;i++) assert.ok(html.indexOf(names[i-1]) < html.indexOf(names[i]),names.join(' < '));
    assert.match(html,/raw-compatible/);assert.equal((html.match(/data-quota-card[\s=>]/g)||[]).length,4);
});

test('network failure retains saved permissions and protections with escaped diagnostic details',async()=>{
    const h=harness();
    const cached={quota_groups:{'gemini-shared':{cooldownUntil:Date.now()/1000+3600},'claude-gpt-shared':{blockedUnknown:true}},
        model_access_families:{'claude-opus-5-5':{state:'unavailable',reason:'generation_404'}}};
    const before=JSON.stringify(cached);
    h.c.AppState={antigravityCreds:{data:{'synthetic.json':cached}}};
    const task=h.toggle();h.requests[0].reject(new Error('synthetic <script>alert("x")</script> failed'));await task;
    const html=h.content.innerHTML;
    assert.match(front(html),/获取额度信息失败|网络错误/);
    assert.match(front(html),/已保存证据/);assert.match(front(html),/未解除/);
    assert.match(front(html),/Opus 5.5 · 暂不可用/);assert.match(front(html),/恢复时间未知/);
    assert.match(extra(html),/计时冷却至/);assert.match(extra(html),/生成返回 404/);
    assert.match(extra(html),/synthetic &lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; failed/);
    assert.doesNotMatch(html,/<script>/);assert.equal(JSON.stringify(cached),before);
    h.flush();assert.equal(h.scrolls.length,0);assert.equal(h.requests.length,1);
});

test('independent unknown group restriction is visible even when only raw group state is returned',async()=>{
    const h=await render(payload({quota_groups:undefined,quota_group_states:{'synthetic-independent':{state:'blocked_unknown'}}}));
    const html=h.content.innerHTML;
    assert.match(front(html),/其他额度组受限 1 项/);
    assert.ok(html.indexOf('其他额度组受限') < html.indexOf('data-quota-card'));
    assert.match(extra(html),/synthetic-independent/);assert.match(extra(html),/恢复时间未知/);
    assert.match(extra(html),/data-release-quota="synthetic-independent"/);
});

test('release marks compact badge pending refresh and never claims remaining timer is unrestricted',async()=>{
    const h=harness();let click, removed=false, refreshes=0, completeRefresh;
    const refresh=new Promise(resolve=>{completeRefresh=resolve;});
    const label={textContent:'恢复时间未知'}, badge={dataset:{quotaCompactGroup:'gemini-shared'},textContent:'恢复时间未知'};
    const unrelated={dataset:{quotaCompactGroup:'claude-gpt-shared'},textContent:'original other restriction'};
    const button={dataset:{releaseQuota:'gemini-shared'},addEventListener:(_,callback)=>{click=callback;},
        parentElement:{querySelector:()=>label},remove:()=>{removed=true;}};
    h.content.querySelectorAll=selector=>selector==='[data-release-quota]'?[button]:selector==='[data-quota-compact-group]'?[badge,unrelated]:[];
    h.c.AppState={antigravityCreds:{refresh:()=>{refreshes++;return refresh;}}};
    const rendering=h.toggle();h.resolve(0,payload({quota_groups:{'gemini-shared':{blockedUnknown:true,cooldownUntil:Date.now()/1000+3600}}}));await rendering;
    const releasing=click();assert.equal(h.requests[1].url,'./creds/action?mode=antigravity');
    assert.deepEqual(JSON.parse(h.requests[1].options.body),{filename:'synthetic.json',action:'release_quota_group',group:'gemini-shared'});
    h.resolve(1,{});await new Promise(resolve=>setImmediate(resolve));
    assert.equal(refreshes,1);assert.equal(removed,true);assert.match(label.textContent,/计时冷却仍有效/);
    assert.match(badge.textContent,/异常拦截已解除，冷却状态待刷新/);
    assert.doesNotMatch(badge.textContent,/未受限|恢复时间未知/);
    assert.equal(unrelated.textContent,'original other restriction');assert.equal(h.requests.length,2);
    completeRefresh();await releasing;
});
