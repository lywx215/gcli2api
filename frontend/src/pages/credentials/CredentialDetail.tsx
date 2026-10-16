import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import type { PanelMode, PanelScope } from '@/domain/panel'
import type { SessionValidationSnapshot } from '@/auth/session'
import {
  CAP,
  CAP_BY_MODE,
  Generation,
  text,
  type Capabilities,
  type Credential,
  type RecordValue,
  type Outcome,
} from './model'
import {
  api,
  actionFailure,
  failureMessage,
  projectManualPublicDetails,
  reprojectManualPublicDetails,
  type createCredentialApi,
  type SafeManualPublicDetails,
} from './api'
import { ConfirmAction } from './ConfirmAction'
import { CredentialStateBadge } from './StatusBadges'
import { DetailActionStatus, type ActionFeedback } from './DetailActionStatus'
import { CycleStatistics, Evidence, ManualResultView, type ManualResult } from './ResultView'
import { LegacyModelQuota } from './LegacyModelQuota'
import { AgQuotaEvidence, type AgQuotaEvidenceReceipt } from './AgQuotaEvidence'
import { SavedErrorDetails } from './SavedErrorDetails'
import { EmailMaintenance } from './EmailMaintenance'
import { createAdvancedCredentialApi, getPreviewFailureReceipt } from './advancedApi'

export interface CredentialDetailToolSession {
  readonly id: number
  readonly ownerRevision: object
  readonly isCurrentOwner: () => boolean
  readonly onClose: () => void
  readonly onRefresh?: () => void
}

export interface CredentialDetailProps {
  row: Credential
  caps: Capabilities
  close: () => void
  restoreFocus: () => void
  busy: boolean
  action: (names: string[], action: string, remark?: string) => Promise<Outcome | undefined>
  beforeManual: (token?: object) => boolean | void
  afterManual: (token?: object) => void
  captureTask: () => () => boolean
  revoke: (e: unknown) => boolean
  mode?: PanelMode
  credentialApi?: ReturnType<typeof createCredentialApi>
  scope?: Readonly<PanelScope>
  validation?: Readonly<SessionValidationSnapshot>
  ownerRevision?: object
  isCurrentOwner?: () => boolean
  isCurrentOpening?: () => boolean
  onRefresh?: () => void
  toolSessionActive?: boolean
  onOpenToolSession?: (tool: 'files' | 'email') => boolean | void
  onCloseToolSession?: () => void
  nestedEmailSession?: CredentialDetailToolSession | null
}

interface ManualAttempt {
  readonly id: number
  readonly filename: string
  readonly operation: 'quota' | 'test' | 'verify-project' | 'preview'
  readonly controller: AbortController
  readonly token: object
  retired: boolean
  finishReason?: 'success' | 'failure' | 'stop' | 'dispose'
  finishOnce: (reason: 'success' | 'failure' | 'stop' | 'dispose') => boolean
}

function projectPresentationResult(
  result: ManualResult,
  publicDetails?: SafeManualPublicDetails
): ManualResult {
  const rawData = result.data as Record<string, unknown> | null | undefined
  const projectedData: Record<string, unknown> = {}
  if (rawData && typeof rawData === 'object' && !Array.isArray(rawData)) {
    if ('phase' in rawData) projectedData.phase = rawData.phase
    if ('phases' in rawData) projectedData.phases = rawData.phases
    if ('error_code' in rawData) projectedData.error_code = rawData.error_code
    if ('state_update' in rawData) projectedData.state_update = rawData.state_update
    if ('quota_groups' in rawData) projectedData.quota_groups = rawData.quota_groups
    if ('quota_group_states' in rawData) projectedData.quota_group_states = rawData.quota_group_states
    if ('quota_state_invalid' in rawData) projectedData.quota_state_invalid = rawData.quota_state_invalid
    if ('model_access_families' in rawData) projectedData.model_access_families = rawData.model_access_families
    if ('models' in rawData) projectedData.models = rawData.models
  }
  return {
    success: result.success,
    httpStatus: result.httpStatus,
    upstreamStatus: result.upstreamStatus,
    verifiedReply: result.verifiedReply,
    updates: result.updates,
    data: projectedData as ManualResult['data'],
    ...(publicDetails ? { publicDetails } : {}),
  }
}

