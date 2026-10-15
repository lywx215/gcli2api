import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { EmailSnapshot, ImportResult } from './types'
import type { ImportWorkflowEmailJob, ImportWorkflowReadonly } from './workflowRunner'

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
    <Card>
      <CardHeader>
        <CardTitle className={outcomeColors[result.outcome]}>
          {outcomes[result.outcome]}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-foreground">
          成功 {successCount} / {totalCount} 项
        </p>

        {result.warnings > 0 && (
          <p role="status" className="text-sm text-warning">
            有 {result.warnings} 条导入警告。凭证保存与邮箱补全分别处理，请检查下方补全状态及凭证页。
          </p>
        )}

        {result.oauthReceipt && (
          <div className="rounded-md border border-border bg-card p-3 text-xs space-y-1">
            <p className="font-medium text-foreground">OAuth 授权结果：</p>
            <p className="text-muted-foreground">
              文件名: <span className="text-foreground">{result.oauthReceipt.filename}</span>
            </p>
            <p className="text-muted-foreground">
              模式: <span className="text-foreground">{result.oauthReceipt.mode}</span>
            </p>
            <p className="text-muted-foreground">
              项目 ID:{' '}
              <span className="text-foreground">
                {result.oauthReceipt.project_id ??
                  (result.oauthReceipt.auto_detected_project ? '自动检测' : '未指定')}
              </span>
            </p>
            {result.oauthReceipt.subscription_tier && (
              <p className="text-muted-foreground">
                订阅层级:{' '}
                <span className="text-foreground">{result.oauthReceipt.subscription_tier}</span>
              </p>
            )}
            {result.oauthReceipt.tier_raw_name && (
              <p className="text-muted-foreground">
                原始层级:{' '}
                <span className="text-foreground">{result.oauthReceipt.tier_raw_name}</span>
              </p>
            )}
            {result.oauthReceipt.tier_detection_status && (
              <p className="text-muted-foreground">
                检测状态:{' '}
                <span className="text-foreground">
                  {result.oauthReceipt.tier_detection_status}
                </span>
              </p>
            )}
          </div>
        )}

        <ul className="divide-y divide-border">
          {result.items.map((item, index) => (
            <li className="py-2 text-sm text-foreground" key={index}>
              <div className="flex justify-between gap-4 break-all">
                <span>{item.label}</span>
                <Badge className="shrink-0 self-start" variant={stateVariants[item.status]}>
                  {states[item.status]}
                </Badge>
              </div>
              {item.receipt && (
                <div className="mt-1 text-xs text-muted-foreground space-y-0.5">
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
            </li>
          ))}
        </ul>

        {onExport && (
          <div className="pt-3 border-t border-border flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-3">
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
    <ul className="divide-y divide-border">
      {snapshot.items.map((item, index) => (
        <li className="py-2 text-sm text-foreground" key={index}>
          <span className="break-all">{item.filename}</span> ·{' '}
          <Badge className="align-middle" variant={stateVariants[item.status]}>
            {states[item.status]}
          </Badge>
          {item.email && (
            <span className="block text-xs leading-5 text-muted-foreground">
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
  return (
    <Card className="border border-border">
      <CardHeader className="py-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium">
            邮箱补全 ({job.jobId.slice(0, 8)}…)
          </CardTitle>
          <Badge variant={emailJobStatusVariants[job.status]}>
            {emailJobStatusLabels[job.status]}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 py-3">
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

        <div className="flex gap-2">
          {job.status === 'tracking' && (
            <Button
              type="button"
              variant="outline"
              size="sm"
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
              size="sm"
              disabled={disabled}
              onClick={() => onResume(job.jobId)}
            >
              恢复跟踪
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
