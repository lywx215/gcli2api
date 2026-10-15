import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestJson } from '@/api/client'
import { getSessionSnapshot, setSessionToken } from '@/auth/session'
import {
  __commitPanelChannel,
  __invalidatePanelChannel,
  capturePanelScope,
  getPanelChannelSnapshot,
  type PanelMode,
  type PanelScope,
} from '@/domain/panel'
import {
  loadOverview,
  normalizeCredentials,
  normalizeModels,
  normalizeRecent,
  normalizeToday,
} from './api'
import { overviewFixture } from './fixtures'

vi.mock('@/api/client', () => ({
  requestJson: vi.fn(),
}))

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const synthResponses: Record<string, unknown> = {
  'creds/stats-today': { date: '2026-10-14', total_count: 10, success_count: 8, failure_count: 2 },
  'creds/stats-recent': { items: [{ date: '2026-10-14', total_count: 10, success_count: 8, failure_count: 2 }] },
  'creds/stats-today-by-model': { by_family: { 'gpt-4': { total: 10, success: 8, failure: 2, rpm: 1 } }, totals: { rpm: 1 } },
  'creds/status': { stats: { total: 10, normal: 8, disabled: 2 } },
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('VITE_UI_FIXTURES', 'false')
  setSessionToken(null)
  __commitPanelChannel('antigravity')
})

afterEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('VITE_UI_FIXTURES', 'false')
  setSessionToken(null)
  __commitPanelChannel('antigravity')
})