export function CredentialDetail({
  row,
  caps,
  close,
  restoreFocus,
  busy,
  action,
  beforeManual,
  afterManual,
  captureTask,
  revoke,
  mode = 'antigravity',
  credentialApi = api,
  scope,
  validation,
  ownerRevision,
  isCurrentOwner,
  isCurrentOpening,
  onRefresh,
  toolSessionActive = false,
  onOpenToolSession,
  onCloseToolSession,
  nestedEmailSession,
}: CredentialDetailProps) {
  const [remark, setRemark] = useState(text(row.remark, ''))
  const [model, setModel] = useState('gemini-2.5-flash')
  const [errors, setErrors] = useState<RecordValue | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<ManualResult | null>(null)
  const [quotaModels, setQuotaModels] = useState<Record<string, unknown>>({})
  const [responseReceipt, setResponseReceipt] = useState<AgQuotaEvidenceReceipt | null>(null)
  const [emailOpen, setEmailOpen] = useState(false)
  const [activeAttempt, setActiveAttempt] = useState<ManualAttempt | null>(null)

  const filesTriggerRef = useRef<HTMLButtonElement | null>(null)
  const emailTriggerRef = useRef<HTMLButtonElement | null>(null)

  const life = useRef(new Generation())
  const mountedLifeRef = useRef<() => boolean>(life.current.capture())
  const isMounted = () => mountedLifeRef.current()
  const [actionFeedback, setActionFeedback] = useState<ActionFeedback | null>(null)
  const [deleted, setDeleted] = useState(false)
  const modeCaps = CAP_BY_MODE[mode]

  const hasOwnerContext = Boolean(scope && validation && ownerRevision && isCurrentOwner && isCurrentOpening)

  const fallbackTaskRef = useRef<(() => boolean) | null>(null)
  if (!fallbackTaskRef.current) {
    fallbackTaskRef.current = captureTask()
  }
  const fallbackPredicate = useRef(() => (fallbackTaskRef.current ? fallbackTaskRef.current() : false)).current
  const isCurrent = isCurrentOpening ?? fallbackPredicate

  const currentAttemptRef = useRef<ManualAttempt | null>(null)
  const attemptSerialRef = useRef(0)

  useEffect(() => {
    if (!mountedLifeRef.current()) {
      mountedLifeRef.current = life.current.capture()
    }
    return () => {
      life.current.invalidate()
      if (currentAttemptRef.current) {
        const att = currentAttemptRef.current
        try {
          att.controller.abort(new DOMException('操作已取消。', 'AbortError'))
        } catch {}
        att.finishOnce('dispose')
      }
    }
  }, [])

  useEffect(() => {
    if (!toolSessionActive && emailOpen) {
      setEmailOpen(false)
    }
  }, [toolSessionActive, emailOpen])

  function handleStopWaiting(targetAttempt: ManualAttempt) {
    if (currentAttemptRef.current !== targetAttempt || targetAttempt.retired) return
    if (!isCurrent() || !isMounted()) return
    try {
      targetAttempt.controller.abort(new DOMException('操作已取消。', 'AbortError'))
    } catch {}
    targetAttempt.finishOnce('stop')
    setError('等待已停止，后端可能已保存状态；请重新读取状态确认。')
  }

  async function loadErrors() {
    if (busy || loading || deleted || actionFeedback?.kind === 'pending' || toolSessionActive) return
    if (!isCurrent() || !isMounted()) return
    const controller = new AbortController()
    setLoading(true)
    setError('')
    try {
      const value = await credentialApi.errors(row.filename, controller.signal)
      if (isCurrent() && isMounted()) {
        setErrors(value)
      }
    } catch (e) {
      if (isCurrent() && isMounted()) {
        setError(failureMessage(e))
      }
    } finally {
      if (isCurrent() && isMounted()) {
        setLoading(false)
      }
    }
  }

  async function runManual(
    operation: 'quota' | 'test' | 'verify-project' | 'preview',
    testModelOverride?: string,
    testChoice?: 'default' | 'chosen'
  ) {
    if (busy || loading || deleted || actionFeedback?.kind === 'pending' || toolSessionActive) return
    if (currentAttemptRef.current !== null && !currentAttemptRef.current.retired) return
    if (!isCurrent() || !isMounted()) return
    if (operation === 'preview' && (!hasOwnerContext || mode !== 'geminicli')) return

    let targetModel: string | undefined = undefined
    if (operation === 'quota') {
      targetModel = testModelOverride ?? model
    } else if (operation === 'test') {
      if (mode === 'geminicli' && testChoice === 'default') {
        targetModel = undefined
      } else {
        const m = (testModelOverride ?? model).trim()
        if (!m) return
        targetModel = m
      }
    } else if (operation === 'verify-project') {
      targetModel = testModelOverride ?? model
    }

    const attemptId = ++attemptSerialRef.current
    const controller = new AbortController()
    const token = Object.freeze({})

    let finished = false
    const finishOnce = (reason: 'success' | 'failure' | 'stop' | 'dispose'): boolean => {
      if (finished) return false
      finished = true
      attempt.retired = true
      attempt.finishReason = reason
      const isCurrentAttempt = currentAttemptRef.current === attempt
      if (isCurrentAttempt) {
        currentAttemptRef.current = null
      }
      if (isCurrentAttempt) {
        afterManual(attempt.token)
        setLoading(false)
        setActiveAttempt(curr => (curr === attempt ? null : curr))
        if (reason === 'dispose') {
          // Dispose suppressing local publication
        }
      }
      return true
    }

    const attempt: ManualAttempt = {
      id: attemptId,
      filename: row.filename,
      operation,
      controller,
      token,
      retired: false,
      finishOnce,
    }

    const admitted = beforeManual(token)
    if (admitted === false) {
      attempt.retired = true
      return
    }

    // R10 minimal policy: after beforeManual accepts a new quota request,
    // clear obsolete models, quota presentation, and prior response receipt.
    // Unrelated test/verify actions must not erase valid model cards.
    if (operation === 'quota') {
      setQuotaModels({})
      setResponseReceipt(null)
    }

    currentAttemptRef.current = attempt
    setActiveAttempt(attempt)
    setLoading(true)
    setError('')
    setResult(null)

    try {
      let value: ManualResult
      if (operation === 'preview') {
        if (mode !== 'geminicli' || !scope) {
          throw new Error('当前渠道不支持配置预览。')
        }
        const advApi = createAdvancedCredentialApi(mode, scope)
        const prevRes = await advApi.configurePreview(row.filename, controller.signal)
        value = prevRes as unknown as ManualResult
      } else {
        value = await credentialApi.manual(row.filename, operation, targetModel, controller.signal)
      }

      if (currentAttemptRef.current !== attempt || attempt.retired || !isCurrent() || !isMounted()) {
        return
      }

      attempt.finishOnce('success')

      setResult(value)

      // Only a current, well-formed, successful quota response repopulates cards
      if (operation === 'quota' && value?.success && value.data && typeof value.data === 'object' && !Array.isArray(value.data)) {
        const rawModels = (value.data as Record<string, unknown>).models
        if (rawModels && typeof rawModels === 'object' && !Array.isArray(rawModels) && Object.keys(rawModels).length > 0) {
          setQuotaModels(rawModels as Record<string, unknown>)
        } else {
          setQuotaModels({})
        }
      }

      // Only a genuine successful quota response sets response receipt
      if (mode === 'antigravity' && operation === 'quota' && value && value.success && validation && scope && hasOwnerContext) {
        const receipt: AgQuotaEvidenceReceipt = Object.freeze({
          source: 'response',
          filename: row.filename,
          scope,
          validation,
          result: value,
        })
        setResponseReceipt(receipt)
      }
    } catch (e) {
      if (currentAttemptRef.current !== attempt || attempt.retired) return
      attempt.finishOnce('failure')
      if (isCurrent() && isMounted()) {
        const previewFailure = operation === 'preview' ? getPreviewFailureReceipt(e) : null
        if (previewFailure) {
          setResult(previewFailure as unknown as ManualResult)
        }
        if (!revoke(e)) {
          setError(failureMessage(e, true))
        }
      }
    } finally {
      attempt.finishOnce('failure')
    }
  }

  async function runAction(name: string, value?: string) {
    if (busy || loading || deleted || actionFeedback?.kind === 'pending' || toolSessionActive) return
    if (!isCurrent() || !isMounted()) return
    setActionFeedback({ kind: 'pending' })
    try {
      const outcome = await action([row.filename], name, value)
      if (!isCurrent() || !isMounted()) return
      setActionFeedback(outcome ?? null)
      if (name === 'delete' && outcome?.kind === 'success') setDeleted(true)
    } catch (err) {
      if (isCurrent() && isMounted()) setActionFeedback(actionFailure(err, 1))
    }
  }

  const disabled = busy || loading || deleted || actionFeedback?.kind === 'pending' || toolSessionActive

  const handleOpenFiles = () => {
    if (disabled || !hasOwnerContext) return
    onOpenToolSession?.('files')
  }

  const handleOpenEmail = () => {
    if (disabled || !hasOwnerContext) return
    const admitted = onOpenToolSession?.('email')
    if (admitted === false) return
    setEmailOpen(true)
  }

  const handleCloseEmail = () => {
    if (!emailOpen) return
    if (!isMounted() || !isCurrent()) return
    if (hasOwnerContext || nestedEmailSession !== undefined) {
      if (!nestedEmailSession || !nestedEmailSession.isCurrentOwner()) {
        return
      }
    }
    if (nestedEmailSession) {
      nestedEmailSession.onClose()
    } else {
      onCloseToolSession?.()
    }
    setEmailOpen(false)
    emailTriggerRef.current?.focus()
  }

  const savedReceipt: AgQuotaEvidenceReceipt | null = useMemo(() => {
    if (mode !== 'antigravity' || !scope || !validation) return null
    const rawData: Record<string, unknown> = {}
    if (row.quota_groups && typeof row.quota_groups === 'object') {
      rawData.quota_groups = row.quota_groups
    }
    if (row.quota_group_states && typeof row.quota_group_states === 'object') {
      rawData.quota_group_states = row.quota_group_states
    }
    if (typeof row.quota_state_invalid === 'boolean') {
      rawData.quota_state_invalid = row.quota_state_invalid
    }
    if (row.model_access_families && typeof row.model_access_families === 'object') {
      rawData.model_access_families = row.model_access_families
    }

    const savedManual: ManualResult = Object.freeze({
      data: Object.freeze(rawData),
      success: false,
      httpStatus: 0,
      upstreamStatus: null,
      verifiedReply: null,
      updates: [],
    })

    return Object.freeze({
      source: 'saved' as const,
      filename: row.filename,
      scope,
      validation,
      result: savedManual,
    })
  }, [
    mode,
    row.filename,
    row.quota_groups,
    row.quota_group_states,
    row.quota_state_invalid,
    row.model_access_families,
    scope,
    validation,
  ])

  const isResponseReceiptValid = Boolean(
    responseReceipt &&
    responseReceipt.source === 'response' &&
    responseReceipt.filename === row.filename &&
    validation &&
    responseReceipt.validation === validation &&
    scope &&
    responseReceipt.scope.sessionEpoch === scope.sessionEpoch &&
    responseReceipt.scope.channelEpoch === scope.channelEpoch &&
    responseReceipt.scope.mode === scope.mode &&
    isCurrent()
  )

  const displayedReceipt = isResponseReceiptValid ? responseReceipt : savedReceipt
  const isSaved = displayedReceipt?.source === 'saved'

  return (
    <Sheet
      open
      onOpenChange={open => {
        if (!open) close()
      }}
    >
      <SheetContent
        onCloseAutoFocus={event => {
          event.preventDefault()
          restoreFocus()
        }}
        className="w-full overflow-y-auto rounded-l-xl bg-popover text-popover-foreground sm:max-w-xl"
      >
        <SheetHeader>
          <SheetTitle className="break-all pr-5 text-[24px] font-semibold">{row.filename}</SheetTitle>
          <SheetDescription className="text-[13px]">
            列表摘要与手动检测。不会读取完整凭证 JSON。
          </SheetDescription>
        </SheetHeader>
        <div className="mt-5 grid gap-5">
          <DetailActionStatus feedback={actionFeedback} />
          {deleted && (
            <p className="rounded-lg bg-info-bg text-[13px] text-info">
              该凭证已删除，关闭后可返回列表。
            </p>
          )}
          <div className="break-all text-sm">
            {text(row.user_email, '邮箱未保存')} · <CredentialStateBadge row={row} /> · {text(row.tier)}
          </div>
          <section className="grid gap-2">
            <h3 className="text-[18px] font-semibold">已保存证据</h3>
            <Evidence data={row} mode={mode} />
            <CycleStatistics data={row} />
          </section>
          {mode === 'antigravity' && scope && displayedReceipt && (
            <AgQuotaEvidence
              mode={mode}
              scope={scope}
              filename={row.filename}
              receipt={displayedReceipt}
              disabled={isSaved ? true : disabled}
              onRefresh={onRefresh}
            />
          )}
          <div className="flex flex-wrap gap-2">
            <Button disabled={disabled} onClick={() => void runAction('enable')}>
              启用
            </Button>
            <Button variant="outline" disabled={disabled} onClick={() => void runAction('disable')}>
              禁用
            </Button>
            <ConfirmAction
              label="永久禁用"
              disabled={disabled || !caps.has(modeCaps.permanent)}
              description="将该凭证设为永久禁用。成功动作不会因关闭页面而撤销。"
              onConfirm={() => void runAction('permanent_disable')}
            />
            <ConfirmAction
              label="删除"
              disabled={disabled}
              description="删除此凭证及其保存状态，此操作不可由页面撤销。"
              onConfirm={() => void runAction('delete')}
            />
          </div>
          <div className="flex flex-wrap gap-2 border-t pt-3">
            <Button
              ref={filesTriggerRef}
              variant="outline"
              size="sm"
              disabled={disabled || !hasOwnerContext}
              onClick={handleOpenFiles}
            >
              单凭证文件下载与查看
            </Button>
            <Button
              ref={emailTriggerRef}
              variant="outline"
              size="sm"
              disabled={(disabled && !emailOpen) || !hasOwnerContext}
              onClick={emailOpen ? handleCloseEmail : handleOpenEmail}
            >
              {emailOpen ? '退出邮箱维护' : '单凭证邮箱维护'}
            </Button>
          </div>
          {emailOpen && hasOwnerContext && scope && validation && (
            <section className="space-y-3 rounded-xl border bg-card p-4 text-card-foreground">
              <div className="flex items-center justify-between border-b pb-2">
                <h4 className="font-semibold text-sm">单凭证邮箱维护</h4>
                <Button variant="ghost" size="sm" onClick={handleCloseEmail}>
                  退出邮箱维护
                </Button>
              </div>
              <EmailMaintenance
                mode={mode}
                scope={scope}
                validation={validation}
                ownerRevision={nestedEmailSession?.ownerRevision ?? ownerRevision ?? Object.freeze({})}
                isCurrentOwner={nestedEmailSession?.isCurrentOwner ?? isCurrent}
                disabled={false}
                target={{ kind: 'single', filename: row.filename }}
                onRefresh={nestedEmailSession?.onRefresh ?? onRefresh}
              />
            </section>
          )}
          <section className="grid gap-2">
            <label className="font-medium" htmlFor="credential-remark">
              备注
            </label>
            <Input
              id="credential-remark"
              maxLength={64}
              value={remark}
              disabled={!caps.has(modeCaps.remark) || disabled}
              onChange={e => setRemark(e.target.value)}
            />
            <Button
              variant="outline"
              disabled={!caps.has(modeCaps.remark) || disabled}
              onClick={() => void runAction('remark', remark)}
            >
              保存备注
            </Button>
            {!caps.has(modeCaps.remark) && (
              <p className="text-[13px] text-muted-foreground">服务未声明备注编辑能力，仅可查看。</p>
            )}
          </section>
          {mode === 'antigravity' && (
            <section className="grid gap-2 text-sm">
              <p>信用额度：{row.enable_credit === true ? '开启' : row.enable_credit === false ? '关闭' : '未知'}</p>
              <ConfirmAction
                label={row.enable_credit === true ? '关闭信用额度' : '开启信用额度'}
                disabled={disabled || !caps.has(CAP.credit) || typeof row.enable_credit !== 'boolean'}
                description="切换信用额度模式会清除该凭证模型冷却，请确认后继续。"
                onConfirm={() => void runAction(row.enable_credit === true ? 'disable_credit' : 'enable_credit')}
              />
              {!caps.has(CAP.credit) && (
                <p className="text-[13px] text-muted-foreground">服务未声明信用额度开关能力。</p>
              )}
            </section>
          )}
          <section className="grid gap-2">
            <Button variant="outline" disabled={disabled} onClick={() => void loadErrors()}>
              读取已保存错误
            </Button>
            {errors && <SavedErrorDetails data={errors} />}
          </section>
          <section className="grid gap-3 rounded-xl border bg-card p-3 text-card-foreground">
            <h3 className="text-[18px] font-semibold">人工检测</h3>
            <p className="text-[13px] text-muted-foreground">
              以下按钮会访问上游，可能刷新 Token、更新权限、额度、项目和统计。不会自动重试。
            </p>
            <Button disabled={disabled} variant="outline" onClick={() => void runManual('quota')}>
              刷新额度并同步状态
            </Button>
            <label className="grid gap-1 text-sm">
              测试模型
              <Input
                aria-label="测试模型"
                value={model}
                onChange={e => setModel(e.target.value)}
                disabled={disabled}
              />
            </label>
            {mode === 'geminicli' && (
              <Button
                disabled={disabled}
                variant="outline"
                onClick={() => void runManual('test', undefined, 'default')}
              >
                默认消息测试
              </Button>
            )}
            <Button
              disabled={disabled || !model.trim()}
              variant="outline"
              onClick={() => void runManual('test', model.trim(), 'chosen')}
            >
              发送固定回复模型测试
            </Button>
            {mode === 'geminicli' && (
              <p className="text-[13px] text-muted-foreground">
                默认消息测试将不指定模型发起测试，并可能触发后端 Preview 探测流程；测试可能向上游发起实际请求。
              </p>
            )}
            <Button
              disabled={disabled}
              variant="outline"
              onClick={() => void runManual('verify-project')}
            >
              验证并更新项目
            </Button>
            {mode === 'geminicli' && (
              <ConfirmAction
                label="配置预览"
                disabled={disabled || !hasOwnerContext}
                description={`为 ${row.filename} 配置 Gemini CLI 预览模式，会访问上游并写回凭证状态。此操作不可由页面撤销。`}
                onConfirm={() => void runManual('preview')}
              />
            )}
          </section>
          {loading && activeAttempt && (
            <div className="flex items-center gap-3">
              <p role="status" className="text-[13px] text-info">
                处理中…
              </p>
              <Button type="button" variant="outline" size="sm" onClick={() => handleStopWaiting(activeAttempt)}>
                停止等待
              </Button>
            </div>
          )}
          {error && (
            <p role="alert" className="rounded-lg bg-destructive-bg text-sm text-destructive">
              {error}
            </p>
          )}
          {Object.keys(quotaModels).length > 0 && scope && (
            <LegacyModelQuota
              models={quotaModels}
              mode={mode}
              busy={disabled}
              scope={scope}
              isCurrent={isCurrent}
              onTestModel={targetId => void runManual('test', targetId, 'chosen')}
              onExpiryReadback={onRefresh}
            />
          )}
          {result && (() => {
            const publicDetails = (result as { publicDetails?: SafeManualPublicDetails }).publicDetails
              ? reprojectManualPublicDetails((result as { publicDetails?: SafeManualPublicDetails }).publicDetails, result.httpStatus ?? undefined)
              : projectManualPublicDetails(result.data, result.httpStatus ?? undefined)
            return (
              <ManualResultView
                result={projectPresentationResult(result, publicDetails)}
                mode={mode}
                publicDetails={publicDetails}
              />
            )
          })()}
        </div>
      </SheetContent>
    </Sheet>
  )
}
