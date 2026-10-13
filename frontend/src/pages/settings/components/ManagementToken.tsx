import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { registerSessionCleanup, useAuth } from '@/auth';
import { managementToken, writeFailure } from '../api';
import type { TokenStatus } from '../types';
import { registerExitDiscard, setExitDirty } from '../exitProtection';
export function ManagementToken({status,onUpdate}:{status?:TokenStatus;onUpdate:(status:TokenStatus)=>void}) {
  const auth=useAuth();const [token,setToken]=useState('');const [message,setMessage]=useState('');const [pending,setPending]=useState(false);const [confirm,setConfirm]=useState(false);
  const epoch=useRef(auth.sessionEpoch);epoch.current=auth.sessionEpoch;const version=useRef(0);
  const [invalid,setInvalid]=useState(false);const input=useRef<HTMLInputElement>(null);
  function discardInput(){setToken('');setInvalid(false);setConfirm(false);setExitDirty('management-token',false);}
  useEffect(()=>{
    const unregister=registerSessionCleanup(()=>{++version.current;discardInput();setPending(false);setMessage('会话已变更，秘密输入已清除。');});
    const unregisterDiscard=registerExitDiscard(()=>{++version.current;discardInput();setPending(false);});
    return()=>{++version.current;setExitDirty('management-token',false);unregister();unregisterDiscard();};
  },[]);
  useEffect(()=>{if(!auth.authenticated||status?.locked){++version.current;discardInput();setPending(false);}else setExitDirty('management-token',token.length>0);},[token,auth.authenticated,status?.locked]);
  const disabled=!auth.authenticated||!status||status.locked||pending;
  async function act(action:'PUT'|'DELETE') {
    if(disabled)return;
    if(action==='PUT'&&(token.length<32||token.length>512||token.trim()!==token||/^\*+$/.test(token))){setInvalid(true);setMessage('请输入 32–512 字符的新 Token，不含首尾空白或掩码占位符。');input.current?.focus();return;}
    const e=epoch.current,n=++version.current;setPending(true);setConfirm(false);
    try{const next=await managementToken(action,token);if(e!==epoch.current||n!==version.current)return;onUpdate(next);discardInput();setMessage('独立 Token 操作已确认。');}
    catch(error){if(e===epoch.current&&n===version.current)setMessage(writeFailure(error)==='unknown'?'结果未知，请重新读取状态；不会自动重试。':'操作被拒绝。');}
    finally{if(e===epoch.current&&n===version.current)setPending(false);}
  }
  return <Card><CardHeader><CardTitle>Management Token</CardTitle></CardHeader><CardContent className="space-y-3">
    <p>{!status?'状态未知':status.configured?'已配置':'未配置（Management API 关闭）'}{status?.locked?' · 环境变量锁定':''}</p>
    <label htmlFor="management-token">新 Token（独立保存）</label><Input ref={input} id="management-token" type="password" autoComplete="new-password" value={token} aria-invalid={invalid} aria-describedby={invalid?'management-token-error':'management-token-help'} onChange={event=>{setToken(event.target.value);setInvalid(false);}} disabled={disabled}/>
    <p id="management-token-help" className="text-xs text-muted-foreground">未提交输入只留在当前页面；环境锁定、会话变化或离开本页会清除。</p>
    <div className="flex flex-wrap gap-2"><Button type="button" disabled={disabled||!token} onClick={()=>void act('PUT')}>保存 Token</Button><Button type="button" variant="outline" disabled={pending||!token} onClick={discardInput}>放弃 Token 输入</Button><Button type="button" variant="destructive" disabled={disabled||!status?.configured} onClick={()=>setConfirm(true)}>清除 Token</Button></div>
    {confirm&&<div role="alert" className="space-y-2"><p>清除将关闭 Management API，依赖此 Token 的连接会失效。</p><Button variant="destructive" onClick={()=>void act('DELETE')}>确认清除</Button> <Button variant="outline" onClick={()=>setConfirm(false)}>取消</Button></div>}
    <p id={invalid?'management-token-error':undefined} role={invalid?'alert':'status'}>{message}</p>
  </CardContent></Card>;
}