describe('loadOverview transport & scope routing', () => {
  it('dispatches exactly four endpoints with query.mode=antigravity, days:7, offset:0, limit:20 for explicit antigravity', async () => {
    vi.mocked(requestJson).mockImplementation(async (path: string) => synthResponses[path])

    const signal = new AbortController().signal
    const result = await loadOverview(signal, { mode: 'antigravity' })

    expect(requestJson).toHaveBeenCalledTimes(4)
    const calls = vi.mocked(requestJson).mock.calls

    for (const [, options] of calls) {
      expect(options?.query?.mode).toBe('antigravity')
    }

    const todayCall = calls.find(([path]) => path === 'creds/stats-today')
    expect(todayCall).toBeDefined()
    expect(todayCall?.[1]?.query).toEqual({ mode: 'antigravity' })

    const recentCall = calls.find(([path]) => path === 'creds/stats-recent')
    expect(recentCall).toBeDefined()
    expect(recentCall?.[1]?.query).toEqual({ mode: 'antigravity', days: 7 })

    const modelsCall = calls.find(([path]) => path === 'creds/stats-today-by-model')
    expect(modelsCall).toBeDefined()
    expect(modelsCall?.[1]?.query).toEqual({ mode: 'antigravity' })

    const statusCall = calls.find(([path]) => path === 'creds/status')
    expect(statusCall).toBeDefined()
    expect(statusCall?.[1]?.query).toEqual({ mode: 'antigravity', offset: 0, limit: 20 })

    expect(result.today.value?.total).toBe(10)
    expect(result.recent.value?.[0].total).toBe(10)
    expect(result.models.value?.items[0].name).toBe('gpt-4')
    expect(result.credentials.value?.total).toBe(10)
  })

  it('dispatches exactly four endpoints with query.mode=geminicli, days:7, offset:0, limit:20 for explicit geminicli', async () => {
    const gcliResponses: Record<string, unknown> = {
      'creds/stats-today': { mode: 'geminicli', date: '2026-10-14', total_count: 10, success_count: 8, failure_count: 2 },
      'creds/stats-recent': { mode: 'geminicli', items: [{ date: '2026-10-14', total_count: 10, success_count: 8, failure_count: 2 }] },
      'creds/stats-today-by-model': { mode: 'geminicli', by_family: { 'gemini-1.5': { total: 10, success: 8, failure: 2, rpm: 1 } }, totals: { rpm: 1 } },
      'creds/status': { mode: 'geminicli', stats: { total: 10, normal: 8, disabled: 2 } },
    }
    vi.mocked(requestJson).mockImplementation(async (path: string) => gcliResponses[path])

    const signal = new AbortController().signal
    const result = await loadOverview(signal, { mode: 'geminicli' })

    expect(requestJson).toHaveBeenCalledTimes(4)
    const calls = vi.mocked(requestJson).mock.calls

    for (const [, options] of calls) {
      expect(options?.query?.mode).toBe('geminicli')
    }

    const todayCall = calls.find(([path]) => path === 'creds/stats-today')
    expect(todayCall).toBeDefined()
    expect(todayCall?.[1]?.query).toEqual({ mode: 'geminicli' })

    const recentCall = calls.find(([path]) => path === 'creds/stats-recent')
    expect(recentCall).toBeDefined()
    expect(recentCall?.[1]?.query).toEqual({ mode: 'geminicli', days: 7 })

    const modelsCall = calls.find(([path]) => path === 'creds/stats-today-by-model')
    expect(modelsCall).toBeDefined()
    expect(modelsCall?.[1]?.query).toEqual({ mode: 'geminicli' })

    const statusCall = calls.find(([path]) => path === 'creds/status')
    expect(statusCall).toBeDefined()
    expect(statusCall?.[1]?.query).toEqual({ mode: 'geminicli', offset: 0, limit: 20 })

    expect(result.today.value?.total).toBe(10)
    expect(result.recent.value?.[0].total).toBe(10)
    expect(result.models.value?.items[0].name).toBe('gemini-1.5')
    expect(result.credentials.value?.total).toBe(10)
  })

  it('keeps single-argument loadOverview as antigravity even while Core channel is geminicli', async () => {
    __commitPanelChannel('geminicli')
    expect(getPanelChannelSnapshot().mode).toBe('geminicli')

    vi.mocked(requestJson).mockImplementation(async (path: string) => synthResponses[path])

    const signal = new AbortController().signal
    const result = await loadOverview(signal)

    expect(requestJson).toHaveBeenCalledTimes(4)
    for (const [, options] of vi.mocked(requestJson).mock.calls) {
      expect(options?.query?.mode).toBe('antigravity')
    }
    expect(result.today.value?.total).toBe(10)
  })

  it('rejects invalid explicit mode before transport', async () => {
    const signal = new AbortController().signal
    await expect(loadOverview(signal, { mode: 'unsupported' as unknown as PanelMode }))
      .rejects.toThrow(TypeError)
    await expect(loadOverview(signal, { mode: 'unsupported' as unknown as PanelMode }))
      .rejects.toThrow('Invalid panel mode: unsupported')
    expect(requestJson).not.toHaveBeenCalled()
  })

  it('rejects mismatching supplied scope before transport', async () => {
    const currentSessionEpoch = getSessionSnapshot().sessionEpoch
    const currentChannelSnapshot = getPanelChannelSnapshot()
    const mismatchScope: PanelScope = {
      mode: 'geminicli',
      channelEpoch: currentChannelSnapshot.channelEpoch,
      sessionEpoch: currentSessionEpoch,
    }
    const signal = new AbortController().signal
    await expect(loadOverview(signal, { mode: 'antigravity', scope: mismatchScope }))
      .rejects.toSatisfy((err: unknown) => {
        return err instanceof DOMException && err.name === 'AbortError' && err.message.includes('作用域已变更')
      })
    expect(requestJson).not.toHaveBeenCalled()
  })

  it('rejects stale channel epoch in supplied scope before transport', async () => {
    const currentSessionEpoch = getSessionSnapshot().sessionEpoch
    const currentChannelSnapshot = getPanelChannelSnapshot()
    const staleChannelScope: PanelScope = {
      mode: 'antigravity',
      channelEpoch: currentChannelSnapshot.channelEpoch - 1,
      sessionEpoch: currentSessionEpoch,
    }
    const signal = new AbortController().signal
    await expect(loadOverview(signal, { mode: 'antigravity', scope: staleChannelScope }))
      .rejects.toSatisfy((err: unknown) => {
        return err instanceof DOMException && err.name === 'AbortError' && err.message.includes('作用域已变更')
      })
    expect(requestJson).not.toHaveBeenCalled()
  })

  it('rejects stale session epoch in supplied scope before transport', async () => {
    const currentSessionEpoch = getSessionSnapshot().sessionEpoch
    const currentChannelSnapshot = getPanelChannelSnapshot()
    const staleSessionScope: PanelScope = {
      mode: 'antigravity',
      channelEpoch: currentChannelSnapshot.channelEpoch,
      sessionEpoch: currentSessionEpoch - 1,
    }
    const signal = new AbortController().signal
    await expect(loadOverview(signal, { mode: 'antigravity', scope: staleSessionScope }))
      .rejects.toSatisfy((err: unknown) => {
        return err instanceof DOMException && err.name === 'AbortError' && err.message.includes('作用域已变更')
      })
    expect(requestJson).not.toHaveBeenCalled()
  })

  it('rejects pre-aborted signal before transport', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(loadOverview(controller.signal, { mode: 'antigravity' }))
      .rejects.toSatisfy((err: unknown) => {
        return (err instanceof DOMException || (err instanceof Error && err.name === 'AbortError')) &&
          (err as Error).name === 'AbortError'
      })
    expect(requestJson).not.toHaveBeenCalled()
  })

  it('copies and freezes caller scope, ensuring input mutations do not affect pending requests or invalidate work', async () => {
    const currentSessionEpoch = getSessionSnapshot().sessionEpoch
    const currentChannelSnapshot = getPanelChannelSnapshot()
    const mutableScope: { mode: PanelMode; channelEpoch: number; sessionEpoch: number } = {
      mode: 'antigravity',
      channelEpoch: currentChannelSnapshot.channelEpoch,
      sessionEpoch: currentSessionEpoch,
    }

    vi.mocked(requestJson).mockImplementation(async (path: string) => synthResponses[path])
    const signal = new AbortController().signal
    const loadPromise = loadOverview(signal, { mode: 'antigravity', scope: mutableScope as PanelScope })

    const calls = vi.mocked(requestJson).mock.calls
    expect(calls).toHaveLength(4)
    const passedScopes = calls.map(c => c[1]?.scope)

    const firstScope = passedScopes[0]
    expect(firstScope).toBeDefined()
    expect(Object.isFrozen(firstScope)).toBe(true)
    expect(firstScope).not.toBe(mutableScope)
    expect(passedScopes[1]).toBe(firstScope)
    expect(passedScopes[2]).toBe(firstScope)
    expect(passedScopes[3]).toBe(firstScope)
    expect(firstScope?.mode).toBe('antigravity')
    expect(firstScope?.channelEpoch).toBe(currentChannelSnapshot.channelEpoch)
    expect(firstScope?.sessionEpoch).toBe(currentSessionEpoch)

    // Caller mutates the input scope
    mutableScope.mode = 'geminicli'
    mutableScope.channelEpoch = 9999
    mutableScope.sessionEpoch = 9999

    // Frozen scope passed to requests remains unchanged
    expect(firstScope?.mode).toBe('antigravity')
    expect(firstScope?.channelEpoch).toBe(currentChannelSnapshot.channelEpoch)
    expect(firstScope?.sessionEpoch).toBe(currentSessionEpoch)

    const result = await loadPromise
    expect(result.today.issue).toBeNull()
    expect(result.credentials.issue).toBeNull()
  })
})

