const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),cp=require('node:child_process');
const source=fs.readFileSync('front/common.js','utf8');
const FAMILY='antigravity.model_access.family_filter', GROUP='antigravity.cooldown.group_filter',CAPS=[FAMILY,GROUP];
const production=cp.spawnSync(process.env.PYTHON || 'python',['-B','tests/fixtures/frontend_quota.py'],{encoding:'utf8'});
assert.equal(production.status,0,production.stderr);
const fixtures=JSON.parse(production.stdout);
function harness(){
 const elements=new Map(),intervals=new Map(),timers=[],frames=[],requests=[],sockets=[],statuses=[];
 let next=0,boxes=[];
 function el(id='') {const classes=new Set();return {id,value:'all',style:{},dataset:{},options:[],checked:false,disabled:false,children:[],textContent:'',innerHTML:'',
  classList:{add:x=>classes.add(x),remove:x=>classes.delete(x),contains:x=>classes.has(x)},
  addEventListener(){},setAttribute(){},getAttribute(){return null;},querySelector(){return null;},querySelectorAll(){return [];},
  appendChild(x){this.children.push(x);},getBoundingClientRect(){return {left:0,top:0,width:100,height:20};}};}
 for(const m of fs.readFileSync('front/control_panel.html','utf8').matchAll(/\bid="([^"]+)"/g))elements.set(m[1],el(m[1]));
 const tabs=['antigravity-manage','config','logs'].map(name=>{const e=el(name+'Button');e.dataset.tab=name;return e;});
 elements.get('antigravity-manageTab').classList.add('active');
 const window={location:{href:'https://synthetic.invalid/',hash:'#antigravity-manage'},localStorage:{getItem:()=>null,setItem(){},removeItem(){}},addEventListener(){},innerHeight:800};
 const document={hidden:false,body:{dataset:{}},documentElement:{clientHeight:800},getElementById:id=>elements.get(id)||null,
  createElement:()=>{const e=el();Object.defineProperty(e,'innerHTML',{get:()=>String(e.textContent).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'),set:()=>{}});return e;},querySelectorAll:selector=>selector.includes('checkbox')?boxes:selector==='.tab'?tabs:selector==='.tab-content'?[...elements.values()].filter(x=>x.id.endsWith('Tab')):[],
  querySelector:selector=>selector==='.tab-content.active'?[...elements.values()].find(x=>x.id.endsWith('Tab')&&x.classList.contains('active')):tabs.find(x=>selector===`.tab[data-tab="${x.dataset.tab}"]`)||null,addEventListener(){}};
 class Socket {static OPEN=1;static CONNECTING=0;constructor(){this.readyState=0;sockets.push(this);}close(){this.closed=true;}}
 const c={window,document,WebSocket:Socket,URL,URLSearchParams,Set,Map,Date,Promise,console,AbortController,
  requestAnimationFrame:fn=>frames.push(fn),setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout(){},
  setInterval:(fn,delay)=>{const id=++next;intervals.set(id,{fn,delay});return id;},clearInterval:id=>intervals.delete(id),
  fetch:(url,options)=>new Promise((resolve,reject)=>requests.push({url,options,resolve,reject})),confirm:()=>true};
 vm.createContext(c);vm.runInContext(source+'\nglobalThis.state=AppState;',c);
 vm.runInContext('showStatus=(...args)=>globalThis.statuses.push(args);initTabSlider=()=>{};updateTabSlider=()=>{};notifyParentConsoleReady=()=>{};syncPanelHash=()=>{};',Object.assign(c,{statuses}));
 c.state.sessionEpoch=1;c.state.sessionReady=true;c.state.authToken='synthetic';
 const ag=c.state.antigravityCreds;
 ag.renderList=()=>ag.updateBatchControls();ag.updatePagination=()=>{};ag.updateStatsDisplay=()=>{};
 const reply=(i,data,status=200)=>requests[i].resolve({ok:status>=200&&status<300,status,json:async()=>data});
 return {c,ag,elements,tabs,intervals,timers,frames,requests,sockets,statuses,reply,
  boxes(names){boxes=names.map(filename=>({checked:false,getAttribute:()=>filename}));return boxes;},
  setFilter(value){elements.get('antigravityModelAccessFilter').value=value;elements.get('antigravityModelAccessFamily').value='claude-opus-5-5';elements.get('antigravityRemarkFilter').value='';ag.applyStatusFilter();}};
}
const page=(names=[],caps=CAPS,more=false)=>({items:names.map(filename=>({filename,error_codes:[]})),total:names.length,has_more:more,panel_capabilities:caps,stats:{}});
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('production timer-only quota snapshots preserve unknown/timer/release and override',()=>{
 const {c}=harness();
 for(const name of ['blocked','combined']){
  const state=c.antigravityQuotaGroupState(fixtures[name],'gemini-shared');assert.equal(state.blockedUnknown,true);assert.equal(state.restricted,true);
  assert.match(c.antigravityQuotaExtra(fixtures[name],true),/data-release-quota="gemini-shared"/);
 }
 const override=c.antigravityQuotaGroupState(fixtures.override,'gemini-shared');assert.equal(override.manualOverride,true);assert.equal(override.restricted,true);assert.equal(override.blockedUnknown,false);
 assert.doesNotMatch(c.antigravityQuotaExtra(fixtures.override,true),/data-release-quota=/);
});
test('invalid/conflicting evidence stays restricted, sparse is unknown and never releasable',()=>{
 const {c}=harness();
 const invalid={...fixtures.blocked,quota_state_invalid:true};
 assert.equal(c.antigravityQuotaGroupState(invalid,'gemini-shared').blockedUnknown,true);
 assert.doesNotMatch(c.antigravityQuotaExtra(invalid,true),/data-release-quota=/);
 const conflict={...fixtures.override,quota_groups:{'gemini-shared':{cooldownUntil:0,blockedUnknown:true,restricted:true}}};
 assert.equal(c.antigravityQuotaGroupState(conflict,'gemini-shared').invalid,true);
 assert.doesNotMatch(c.antigravityQuotaExtra(conflict,true),/data-release-quota=/);
 assert.equal(c.antigravityQuotaGroupState({quota_groups:{'gemini-shared':{cooldownUntil:0}}},'gemini-shared').restricted,null);
});
test('actual manual HTTP failure falls back by independent blocks; new/empty/partial blocks win',()=>{
 const {c}=harness();const cached=fixtures.cached;
 const response=c.antigravityQuotaEvidence(fixtures.failed,cached);
 assert.equal(response.quotaEvidenceSource,'cache');assert.deepEqual(response.model_access_families,fixtures.failed.model_access_families);
 assert.equal(c.antigravityQuotaGroupState(response,'claude-gpt-shared').blockedUnknown,true);
 const empty=c.antigravityQuotaEvidence({quota_groups:{},quota_group_states:{},model_access_families:{}},cached);
 assert.deepEqual(Object.keys(empty.quota_groups),[]);assert.deepEqual(Object.keys(empty.model_access_families),[]);
 assert.equal(c.antigravityQuotaGroupState(empty,'gemini-shared').restricted,false);
 const partial=c.antigravityQuotaEvidence({quota_groups:{'gemini-shared':{cooldownUntil:0}}},cached);
 assert(!('quota_group_states' in partial));assert.equal(c.antigravityQuotaGroupState(partial,'claude-gpt-shared').restricted,null);
 assert.equal(c.antigravityQuotaEvidence({},cached).quotaEvidenceSource,'cache');
});
test('A-B-A changes cancel old selection; old response cannot commit',async()=>{
 const h=harness();h.ag.applyCapabilities(CAPS);h.ag.currentModelAccessFilter='supported';
 const selection=h.ag.selectAllMatching();h.setFilter('unavailable');h.setFilter('supported');
 h.reply(0,page(['old.json']));await selection;assert.equal(h.ag.selectedFiles.size,0);
 h.reply(1,page(['middle.json']));h.reply(2,page(['current.json']));await tick();assert.deepEqual(Object.keys(h.ag.data),['current.json']);
});
test('page navigation keeps all-selection alive; manual change cancels; uncheck only this page',async()=>{
 const h=harness();h.ag.applyCapabilities(CAPS);const boxes=h.boxes(['visible.json']);
 const selection=h.ag.selectAllMatching();h.ag.currentPage=2;h.ag.pageSize=50;h.reply(0,page(['visible.json','offpage.json']));await selection;
 assert.equal(h.ag.selectedFiles.size,2);assert.equal(boxes[0].checked,true);
 h.elements.get('selectAllAntigravityCheckbox').checked=false;h.c.toggleSelectAllAntigravity();assert.deepEqual([...h.ag.selectedFiles],['offpage.json']);
 const next=h.ag.selectAllMatching();h.c.toggleAntigravityFileSelection('manual.json');h.reply(1,page(['late.json']));await next;
 assert.deepEqual([...h.ag.selectedFiles],['offpage.json','manual.json']);
});
test('second selection page capability withdrawal cancels entire task and loads ordinary list once',async()=>{
 const h=harness();h.ag.applyCapabilities(CAPS);h.ag.currentModelAccessFamily='claude-opus-4-6';h.ag.currentModelAccessFilter='supported';
 const pending=h.ag.selectAllMatching();h.reply(0,page(['first.json'],CAPS,true));await tick();
 h.reply(1,page(['second.json'],[]));await tick();assert.equal(h.requests.length,3);h.reply(2,page(['ordinary.json'],[]));await pending;
 assert.equal(h.ag.selectedFiles.size,0);assert.equal(h.ag.currentPage,1);assert.equal(h.ag.currentModelAccessFamily,'claude-opus-5-5');
 assert.equal(h.elements.get('antigravityModelAccessFilter').disabled,true);
});
test('501 locks all used advanced capabilities, only one recovery; 200 cannot bypass lock',async()=>{
 const h=harness();h.ag.applyCapabilities(CAPS);h.ag.currentModelAccessFilter='supported';h.ag.currentCooldownFilter='any_restricted';
 h.ag.selectedFiles.add('old.json');const before=h.ag.filterRevision;const pending=h.ag.refresh();
 h.reply(0,{detail:'legacy failure',capability:FAMILY},501);await tick();assert.equal(h.requests.length,2);
 assert.equal(h.ag.filterRevision,before+1);assert.equal(h.ag.selectedFiles.size,0);
 const retry=new URL(h.requests[1].url,h.c.window.location.href);assert.equal(retry.searchParams.get('cooldown_filter'),'all');assert(!retry.searchParams.has('model_access_family'));
 h.reply(1,page(['ordinary.json'],CAPS));await pending;assert.equal(h.ag.modelAccessFamilyCapability,false);assert.equal(h.ag.cooldownGroupCapability,false);
 h.ag.applyCapabilities(CAPS);assert.equal(h.ag.modelAccessFamilyCapability,false);
});
test('double 501 and mixed 200 withdrawal/501 never cause a third request; ordinary 200 missing cap is recoverable',async()=>{
 for(const first of [200,501]){
  const h=harness();h.ag.applyCapabilities(CAPS);h.ag.currentModelAccessFilter='supported';const pending=h.ag.refresh();
  h.reply(0,first===200?page([],[]):{detail:'legacy'},first);await tick();h.reply(1,{detail:'again',capability:GROUP},501);await pending;
  assert.equal(h.requests.length,2);
 }
 const h=harness();h.ag.applyCapabilities(CAPS);h.ag.applyCapabilities([]);h.ag.applyCapabilities(CAPS);assert.equal(h.ag.modelAccessFamilyCapability,true);
});
test('401 and 500 do not downgrade or expand selection',async()=>{
 for(const status of [401,500]){const h=harness();h.ag.applyCapabilities(CAPS);h.ag.selectedFiles.add('old.json');const pending=h.ag.refresh();h.reply(0,{detail:'failed'},status);await pending;assert.equal(h.requests.length,1);assert.equal(h.ag.modelAccessFamilyCapability,true);assert.equal(h.ag.selectedFiles.size,1);}
});
test('logout stops both intervals/socket, old callbacks and old request finally cannot affect relogin',async()=>{
 const h=harness();h.c.startCooldownTimer();h.c.startStatsAutoRefresh('antigravity');h.c.connectWebSocket();
 assert.deepEqual([...h.intervals.values()].map(x=>x.delay).sort((a,b)=>a-b),[1000,30000]);
 const callbacks=[...h.intervals.values()].map(x=>x.fn),oldMessage=h.sockets[0].onmessage;
 const old=h.ag.refresh();h.c.logout();assert.equal(h.intervals.size,0);assert.equal(h.sockets[0].closed,true);
 callbacks.forEach(fn=>fn());oldMessage({data:'old log'});assert.equal(h.requests.length,1);assert.equal(h.c.state.allLogs.length,0);
 h.c.beginPanelSession('new-synthetic');const fresh=h.ag.refresh();h.reply(0,page(['old.json']));await old;
 assert.equal(h.elements.get('antigravityCredsLoading').style.display,'block');
 h.reply(1,page(['fresh.json'],[]));await fresh;assert.deepEqual(Object.keys(h.ag.data),['fresh.json']);
});
test('expired refresh promise and tab animation cannot restart tasks after logout; same-tab login restores once',async()=>{
 const h=harness();h.ag.applyCapabilities(CAPS);h.ag.statsData={quota_next_expiry:1};h.c.updateCooldownDisplays();h.c.logout();await tick();assert.equal(h.requests.length,0);
 h.c.beginPanelSession('new');h.ag.cooldownRefreshPending=true;await tick();assert.equal(h.ag.cooldownRefreshPending,true);
 h.c.switchTab('config');h.c.logout();h.timers.forEach(fn=>fn());h.frames.forEach(fn=>fn());assert.equal(h.requests.length,0);
 h.c.beginPanelSession('third');h.c.switchTab('antigravity-manage');h.c.switchTab('antigravity-manage');
 assert.equal(h.requests.length,2);assert.equal([...h.intervals.values()].filter(x=>x.delay===30000).length,1);
 h.reply(0,page([],[]));h.reply(1,{totals:{},by_family:{}});await tick();
});

test('version display preserves server version and rejects stale responses',async()=>{
 const h=harness();let p=h.c.fetchAndDisplayVersion();assert.equal(h.requests[0].options.cache,'no-store');
 h.reply(0,{success:true,display_version:'d1004-1 (synthetic)',version:'fallback',source_ref:'d1004-1',full_hash:'synthetic',message:'fixture',commit_date:'fixture-date'});await p;
 assert.equal(h.elements.get('versionText').textContent,'d1004-1 (synthetic)');assert.match(h.elements.get('versionText').title,/fixture-date/);
 p=h.c.fetchAndDisplayVersion();h.reply(1,{success:true,version:'raw-version'});await p;assert.equal(h.elements.get('versionText').textContent,'raw-version');
 p=h.c.fetchAndDisplayVersion();h.c.logout();h.reply(2,{success:true,display_version:'stale'});await p;assert.equal(h.elements.get('versionText').textContent,'raw-version');
 for(const file of ['front/control_panel.html','front/control_panel_mobile.html'])assert.doesNotMatch(fs.readFileSync(file,'utf8'),/id="(?:updateBtn|checkUpdateBtn)"/);
});

test('rapid A-B-A and logout during fade restore visible content and matching button once',async()=>{
 const h=harness(),a=h.elements.get('antigravity-manageTab');
 h.c.state.loadedSessionTab='1:antigravity-manage';h.c.switchTab('config');assert.equal(a.style.opacity,'0');
 h.c.switchTab('antigravity-manage');assert.equal(a.style.opacity,'');assert.equal(a.style.transform,'');
 assert.deepEqual(h.tabs.filter(x=>x.classList.contains('active')).map(x=>x.dataset.tab),['antigravity-manage']);
 h.timers.splice(0).forEach(fn=>fn());h.frames.splice(0).forEach(fn=>fn());assert.equal(h.requests.length,0);
 h.c.switchTab('config');h.c.logout();assert.equal(a.style.opacity,'');assert.equal(a.style.transform,'');
 h.c.beginPanelSession('new-synthetic');h.c.switchTab('antigravity-manage');h.c.switchTab('antigravity-manage');
 h.timers.splice(0).forEach(fn=>fn());h.frames.splice(0).forEach(fn=>fn());
 assert.equal(h.requests.length,2);assert.equal(a.classList.contains('active'),true);assert.equal(a.style.opacity,'');
 assert.deepEqual(h.tabs.filter(x=>x.classList.contains('active')).map(x=>x.dataset.tab),['antigravity-manage']);
 h.reply(0,page([],[]));h.reply(1,{totals:{},by_family:{}});await tick();
});

test('group-only 501 with default family parameters preserves family capability',async()=>{
 for(const machineFields of [{},{error_code:'capability_unavailable',capability:GROUP}]) {
  const h=harness();h.ag.applyCapabilities(CAPS);h.ag.currentCooldownFilter='any_restricted';
  const pending=h.ag.refresh(),first=new URL(h.requests[0].url,h.c.window.location.href);
  assert.equal(first.searchParams.get('model_access_family'),'claude-opus-5-5');assert.equal(first.searchParams.get('model_access_filter'),'all');
  h.reply(0,{detail:'synthetic group unavailable',...machineFields},501);await tick();assert.equal(h.requests.length,2);
  assert.equal(h.ag.failedCapabilities.has(FAMILY),false);assert.equal(h.ag.failedCapabilities.has(GROUP),true);
  assert.equal(h.ag.modelAccessFamilyCapability,true);assert.equal(h.ag.cooldownGroupCapability,false);
  const retry=new URL(h.requests[1].url,h.c.window.location.href);assert.equal(retry.searchParams.get('cooldown_filter'),'all');assert.equal(retry.searchParams.get('model_access_family'),'claude-opus-5-5');
  h.reply(1,page(['ordinary.json'],CAPS));await pending;assert.equal(h.requests.length,2);assert.equal(h.ag.modelAccessFamilyCapability,true);assert.equal(h.ag.cooldownGroupCapability,false);
 }
 const h=harness();h.ag.applyCapabilities(CAPS);const pending=h.ag.refresh();
 h.reply(0,{detail:'synthetic explicit family unavailable',error_code:'capability_unavailable',capability:FAMILY},501);await tick();
 assert.equal(h.ag.failedCapabilities.has(FAMILY),true);assert.equal(h.ag.failedCapabilities.has(GROUP),false);
 h.reply(1,page([],CAPS));await pending;
});
