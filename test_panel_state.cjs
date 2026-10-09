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
test('page navigation keeps all-selection alive; manual change cancels; uncheck clears all pages',async()=>{
 const h=harness();h.ag.applyCapabilities(CAPS);const boxes=h.boxes(['visible.json']);
 const selection=h.ag.selectAllMatching();h.ag.currentPage=2;h.ag.pageSize=50;h.reply(0,page(['visible.json','offpage.json']));await selection;
 assert.equal(h.ag.selectedFiles.size,2);assert.equal(boxes[0].checked,true);
 h.elements.get('selectAllAntigravityCheckbox').checked=false;h.c.toggleSelectAllAntigravity();assert.deepEqual([...h.ag.selectedFiles],[]);
 const next=h.ag.selectAllMatching();h.c.toggleAntigravityFileSelection('manual.json');h.reply(1,page(['late.json']));await next;
 assert.deepEqual([...h.ag.selectedFiles],['manual.json']);
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


test('unchecking page selection clears all 50 selections and keeps pages unchecked',()=>{
 const h=harness(),header=h.elements.get('selectAllAntigravityCheckbox');
 const first=Array.from({length:25},(_,i)=>`first-${i}.json`);
 const second=Array.from({length:25},(_,i)=>`second-${i}.json`);
 h.boxes(first);header.checked=true;h.c.toggleSelectAllAntigravity();
 assert.equal(h.ag.selectedFiles.size,25);
 h.ag.currentPage=2;h.boxes(second);header.checked=true;h.c.toggleSelectAllAntigravity();
 assert.equal(h.ag.selectedFiles.size,50);
 header.checked=false;h.c.toggleSelectAllAntigravity();
 assert.equal(h.ag.selectedFiles.size,0);
 assert.equal(h.elements.get('antigravitySelectedCount').textContent,'已选择 0 项');
 assert.equal(h.elements.get('antigravityBatchDeleteBtn').disabled,true);
 assert.equal(header.checked,false);assert.equal(header.indeterminate,false);
 for(const [page,names] of [[1,first],[2,second]]){
  h.ag.currentPage=page;const boxes=h.boxes(names);h.ag.updateBatchControls();
  assert.ok(boxes.every(box=>!box.checked));assert.equal(header.checked,false);
 }
});

test('unchecking cancels a pending cross-page selection before a late response',async()=>{
 const h=harness();h.ag.applyCapabilities(CAPS);h.boxes(['visible.json']);
 h.ag.selectedFiles.add('visible.json');h.ag.selectedFiles.add('offpage.json');h.ag.updateBatchControls();
 const pending=h.ag.selectAllMatching();
 const button=h.elements.get('antigravitySelectAllMatchingBtn');assert.equal(button.disabled,true);
 h.elements.get('selectAllAntigravityCheckbox').checked=false;h.c.toggleSelectAllAntigravity();
 assert.equal(h.ag.selectedFiles.size,0);assert.equal(button.disabled,false);
 h.reply(0,page(['visible.json','offpage.json','late.json']));await pending;
 assert.equal(h.ag.selectedFiles.size,0);assert.equal(button.disabled,false);
 assert.equal(h.elements.get('antigravitySelectedCount').textContent,'已选择 0 项');
 assert.equal(h.elements.get('selectAllAntigravityCheckbox').checked,false);
});

const SEARCH = 'antigravity.credentials.search';
const SEARCH_CAPS = [...CAPS, SEARCH];
test('search remains disabled until supported, draft is isolated and submitting clears selection', async () => {
 const h = harness(), input = h.elements.get('antigravitySearchInput');
 h.ag.applyCapabilities([]); input.value = '1621';
 assert.equal(input.disabled, true); assert.equal(h.ag.applySearch(), undefined);
 assert(!new URL(h.ag.getStatusUrl(0, 25), h.c.window.location.href).searchParams.has('search'));
 h.ag.applyCapabilities(SEARCH_CAPS); assert.equal(input.disabled, false);
 assert.equal(h.ag.currentSearch, ''); assert(!h.ag.getStatusUrl(0, 25).includes('search='));
 h.ag.selectedFiles.add('old.json'); h.ag.currentPage = 3; input.value = ' 001621 ';
 const before = h.ag.filterRevision, pending = h.ag.applySearch();
 assert.equal(h.ag.currentSearch, '001621'); assert.equal(input.value, '001621'); assert.equal(h.ag.currentPage, 1);
 assert.equal(h.ag.selectedFiles.size, 0); assert.equal(h.ag.filterRevision, before + 1);
 assert.equal(new URL(h.requests[0].url, h.c.window.location.href).searchParams.get('search'), '001621');
 h.reply(0, page(['001621_synthetic.json'], SEARCH_CAPS)); await pending;
 input.value = 'unsubmitted@example.invalid'; h.ag.currentPage = 2;
 assert.equal(new URL(h.ag.getStatusUrl(25, 25), h.c.window.location.href).searchParams.get('search'), '001621');
 const clear = h.ag.applySearch(true); assert.equal(input.value, ''); assert.equal(h.ag.currentSearch, '');
 h.reply(1, page([], SEARCH_CAPS)); await clear;
 input.value = 'x'.repeat(256); assert.equal(h.ag.applySearch(), undefined); assert.equal(h.requests.length, 2);
 // Gemini CLI does not send the Antigravity-only parameter.
 h.c.state.creds.currentSearch = '1621'; h.c.state.creds.searchCapability = true;
 assert(!h.c.state.creds.getStatusUrl(0, 25).includes('search='));
});
test('HTTP 200 search capability withdrawal cancels all-selection before applying any page', async () => {
 const h = harness(); h.ag.applyCapabilities(SEARCH_CAPS); h.ag.currentSearch = '1621';
 h.elements.get('antigravitySearchInput').value = '1621';
 const selection = h.ag.selectAllMatching(); h.reply(0, page(['1621_first.json'], SEARCH_CAPS, true)); await tick();
 assert.equal(new URL(h.requests[1].url, h.c.window.location.href).searchParams.get('search'), '1621');
 h.reply(1, page(['unfiltered-old-service.json'], CAPS)); await tick();
 assert.equal(h.ag.currentSearch, ''); assert.equal(h.elements.get('antigravitySearchInput').value, '');
 assert.equal(h.ag.selectedFiles.size, 0); assert.equal(h.elements.get('antigravitySearchBtn').disabled, true);
 assert.equal(h.requests.length, 3); assert(!h.requests[2].url.includes('search='));
 h.reply(2, page(['ordinary.json'], CAPS)); await selection; assert.equal(h.ag.selectedFiles.size, 0);
});
test('search changes invalidate pending selections including A-B-A, and capability 501 cannot be re-enabled in session', async () => {
 const h = harness(); h.ag.applyCapabilities(SEARCH_CAPS); h.ag.currentSearch = 'A';
 const selection = h.ag.selectAllMatching(); h.ag.currentSearch = 'B'; h.ag.invalidateFilters(); h.ag.currentSearch = 'A'; h.ag.invalidateFilters();
 h.reply(0, page(['late.json'], SEARCH_CAPS)); await selection; assert.equal(h.ag.selectedFiles.size, 0);
 const read = h.ag.refresh(); h.reply(1, {capability: SEARCH}, 501); await tick();
 assert.equal(h.ag.searchCapability, false); assert(!h.requests[2].url.includes('search='));
 h.reply(2, page([], SEARCH_CAPS)); await read; assert.equal(h.ag.searchCapability, false);
});
const progress = (id, items, counts, complete = false, total = items.length) => ({job_id:id, sealed:true, complete, total, counts, items});
const uploadWithJob = (id, filename = '1621_synthetic.json') => ({uploaded_count:1, results:[{filename,status:'success'}], email_enrichment:{job_id:id, accepted:1, skipped:0}});
test('email jobs poll outside credential tab, finish once, and refresh after confirmed email writes', async () => {
 const h = harness(), tracker = h.c.state.emailEnrichment;
 h.elements.get('antigravity-manageTab').classList.remove('active');
 tracker.track(uploadWithJob('job-one'), 1); assert.equal(tracker.forFilename('1621_synthetic.json').status, 'queued');
 h.timers.shift()(); await tick(); assert.match(h.requests[0].url, /email-enrichment\/job-one/);
 h.reply(0, progress('job-one', [{filename:'1621_synthetic.json',status:'running'}], {running:1})); await tick();
 assert.equal(tracker.forFilename('1621_synthetic.json').status, 'running'); assert.equal(h.timers.length, 1);
 h.elements.get('antigravity-manageTab').classList.add('active'); h.ag.applyCapabilities(SEARCH_CAPS);
 h.timers.shift()(); await tick(); h.reply(1, progress('job-one', [{filename:'1621_synthetic.json',status:'success',user_email:'synthetic@example.invalid'}], {success:1}, true)); await tick();
 assert.equal(tracker.forFilename('1621_synthetic.json').user_email, 'synthetic@example.invalid'); assert.equal(h.requests.length, 3);
 assert.match(h.requests[2].url, /creds\/status/); h.reply(2, page(['1621_synthetic.json'], SEARCH_CAPS)); await tick();
 assert.equal(h.timers.length, 0); assert.equal(tracker.jobs.get('job-one').complete, true);
 assert.match(h.elements.get('antigravityEmailEnrichmentProgress').textContent, /成功 1/);
});
test('email progress consumes all pages and older job cannot mask a newer upload', async () => {
 const h = harness(), tracker = h.c.state.emailEnrichment;
 tracker.track(uploadWithJob('old-job'), 1); h.timers.shift()(); await tick();
 tracker.track(uploadWithJob('new-job'), 1);
 h.reply(0, progress('old-job', [{filename:'1621_synthetic.json',status:'success',user_email:'old@example.invalid'}], {success:1}, true, 2)); await tick();
 assert.match(h.requests[1].url, /offset=1/);
 h.reply(1, progress('old-job', [{filename:'other.json',status:'failed',reason:'do-not-render-sensitive-response'}], {success:1,failed:1}, true, 2)); await tick();
 assert.match(h.requests[2].url, /new-job/);
 h.reply(2, progress('new-job', [{filename:'1621_synthetic.json',status:'settlement_pending'}], {settlement_pending:1})); await tick();
 assert.equal(tracker.forFilename('1621_synthetic.json').status, 'settlement_pending');
 assert(!h.elements.get('antigravityEmailEnrichmentProgress').textContent.includes('do-not-render-sensitive-response'));
 h.reply(3, page([], CAPS)); await tick();
});
test('expired jobs explain restart and late progress after logout cannot affect new session', async () => {
 const h = harness(), tracker = h.c.state.emailEnrichment;
 tracker.track(uploadWithJob('expired-job'), 1); h.timers.shift()(); await tick(); h.reply(0, {}, 404); await tick();
 assert.equal(tracker.forFilename('1621_synthetic.json').status, 'expired'); assert.equal(h.timers.length, 0);
 assert.match(h.elements.get('antigravityEmailEnrichmentProgress').textContent, /失效.*重启/);
 tracker.track(uploadWithJob('late-job'), 1); h.timers.shift()(); await tick();
 const oldSignal = h.requests[1].options.signal; h.c.logout(); assert.equal(oldSignal.aborted, true); assert.equal(tracker.jobs.size, 0);
 h.c.beginPanelSession('new-synthetic'); h.reply(1, progress('late-job', [{filename:'1621_synthetic.json',status:'success',user_email:'stale@example.invalid'}], {success:1}, true)); await tick();
 assert.equal(tracker.jobs.size, 0); assert.equal(tracker.byFilename.size, 0); assert.equal(h.elements.get('antigravityEmailEnrichmentProgress').hidden, true);
 assert.equal(h.requests.length, 2);
});
test('disabled automatic enrichment warnings are fixed summaries and no job polling starts', () => {
 const h = harness(), tracker = h.c.state.emailEnrichment;
 tracker.track({email_enrichment:{job_id:null,accepted:0,skipped:1},warnings:['RAW UPSTREAM SECRET MUST NEVER APPEAR']},1);
 assert.equal(h.timers.length, 0); assert.match(h.elements.get('antigravityEmailEnrichmentProgress').textContent, /上传仍已保存/);
 assert(!h.elements.get('antigravityEmailEnrichmentProgress').textContent.includes('RAW UPSTREAM'));
});
test('wide layout is scoped to Antigravity, same-tab entry and logout reset it', () => {
 const h = harness(), classes = new Set();
 h.c.document.body.classList = {add: value => classes.add(value), remove: value => classes.delete(value)};
 h.c.state.loadedSessionTab = '1:antigravity-manage'; h.c.switchTab('antigravity-manage'); assert(classes.has('antigravity-wide'));
 h.c.switchTab('config'); assert(!classes.has('antigravity-wide'));
 h.c.switchTab('antigravity-manage'); assert(classes.has('antigravity-wide')); h.c.logout(); assert(!classes.has('antigravity-wide'));
});

test('a failed later progress page keeps polling rather than losing terminal item details', async () => {
 const h = harness(), tracker = h.c.state.emailEnrichment;
 h.elements.get('antigravity-manageTab').classList.remove('active');
 tracker.track(uploadWithJob('partial-job'), 1); h.timers.shift()(); await tick();
 h.reply(0, progress('partial-job', [{filename:'1621_synthetic.json',status:'success',user_email:'synthetic@example.invalid'}], {success:1,failed:1}, true, 2)); await tick();
 h.reply(1, {}, 500); await tick(); assert.equal(tracker.jobs.get('partial-job').complete, false); assert.equal(h.timers.length, 1);
 h.timers.shift()(); await tick(); h.reply(2, progress('partial-job', [{filename:'1621_synthetic.json',status:'success',user_email:'synthetic@example.invalid'}, {filename:'other.json',status:'failed'}], {success:1,failed:1}, true, 2)); await tick();
 assert.equal(tracker.jobs.get('partial-job').complete, true); assert.equal(tracker.forFilename('other.json').status, 'failed'); assert.equal(h.timers.length, 0);
});

test('malformed sparse progress pages have a hard per-poll request bound', async () => {
 const h = harness(), tracker = h.c.state.emailEnrichment;
 h.elements.get('antigravity-manageTab').classList.remove('active');
 tracker.track(uploadWithJob('bounded-job'), 1); h.timers.shift()(); await tick();
 for (let offset = 0; offset < 50; offset++) {
   assert.equal(h.requests.length, offset + 1);
   h.reply(offset, progress('bounded-job', [{filename:'sparse-' + offset + '.json',status:'failed'}], {failed:5000}, true, 5000)); await tick();
 }
 assert.equal(h.requests.length, 50); assert.equal(tracker.jobs.get('bounded-job').complete, false); assert.equal(h.timers.length, 1);
});

test('complete full job marks omitted saved filenames skipped without touching a newer upload', async () => {
 const h = harness(), tracker = h.c.state.emailEnrichment;
 h.elements.get('antigravity-manageTab').classList.remove('active');
 tracker.track({...uploadWithJob('omitted-job'),results:[{filename:'omitted.json',status:'success'},{filename:'reused.json',status:'success'}]},1);
 h.timers.shift()(); await tick();
 tracker.track(uploadWithJob('newer-job','reused.json'),1);
 const newerSequence = tracker.forFilename('reused.json').sequence;
 h.reply(0,progress('omitted-job',[],{skipped:2},true,0)); await tick();
 assert.equal(tracker.forFilename('omitted.json').status,'skipped');
 assert.equal(tracker.forFilename('omitted.json').reason,'not_reported_after_completion');
 assert.equal(tracker.forFilename('reused.json').status,'queued'); assert.equal(tracker.forFilename('reused.json').sequence,newerSequence);
 assert.equal(tracker.jobs.get('omitted-job').complete,true);
 h.reply(1,progress('newer-job',[{filename:'reused.json',status:'running'}],{running:1},false)); await tick();
 assert.equal(tracker.forFilename('reused.json').status,'running');
 assert.match(h.elements.get('antigravityEmailEnrichmentProgress').textContent,/未完成 2/);
 assert(!h.elements.get('antigravityEmailEnrichmentProgress').textContent.includes('not_reported_after_completion'));
});
test('omitted queued records stay pending after partial failures or malformed missing pages', async () => {
 for (const failure of ['http','empty','wrong-job','invalid-item','invalid-total']) {
  const h = harness(), tracker = h.c.state.emailEnrichment;
  h.elements.get('antigravity-manageTab').classList.remove('active');
  tracker.track(uploadWithJob('incomplete-job','omitted.json'),1); h.timers.shift()(); await tick();
  h.reply(0,progress('incomplete-job',[{filename:'reported.json',status:'failed'}],{failed:2,skipped:1},true,2)); await tick();
  if(failure==='http') h.reply(1,{},500);
  if(failure==='empty') h.reply(1,progress('incomplete-job',[],{failed:2,skipped:1},true,2));
  if(failure==='wrong-job') h.reply(1,progress('other-job',[{filename:'reported-two.json',status:'failed'}],{failed:2,skipped:1},true,2));
  if(failure==='invalid-item') h.reply(1,progress('incomplete-job',[{filename:'reported-two.json',status:'invalid'}],{failed:2,skipped:1},true,2));
  if(failure==='invalid-total') h.reply(1,progress('incomplete-job',[{filename:'reported-two.json',status:'failed'}],{failed:2,skipped:1},true,'2'));
  await tick(); assert.equal(tracker.forFilename('omitted.json').status,'queued',failure);
  assert.equal(tracker.jobs.get('incomplete-job').complete,false,failure); assert.equal(h.timers.length,1,failure);
 }
});
test('client records and jobs retain their fixed bounds when completed jobs include omitted names', () => {
 const h = harness(), tracker = h.c.state.emailEnrichment;
 const names = Array.from({length:5001},(_,index)=>({filename:'bounded-'+index+'.json',status:'success'}));
 tracker.track({...uploadWithJob('large-job'),results:names},1); assert.equal(tracker.byFilename.size,5000);
 for(let index=0;index<130;index++) tracker.track(uploadWithJob('bounded-job-'+index,'job-'+index+'.json'),1);
 assert.equal(tracker.jobs.size,128); assert.equal(tracker.byFilename.size,5000);
});