describe('deferred mocked transport, epochs and abort semantics', () => {
  it('rejects with AbortError when channel epoch advances without mode change while requests are pending', async () => {
    const deferredMap = new Map<string, Deferred<unknown>>()
    for (const path of ['creds/stats-today', 'creds/stats-recent', 'creds/stats-today-by-model', 'creds/status']) {
      deferredMap.set(path, createDeferred())
    }
    vi.mocked(requestJson).mockImplementation(async (path: string) => {
      return deferredMap.get(path)!.promise
    })

    const currentSessionEpoch = getSessionSnapshot().sessionEpoch
    const scope = capturePanelScope(currentSessionEpoch)
    const controller = new AbortController()

    const promise = loadOverview(controller.signal, { mode: 'antigravity', scope })
    expect(requestJson).toHaveBeenCalledTimes(4)

    // Advance channel epoch without changing mode
    const initialMode = getPanelChannelSnapshot().mode
    __invalidatePanelChannel()
    expect(getPanelChannelSnapshot().mode).toBe(initialMode)
    expect(controller.signal.aborted).toBe(false)

    // Attach rejection assertion BEFORE resolving
    const rejectionAssertion = expect(promise).rejects.toSatisfy((err: unknown) => {
      return (err instanceof DOMException || (err instanceof Error && err.name === 'AbortError')) &&
        (err as Error).name === 'AbortError' &&
        (err as Error).message.includes('作用域已变更')
    })

    // Deferred transport resolves (ignoring cancellation)
    for (const [path, deferred] of deferredMap) {
      deferred.resolve(synthResponses[path])
    }

    await rejectionAssertion
  })

  it('rejects with AbortError when session epoch advances while requests are pending', async () => {
    const deferredMap = new Map<string, Deferred<unknown>>()
    for (const path of ['creds/stats-today', 'creds/stats-recent', 'creds/stats-today-by-model', 'creds/status']) {
      deferredMap.set(path, createDeferred())
    }
    vi.mocked(requestJson).mockImplementation(async (path: string) => {
      return deferredMap.get(path)!.promise
    })

    const currentSessionEpoch = getSessionSnapshot().sessionEpoch
    const scope = capturePanelScope(currentSessionEpoch)
    const controller = new AbortController()

    const promise = loadOverview(controller.signal, { mode: 'antigravity', scope })
    expect(requestJson).toHaveBeenCalledTimes(4)

    // Advance session epoch while requests are pending
    setSessionToken('new-synthetic-token')
    expect(getSessionSnapshot().sessionEpoch).toBeGreaterThan(currentSessionEpoch)
    expect(controller.signal.aborted).toBe(false)

    // Attach rejection assertion BEFORE resolving
    const rejectionAssertion = expect(promise).rejects.toSatisfy((err: unknown) => {
      return (err instanceof DOMException || (err instanceof Error && err.name === 'AbortError')) &&
        (err as Error).name === 'AbortError' &&
        (err as Error).message.includes('作用域已变更')
    })

    for (const [path, deferred] of deferredMap) {
      deferred.resolve(synthResponses[path])
    }

    await rejectionAssertion
  })

  it('propagates caller abort signal when caller aborts while requests are pending', async () => {
    const deferredMap = new Map<string, Deferred<unknown>>()
    for (const path of ['creds/stats-today', 'creds/stats-recent', 'creds/stats-today-by-model', 'creds/status']) {
      deferredMap.set(path, createDeferred())
    }
    vi.mocked(requestJson).mockImplementation(async (path: string) => {
      return deferredMap.get(path)!.promise
    })

    const controller = new AbortController()
    const promise = loadOverview(controller.signal, { mode: 'antigravity' })
    expect(requestJson).toHaveBeenCalledTimes(4)

    controller.abort(new DOMException('User cancelled operation', 'AbortError'))

    // Attach rejection assertion BEFORE resolving
    const rejectionAssertion = expect(promise).rejects.toSatisfy((err: unknown) => {
      return (err instanceof DOMException || (err instanceof Error && err.name === 'AbortError')) &&
        (err as Error).name === 'AbortError'
    })

    for (const [path, deferred] of deferredMap) {
      deferred.resolve(synthResponses[path])
    }

    await rejectionAssertion
  })

  it('returns expected values when scope remains current throughout pending requests', async () => {
    const deferredMap = new Map<string, Deferred<unknown>>()
    for (const path of ['creds/stats-today', 'creds/stats-recent', 'creds/stats-today-by-model', 'creds/status']) {
      deferredMap.set(path, createDeferred())
    }
    vi.mocked(requestJson).mockImplementation(async (path: string) => {
      return deferredMap.get(path)!.promise
    })

    const currentSessionEpoch = getSessionSnapshot().sessionEpoch
    const scope = capturePanelScope(currentSessionEpoch)
    const controller = new AbortController()

    const promise = loadOverview(controller.signal, { mode: 'antigravity', scope })

    for (const [path, deferred] of deferredMap) {
      deferred.resolve(synthResponses[path])
    }

    const result = await promise
    expect(result.today).toEqual({ value: { date: '2026-10-14', total: 10, success: 8, failure: 2 }, issue: null })
    expect(result.recent).toEqual({ value: [{ date: '2026-10-14', total: 10, success: 8, failure: 2 }], issue: null })
    expect(result.models.issue).toBeNull()
    expect(result.models.value?.items).toEqual([{ name: 'gpt-4', total: 10, success: 8, failure: 2, rpm: 1 }])
    expect(result.credentials).toEqual({ value: { total: 10, normal: 8, disabled: 2 }, issue: null })
  })

  it('leaves the other three observations intact when one endpoint experiences a non-abort failure', async () => {
    vi.mocked(requestJson).mockImplementation(async (path: string) => {
      if (path === 'creds/stats-today') {
        throw new Error('500 Internal Server Error')
      }
      return synthResponses[path]
    })

    const signal = new AbortController().signal
    const result = await loadOverview(signal, { mode: 'antigravity' })

    expect(result.today).toEqual({ value: null, issue: '读取失败，可手动刷新' })
    expect(result.recent).toEqual({ value: [{ date: '2026-10-14', total: 10, success: 8, failure: 2 }], issue: null })
    expect(result.models.issue).toBeNull()
    expect(result.models.value?.items).toEqual([{ name: 'gpt-4', total: 10, success: 8, failure: 2, rpm: 1 }])
    expect(result.credentials).toEqual({ value: { total: 10, normal: 8, disabled: 2 }, issue: null })
  })

  it('rejects the entire load when transport throws an AbortError', async () => {
    vi.mocked(requestJson).mockImplementation(async (path: string) => {
      if (path === 'creds/stats-today') {
        throw new DOMException('Transport aborted', 'AbortError')
      }
      return synthResponses[path]
    })

    const signal = new AbortController().signal
    await expect(loadOverview(signal, { mode: 'antigravity' })).rejects.toSatisfy((err: unknown) => {
      return (err instanceof DOMException || (err instanceof Error && err.name === 'AbortError')) &&
        (err as Error).name === 'AbortError'
    })
  })
})

