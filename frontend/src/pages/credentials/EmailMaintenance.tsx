import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { PanelMode, PanelScope } from '@/domain/panel'
import {
  getPanelChannelSnapshot,
  isPanelScopeCurrent,
  subscribePanelChannel,
} from '@/domain/panel'
import {
  getSessionSnapshot,
  getSessionValidationSnapshot,
  subscribeSession,
  subscribeSessionValidation,
  type SessionValidationSnapshot,
} from '@/auth/session'
import {
  createCredentialApi,
  type DeduplicateByEmailResult,
  type RefreshAllEmailsResult,
} from './api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

export type EmailMaintenanceTarget =
  | Readonly<{ kind: 'single'; filename: string }>
  | Readonly<{ kind: 'selection'; filenames: readonly string[] }>
  | Readonly<{ kind: 'channel' }>

export interface EmailMaintenanceProps {
  readonly mode: PanelMode
  readonly scope: Readonly<PanelScope>
  readonly validation: Readonly<SessionValidationSnapshot>
  readonly ownerRevision: object
  readonly isCurrentOwner: () => boolean
  readonly disabled?: boolean
  readonly target: EmailMaintenanceTarget
  readonly onRefresh?: () => void
}

function areTargetsEqual(a: EmailMaintenanceTarget, b: EmailMaintenanceTarget): boolean {
  if (a === b) return true
  if (a.kind !== b.kind) return false
  if (a.kind === 'single' && b.kind === 'single') {
    return a.filename === b.filename
  }
  if (a.kind === 'selection' && b.kind === 'selection') {
    if (a.filenames === b.filenames) return true
    if (a.filenames.length !== b.filenames.length) return false
    for (let i = 0; i < a.filenames.length; i++) {
      if (a.filenames[i] !== b.filenames[i]) return false
    }
    return true
  }
  if (a.kind === 'channel' && b.kind === 'channel') {
    return true
  }
  return false
}

function isEnvironmentValid(
  mode: PanelMode,
  scope: PanelScope,
  validation: SessionValidationSnapshot,
  isCurrentOwner: () => boolean,
): boolean {
  if (mode !== scope.mode) return false

  const currentSession = getSessionSnapshot()
  if (currentSession.token === null) return false
  if (currentSession.sessionEpoch !== scope.sessionEpoch) return false
  if (!isPanelScopeCurrent(scope, currentSession.sessionEpoch)) return false

  const currentValidation = getSessionValidationSnapshot()
  if (currentValidation !== validation) return false
  if (currentValidation.status !== 'verified') return false
  if (currentValidation.sessionEpoch !== scope.sessionEpoch) return false

  try {
    if (!isCurrentOwner()) return false
  } catch {
    return false
  }

  return true
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return '操作已取消。'
  }
  if (error instanceof Error) {
    if (
      error.message === '邮箱响应格式无效' ||
      error.message === '刷新邮箱响应格式无效' ||
      error.message === '凭证去重响应格式无效' ||
      error.message === '凭证标识不一致' ||
      error.message === '邮箱响应格式不完整' ||
      error.message.includes('格式无效') ||
      error.message.includes('格式不完整') ||
      error.message.includes('标识不一致')
    ) {
      return '结果未能确认，请读取保存状态，勿盲目重试'
    }
    if (error.message.startsWith('请求被拒绝') || error.message.startsWith('请求未完成')) {
      return error.message
    }
  }
  return '结果未能确认，请读取保存状态，勿盲目重试'
}

function validateSelection(filenames: readonly string[]): {
  valid: boolean
  reason?: string
} {
  if (!Array.isArray(filenames) || filenames.length === 0) {
    return { valid: false, reason: '请至少选择 1 项凭证。' }
  }
  if (filenames.length > 100) {
    return {
      valid: false,
      reason: `已选凭证数量（${filenames.length} 项）超过上限，最多支持 100 项。`,
    }
  }
  const seen = new Set<string>()
  for (const name of filenames) {
    if (typeof name !== 'string' || !name.trim()) {
      return { valid: false, reason: '选择项中包含无效凭证标识。' }
    }
    if (seen.has(name)) {
      return { valid: false, reason: '选择项中包含重复凭证。' }
    }
    seen.add(name)
  }
  return { valid: true }
}

