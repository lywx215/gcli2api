import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/domain/shared'
import type { EmailSnapshot, ImportItemFailureReason, ImportResult } from './types'
import type { ImportWorkflowEmailJob, ImportWorkflowReadonly } from './workflowRunner'

export const failureReasonSummaries: Record<ImportItemFailureReason, string> = {
  credential_exchange_failed: '授权无效或网络异常',
  credential_store_failed: '凭证存储失败，请稍后重试',
  credential_import_failed: '凭证导入失败',
}

export function getFailureReasonSummary(reason?: ImportItemFailureReason): string {
  if (reason && reason in failureReasonSummaries) {
    return failureReasonSummaries[reason]
  }
  return '导入失败，原因不可用'
}

const outcomes = {
  success: '全部成功',
  partial: '部分成功',
  failed: '导入失败',
  unknown: '结果未知',
} as const

const states = {
  success: '成功',
  failed: '失败',
  unknown: '未知',
  queued: '排队中',
  running: '获取中',
  settlement_pending: '等待保存确认',
  skipped: '已跳过',
  superseded: '已被新任务替代',
} as const

const outcomeColors = {
  success: 'text-success',
  partial: 'text-warning',
  failed: 'text-destructive',
  unknown: 'text-warning',
} as const

const stateVariants = {
  success: 'success',
  failed: 'destructive',
  unknown: 'warning',
  queued: 'info',
  running: 'info',
  settlement_pending: 'warning',
  skipped: 'info',
  superseded: 'info',
} as const

export function isStrictBasename(name: unknown): name is string {
  if (typeof name !== 'string') return false
  if (name.length === 0 || name.length > 250) return false
  const trimmed = name.trim()
  if (!trimmed || trimmed !== name) return false
  if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') return false
  if (/[\x00-\x1f\x7f]/.test(name)) return false
  return true
}

export function getEligibleExportFilenames(
  result: ImportWorkflowReadonly<ImportResult> | null,
): {
  readonly filenames: readonly string[]
  readonly reason?: string
} {
  if (!result) {
    return { filenames: Object.freeze([]), reason: '无导入结果。' }
  }
  const rawNames = result.confirmedFilenames
  if (!rawNames || !Array.isArray(rawNames)) {
    return { filenames: Object.freeze([]), reason: '当前结果未包含已确认凭证文件名。' }
  }
  if (rawNames.length === 0) {
    return { filenames: Object.freeze([]), reason: '没有可导出的已确认凭证。' }
  }
  if (rawNames.length > 100) {
    return {
      filenames: Object.freeze([]),
      reason: '已确认凭证数量超过单次导出上限（最多 100 项）。',
    }
  }
  for (const name of rawNames) {
    if (!isStrictBasename(name)) {
      return { filenames: Object.freeze([]), reason: '凭证文件名格式无效，无法安全导出。' }
    }
  }
  const unique = new Set(rawNames)
  if (unique.size !== rawNames.length) {
    return { filenames: Object.freeze([]), reason: '凭证文件名存在重复，无法安全导出。' }
  }
  return { filenames: Object.freeze([...rawNames]) }
}

export interface ImportResultsProps {
  readonly result: ImportWorkflowReadonly<ImportResult>
  readonly onExport?: () => void
  readonly exportDisabled?: boolean
  readonly exportReason?: string
  readonly isExporting?: boolean
  readonly exportMessage?: string
}