describe('normalizer channel isolation & legacy compatibility', () => {
  it('normalizes today stats for missing mode, matching mode, opposite mode, and by_mode', () => {
    // Missing response.mode stays legacy-compatible
    expect(normalizeToday({ date: '2026-10-14', total_count: 5 }, 'antigravity'))
      .toEqual({ value: { date: '2026-10-14', success: null, failure: null, total: 5 }, issue: null })

    // Matching mode string works
    expect(normalizeToday({ mode: 'antigravity', date: '2026-10-14', total_count: 5 }, 'antigravity'))
      .toEqual({ value: { date: '2026-10-14', success: null, failure: null, total: 5 }, issue: null })
    expect(normalizeToday({ mode: 'geminicli', date: '2026-10-14', total_count: 5 }, 'geminicli'))
      .toEqual({ value: { date: '2026-10-14', success: null, failure: null, total: 5 }, issue: null })

    // Opposite-channel string becomes fixed unavailable observation
    expect(normalizeToday({ mode: 'geminicli', date: '2026-10-14', total_count: 5 }, 'antigravity'))
      .toEqual({ value: null, issue: '统计数据不可用' })
    expect(normalizeToday({ mode: 'antigravity', date: '2026-10-14', total_count: 5 }, 'geminicli'))
      .toEqual({ value: null, issue: '统计数据不可用' })

    // Non-null by_mode cannot masquerade as selected-channel data
    expect(normalizeToday({ mode: 'antigravity', by_mode: { antigravity: { total_count: 5 } }, date: '2026-10-14', total_count: 5 }, 'antigravity'))
      .toEqual({ value: null, issue: '统计数据不可用' })
    expect(normalizeToday({ mode: 'geminicli', by_mode: {}, date: '2026-10-14', total_count: 5 }, 'geminicli'))
      .toEqual({ value: null, issue: '统计数据不可用' })
  })

  it('normalizes recent stats for missing mode, matching mode, opposite mode, and by_mode', () => {
    // Missing response.mode stays legacy-compatible
    expect(normalizeRecent({ items: [{ date: '2026-10-14', total_count: 5 }] }, 'antigravity'))
      .toEqual({ value: [{ date: '2026-10-14', success: null, failure: null, total: 5 }], issue: null })

    // Matching mode string works
    expect(normalizeRecent({ mode: 'antigravity', items: [{ date: '2026-10-14', total_count: 5 }] }, 'antigravity'))
      .toEqual({ value: [{ date: '2026-10-14', success: null, failure: null, total: 5 }], issue: null })
    expect(normalizeRecent({ mode: 'geminicli', items: [{ date: '2026-10-14', total_count: 5 }] }, 'geminicli'))
      .toEqual({ value: [{ date: '2026-10-14', success: null, failure: null, total: 5 }], issue: null })

    // Opposite-channel string becomes fixed unavailable observation
    expect(normalizeRecent({ mode: 'geminicli', items: [{ date: '2026-10-14', total_count: 5 }] }, 'antigravity'))
      .toEqual({ value: null, issue: '统计数据不可用' })
    expect(normalizeRecent({ mode: 'antigravity', items: [{ date: '2026-10-14', total_count: 5 }] }, 'geminicli'))
      .toEqual({ value: null, issue: '统计数据不可用' })

    // Non-null by_mode cannot masquerade as selected-channel data
    expect(normalizeRecent({ mode: 'antigravity', by_mode: {}, items: [{ date: '2026-10-14', total_count: 5 }] }, 'antigravity'))
      .toEqual({ value: null, issue: '统计数据不可用' })
    expect(normalizeRecent({ mode: 'geminicli', by_mode: { geminicli: [] }, items: [{ date: '2026-10-14', total_count: 5 }] }, 'geminicli'))
      .toEqual({ value: null, issue: '统计数据不可用' })
  })

  it('normalizes models stats for missing mode, matching mode, opposite mode, and by_mode', () => {
    // Missing response.mode stays legacy-compatible
    expect(normalizeModels({ by_family: { test: { total: 5 } }, totals: { rpm: 0 } }, 'antigravity'))
      .toEqual({ value: { items: [{ name: 'test', success: null, failure: null, total: 5, rpm: null }], rpm: 0 }, issue: null })

    // Matching mode string works
    expect(normalizeModels({ mode: 'antigravity', by_family: { test: { total: 5 } }, totals: { rpm: 0 } }, 'antigravity'))
      .toEqual({ value: { items: [{ name: 'test', success: null, failure: null, total: 5, rpm: null }], rpm: 0 }, issue: null })
    expect(normalizeModels({ mode: 'geminicli', by_family: { test: { total: 5 } }, totals: { rpm: 0 } }, 'geminicli'))
      .toEqual({ value: { items: [{ name: 'test', success: null, failure: null, total: 5, rpm: null }], rpm: 0 }, issue: null })

    // Opposite-channel string becomes fixed unavailable observation
    expect(normalizeModels({ mode: 'geminicli', by_family: { test: { total: 5 } }, totals: { rpm: 0 } }, 'antigravity'))
      .toEqual({ value: null, issue: '统计数据不可用' })
    expect(normalizeModels({ mode: 'antigravity', by_family: { test: { total: 5 } }, totals: { rpm: 0 } }, 'geminicli'))
      .toEqual({ value: null, issue: '统计数据不可用' })

    // Non-null by_mode cannot masquerade as selected-channel data
    expect(normalizeModels({ mode: 'antigravity', by_mode: { test: {} }, by_family: { test: { total: 5 } }, totals: { rpm: 0 } }, 'antigravity'))
      .toEqual({ value: null, issue: '统计数据不可用' })
    expect(normalizeModels({ mode: 'geminicli', by_mode: {}, by_family: { test: { total: 5 } }, totals: { rpm: 0 } }, 'geminicli'))
      .toEqual({ value: null, issue: '统计数据不可用' })
  })

  it('normalizes credentials stats for missing mode, matching mode, opposite mode, and by_mode', () => {
    // Missing response.mode stays legacy-compatible
    expect(normalizeCredentials({ stats: { total: 10, normal: 8, disabled: 2 } }, 'antigravity'))
      .toEqual({ value: { total: 10, normal: 8, disabled: 2 }, issue: null })

    // Matching mode string works
    expect(normalizeCredentials({ mode: 'antigravity', stats: { total: 10, normal: 8, disabled: 2 } }, 'antigravity'))
      .toEqual({ value: { total: 10, normal: 8, disabled: 2 }, issue: null })
    expect(normalizeCredentials({ mode: 'geminicli', stats: { total: 10, normal: 8, disabled: 2 } }, 'geminicli'))
      .toEqual({ value: { total: 10, normal: 8, disabled: 2 }, issue: null })

    // Opposite-channel string becomes fixed unavailable observation
    expect(normalizeCredentials({ mode: 'geminicli', stats: { total: 10, normal: 8, disabled: 2 } }, 'antigravity'))
      .toEqual({ value: null, issue: '凭证摘要不可用' })
    expect(normalizeCredentials({ mode: 'antigravity', stats: { total: 10, normal: 8, disabled: 2 } }, 'geminicli'))
      .toEqual({ value: null, issue: '凭证摘要不可用' })

    // Non-null by_mode cannot masquerade as selected-channel data
    expect(normalizeCredentials({ mode: 'antigravity', by_mode: { antigravity: {} }, stats: { total: 10, normal: 8, disabled: 2 } }, 'antigravity'))
      .toEqual({ value: null, issue: '凭证摘要不可用' })
    expect(normalizeCredentials({ mode: 'geminicli', by_mode: {}, stats: { total: 10, normal: 8, disabled: 2 } }, 'geminicli'))
      .toEqual({ value: null, issue: '凭证摘要不可用' })
  })
})

