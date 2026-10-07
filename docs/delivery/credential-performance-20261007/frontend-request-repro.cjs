// Offline source-only reproduction. No credential reads or network requests.
// Run from G:/code/gemini30/gcli2api-master-integration with node <this file>.
const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const s=fs.readFileSync('front/common.js','utf8');
const section=(a,b)=>s.slice(s.indexOf(a),s.indexOf(b,s.indexOf(a)));
const elements=new Map();const requests=[];const modals=[];
const ctx={URL,URLSearchParams,Set,Map,Date,Promise,console,window:{location:{href:'https://synthetic.invalid/'}},document:{getElementById:id=>{if(!elements.has(id)) elements.set(id,{style:{},options:[],value:'all'});return elements.get(id)},querySelectorAll:()=>[]},AppState:{sessionEpoch:1},getAuthHeaders:()=>({}),showStatus:()=>{},confirm:()=>true,showMessageModal:(...a)=>modals.push(a),modelAccessResultText:()=>'',manualResultSummary:()=>'',modelAccessBatchText:()=>'',modelAccessOverviewText:()=>'',fetch:(url,opts)=>new Promise(resolve=>requests.push({url,opts,resolve}))};
vm.createContext(ctx);vm.runInContext(section('function createCredsManager(', 'function createUploadManager(')+section('async function batchRefreshCooldownCredentials(', 'function batchRefreshCooldownSelectedCredentials('),ctx);
const ag=ctx.createCredsManager('antigravity');ag.renderList=()=>{};ag.updateStatsDisplay=()=>{};ag.updatePagination=()=>{};
const page={items:[],total:0,panel_capabilities:['antigravity.cooldown.group_filter','antigravity.model_access.family_filter'],stats:{}};
function reply(i,data){requests[i].resolve({ok:true,status:200,json:async()=>data});}
const tick=()=>new Promise(r=>setImmediate(r));
(async()=>{
 const first=ag.refresh();reply(0,page);await first;assert.equal(requests.length,1);
 console.log(JSON.stringify({case:'normal first refresh with capabilities',requests:requests.length}));
 const pending=[ag.refresh(),ag.refresh(),ag.refresh()];assert.equal(requests.length,4);
 console.log(JSON.stringify({case:'three overlapping refreshes',requests:requests.length-1,abortSignals:requests.slice(1).filter(x=>x.opts.signal).length}));
 reply(1,page);reply(2,page);reply(3,page);await Promise.all(pending);
 ag.selectedFiles.add('synthetic.json');const batch=ctx.batchRefreshCooldownCredentials(ag,'Antigravity');reply(4,{success_count:1,results:[{success:true,filename:'synthetic.json'}]});await tick();
 assert.equal(requests.length,6);assert.equal(modals.length,0);
 console.log(JSON.stringify({case:'batch HTTP completed, list HTTP pending',requests:requests.slice(4).map(x=>x.url.split('?')[0]),completionModals:modals.length}));
 reply(5,page);await batch;assert.equal(modals.length,1);console.log(JSON.stringify({case:'list HTTP completed',completionModals:modals.length}));
 ag.updateBatchControls(); const offset=requests.length;
 const duplicateA=ctx.batchRefreshCooldownCredentials(ag,'Antigravity');
 const duplicateB=ctx.batchRefreshCooldownCredentials(ag,'Antigravity');
 assert.equal(requests.length-offset,2);
 console.log(JSON.stringify({case:'two batch clicks with both confirmations accepted',concurrentBatchRequests:requests.length-offset,disabledButtons:[...elements.values()].filter(e=>e.disabled===true).length}));
 reply(offset,{success_count:1,results:[]});reply(offset+1,{success_count:1,results:[]});await tick();
 reply(offset+2,page);reply(offset+3,page);await Promise.all([duplicateA,duplicateB]);
 console.log('All offline assertions passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});

// Exercise the real toast lifetime, with a synthetic clock and synthetic DOM.
const toastTimers=[];
const statusDiv={classList:{add(){}},offsetHeight:1};
const statusSection={innerHTML:'',querySelector:()=>statusDiv};
const toastContext={window:{},document:{getElementById:()=>statusSection},setTimeout:(fn,ms)=>{toastTimers.push({fn,ms});return toastTimers.length;},clearTimeout:()=>{},showMessageModal:()=>{}};
vm.createContext(toastContext);
vm.runInContext(section('function showStatus(', 'function linkifyText('),toastContext);
toastContext.showStatus('Synthetic batch running','info');
assert.notEqual(statusSection.innerHTML,'');
toastTimers[0].fn();toastTimers[1].fn();assert.equal(statusSection.innerHTML,'');
console.log(JSON.stringify({case:'batch-start toast lifetime',delaysMs:toastTimers.map(t=>t.ms),toastClearedWithoutBatchCompletion:true}));