interface SelectionReceiptData {
  emails: string[]
  matched: number | null
  missing: number | null
}

function EmailMaintenanceView(props: EmailMaintenanceProps): ReactElement {
  const [isBusy, setIsBusy] = useState(false)
  const isBusyRef = useRef(false)
  const activeAbortControllerRef = useRef<AbortController | null>(null)
  const isMountedRef = useRef(true)
  const isRetiredRef = useRef(false)
  if (props.disabled) {
    isRetiredRef.current = true
  }

  // Single target state
  const [singleEmail, setSingleEmail] = useState<string | null>(null)
  const [singleCopyStatus, setSingleCopyStatus] = useState<string | null>(null)
  const [singleFallbackText, setSingleFallbackText] = useState<string | null>(null)

  // Selection target state
  const [selectionReceipt, setSelectionReceipt] = useState<SelectionReceiptData | null>(null)
  const [selectionCopyStatus, setSelectionCopyStatus] = useState<string | null>(null)
  const [selectionFallbackText, setSelectionFallbackText] = useState<string | null>(null)

  // Channel target state
  const [refreshReceipt, setRefreshReceipt] = useState<RefreshAllEmailsResult | null>(null)
  const [dedupReceipt, setDedupReceipt] = useState<DeduplicateByEmailResult | null>(null)
  const [dedupDialogOpen, setDedupDialogOpen] = useState(false)
  const activeConfirmTokenRef = useRef<object | null>(null)

  // General error state
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const isActorStillValid = useCallback(() => {
    if (!isMountedRef.current || isRetiredRef.current || props.disabled) return false
    return isEnvironmentValid(props.mode, props.scope, props.validation, props.isCurrentOwner)
  }, [props.mode, props.scope, props.validation, props.isCurrentOwner, props.disabled])

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      isRetiredRef.current = true
      if (activeAbortControllerRef.current) {
        activeAbortControllerRef.current.abort()
        activeAbortControllerRef.current = null
      }
      activeConfirmTokenRef.current = null
      isBusyRef.current = false
    }
  }, [])

  useEffect(() => {
    const checkSubscriptions = () => {
      if (!isEnvironmentValid(props.mode, props.scope, props.validation, props.isCurrentOwner)) {
        if (activeAbortControllerRef.current) {
          activeAbortControllerRef.current.abort()
          activeAbortControllerRef.current = null
        }
      }
    }

    const unsub1 = subscribeSession(checkSubscriptions)
    const unsub2 = subscribeSessionValidation(checkSubscriptions)
    const unsub3 = subscribePanelChannel(checkSubscriptions)

    return () => {
      unsub1()
      unsub2()
      unsub3()
    }
  }, [props.mode, props.scope, props.validation, props.isCurrentOwner])

  useEffect(() => {
    if (props.disabled) {
      isRetiredRef.current = true
      if (activeAbortControllerRef.current) {
        activeAbortControllerRef.current.abort()
        activeAbortControllerRef.current = null
      }
      activeConfirmTokenRef.current = null
      setDedupDialogOpen(false)
      setSingleFallbackText(null)
      setSelectionFallbackText(null)
      setSingleCopyStatus(null)
      setSelectionCopyStatus(null)
    }
  }, [props.disabled])

  const startAction = useCallback(() => {
    if (isBusyRef.current) return null
    if (!isActorStillValid()) return null
    if (props.disabled) return null

    isBusyRef.current = true
    setIsBusy(true)
    const controller = new AbortController()
    activeAbortControllerRef.current = controller
    return controller
  }, [isActorStillValid, props.disabled])

  const endAction = useCallback(() => {
    isBusyRef.current = false
    setIsBusy(false)
    activeAbortControllerRef.current = null
  }, [])

  // Handle single fetch email
  const handleFetchEmail = async () => {
    if (props.target.kind !== 'single') return
    const filename = props.target.filename
    const capturedOnRefresh = props.onRefresh
    const controller = startAction()
    if (!controller) return

    setErrorMessage(null)
    setSingleCopyStatus(null)
    setSingleFallbackText(null)

    try {
      const scopedApi = createCredentialApi(props.mode, props.scope)
      const result = await scopedApi.fetchEmail(filename, controller.signal)

      if (!isActorStillValid() || controller.signal.aborted) {
        return
      }

      setSingleEmail(result.email)
      endAction()

      if (isActorStillValid()) {
        try {
          capturedOnRefresh?.()
        } catch {
          // Isolate callback exceptions
        }
      }
    } catch (error) {
      if (!isActorStillValid() || controller.signal.aborted) {
        return
      }

      setErrorMessage(formatErrorMessage(error))
      endAction()

      if (isActorStillValid()) {
        try {
          capturedOnRefresh?.()
        } catch {
          // Isolate callback exceptions
        }
      }
    }
  }

  // Handle local copy for single email
  const handleCopySingleEmail = async () => {
    if (!singleEmail) return
    if (!isActorStillValid() || props.disabled || isBusy) return

    const emailToCopy = singleEmail
    if (
      typeof navigator !== 'undefined' &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === 'function'
    ) {
      try {
        await navigator.clipboard.writeText(emailToCopy)
        if (!isActorStillValid()) return
        setSingleCopyStatus('已复制到剪贴板')
        setSingleFallbackText(null)
      } catch {
        if (!isActorStillValid()) return
        setSingleCopyStatus(null)
        setSingleFallbackText(emailToCopy)
      }
    } else {
      if (!isActorStillValid()) return
      setSingleCopyStatus(null)
      setSingleFallbackText(emailToCopy)
    }
  }

  // Handle selection copy emails
  const handleCopySelectionEmails = async () => {
    if (props.target.kind !== 'selection') return
    const selectionCheck = validateSelection(props.target.filenames)
    if (!selectionCheck.valid) return

    const filenamesToCopy = [...props.target.filenames]
    const capturedOnRefresh = props.onRefresh
    const controller = startAction()
    if (!controller) return

    setErrorMessage(null)
    setSelectionCopyStatus(null)
    setSelectionFallbackText(null)
    setSelectionReceipt(null)

    try {
      const scopedApi = createCredentialApi(props.mode, props.scope)
      const result = await scopedApi.emails(filenamesToCopy, controller.signal)

      if (!isActorStillValid() || controller.signal.aborted) {
        return
      }

      setSelectionReceipt({
        emails: result.emails,
        matched: result.matched,
        missing: result.missing,
      })

      const textToCopy = result.emails.join('\n')
      if (
        typeof navigator !== 'undefined' &&
        navigator.clipboard &&
        typeof navigator.clipboard.writeText === 'function'
      ) {
        try {
          await navigator.clipboard.writeText(textToCopy)
          if (!isActorStillValid() || controller.signal.aborted) {
            return
          }
          setSelectionCopyStatus(`已复制 ${result.emails.length} 个邮箱到剪贴板`)
          setSelectionFallbackText(null)
        } catch {
          if (!isActorStillValid() || controller.signal.aborted) {
            return
          }
          setSelectionCopyStatus(null)
          setSelectionFallbackText(textToCopy)
        }
      } else {
        if (!isActorStillValid() || controller.signal.aborted) {
          return
        }
        setSelectionCopyStatus(null)
        setSelectionFallbackText(textToCopy)
      }

      endAction()

      if (isActorStillValid()) {
        try {
          capturedOnRefresh?.()
        } catch {
          // Isolate callback exceptions
        }
      }
    } catch (error) {
      if (!isActorStillValid() || controller.signal.aborted) {
        return
      }

      setErrorMessage(formatErrorMessage(error))
      endAction()

      if (isActorStillValid()) {
        try {
          capturedOnRefresh?.()
        } catch {
          // Isolate callback exceptions
        }
      }
    }
  }

  // Handle channel refresh all emails
  const handleRefreshAllEmails = async () => {
    if (props.target.kind !== 'channel') return
    const capturedOnRefresh = props.onRefresh
    const controller = startAction()
    if (!controller) return

    setErrorMessage(null)
    setRefreshReceipt(null)

    try {
      const scopedApi = createCredentialApi(props.mode, props.scope)
      const result = await scopedApi.refreshAllEmails(controller.signal)

      if (!isActorStillValid() || controller.signal.aborted) {
        return
      }

      setRefreshReceipt(result)
      endAction()

      if (isActorStillValid()) {
        try {
          capturedOnRefresh?.()
        } catch {
          // Isolate callback exceptions
        }
      }
    } catch (error) {
      if (!isActorStillValid() || controller.signal.aborted) {
        return
      }

      setErrorMessage(formatErrorMessage(error))
      endAction()

      if (isActorStillValid()) {
        try {
          capturedOnRefresh?.()
        } catch {
          // Isolate callback exceptions
        }
      }
    }
  }

  // Handle dedup dialog and confirm
  const handleOpenDedupDialog = () => {
    if (!isActorStillValid() || props.disabled || isBusyRef.current) return
    const token = {}
    activeConfirmTokenRef.current = token
    setDedupDialogOpen(true)
  }

  const handleCancelDedup = () => {
    activeConfirmTokenRef.current = null
    setDedupDialogOpen(false)
  }

  const handleDedupOpenChange = (open: boolean) => {
    if (!open) {
      activeConfirmTokenRef.current = null
      setDedupDialogOpen(false)
    }
  }

  const handleConfirmDedup = async () => {
    const token = activeConfirmTokenRef.current
    if (!token) return
    activeConfirmTokenRef.current = null
    setDedupDialogOpen(false)

    if (!isActorStillValid() || props.disabled || isBusyRef.current) return

    const capturedOnRefresh = props.onRefresh
    const controller = startAction()
    if (!controller) return

    setErrorMessage(null)
    setDedupReceipt(null)

    try {
      const scopedApi = createCredentialApi(props.mode, props.scope)
      const result = await scopedApi.deduplicateByEmail(controller.signal)

      if (!isActorStillValid() || controller.signal.aborted) {
        return
      }

      setDedupReceipt(result)
      endAction()

      if (isActorStillValid()) {
        try {
          capturedOnRefresh?.()
        } catch {
          // Isolate callback exceptions
        }
      }
    } catch (error) {
      if (!isActorStillValid() || controller.signal.aborted) {
        return
      }

      setErrorMessage(formatErrorMessage(error))
      endAction()

      if (isActorStillValid()) {
        try {
          capturedOnRefresh?.()
        } catch {
          // Isolate callback exceptions
        }
      }
    }
  }

  const channelDisplayName = props.mode === 'antigravity' ? 'Antigravity' : 'Gemini CLI'

  return (
    <div className="rounded-lg border border-border bg-card p-4 text-card-foreground shadow-sm space-y-4">
      {props.target.kind === 'single' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">凭证邮箱维护</span>
              <span className="font-mono text-xs text-muted-foreground">{props.target.filename}</span>
            </div>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            获取指定凭证绑定的邮箱。后端优先返回已缓存的邮箱，可能返回现有缓存数据；不承诺强制向上游刷新或清除缓存。
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={handleFetchEmail}
              disabled={props.disabled || isBusy}
              size="sm"
            >
              {isBusy ? '获取中...' : '获取/再次获取邮箱'}
            </Button>
            {singleEmail && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleCopySingleEmail}
                disabled={props.disabled || isBusy}
              >
                复制邮箱
              </Button>
            )}
          </div>
          {singleEmail && (
            <div className="rounded-md border border-border/70 bg-muted/30 p-2 text-xs space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">已获取邮箱:</span>
                <span className="font-mono font-medium">{singleEmail}</span>
              </div>
              {singleCopyStatus && (
                <div className="text-success text-xs font-medium">{singleCopyStatus}</div>
              )}
            </div>
          )}
          {singleFallbackText && (
            <div className="space-y-1">
              <p className="text-xs text-warning font-medium">无法访问剪贴板，请手动复制以下邮箱：</p>
              <Textarea
                readOnly
                value={singleFallbackText}
                className="font-mono text-xs h-20"
                aria-label="手动复制邮箱内容"
              />
            </div>
          )}
        </div>
      )}

      {props.target.kind === 'selection' && (() => {
        const selectionCheck = validateSelection(props.target.filenames)
        return (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">批量复制凭证邮箱</span>
              <span className="text-xs text-muted-foreground">
                已选凭证: {props.target.filenames.length} 项
              </span>
            </div>
            {!selectionCheck.valid && (
              <p className="text-xs text-warning font-medium">{selectionCheck.reason}</p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={handleCopySelectionEmails}
                disabled={props.disabled || isBusy || !selectionCheck.valid}
                size="sm"
              >
                {isBusy ? '处理中...' : '复制选中邮箱'}
              </Button>
            </div>
            {selectionReceipt && (
              <div className="rounded-md border border-border/70 bg-muted/30 p-3 text-xs space-y-2">
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <span className="text-muted-foreground">匹配凭证数: </span>
                    <span className="font-semibold">
                      {selectionReceipt.matched !== null ? selectionReceipt.matched : '未知'}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">缺失凭证数: </span>
                    <span className="font-semibold">
                      {selectionReceipt.missing !== null ? selectionReceipt.missing : '未知'}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">独立邮箱数: </span>
                    <span className="font-semibold">{selectionReceipt.emails.length}</span>
                  </div>
                </div>
                {selectionCopyStatus && (
                  <div className="text-success text-xs font-medium">{selectionCopyStatus}</div>
                )}
              </div>
            )}
            {selectionFallbackText && (
              <div className="space-y-1">
                <p className="text-xs text-warning font-medium">
                  剪贴板不可用或复制被拒绝，请手动复制以下邮箱：
                </p>
                <Textarea
                  readOnly
                  value={selectionFallbackText}
                  className="font-mono text-xs h-28"
                  aria-label="手动复制批量邮箱内容"
                />
              </div>
            )}
          </div>
        )
      })()}

      {props.target.kind === 'channel' && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 border-b border-border/60 pb-2">
            <span className="text-sm font-medium">当前整个渠道:</span>
            <Badge variant="outline">{channelDisplayName}</Badge>
          </div>

          {/* 全渠道刷新 */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <span className="text-xs font-semibold">全渠道刷新邮箱</span>
                <p className="text-xs text-muted-foreground">
                  全渠道刷新将同步当前渠道所有凭证邮箱，可能访问上游服务或使用刷新令牌；已缓存凭证将被跳过。
                </p>
              </div>
              <Button
                onClick={handleRefreshAllEmails}
                disabled={props.disabled || isBusy}
                size="sm"
              >
                {isBusy ? '刷新中...' : '全渠道刷新邮箱'}
              </Button>
            </div>
            {refreshReceipt && (
              <div className="rounded-md border border-border/70 bg-muted/30 p-3 text-xs space-y-2">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <div>
                    <span className="text-muted-foreground">新获取: </span>
                    <span className="font-semibold">{refreshReceipt.success_count}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">已跳过（使用缓存）: </span>
                    <span className="font-semibold">{refreshReceipt.skipped_count}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">失败: </span>
                    <span className="font-semibold">{refreshReceipt.failed_count}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">总计: </span>
                    <span className="font-semibold">{refreshReceipt.total_count}</span>
                  </div>
                </div>
                {refreshReceipt.results.length > 0 && (
                  <div className="max-h-40 overflow-y-auto space-y-1 pt-1 border-t border-border/50">
                    {refreshReceipt.results.map(row => (
                      <div
                        key={row.filename}
                        className="flex items-center justify-between py-0.5 font-mono text-[11px]"
                      >
                        <span className="truncate max-w-[200px]">{row.filename}</span>
                        <div className="flex items-center gap-2">
                          {row.skipped ? (
                            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                              已跳过（缓存）
                            </Badge>
                          ) : row.success ? (
                            <Badge variant="success" className="text-[10px] px-1.5 py-0">
                              新获取
                            </Badge>
                          ) : (
                            <Badge variant="destructive" className="text-[10px] px-1.5 py-0">
                              失败
                            </Badge>
                          )}
                          <span className="text-muted-foreground truncate max-w-[180px]">
                            {row.email ?? '无'}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 全渠道去重 */}
          <div className="space-y-2 pt-2 border-t border-border/60">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <span className="text-xs font-semibold text-destructive">全渠道按邮箱去重</span>
                <p className="text-xs text-muted-foreground">
                  按用户邮箱对当前整个渠道的凭证去重，保留首个凭证，删除其余重复凭证。此操作不可回滚。
                </p>
              </div>
              <Button
                variant="destructive"
                onClick={handleOpenDedupDialog}
                disabled={props.disabled || isBusy}
                size="sm"
              >
                按邮箱去重
              </Button>
            </div>
            {dedupReceipt && (
              <div className="rounded-md border border-border/70 bg-muted/30 p-3 text-xs space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">去重结果:</span>
                  {dedupReceipt.outcome === 'success' ? (
                    <Badge variant="success">去重完成</Badge>
                  ) : dedupReceipt.outcome === 'partial' ? (
                    <Badge variant="warning">部分成功</Badge>
                  ) : (
                    <Badge variant="destructive">去重失败</Badge>
                  )}
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  <div>
                    <span className="text-muted-foreground">已删除: </span>
                    <span className="font-semibold">{dedupReceipt.deleted_count}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">已保留: </span>
                    <span className="font-semibold">{dedupReceipt.kept_count}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">总凭证数: </span>
                    <span className="font-semibold">{dedupReceipt.total_count}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">独立邮箱数: </span>
                    <span className="font-semibold">{dedupReceipt.unique_emails_count}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">无邮箱凭证数: </span>
                    <span className="font-semibold">{dedupReceipt.no_email_count}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">错误数: </span>
                    <span className="font-semibold">{dedupReceipt.error_count}</span>
                  </div>
                </div>
                {dedupReceipt.duplicate_groups.length > 0 && (
                  <div className="max-h-36 overflow-y-auto space-y-1.5 pt-1 border-t border-border/50">
                    {dedupReceipt.duplicate_groups.map(group => (
                      <div
                        key={group.email}
                        className="rounded bg-muted/40 p-1.5 text-[11px] space-y-0.5"
                      >
                        <div className="font-semibold font-mono">{group.email}</div>
                        <div className="text-muted-foreground">
                          保留: <span className="font-mono text-foreground">{group.kept_file}</span>
                        </div>
                        <div className="text-muted-foreground truncate">
                          删除 ({group.duplicate_count}):{' '}
                          <span className="font-mono text-destructive">
                            {group.deleted_files.join(', ')}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 去重二次确认弹窗 */}
          <AlertDialog open={dedupDialogOpen} onOpenChange={handleDedupOpenChange}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>确认按邮箱去重</AlertDialogTitle>
                <AlertDialogDescription>
                  此操作将在当前整个渠道（{channelDisplayName}）中按用户邮箱执行去重，保留首个凭证，删除其余重复凭证。此操作为破坏性操作，不可回滚。确定要继续吗？
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel onClick={handleCancelDedup}>取消</AlertDialogCancel>
                <AlertDialogAction onClick={handleConfirmDedup}>确认去重</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      )}

      {errorMessage && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive font-medium">
          {errorMessage}
        </div>
      )}
    </div>
  )
}

function EmailMaintenanceRoot(props: EmailMaintenanceProps): ReactElement | null {
  const [actorId, setActorId] = useState(0)

  const prevRef = useRef<{
    ownerRevision: object
    target: EmailMaintenanceTarget
    scope: PanelScope
    validation: SessionValidationSnapshot
    disabled: boolean
  }>({
    ownerRevision: props.ownerRevision,
    target: props.target,
    scope: props.scope,
    validation: props.validation,
    disabled: Boolean(props.disabled),
  })

  const isEquivalent =
    props.ownerRevision === prevRef.current.ownerRevision &&
    areTargetsEqual(props.target, prevRef.current.target) &&
    props.scope.mode === prevRef.current.scope.mode &&
    props.scope.channelEpoch === prevRef.current.scope.channelEpoch &&
    props.scope.sessionEpoch === prevRef.current.scope.sessionEpoch &&
    props.validation === prevRef.current.validation &&
    Boolean(props.disabled) === prevRef.current.disabled

  if (!isEquivalent) {
    prevRef.current = {
      ownerRevision: props.ownerRevision,
      target: props.target,
      scope: props.scope,
      validation: props.validation,
      disabled: Boolean(props.disabled),
    }
    setActorId(id => id + 1)
  }

  return <EmailMaintenanceView key={actorId} {...props} />
}

export function EmailMaintenance(props: EmailMaintenanceProps): ReactElement | null {
  useSyncExternalStore(subscribeSession, getSessionSnapshot, getSessionSnapshot)
  useSyncExternalStore(subscribeSessionValidation, getSessionValidationSnapshot, getSessionValidationSnapshot)
  useSyncExternalStore(subscribePanelChannel, getPanelChannelSnapshot, getPanelChannelSnapshot)

  if (!isEnvironmentValid(props.mode, props.scope, props.validation, props.isCurrentOwner)) {
    return null
  }

  return <EmailMaintenanceRoot {...props} />
}