describe('credential normalization contract', () => {
  it('uses global stats only, ignoring response.total, items, model_access_summary and cycle metadata', () => {
    const payload = {
      total: 999,
      items: [{ filename: 'test.json', disabled: false, cycle_stats: { a: 1 }, last_cycle_stats: { b: 2 } }],
      model_access_summary: { total: 888, family_counts: { pro: { supported: 10, unavailable: 0, unknown: 0 } } },
      cycle_stats: { global: 1 },
      last_cycle_stats: { global: 0 },
      stats: { total: 10, normal: 8, disabled: 2 },
    }
    const result = normalizeCredentials(payload, 'antigravity')
    expect(result).toEqual({ value: { total: 10, normal: 8, disabled: 2 }, issue: null })
  })

  it('preserves exact three-field legacy equality when optional counters are absent', () => {
    const payload = { stats: { total: 12, normal: 10, disabled: 2 } }
    const result = normalizeCredentials(payload, 'antigravity')
    expect(result.value).toEqual({ total: 12, normal: 10, disabled: 2 })
    expect('permanent_disabled' in (result.value ?? {})).toBe(false)
    expect('in_cooldown' in (result.value ?? {})).toBe(false)
    expect('no_cooldown' in (result.value ?? {})).toBe(false)
    expect('quota_restricted' in (result.value ?? {})).toBe(false)
    expect('quota_unrestricted' in (result.value ?? {})).toBe(false)
    expect('quota_blocked_unknown' in (result.value ?? {})).toBe(false)
    expect('quota_state_invalid' in (result.value ?? {})).toBe(false)
    expect('quota_next_expiry' in (result.value ?? {})).toBe(false)
  })

  it('preserves valid zero for optional permanent_disabled, in_cooldown, no_cooldown and all four quota counters plus quota_next_expiry', () => {
    const payload = {
      panel_capabilities: ['antigravity.cooldown.group_filter'],
      stats: {
        total: 0,
        normal: 0,
        disabled: 0,
        permanent_disabled: 0,
        in_cooldown: 0,
        no_cooldown: 0,
        quota_restricted: 0,
        quota_unrestricted: 0,
        quota_blocked_unknown: 0,
        quota_state_invalid: 0,
        quota_next_expiry: 0,
      },
    }
    const result = normalizeCredentials(payload, 'antigravity')
    expect(result.value).toEqual({
      total: 0,
      normal: 0,
      disabled: 0,
      permanent_disabled: 0,
      in_cooldown: 0,
      no_cooldown: 0,
      quota_restricted: 0,
      quota_unrestricted: 0,
      quota_blocked_unknown: 0,
      quota_state_invalid: 0,
      quota_next_expiry: 0,
    })
  })

  it('omits optional counts when missing, null, false, string, fractional, negative, or nonfinite', () => {
    const invalidValues = [null, false, '0', 1.5, -1, NaN, Infinity, -Infinity]
    for (const bad of invalidValues) {
      const payload = {
        panel_capabilities: ['antigravity.cooldown.group_filter'],
        stats: {
          total: 10,
          normal: 8,
          disabled: 2,
          permanent_disabled: bad,
          in_cooldown: bad,
          no_cooldown: bad,
          quota_restricted: bad,
          quota_unrestricted: bad,
          quota_blocked_unknown: bad,
          quota_state_invalid: bad,
        },
      }
      const result = normalizeCredentials(payload, 'antigravity')
      expect(result.value).toEqual({ total: 10, normal: 8, disabled: 2 })
    }
  })

  it('keeps required counts (total, normal, disabled) as null when invalid, missing, string, fractional, or negative', () => {
    const testCases = [
      { total: 'bad', normal: 8, disabled: 2 },
      { total: 10, normal: -1, disabled: 2 },
      { total: 10, normal: 8, disabled: 2.5 },
      { total: null, normal: false, disabled: NaN },
      {},
    ]
    for (const stats of testCases) {
      const result = normalizeCredentials({ stats }, 'antigravity')
      expect(result.issue).toBeNull()
      expect(result.value).toHaveProperty('total')
      expect(result.value).toHaveProperty('normal')
      expect(result.value).toHaveProperty('disabled')
    }
    const allInvalid = normalizeCredentials({ stats: { total: -1, normal: 'abc', disabled: 1.2 } }, 'antigravity')
    expect(allInvalid.value).toEqual({ total: null, normal: null, disabled: null })
  })

  it('does not sum or recompute counters and strips unknown, nested, secret, and diagnostic fields', () => {
    const payload = {
      stats: {
        total: 50,
        normal: 2,
        disabled: 3,
        api_key: 'sk-secret-12345',
        client_secret: 'shh-private',
        raw_credential: { token: 'secret' },
        diagnostic_info: 'debug-payload',
        extra_metadata: 12345,
      },
    }
    const result = normalizeCredentials(payload, 'antigravity')
    expect(result.value).toEqual({ total: 50, normal: 2, disabled: 3 })
    expect(Object.keys(result.value!)).toEqual(['total', 'normal', 'disabled'])
  })

  it('requires antigravity.cooldown.group_filter for AG quota fields, omitting them if capability is absent or wrong', () => {
    const baseStats = {
      total: 10,
      normal: 8,
      disabled: 2,
      quota_restricted: 1,
      quota_unrestricted: 7,
      quota_blocked_unknown: 0,
      quota_state_invalid: 0,
      quota_next_expiry: 1728900000,
    }

    // Absent capability
    const absentResult = normalizeCredentials({ stats: baseStats }, 'antigravity')
    expect(absentResult.value).toEqual({ total: 10, normal: 8, disabled: 2 })

    // Wrong capability
    const wrongCaps = [
      ['antigravity.quota.summary'],
      ['geminicli.quota.summary'],
      ['antigravity.model_access.family_filter'],
      ['antigravity.cooldown.other_filter'],
    ]
    for (const panel_capabilities of wrongCaps) {
      const wrongResult = normalizeCredentials({ stats: baseStats, panel_capabilities }, 'antigravity')
      expect(wrongResult.value).toEqual({ total: 10, normal: 8, disabled: 2 })
    }

    // Matching capability for AG
    const correctResult = normalizeCredentials(
      { stats: baseStats, panel_capabilities: ['antigravity.cooldown.group_filter'] },
      'antigravity',
    )
    expect(correctResult.value).toEqual({
      total: 10,
      normal: 8,
      disabled: 2,
      quota_restricted: 1,
      quota_unrestricted: 7,
      quota_blocked_unknown: 0,
      quota_state_invalid: 0,
      quota_next_expiry: 1728900000,
    })
  })

  it('omits AG quota fields in GCLI mode even when antigravity.cooldown.group_filter is present', () => {
    const payload = {
      panel_capabilities: ['antigravity.cooldown.group_filter'],
      stats: {
        total: 10,
        normal: 8,
        disabled: 2,
        permanent_disabled: 1,
        in_cooldown: 2,
        no_cooldown: 6,
        quota_restricted: 1,
        quota_unrestricted: 5,
        quota_blocked_unknown: 0,
        quota_state_invalid: 0,
        quota_next_expiry: 1728900000,
      },
    }
    const gcliExplicit = normalizeCredentials(payload, 'geminicli')
    expect(gcliExplicit.value).toEqual({
      total: 10,
      normal: 8,
      disabled: 2,
      permanent_disabled: 1,
      in_cooldown: 2,
      no_cooldown: 6,
    })
    expect('quota_restricted' in (gcliExplicit.value ?? {})).toBe(false)
    expect('quota_next_expiry' in (gcliExplicit.value ?? {})).toBe(false)

    const gcliInPayload = normalizeCredentials({ ...payload, mode: 'geminicli' })
    expect(gcliInPayload.value).toEqual({
      total: 10,
      normal: 8,
      disabled: 2,
      permanent_disabled: 1,
      in_cooldown: 2,
      no_cooldown: 6,
    })
  })

  it('accepts fractional values and zero for quota_next_expiry, rejects invalid values, and never treats it as integer count', () => {
    const caps = ['antigravity.cooldown.group_filter']
    // Fractional timestamp
    const fractional = normalizeCredentials(
      { panel_capabilities: caps, stats: { total: 10, normal: 8, disabled: 2, quota_next_expiry: 1728900000.75 } },
      'antigravity',
    )
    expect(fractional.value?.quota_next_expiry).toBe(1728900000.75)

    // Zero
    const zero = normalizeCredentials(
      { panel_capabilities: caps, stats: { total: 10, normal: 8, disabled: 2, quota_next_expiry: 0 } },
      'antigravity',
    )
    expect(zero.value?.quota_next_expiry).toBe(0)

    // Invalid values: negative, string, NaN, Infinity, -Infinity, null, boolean
    const invalidExpiries = [-0.1, -1, '1728900000', '1728900000.5', NaN, Infinity, -Infinity, null, false, true]
    for (const bad of invalidExpiries) {
      const res = normalizeCredentials(
        { panel_capabilities: caps, stats: { total: 10, normal: 8, disabled: 2, quota_next_expiry: bad } },
        'antigravity',
      )
      expect('quota_next_expiry' in (res.value ?? {})).toBe(false)
    }
  })
})

