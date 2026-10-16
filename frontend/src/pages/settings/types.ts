import { z } from 'zod';
export type Value = string | number | boolean | string[] | number[];
export type Config = Record<string, Value>;
export type Draft = Record<string, string | boolean>;
export type TokenStatus = { configured: boolean; locked: boolean; source?: string };
export type EmbedPolicySource = 'environment' | 'storage' | 'default' | 'unknown';
export type EmbedPolicyStatus = {
  readonly source: EmbedPolicySource;
  readonly valid: boolean | 'unknown';
  readonly locked: boolean | 'unknown';
};
export type Snapshot = {
  config: Config;
  envLocked: string[];
  capabilities: string[];
  token?: TokenStatus;
  embedPolicy?: EmbedPolicyStatus;
};
export type Field = { key: string; label: string; section: string; kind?: 'number' | 'boolean' | 'secret' | 'numbers' | 'origins'; min?: number; max?: number; integer?: boolean; choices?: string[]; capability?: string };
export const fields: Field[] = [
  {key:'host',label:'监听地址',section:'服务'}, {key:'port',label:'端口',section:'服务',kind:'number',min:1,max:65535,integer:true},
  {key:'credentials_dir',label:'凭证目录',section:'服务'}, {key:'debug_mode',label:'调试模式',section:'服务',kind:'boolean'},
  ...['api_password','panel_password','password'].map((key,i):Field=>({key,label:['API 密码','面板密码','通用密码'][i],section:'访问安全',kind:'secret'})),
  {key:'gcli_embed_mode',label:'嵌入策略',section:'访问安全',choices:['any_https','exact','disabled']},
  {key:'gcli_embed_allowed_origins',label:'允许的 HTTPS Origin（每行一个）',section:'访问安全',kind:'origins'},
  ...['proxy','code_assist_endpoint','oauth_proxy_url','googleapis_proxy_url','resource_manager_api_url','service_usage_api_url','antigravity_api_url'].map((key,i):Field=>({key,label:['网络代理','Code Assist Endpoint','OAuth 代理','Google APIs 代理','Resource Manager API','Service Usage API','Antigravity API'][i],section:'网络'})),
  {key:'auto_ban_enabled',label:'自动禁用',section:'重试与保护',kind:'boolean'},
  {key:'auto_ban_error_codes',label:'自动禁用错误码（逗号分隔）',section:'重试与保护',kind:'numbers'},
  {key:'retry_429_enabled',label:'启用 429 重试',section:'重试与保护',kind:'boolean'},
  {key:'retry_429_max_retries',label:'429 最大重试次数',section:'重试与保护',kind:'number',min:0,integer:true},
  {key:'retry_429_interval',label:'429 间隔（秒）',section:'重试与保护',kind:'number',min:0.01,max:10},
  {key:'smart_429_protection_enabled',label:'SMART 429 保护',section:'重试与保护',kind:'boolean'},
  {key:'smart_429_max_attempts',label:'SMART 最大尝试次数',section:'重试与保护',kind:'number',min:1,max:5,integer:true},
  {key:'smart_429_retry_base_interval',label:'SMART 重试间隔（秒）',section:'重试与保护',kind:'number',min:0.1,max:5},
  {key:'quota_fallback_cooldown_minutes',label:'额度耗尽兜底冷却（分钟）',section:'重试与保护',kind:'number',min:1,max:1440,integer:true},
  {key:'anti_truncation_max_attempts',label:'抗截断最大尝试次数',section:'重试与保护',kind:'number',min:1,max:10,integer:true},
  ...['compatibility_mode_enabled','return_thoughts_to_frontend','antigravity_stream2nostream','antigravity_switch_credential_enabled'].map((key,i):Field=>({key,label:['兼容模式','返回思维链','Antigravity 流式转非流式','Antigravity 切换凭证'][i],section:'Antigravity',kind:'boolean'})),
  {key:'antigravity_flash_non_stream_mode',label:'Flash 非流模式',section:'Antigravity',choices:['inherit','native','stream_collect'],capability:'antigravity.flash.non_stream_transport'},
  {key:'antigravity_native_timeout_seconds',label:'直接非流超时（秒）',section:'Antigravity',kind:'number',min:30,max:3600,integer:true,capability:'antigravity.native.timeout'},
  {key:'routing_mode',label:'轮巡模式',section:'Antigravity',choices:['normal','unstable']},
  {key:'keepalive_url',label:'保活 URL',section:'保活'},
  {key:'keepalive_interval',label:'保活间隔（秒）',section:'保活',kind:'number',min:5,max:86400,integer:true},
];
export const secretKeys = fields.filter(f=>f.kind==='secret').map(f=>f.key);
export const same = (a:unknown,b:unknown) => JSON.stringify(a)===JSON.stringify(b);
export const sensitiveCarryKeys=fields.filter(f=>f.kind==='secret'||f.section==='网络'||f.key==='keepalive_url').map(f=>f.key);
export function nonSensitive<T extends Config | Draft>(value:T):T {
  return Object.fromEntries(Object.entries(value).filter(([key])=>!sensitiveCarryKeys.includes(key))) as T;
}
export function toDraft(config:Config):Draft {
  return Object.fromEntries(fields.map(f=>[f.key, f.kind==='secret' ? '' : Array.isArray(config[f.key]) ? (config[f.key] as Value[]).join(f.kind==='origins'?'\n':',') : typeof config[f.key]==='boolean' ? config[f.key] : config[f.key]===undefined ? '' : String(config[f.key])])) as Draft;
}
export function editable(field:Field,snapshot:Snapshot):boolean {
  return !snapshot.envLocked.includes(field.key) && (!field.capability || snapshot.capabilities.includes(field.capability));
}
export function parseField(field:Field,raw:string|boolean):Value {
  if(field.kind==='boolean') return z.boolean().parse(raw);
  const text=z.string().parse(raw);
  if(field.kind==='secret') return z.string().min(1,'新密码不能为空').refine(v=>!/^\*+$/.test(v),'不能提交掩码占位符').parse(text);
  if(field.kind==='number') {
    let schema=z.number().finite();
    if(field.integer) schema=schema.int();
    if(field.min!==undefined) schema=schema.min(field.min);
    if(field.max!==undefined) schema=schema.max(field.max);
    if(text.trim()==='') throw new Error('请输入数字，空白不等于 0');
    return schema.parse(Number(text));
  }
  if(field.kind==='numbers') return text.trim()===''?[]:text.split(',').map(item=>{if(!/^\d+$/.test(item.trim()))throw new Error('错误码必须为整数'); return z.number().int().min(100).max(599).parse(Number(item));});
  if(field.kind==='origins') {
    const list=text===''?[]:text.split(/\r?\n/);
    return z.array(z.string().refine(v=>{try {const u=new URL(v);return u.protocol==='https:' && u.origin===v && !u.username && !u.password && !u.hostname.endsWith('.');}catch{return false;}},'请输入规范 HTTPS Origin，不带路径')).refine(v=>new Set(v).size===v.length,'Origin 不可重复').parse(list);
  }
  if(field.choices && !field.choices.includes(text)) throw new Error('请选择支持的值');
  if(field.key==='host' && !text.trim()) throw new Error('监听地址不能为空');
  return text;
}
export function buildPatch(draft:Draft,baseline:Config,snapshot:Snapshot):Config {
  const patch:Config={}; const original=toDraft(baseline);
  for(const f of fields) {
    if(!editable(f,snapshot) || draft[f.key]===undefined || same(draft[f.key],original[f.key]))continue;
    const value=parseField(f,draft[f.key]);
    if(f.kind==='secret' || !same(value,baseline[f.key])) patch[f.key]=value;
  }
  const merged={...baseline,...patch};
  if(merged.gcli_embed_mode==='exact' && (!Array.isArray(merged.gcli_embed_allowed_origins)||!merged.gcli_embed_allowed_origins.length))throw new Error('精确嵌入至少需要一个 HTTPS Origin');
  return patch;
}
export function draftSchema(baseline:Config,snapshot:Snapshot) {
  return z.record(z.string(),z.union([z.string(),z.boolean()])).superRefine((value,ctx)=>{
    const parsed:Config={};
    for(const field of fields) {
      if(!editable(field,snapshot)||same(value[field.key],toDraft(baseline)[field.key])||value[field.key]===undefined)continue;
      try {parsed[field.key]=parseField(field,value[field.key]);}catch {ctx.addIssue({code:'custom',path:[field.key],message:'值无效；请检查范围、格式或密码占位符'});}
    }
    const merged={...baseline,...parsed};
    if(merged.gcli_embed_mode==='exact'&&(!Array.isArray(merged.gcli_embed_allowed_origins)||!merged.gcli_embed_allowed_origins.length)){
      const origins=fields.find(field=>field.key==='gcli_embed_allowed_origins')!;
      ctx.addIssue({code:'custom',path:[editable(origins,snapshot)?origins.key:'gcli_embed_mode'],message:'精确嵌入至少需要一个有效的 HTTPS Origin'});
    }
  });
}
