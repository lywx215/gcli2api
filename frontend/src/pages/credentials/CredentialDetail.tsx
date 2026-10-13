import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { CAP, Generation, text, type Capabilities, type Credential, type RecordValue, type Outcome } from './model'
import { api, actionFailure, failureMessage } from './api'
import { ConfirmAction } from './ConfirmAction'
import { CredentialStateBadge } from './StatusBadges'
import { DetailActionStatus, type ActionFeedback } from './DetailActionStatus'
import { CycleStatistics, ErrorSummary, Evidence, ManualResultView, type ManualResult } from './ResultView'
export function CredentialDetail({ row, caps, close, restoreFocus, busy, action, beforeManual, afterManual, captureTask, revoke }: { row: Credential; caps: Capabilities; close: () => void; restoreFocus: () => void; busy: boolean; action: (names: string[], action: string, remark?: string) => Promise<Outcome | undefined>; beforeManual: () => void; afterManual: () => void; captureTask: () => () => boolean; revoke: (e: unknown) => boolean }) {
  const [remark, setRemark] = useState(text(row.remark, '')); const [model, setModel] = useState('gemini-2.5-flash')
  const [errors, setErrors] = useState<RecordValue | null>(null); const [error, setError] = useState(''); const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<ManualResult | null>(null)
  const life = useRef(new Generation())
  const [actionFeedback, setActionFeedback] = useState<ActionFeedback | null>(null)
  const [deleted, setDeleted] = useState(false)
  useEffect(() => () => { life.current.invalidate() }, [])
  async function loadErrors() {
    const valid = life.current.capture(); const active = captureTask(); setLoading(true); setError('')
    try { const value = await api.errors(row.filename); if (valid() && active()) setErrors(value) }
    catch (e) { if (valid() && active()) setError(failureMessage(e)) }
    finally { if (valid() && active()) setLoading(false) }
  }
  async function manual(operation: 'quota' | 'test' | 'verify-project') {
    const valid = life.current.capture(); const active = captureTask(); setLoading(true); setError(''); setResult(null); beforeManual()
    try { const value = await api.manual(row.filename, operation, model); if (valid() && active()) setResult(value) }
    catch (e) { if (valid() && active() && !revoke(e)) setError(failureMessage(e, true)) }
    finally { if (active()) afterManual(); if (valid() && active()) setLoading(false) }
  }
  async function runAction(name: string, value?: string) {
    if (busy || loading || deleted || actionFeedback?.kind === 'pending') return
    const valid = life.current.capture(); const active = captureTask()
    setActionFeedback({ kind: 'pending' })
    try {
      const outcome = await action([row.filename], name, value)
      if (!valid() || !active()) return
      setActionFeedback(outcome ?? null)
      if (name === 'delete' && outcome?.kind === 'success') setDeleted(true)
    } catch (error) {
      if (valid() && active()) setActionFeedback(actionFailure(error, 1))
    }
  }
  const disabled = busy || loading || deleted || actionFeedback?.kind === 'pending'
  return <Sheet open onOpenChange={open => { if (!open) close() }}><SheetContent onCloseAutoFocus={event => { event.preventDefault(); restoreFocus() }} className="w-full overflow-y-auto rounded-l-xl bg-popover text-popover-foreground sm:max-w-xl"><SheetHeader><SheetTitle className="break-all pr-5 text-[24px] font-semibold">{row.filename}</SheetTitle><SheetDescription className="text-[13px]">列表摘要与手动检测。不会读取完整凭证 JSON。</SheetDescription></SheetHeader><div className="mt-5 grid gap-5">
    <DetailActionStatus feedback={actionFeedback} />
    {deleted && <p className="rounded-lg bg-info-bg text-[13px] text-info">该凭证已删除，关闭后可返回列表。</p>}
    <div className="break-all text-sm">{text(row.user_email, '邮箱未保存')} · <CredentialStateBadge row={row} /> · {text(row.tier)}</div>
    <section className="grid gap-2"><h3 className="text-[18px] font-semibold">已保存证据</h3><Evidence data={row} /><CycleStatistics data={row} /></section>
    <div className="flex flex-wrap gap-2"><Button disabled={disabled} onClick={() => void runAction('enable')}>启用</Button><Button variant="outline" disabled={disabled} onClick={() => void runAction('disable')}>禁用</Button><ConfirmAction label="永久禁用" disabled={disabled || !caps.has(CAP.permanent)} description="将该凭证设为永久禁用。成功动作不会因关闭页面而撤销。" onConfirm={() => void runAction('permanent_disable')} /><ConfirmAction label="删除" disabled={disabled} description="删除此凭证及其保存状态，此操作不可由页面撤销。" onConfirm={() => void runAction('delete')} /></div>
    <section className="grid gap-2"><label className="font-medium" htmlFor="credential-remark">备注</label><Input id="credential-remark" maxLength={64} value={remark} disabled={!caps.has(CAP.remark) || disabled} onChange={e => setRemark(e.target.value)} /><Button variant="outline" disabled={!caps.has(CAP.remark) || disabled} onClick={() => void runAction('remark', remark)}>保存备注</Button>{!caps.has(CAP.remark) && <p className="text-[13px] text-muted-foreground">服务未声明备注编辑能力，仅可查看。</p>}</section>
    <section className="grid gap-2 text-sm"><p>信用额度：{row.enable_credit === true ? '开启' : row.enable_credit === false ? '关闭' : '未知'}</p><ConfirmAction label={row.enable_credit === true ? '关闭信用额度' : '开启信用额度'} disabled={disabled || !caps.has(CAP.credit) || typeof row.enable_credit !== 'boolean'} description="切换信用额度模式会清除该凭证模型冷却，请确认后继续。" onConfirm={() => void runAction(row.enable_credit === true ? 'disable_credit' : 'enable_credit')} />{!caps.has(CAP.credit) && <p className="text-[13px] text-muted-foreground">服务未声明信用额度开关能力。</p>}</section>
    <section className="grid gap-2"><Button variant="outline" disabled={disabled} onClick={() => void loadErrors()}>读取已保存错误</Button>{errors && <ErrorSummary data={errors} />}</section>
    <section className="grid gap-3 rounded-xl border bg-card p-3 text-card-foreground"><h3 className="text-[18px] font-semibold">人工检测</h3><p className="text-[13px] text-muted-foreground">以下按钮会访问上游，可能刷新 Token、更新权限、额度、项目和统计。不会自动重试。</p><Button disabled={disabled} variant="outline" onClick={() => void manual('quota')}>刷新额度并同步状态</Button><label className="grid gap-1 text-sm">测试模型<Input aria-label="测试模型" value={model} onChange={e => setModel(e.target.value)} disabled={disabled} /></label><Button disabled={disabled || !model.trim()} variant="outline" onClick={() => void manual('test')}>发送固定回复模型测试</Button><Button disabled={disabled} variant="outline" onClick={() => void manual('verify-project')}>验证并更新项目</Button></section>
    {loading && <p role="status" className="text-[13px] text-info">处理中…</p>}{error && <p role="alert" className="rounded-lg bg-destructive-bg text-sm text-destructive">{error}</p>}{result && <ManualResultView result={result} />}
  </div></SheetContent></Sheet>
}