describe('DEV fixture mode', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_UI_FIXTURES', 'true')
  })

  afterEach(() => {
    vi.stubEnv('VITE_UI_FIXTURES', 'false')
  })

  it('returns four fixed unavailable observations for explicit GCLI with zero requestJson calls and no AG fixture reuse', async () => {
    const signal = new AbortController().signal
    const result = await loadOverview(signal, { mode: 'geminicli' })

    expect(requestJson).not.toHaveBeenCalled()
    expect(result).toEqual({
      today: { value: null, issue: '统计数据不可用' },
      recent: { value: null, issue: '近期统计不可用' },
      models: { value: null, issue: '模型统计不可用' },
      credentials: { value: null, issue: '凭证摘要不可用' },
    })

    // Verify no AG fixture reuse
    expect(result.today.value).toBeNull()
    expect(result.recent.value).toBeNull()
    expect(result.models.value).toBeNull()
    expect(result.credentials.value).toBeNull()
    expect(result).not.toEqual(overviewFixture)
    expect(result.today).not.toEqual(overviewFixture.today)
    expect(result.recent).not.toEqual(overviewFixture.recent)
    expect(result.models).not.toEqual(overviewFixture.models)
    expect(result.credentials).not.toEqual(overviewFixture.credentials)
  })

  it('returns unchanged overviewFixture for antigravity mode in DEV fixture mode', async () => {
    const signal = new AbortController().signal
    const result = await loadOverview(signal, { mode: 'antigravity' })

    expect(requestJson).not.toHaveBeenCalled()
    expect(result).toEqual(overviewFixture)
  })

  it('returns unchanged overviewFixture for default (single-argument) loadOverview in DEV fixture mode', async () => {
    const signal = new AbortController().signal
    const result = await loadOverview(signal)

    expect(requestJson).not.toHaveBeenCalled()
    expect(result).toEqual(overviewFixture)
  })
})
