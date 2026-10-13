import { useEffect, useState } from 'react'
import { getServiceBase } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { completeOAuth, importTokens, startOAuth, uploadFiles } from './api'
import { EmailResults, ImportResults } from './components'
import { useImportFlow } from './hooks'

export default function ImportPage() {
  const flow = useImportFlow()
  const [method, setMethod] = useState<'oauth' | 'files' | 'tokens'>('oauth')
  const [files, setFiles] = useState<File[]>([])
  const [fileKey, setFileKey] = useState(0)
  const [tokens, setTokens] = useState('')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [projectId, setProjectId] = useState('')
  const [filename, setFilename] = useState('')
  const [callbackUrl, setCallbackUrl] = useState('')
  const preview = import.meta.env.DEV && import.meta.env.VITE_UI_FIXTURES === 'true'
  const legacy = new URL(getServiceBase()); legacy.hash = 'antigravity-manage'
  function clearSecrets() { setTokens(''); setClientSecret(''); setCallbackUrl(''); setFiles([]); setFileKey(key => key + 1) }
  useEffect(() => { clearSecrets(); setClientId(''); setProjectId(''); setFilename('') }, [flow.sessionEpoch, flow.authenticated])
  const tokenList = [...new Set(tokens.split(/\r?\n/).map(value => value.trim()).filter(Boolean))]
  const disabled = flow.busy || !flow.authenticated
  return <section className="mx-auto max-w-4xl space-y-6">
    <header><h1 className="text-2xl font-semibold">导入凭证</h1><p className="mt-2 text-muted-foreground">添加 Antigravity 账号。操作只在提交后开始，结果按每项显示。</p></header>
    {preview && <p role="status" className="rounded-md border p-3">合成预览：不会调用后台或打开真实 OAuth。点击完成授权可查看示例结果。</p>}
    {!flow.authenticated && <p role="status">请先登录。</p>}
    <div className="flex flex-wrap gap-2" aria-label="导入方式">
      {(['oauth', 'files', 'tokens'] as const).map(value => <Button key={value} variant={method === value ? 'default' : 'outline'} disabled={flow.busy} aria-pressed={method === value} onClick={() => setMethod(value)}>{({ oauth: 'OAuth 授权', files: 'JSON / ZIP 文件', tokens: 'Refresh token' })[value]}</Button>)}
    </div>
    <Card><CardHeader><CardTitle>{method === 'oauth' ? 'Google OAuth 授权' : method === 'files' ? '导入凭证文件' : '通过 Refresh token 添加'}</CardTitle></CardHeader>
    <CardContent className="space-y-4">
      {method === 'oauth' && <>
        <label className="block space-y-2"><span>项目 ID（可选，留空自动检测）</span><Input value={projectId} onChange={event => setProjectId(event.target.value)} disabled={disabled} /></label>
        {flow.prompt && <div role="status" className="rounded-md border p-3"><p>{flow.prompt.manual ? '需要手动填写项目 ID' : '请选择项目后继续授权'}</p>{flow.prompt.projects.map(project => <Button key={project} variant="outline" className="m-1" onClick={() => setProjectId(project)}>{project}</Button>)}</div>}
        <Button disabled={disabled} onClick={() => void flow.run(signal => startOAuth(projectId, signal))}>生成授权链接</Button>
        {flow.authUrl && <p><a className="underline underline-offset-4" href={flow.authUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">打开 Google 授权页面</a></p>}
        <p className="text-sm text-muted-foreground">在授权页面完成操作后，点击完成授权。若浏览器显示无法连接本地回调地址，可粘贴完整回调 URL。</p>
        <label className="block space-y-2"><span>回调 URL（可选，含敏感授权码）</span><Input type="password" autoComplete="off" value={callbackUrl} onChange={event => setCallbackUrl(event.target.value)} disabled={disabled} /></label>
        <Button disabled={disabled || (!preview && !flow.authUrl && !callbackUrl)} onClick={() => void flow.run(signal => completeOAuth(callbackUrl.trim() || null, projectId.trim(), signal), clearSecrets)}>完成授权</Button>
      </>}
      {method === 'files' && <>
        <label className="block space-y-2"><span>选择 JSON 或 ZIP（可多选）</span><Input key={fileKey} type="file" multiple accept=".json,.zip" disabled={disabled} onChange={event => setFiles(Array.from(event.target.files ?? []))} /></label>
        <p className="text-sm text-muted-foreground">已选 {files.length} 个文件。ZIP 不递归解压；文件数量和解压预算由服务器校验。</p>
        <Button disabled={disabled || !files.length} onClick={() => void flow.run(signal => uploadFiles(files, signal), clearSecrets)}>上传并导入</Button>
      </>}
      {method === 'tokens' && <>
        <label className="block space-y-2"><span>Refresh token（每行一个）</span><Textarea autoComplete="off" spellCheck={false} rows={5} value={tokens} onChange={event => setTokens(event.target.value)} disabled={disabled} /></label>
        <p className="text-sm text-muted-foreground">共 {tokenList.length} 个去重后 token，每批最多 200 个；输入仅保留在本页内存中。</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-2"><span>Client ID（可选）</span><Input value={clientId} disabled={disabled} onChange={event => setClientId(event.target.value)} /></label>
          <label className="space-y-2"><span>Client secret（可选）</span><Input type="password" autoComplete="off" value={clientSecret} disabled={disabled} onChange={event => setClientSecret(event.target.value)} /></label>
          <label className="space-y-2"><span>{tokenList.length > 1 ? '文件名前缀（可选）' : '文件名（可选）'}</span><Input value={filename} disabled={disabled} onChange={event => setFilename(event.target.value)} /></label>
          {tokenList.length <= 1 && <label className="space-y-2"><span>项目 ID（可选）</span><Input value={projectId} disabled={disabled} onChange={event => setProjectId(event.target.value)} /></label>}
        </div>
        <Button disabled={disabled || !tokenList.length || tokenList.length > 200} onClick={() => void flow.run(signal => importTokens({ tokens: tokenList, clientId, clientSecret, projectId, filename }, signal), clearSecrets)}>添加 {tokenList.length > 1 ? '批量凭证' : '凭证'}</Button>
      </>}
    </CardContent></Card>
    {flow.busy && <div role="status" className="flex items-center gap-3"><p>请求处理中…</p><Button variant="outline" onClick={() => { flow.cancel(); clearSecrets() }}>停止等待</Button></div>}
    {flow.message && <p role="status" className="rounded-md border p-3">{flow.message}</p>}
    {flow.result && <ImportResults result={flow.result} />}
    {(flow.jobId || flow.email || flow.emailMessage) && <Card><CardHeader><CardTitle>邮箱补全</CardTitle></CardHeader><CardContent className="space-y-3">
      {flow.email ? <EmailResults snapshot={flow.email} /> : flow.jobId && <p>正在读取邮箱补全进度…</p>}
      {flow.emailMessage && <p role="status">{flow.emailMessage}</p>}
      {flow.jobId && !flow.email?.complete && <Button variant="outline" onClick={flow.stopEmail}>停止跟踪</Button>}
    </CardContent></Card>}
    <div className="flex flex-wrap gap-4"><a href="#/credentials" className="underline underline-offset-4">查看凭证列表</a>{!preview && <a href={legacy.href} className="underline underline-offset-4">旧 AG 面板：手动获取邮箱与高级工具</a>}</div>
  </section>
}
