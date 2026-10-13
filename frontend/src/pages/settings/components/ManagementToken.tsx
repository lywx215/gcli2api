import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { registerSessionCleanup, useAuth } from '@/auth';
import { managementToken, writeFailure } from '../api';
import type { TokenStatus } from '../types';
export function ManagementToken({status,onUpdate}:{status?:TokenStatus;onUpdate:(status:TokenStatus)=>void}) {
  const auth=useAuth();const [token,setToken]=useState('');const [message,setMessage]=useState('');const [pending,setPending]=useState(false);const [confirm,setConfirm]=useState(false);
  const epoch=useRef(auth.sessionEpoch);epoch.current=auth.sessionEpoch;const version=useRef(0);
  useEffect(()=>{const unregister=registerSessionCleanup(()=>{++version.current;setToken('');setConfirm(false);setPending(false);setMessage('会话已变更，秘密输入已清除。');});return()=>{++version.current;unregister();};},[]);
  const disabled=!auth.authenticated||!status||status.locked||pending;
  async function act(action:'PUT'|'DELETE') {
    if(disabled)return;
    if(action==='PUT'&&(token.length<32||token.length>512||token.trim()!==token||/^\*+$/.test(token))){setMessage('请输入 32–512 字符的新 Token，不含首尾空白或掩码占位符。');return;}
    const e=epoch.current,n=++version.current;setPending(true);setConfirm(false);
    try{const next=await managementToken(action,token);if(e!==epoch.current||n!==version.current)return;onUpdate(next);setToken('');setMessage('独立 Token 操作已确认。');}
    catch(error){if(e===epoch.current&&n===version.current)setMessage(writeFailure(error)==='unknown'?'结果未知，请重新读取状态；不会自动重试。':'操作被拒绝。');}
    finally{if(e===epoch.current&&n===version.current)setPending(false);}
  }
  return <Card><CardHeader><CardTitle>Management Token</CardTitle></CardHeader><CardContent className="space-y-3">
    <p>{!status?'状态未知':status.configured?'已配置':'未配置（Management API 关闭）'}{status?.locked?' · 环境变量锁定':''}</p>
    <label htmlFor="management-token">新 Token（独立保存）</label><Input id="management-token" type="password" autoComplete="new-password" value={token} onChange={event=>setToken(event.target.value)} disabled={disabled}/>
    <div className="flex flex-wrap gap-2"><Button type="button" disabled={disabled||!token} onClick={()=>void act('PUT')}>保存 Token</Button><Button type="button" variant="destructive" disabled={disabled||!status?.configured} onClick={()=>setConfirm(true)}>清除 Token</Button></div>
    {confirm&&<div role="alert" className="space-y-2"><p>清除将关闭 Management API，依赖此 Token 的连接会失效。</p><Button variant="destructive" onClick={()=>void act('DELETE')}>确认清除</Button> <Button variant="outline" onClick={()=>setConfirm(false)}>取消</Button></div>}
    <p role="status">{message}</p>
  </CardContent></Card>;
}
