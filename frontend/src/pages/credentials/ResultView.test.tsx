import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ManualResultView } from './ResultView'
import { manualResult } from './model'

describe('manual result explanations and quota evidence', () => {
  it('explains a structured timeout and pending write independently of its HTTP evidence', () => {
    render(<ManualResultView result={manualResult({
      success: false, status_code: 504, upstream_status: null, error_code: 'quota_timeout', phase: 'oauth',
      phases: [{ phase: 'oauth', upstream_status: 503 }],
      state_update: { quota: { status: 'pending', reason: 'settlement_unconfirmed' } },
    }, 504)} />)
    expect(screen.getByText('阶段：Token 刷新')).toBeInTheDocument()
    expect(screen.getByText('Token 刷新：上游 HTTP 503')).toBeInTheDocument()
    expect(screen.getByText(/结果说明：当前阶段超时/)).toHaveTextContent('请勿盲目重试')
    expect(screen.getByText('quota：pending')).toHaveClass('text-warning')
    expect(screen.getByText(/写回结果尚未确认（写回结果尚未确认/)).toHaveTextContent('请重新读取状态')
    expect(screen.getByText(/上游操作：未成功.*HTTP 504.*上游 HTTP 未知/)).toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('explains a Google permission failure without rendering arbitrary error or identity fields', () => {
    const { container } = render(<ManualResultView result={manualResult({
      success: false, upstream_status: 403, response_source: 'google', phase: 'quota',
      error: 'SYNTHETIC_RAW_ERROR', access_token: 'SYNTHETIC_TOKEN', user_email: 'synthetic-identity@example.invalid',
      filename: 'synthetic-private-identity.json',
    }, 403)} />)
    expect(screen.getByText('结果说明：权限不足')).toBeInTheDocument()
    expect(screen.getByText('阶段：额度查询')).toBeInTheDocument()
    expect(container).not.toHaveTextContent(/SYNTHETIC_RAW_ERROR|SYNTHETIC_TOKEN|synthetic-identity|synthetic-private/)
  })

  it('uses safe fallbacks for unknown codes, phases, update names and reasons', () => {
    const { container } = render(<ManualResultView result={manualResult({
      success: false, error_code: 'constructor', phase: 'SYNTHETIC_PHASE',
      phases: [{ phase: 'SYNTHETIC_EVENT', upstream_status: 'SYNTHETIC_HTTP' }],
      state_update: { SYNTHETIC_PRIVATE_KEY: { status: 'SYNTHETIC_STATUS', reason: 'SYNTHETIC_REASON' } },
    })} />)
    expect(screen.getByText(/结果说明：未识别的结构化错误/)).toBeInTheDocument()
    expect(screen.getByText('阶段：请求处理')).toBeInTheDocument()
    expect(screen.getByText('辅助请求：未取得有效上游 HTTP 状态')).toBeInTheDocument()
    expect(screen.getByText('其他状态：unknown')).toBeInTheDocument()
    expect(screen.getByText(/未提供可识别原因/)).toBeInTheDocument()
    expect(container).not.toHaveTextContent(/constructor|SYNTHETIC_/)
  })

  it('formats only finite quota fractions in range and retains small nonzero evidence', () => {
    const cases: [string, unknown, string][] = [
      ['zero', 0, '0%'], ['full', 1, '100%'], ['fraction', 0.123456, '12.35%'], ['tiny', 0.00001, '<0.01%'],
      ['almost-full', 0.99999, '>99.99%'], ['negative', -0.1, '未知'], ['over-full', 1.1, '未知'],
      ['nan', NaN, '未知'], ['infinite', Infinity, '未知'], ['string', '0.5', '未知'], ['null', null, '未知'], ['missing', undefined, '未知'],
    ]
    render(<ManualResultView result={manualResult({ success: true, models: Object.fromEntries(cases.map(([name, remaining]) => [name, { remaining }])) })} />)
    for (const [name, , percentage] of cases) expect(screen.getByText(`${name}：剩余 ${percentage} · 恢复时间未知`)).toBeInTheDocument()
  })

  it('hides only explicitly invisible models without mutating backend evidence', () => {
    const hidden = Object.freeze({ remaining: 0, visible: false })
    const models = Object.freeze({ retired: hidden, current: Object.freeze({ remaining: 0.43 }), 'string-flag': Object.freeze({ remaining: 0.5, visible: 'false' }) })
    const data = Object.freeze({ success: true, models })
    const result = manualResult(data)
    render(<ManualResultView result={result} />)
    expect(screen.queryByText(/^retired：/)).not.toBeInTheDocument()
    expect(screen.getByText('current：剩余 43% · 恢复时间未知')).toBeInTheDocument()
    expect(screen.getByText('string-flag：剩余 50% · 恢复时间未知')).toBeInTheDocument()
    expect(result.data).toBe(data)
    expect(result.data.models).toBe(models)
    expect(models.retired).toBe(hidden)
  })

  it('formats valid zoned dates and keeps rolling, missing or invalid recovery times unknown', () => {
    const models = {
      utc: { remaining: 0.5, resetTimeRaw: '2026-10-13T00:30:00Z' },
      offset: { remaining: 0.5, resetTimeRaw: '2026-10-13T08:30:00+08:00' },
      rolling: { remaining: 0, rolling168h: true, resetTimeRaw: '2026-10-20T00:30:00Z' },
      'invalid-day': { resetTimeRaw: '2026-02-30T00:30:00Z' },
      'invalid-offset': { resetTimeRaw: '2026-10-13T00:30:00+24:00' },
      'without-zone': { resetTimeRaw: '2026-10-13T00:30:00' },
      'raw-message': { resetTimeRaw: 'SYNTHETIC_RAW_DATE', resetTime: 'SYNTHETIC_LEGACY_DATE' },
      missing: { resetTime: '10-13 08:30' },
    }
    const { container } = render(<ManualResultView result={manualResult({ success: true, models })} />)
    for (const name of ['utc', 'offset']) expect(screen.getByText(new RegExp(`^${name}：`))).toHaveTextContent('2026/10/13 08:30:00（北京时间）')
    expect(screen.getByText(/^rolling：/)).toHaveTextContent('恢复时间未知（上游滚动 168h）')
    for (const name of ['invalid-day', 'invalid-offset', 'without-zone', 'raw-message', 'missing']) expect(screen.getByText(new RegExp(`^${name}：`))).toHaveTextContent('恢复时间未知')
    expect(container).not.toHaveTextContent(/SYNTHETIC_RAW_DATE|SYNTHETIC_LEGACY_DATE/)
  })

  it('keeps upstream success separate from failed or skipped state writes and their local reasons', () => {
    render(<ManualResultView result={manualResult({
      success: true, upstream_status: 200, error_code: 'quota_timeout', phase: 'quota_sync',
      state_update: { quota: { status: 'failed', reason: 'state_update_failed' }, model_access: { status: 'skipped', reason: 'credential_changed' } },
    })} />)
    expect(screen.getByText(/上游操作：成功.*上游 HTTP 200/)).toHaveClass('text-success')
    expect(screen.getByText('quota：failed')).toHaveClass('text-destructive')
    expect(screen.getByText('更新失败（状态更新失败）')).toBeInTheDocument()
    expect(screen.getByText('model_access：skipped')).toHaveClass('text-info')
    expect(screen.getByText('未应用（凭证已变化）')).toBeInTheDocument()
  })
})
