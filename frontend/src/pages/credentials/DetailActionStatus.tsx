import type { Outcome } from './model'

export type ActionFeedback = { kind: 'pending' } | Outcome

const labels: Record<Outcome['kind'], string> = {
  success: '操作成功',
  partial: '部分成功',
  rejected: '操作失败',
  unknown: '结果未知',
}

export function DetailActionStatus({ feedback }: { feedback: ActionFeedback | null }) {
  return (
    <div className={feedback ? undefined : 'sr-only'} role="status" aria-label="凭证操作状态" aria-live="polite" aria-atomic="true">
      {feedback && (
        <p className={`rounded-xl border p-3 text-sm ${feedback.kind === 'success' ? 'border-success/30 bg-success-bg text-success' : feedback.kind === 'rejected' ? 'border-destructive/30 bg-destructive-bg text-destructive' : feedback.kind === 'partial' || feedback.kind === 'unknown' ? 'border-warning/30 bg-warning-bg text-warning' : 'border-border bg-info-bg text-info'}`}>
          {feedback.kind === 'pending' ? '正在执行凭证操作…' : feedback.message === `${labels[feedback.kind]}。` ? feedback.message : `${labels[feedback.kind]}：${feedback.message}`}
        </p>
      )}
    </div>
  )
}
