import { ApiError, requestJson } from '@/api/client';
import { fields, nonSensitive, same } from './types';
import type { Config, Snapshot, TokenStatus } from './types';
const object=(v:unknown):v is Record<string,unknown> => !!v && typeof v==='object' && !Array.isArray(v);
const strings=(v:unknown):string[] => Array.isArray(v)&&v.every(i=>typeof i==='string')?v:[];
export class SemanticError extends Error {}
export function readSnapshot(raw:unknown):Snapshot {
  if(!object(raw)||!object(raw.config)||raw.success===false||raw.error||!Array.isArray(raw.env_locked)||!raw.env_locked.every(key=>typeof key==='string'))throw new SemanticError('配置响应无效');
  const config:Config={};
  for(const f of fields) {
    if(f.kind==='secret')continue;
    const v=raw.config[f.key];
    if(typeof v==='string'||typeof v==='number'||typeof v==='boolean'||(Array.isArray(v)&&v.every(i=>typeof i==='number'||typeof i==='string')))config[f.key]=v as Config[string];
  }
  const security=object(raw.security)?raw.security:{};
  const value=security.node_management_token;
  const token=object(value)&&typeof value.configured==='boolean'&&typeof value.locked==='boolean'?value as TokenStatus:undefined;
  return {config,envLocked:strings(raw.env_locked),capabilities:strings(raw.capabilities),token};
}
export const fixtureMode=import.meta.env.DEV && import.meta.env.VITE_UI_FIXTURES==='true';
export async function getConfig(signal?:AbortSignal) {if(fixtureMode)return (await import('./fixtures')).snapshot();return readSnapshot(await requestJson('config/get',{signal}));}
export type SaveResult={kind:'acknowledged'|'partial'|'unknown'|'rejected'; acknowledged:string[]};
export function readSave(raw:unknown,sent:Config):SaveResult {
  if(!object(raw))return {kind:'unknown',acknowledged:[]};
  if(raw.success===false||raw.error)return {kind:'rejected',acknowledged:[]};
  const saved=object(raw.saved_config)?raw.saved_config:{};
  const keys=Object.keys(sent).filter(key=>same(saved[key],sent[key]));
  return {kind:keys.length===Object.keys(sent).length?'acknowledged':keys.length?'partial':'unknown',acknowledged:keys};
}
export async function saveConfig(patch:Config) {if(fixtureMode)return readSave((await import('./fixtures')).save(patch),patch);return readSave(await requestJson('config/save',{method:'POST',body:{config:patch}}),patch);}
export function writeFailure(error:unknown):'rejected'|'unknown' {
  return error instanceof ApiError && error.status>=400 && error.status<500 ? 'rejected':'unknown';
}
export async function readEngine(signal?:AbortSignal):Promise<string> {
  if(fixtureMode)return 'synthetic (仅预览)';
  const raw=await requestJson<unknown>('config/storage-engine',{signal});
  if(!object(raw)||typeof raw.current_engine!=='string')throw new SemanticError('存储状态未知');
  return raw.current_engine;
}
export async function managementToken(action:'PUT'|'DELETE',token?:string):Promise<TokenStatus> {
  if(fixtureMode)return (await import('./fixtures')).setToken(action);
  const raw=await requestJson<unknown>('config/management-token',{method:action,...(action==='PUT'?{body:{token}}:{})});
  if(!object(raw)||raw.success===false||raw.error||!object(raw.status)||typeof raw.status.configured!=='boolean'||typeof raw.status.locked!=='boolean')throw new SemanticError('操作结果需重新读取确认');
  return raw.status as TokenStatus;
}
export const safePatch=nonSensitive;
