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
        <p className="rounded-lg border p-3 text-sm">
          {feedback.kind === 'pending' ? '正在执行凭证操作…' : feedback.message === `${labels[feedback.kind]}。` ? feedback.message : `${labels[feedback.kind]}：${feedback.message}`}
        </p>
      )}
    </div>
  )
}
