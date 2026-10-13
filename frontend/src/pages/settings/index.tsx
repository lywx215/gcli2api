import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getServiceBase } from '@/api/client';
import { useSettings } from './hooks';
import { fixtureMode } from './api';
import { fields, same, toDraft } from './types';
import { ManagementToken } from './components/ManagementToken';
import { ConfigField } from './components/ConfigField';
import { UnsavedChangesGuard } from './components/UnsavedChangesGuard';
export default function SettingsPage(){
  const s=useSettings();const values=s.form.watch();const original=toDraft(s.baseline);
  const changes=fields.filter(f=>values[f.key]!==undefined&&!same(values[f.key],original[f.key]));
  const legacy=new URL(getServiceBase());legacy.hash='config';
  return <div id="settings-content" tabIndex={-1} className="mx-auto max-w-6xl space-y-6">
    {fixtureMode&&<p role="status" className="rounded-md border border-border p-3">合成预览：本页所有操作仅影响内存示例，不访问后台。</p>}<header><h1 className="text-2xl font-semibold">设置</h1><p className="text-muted-foreground">Antigravity 与共享配置。只提交已修改且未被环境锁定的字段。</p></header>
    <div className="flex flex-wrap gap-3"><Button id="settings-read-config" variant="outline" disabled={s.busy||!s.auth.authenticated} onClick={()=>void s.refresh()}>重新读取并对照</Button>{s.observed&&<Button variant="outline" disabled={s.busy} onClick={s.acceptObservation}>放弃草稿并采用观察值</Button>}</div>
    <p className="text-sm text-muted-foreground">非敏感草稿只保留在当前标签页内存。切换新版页面可保留修改；刷新、关闭浏览器或前往旧页面会丢失草稿，请先处理未保存修改。</p>
    <p role="status" aria-live="polite">{s.busy?'正在处理…':s.status}</p>
    <UnsavedChangesGuard />
    <p className="rounded-md border p-3 text-sm text-muted-foreground">监听地址、端口、凭证目录等运行配置保存后可能需要重启服务才生效；保存确认不代表运行进程已切换。本页不会自动重启。</p>
    {!s.auth.authenticated&&<p role="alert">请重新登录。非敏感草稿仅保存在内存，秘密输入已清除。</p>}
    <form noValidate onSubmit={s.form.handleSubmit(s.save,errors=>{
      const first=fields.find(field=>errors[field.key]);
      if(first){s.form.setFocus(first.key);document.getElementById(first.key)?.scrollIntoView?.({block:'center'});}
    })} className="space-y-6">
      {[...new Set(fields.map(f=>f.section))].map(section=><Card key={section}><CardHeader><CardTitle>{section}</CardTitle></CardHeader><CardContent className="grid gap-4 md:grid-cols-2">{fields.filter(f=>f.section===section).map(field=><ConfigField key={field.key} field={field} form={s.form} snapshot={s.snapshot} disabled={s.busy||!s.auth.authenticated}/>)}</CardContent></Card>)}
      <Card><CardHeader><CardTitle>修改对照（{changes.length}）</CardTitle></CardHeader><CardContent className="space-y-3"><p className="text-sm text-muted-foreground">读取仅反映当前观察值，不保证事务、原子性或没有其他写入。密码与可能含秘密的网络字段均隐藏值。</p>
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th>字段</th><th>原基线</th><th>草稿</th><th>最近提交</th><th>当前观察</th></tr></thead><tbody>{changes.map(f=>{
          const redact=f.kind==='secret'||f.section==='网络'||f.key==='keepalive_url';const show=(value:unknown)=>value===undefined?'未提供':redact?'[已隐藏]':JSON.stringify(value);
          return <tr className="border-t border-border" key={f.key}><th className="py-2">{f.label}</th><td>{show(s.baseline[f.key])}</td><td>{show(values[f.key])}</td><td>{show(s.sent?.[f.key])}</td><td>{show(s.observed?.[f.key])}</td></tr>;
        })}</tbody></table></div>
        <Button type="submit" disabled={s.busy||!s.auth.authenticated||!s.snapshot||s.needsRead||!changes.length}>保存已修改字段</Button>
      </CardContent></Card>
    </form>
    <ManagementToken status={s.snapshot?.token} onUpdate={token=>s.setSnapshot(previous=>previous?{...previous,token}:previous)}/>
    <Card><CardHeader><CardTitle>存储与模型路由</CardTitle></CardHeader><CardContent className="space-y-3"><p>当前存储引擎：{s.engine}</p><p className="text-sm text-muted-foreground">切换存储可能迁移或覆盖数据、改变凭证可见性。请在旧配置页检查预览、备份与目标，再明确确认切换。本页不执行迁移。</p><div className="flex flex-wrap gap-4">{fixtureMode?<span className="text-muted-foreground">合成预览中不打开真实存储入口。</span>:<a className="underline" href={legacy.href}>旧配置页：存储预览与切换</a>}<a className="underline" href="#/model-routing">模型路由编辑器</a></div></CardContent></Card>
  </div>;
}
