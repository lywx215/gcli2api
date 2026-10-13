import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { registerSessionCleanup, useAuth } from '@/auth';
import { getConfig, readEngine, saveConfig, writeFailure } from './api';
import { buildPatch, draftSchema, nonSensitive, same, secretKeys, sensitiveCarryKeys, toDraft } from './types';
import { registerExitDiscard, setExitDirty } from './exitProtection';
import type { Config, Draft, Snapshot } from './types';
const empty:Snapshot={config:{},envLocked:[],capabilities:[]};
// Only changed non-secret form inputs survive page unmount / authentication changes.
let carriedDraft:Draft={};
let carriedEvidence:{sent:Config;baseline:Config}|undefined;
export function clearCarriedDraft(){carriedDraft={};carriedEvidence=undefined;setExitDirty('configuration',false);setExitDirty('configuration-secrets',false);}
export function useSettings() {
  const auth=useAuth();
  const [snapshot,setSnapshot]=useState<Snapshot>();
  const [baseline,setBaseline]=useState<Config>(carriedEvidence?.baseline??{});
  const [observed,setObserved]=useState<Config>();
  const [sent,setSent]=useState<Config|undefined>(carriedEvidence?.sent);
  const [engine,setEngine]=useState('未知');
  const [status,setStatus]=useState(Object.keys(carriedDraft).length?'草稿已保留；请重新读取配置后对照。':'');
  const [busy,setBusy]=useState(false);
  const [needsRead,setNeedsRead]=useState(Object.keys(carriedDraft).length>0);
  const form=useForm<Draft>({defaultValues:{...toDraft({}),...carriedDraft},resolver:zodResolver(draftSchema(baseline,snapshot??empty))});
  const epoch=useRef(auth.sessionEpoch); epoch.current=auth.sessionEpoch;
  const serial=useRef(0); const mounted=useRef(true); const baselineRef=useRef(baseline);baselineRef.current=baseline;
  const current=(e:number,n:number)=>mounted.current&&e===epoch.current&&n===serial.current;
  const resetting=useRef(false);
  function resetDraft(values:Draft){resetting.current=true;form.reset(values);resetting.current=false;}
  function remember(){
    if(resetting.current)return;
    const original=toDraft(baselineRef.current);
    const values=nonSensitive(form.getValues());
    if(Object.keys(baselineRef.current).length) carriedDraft=Object.fromEntries(Object.entries(values).filter(([k,v])=>!same(v,original[k])));
    setExitDirty('configuration',Object.keys(carriedDraft).length>0);
    const draft=form.getValues();
    setExitDirty('configuration-secrets',sensitiveCarryKeys.some(key=>draft[key]!==undefined&&!same(draft[key],original[key])));
  }
  useEffect(()=>{
    mounted.current=true;
    const subscription=form.watch(()=>remember());
    const unregisterDiscard=registerExitDiscard(scope=>{
      if(scope==='all')clearCarriedDraft();
      const safeBaseline=nonSensitive(baselineRef.current);
      setBaseline(safeBaseline);baselineRef.current=safeBaseline;
      resetDraft(scope==='all'?toDraft(safeBaseline):{...toDraft({}),...nonSensitive(form.getValues())});
      if(scope==='all')setSent(undefined);
      setObserved(previous=>previous?nonSensitive(previous):previous);
      setSnapshot(previous=>previous?{...previous,config:nonSensitive(previous.config)}:previous);
      remember();
    });
    const unregister=registerSessionCleanup(()=>{
      remember(); ++serial.current;
      resetDraft({...toDraft({}),...carriedDraft});
      setSnapshot(undefined);setObserved(undefined);setSent(carriedEvidence?.sent);setBaseline(carriedEvidence?.baseline??{});baselineRef.current=carriedEvidence?.baseline??{};setEngine('未知');setBusy(false);setNeedsRead(true);
      setExitDirty('configuration',Object.keys(carriedDraft).length>0);setExitDirty('configuration-secrets',false);
      setStatus('会话已变更，秘密输入已清除。非敏感草稿仍保留；重新认证后请主动读取对照，不会自动重试保存。');
    });
    return ()=>{remember();setExitDirty('configuration-secrets',false);mounted.current=false;++serial.current;subscription.unsubscribe();unregister();unregisterDiscard();};
  // Form methods are stable; session cleanup is registered once.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  async function refresh(){
    if(!auth.authenticated||busy)return;
    const e=epoch.current,n=++serial.current;setBusy(true);
    // Capability withdrawal takes effect before the observation request finishes.
    setSnapshot(previous=>previous?{...previous,capabilities:[]}:undefined);
    try {
      const next=await getConfig();if(!current(e,n))return;
      setSnapshot(next);setObserved(next.config);setNeedsRead(false);
      if(!snapshot){
        const restoredBaseline={...next.config,...carriedEvidence?.baseline};
        setBaseline(restoredBaseline);baselineRef.current=restoredBaseline;
        const retained={...carriedDraft};
        resetDraft({...toDraft(next.config),...retained}); carriedDraft=retained;
        remember();
      }
      setStatus('已读取当前观察值，草稿未被覆盖。读回不是事务或并发冲突保证。');
      try{const value=await readEngine();if(current(e,n))setEngine(value);}catch{if(current(e,n))setEngine('读取失败');}
    }catch{if(current(e,n)){setNeedsRead(true);setStatus('读取失败；草稿保留，保存暂不可用。');}}
    finally{if(current(e,n))setBusy(false);}
  }
  useEffect(()=>{if(auth.authenticated&&!needsRead&&!snapshot)void refresh();},[auth.authenticated]);
  async function save(values:Draft){
    if(!snapshot||needsRead||busy||!auth.authenticated)return;
    let patch:Config;
    try{patch=buildPatch(values,baseline,snapshot);}catch{setStatus('配置校验失败：请检查输入及精确嵌入 Origin。');return;}
    if(!Object.keys(patch).length){setStatus('没有可提交的修改。');return;}
    const e=epoch.current,n=++serial.current;setBusy(true);setSent(nonSensitive(patch));
    carriedEvidence={sent:nonSensitive(patch),baseline:Object.fromEntries(Object.keys(nonSensitive(patch)).filter(k=>baseline[k]!==undefined).map(k=>[k,baseline[k]]))};
    const passwordChanged=Object.keys(patch).some(k=>k==='panel_password'||k==='password');
    try {
      const result=await saveConfig(patch);if(!current(e,n))return;
      const text={acknowledged:'服务已确认接收保存；请重新读取对照实际值。',partial:'仅部分字段得到确认；请重新读取对照，勿直接重复提交。',rejected:'服务明确拒绝保存；草稿已保留。',unknown:'保存结果未知；请重新读取对照，勿直接重复提交。'}[result.kind];
      setStatus(text);
      setNeedsRead(result.kind!=='rejected');
      if(result.kind==='acknowledged'){
        // An acknowledgement advances the edit baseline, not an observed server
        // snapshot. Unknown/partial saves retain the original comparison evidence.
        const accepted=Object.fromEntries(Object.entries(patch).filter(([key])=>!secretKeys.includes(key)));
        const nextBaseline={...baselineRef.current,...accepted};
        setBaseline(nextBaseline);baselineRef.current=nextBaseline;carriedEvidence=undefined;
        const nextDraft={...form.getValues()},normalized=toDraft(nextBaseline);
        for(const key of Object.keys(accepted))if(same(nextDraft[key],values[key]))nextDraft[key]=normalized[key];
        resetDraft(nextDraft);
      }
      for(const key of secretKeys)form.setValue(key,'');
      remember();
      if(passwordChanged&&result.kind!=='rejected')auth.logout();
    }catch(error){
      if(!current(e,n))return;
      const kind=writeFailure(error);setNeedsRead(kind==='unknown');
      setStatus(kind==='unknown'?'保存结果未知；保留草稿、提交值和原基线。请重新读取对照，不会自动重试。':'请求被拒绝，草稿已保留。');
      if(passwordChanged&&kind==='unknown'){for(const key of secretKeys)form.setValue(key,'');auth.logout();}
    }finally{if(current(e,n))setBusy(false);}
  }
  function acceptObservation(){
    if(!observed)return;
    clearCarriedDraft();setBaseline(observed);baselineRef.current=observed;resetDraft(toDraft(observed));setSent(undefined);setStatus('已明确采用观察值，原草稿已放弃。');
  }
  return {auth,form,snapshot,baseline,observed,sent,engine,status,busy,needsRead,refresh,save,acceptObservation,setStatus,setSnapshot};
}
