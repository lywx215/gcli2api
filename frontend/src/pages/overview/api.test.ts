import { describe, expect, it, vi, beforeEach } from 'vitest'
import { requestJson } from '@/api/client'
import { count, loadOverview, normalizeCredentials, normalizeModels, normalizeRecent, normalizeToday } from './api'
vi.mock('@/api/client', () => ({ requestJson: vi.fn() }))
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('VITE_UI_FIXTURES', 'false') })
describe('overview endpoint semantics', () => {
  it('keeps zero while rejecting missing, string, NaN and negative counters', () => {
    expect(count(0)).toBe(0)
    for (const input of [undefined, null, '0', NaN, -1]) expect(count(input)).toBeNull()
    expect(normalizeToday({ date: '2026-10-13', total_count: 0 }).value).toEqual({ date: '2026-10-13', success: null, failure: null, total: 0 })
  })
  it('does not turn unsupported or failed backend zeros into real metrics', () => {
    expect(normalizeToday({ date: '', total_count: 0, note: 'unsupported' }).value).toBeNull()
    expect(normalizeModels({ by_family: {}, totals: { total: 0 }, error: 'synthetic failure' }).value).toBeNull()
    expect(normalizeRecent({ items: [], since: null }).value).toBeNull()
    expect(normalizeToday({ metric: 'attempts', date: '2026-10-13', total_count: 5 }).value).toBeNull()
  })
  it('preserves existing field names and does not infer counters', () => {
    expect(normalizeModels({ by_family: { synthetic: { success: 2, failure: 1, rpm: 0 } }, totals: { rpm: 0 } }).value).toEqual({ items: [{ name: 'synthetic', success: 2, failure: 1, total: null, rpm: 0 }], rpm: 0 })
    expect(normalizeCredentials({ items: [], total: 5, stats: { total: 5, normal: 0, disabled: 5 } }).value).toEqual({ total: 5, normal: 0, disabled: 5 })
    expect(normalizeRecent({ items: [{ date: '2026-10-11', total_count: 2 }] }).value).toHaveLength(1)
  })
  it('isolates individual failures and uses AG query mode and a light status page', async () => {
    vi.mocked(requestJson).mockImplementation(async path => {
      if (path === 'creds/stats-today') throw new Error('synthetic network failure')
      if (path === 'creds/stats-recent') return { items: [] }
      if (path === 'creds/stats-today-by-model') return { by_family: {}, totals: { rpm: 0 } }
      return { stats: { total: 0, normal: 0, disabled: 0 } }
    })
    const result = await loadOverview(new AbortController().signal)
    expect(result.today.value).toBeNull()
    expect(result.credentials.value?.total).toBe(0)
    for (const [, options] of vi.mocked(requestJson).mock.calls) expect(options?.query?.mode).toBe('antigravity')
    expect(requestJson).toHaveBeenCalledWith('creds/status', expect.objectContaining({ query: { mode: 'antigravity', offset: 0, limit: 20 } }))
  })
})