export function ImportResults({
  result,
  onExport,
  exportDisabled = false,
  exportReason,
  isExporting = false,
  exportMessage,
}: ImportResultsProps) {
  const successCount = result.items.filter(item => item.status === 'success').length
  const totalCount = result.items.length

  return (
    <Card className="max-w-3xl border border-border">
      <CardHeader className="p-3.5 pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className={cn("text-sm font-semibold", outcomeColors[result.outcome])}>
            {outcomes[result.outcome]}
          </CardTitle>
          <span className="text-xs text-muted-foreground tabular-nums font-medium">
            成功 {successCount} / {totalCount} 项
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 p-3.5 pt-0">
        {result.warnings > 0 && (
          <p role="status" className="rounded-md border border-warning/30 bg-warning-bg p-2 text-xs text-warning">
            有 {result.warnings} 条导入警告。凭证保存与邮箱补全分别处理，请检查下方补全状态及凭证页。
          </p>
        )}

        {result.oauthReceipt && (
          <div className="rounded-md border border-border bg-card p-2.5 text-xs space-y-1">
            <p className="font-medium text-foreground">OAuth 授权结果：</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-0.5 text-muted-foreground">
              <p>
                文件名: <span className="text-foreground break-all">{result.oauthReceipt.filename}</span>
              </p>
              <p>
                模式: <span className="text-foreground">{result.oauthReceipt.mode}</span>
              </p>
              <p>
                项目 ID:{' '}
                <span className="text-foreground">
                  {result.oauthReceipt.project_id ??
                    (result.oauthReceipt.auto_detected_project ? '自动检测' : '未指定')}
                </span>
              </p>
              {result.oauthReceipt.subscription_tier && (
                <p>
                  订阅层级:{' '}
                  <span className="text-foreground">{result.oauthReceipt.subscription_tier}</span>
                </p>
              )}
              {result.oauthReceipt.tier_raw_name && (
                <p>
                  原始层级:{' '}
                  <span className="text-foreground">{result.oauthReceipt.tier_raw_name}</span>
                </p>
              )}
              {result.oauthReceipt.tier_detection_status && (
                <p>
                  检测状态:{' '}
                  <span className="text-foreground">
                    {result.oauthReceipt.tier_detection_status}
                  </span>
                </p>
              )}
            </div>
          </div>
        )}

        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-left border-collapse text-xs md:text-[13px]" aria-label="导入结果列表">
            <thead>
              <tr className="border-b border-border bg-secondary/30 text-[12px] font-semibold text-muted-foreground">
                <th className="px-2.5 py-1.5 h-8">导入项</th>
                <th className="px-2.5 py-1.5 h-8 w-24">状态</th>
                <th className="px-2.5 py-1.5 h-8">详情 / 错误</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {result.items.map((item, index) => (
                <tr key={index} className="hover:bg-hover/50 transition-colors">
                  <td className="px-2.5 py-1.5 align-top font-medium break-all text-foreground">
                    {item.label}
                  </td>
                  <td className="px-2.5 py-1.5 align-top whitespace-nowrap">
                    <Badge variant={stateVariants[item.status]} className="text-[11px] px-1.5 py-0">
                      {states[item.status]}
                    </Badge>
                  </td>
                  <td className="px-2.5 py-1.5 align-top text-xs">
                    {item.status === 'failed' && (
                      <p className="text-destructive font-medium">
                        {getFailureReasonSummary(item.failureReason)}
                      </p>
                    )}
                    {item.receipt && (
                      <div className="text-muted-foreground space-y-0.5">
                        {item.receipt.project_id && <p>项目 ID: {item.receipt.project_id}</p>}
                        {item.receipt.subscription_tier && (
                          <p>层级: {item.receipt.subscription_tier}</p>
                        )}
                        {item.receipt.tier_raw_name && (
                          <p>原始层级: {item.receipt.tier_raw_name}</p>
                        )}
                        {item.receipt.tier_detection_status && (
                          <p>检测状态: {item.receipt.tier_detection_status}</p>
                        )}
                      </div>
                    )}
                    {item.status !== 'failed' && !item.receipt && (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {onExport && (
          <div className="pt-2 border-t border-border flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={exportDisabled}
                onClick={onExport}
              >
                {isExporting ? '导出中…' : '导出凭证'}
              </Button>
              {exportReason && (
                <span className="text-xs text-muted-foreground">{exportReason}</span>
              )}
            </div>
            {exportMessage && (
              <p role="status" className="text-xs text-info">
                {exportMessage}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export function EmailResults({
  snapshot,
}: {
  snapshot: ImportWorkflowReadonly<EmailSnapshot> | EmailSnapshot
}) {
  return (
    <ul className="divide-y divide-border rounded-md border border-border px-2.5 text-xs text-foreground" aria-label="邮箱补全结果">
      {snapshot.items.map((item, index) => (
        <li className="py-1.5 flex flex-wrap items-center justify-between gap-2" key={index}>
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-medium truncate break-all" title={item.filename}>
              {item.filename}
            </span>
            <Badge className="text-[11px] px-1.5 py-0" variant={stateVariants[item.status]}>
              {states[item.status]}
            </Badge>
          </div>
          {item.email && (
            <span className="text-xs text-muted-foreground truncate font-mono">
              {item.email}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

const emailJobStatusVariants = {
  tracking: 'info',
  stopped: 'warning',
  complete: 'success',
  expired: 'destructive',
  unavailable: 'warning',
} as const

const emailJobStatusLabels = {
  tracking: '跟踪中',
  stopped: '已停止',
  complete: '已完成',
  expired: '已过期',
  unavailable: '暂不可用',
} as const

export interface EmailJobCardProps {
  readonly job: ImportWorkflowEmailJob
  readonly onStop: (jobId: string) => void
  readonly onResume: (jobId: string) => void
  readonly disabled?: boolean
}

export function EmailJobCard({
  job,
  onStop,
  onResume,
  disabled = false,
}: EmailJobCardProps) {
  const total = job.snapshot?.items.length ?? 0
  const finished = job.snapshot?.items.filter(
    item => item.status === 'success' || item.status === 'failed' || item.status === 'skipped' || item.status === 'superseded'
  ).length ?? 0
  const percent = total > 0 ? Math.round((finished / total) * 100) : (job.status === 'complete' ? 100 : 0)

  return (
    <Card className="max-w-3xl border border-border p-3 space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs md:text-sm font-medium text-foreground">
            邮箱补全 ({job.jobId.slice(0, 8)}…)
          </span>
          <Badge variant={emailJobStatusVariants[job.status]} className="text-[11px] px-1.5 py-0">
            {emailJobStatusLabels[job.status]}
          </Badge>
        </div>

        <div className="flex items-center gap-2.5">
          {total > 0 && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="tabular-nums font-medium">{finished}/{total} ({percent}%)</span>
              <div className="h-1.5 w-16 md:w-24 overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full bg-primary transition-all duration-300"
                  style={{ width: `${percent}%` }}
                />
              </div>
            </div>
          )}

          {job.status === 'tracking' && (
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={disabled}
              onClick={() => onStop(job.jobId)}
            >
              停止跟踪
            </Button>
          )}

          {(job.status === 'stopped' || job.status === 'unavailable') && (
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={disabled}
              onClick={() => onResume(job.jobId)}
            >
              恢复跟踪
            </Button>
          )}
        </div>
      </div>

      {job.message && (
        <p role="status" className="text-xs text-info">
          {job.message}
        </p>
      )}

      {job.snapshot && <EmailResults snapshot={job.snapshot} />}

      {job.status === 'stopped' && (
        <p className="text-xs text-muted-foreground">
          停止等待不是撤销；已发送的操作可能已在服务器保存凭证。
        </p>
      )}
    </Card>
  )
}
