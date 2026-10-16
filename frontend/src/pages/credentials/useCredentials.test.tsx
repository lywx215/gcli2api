import type { ReactNode } from 'react'
import { act, renderHook as rtlRenderHook, waitFor, type RenderHookOptions } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import { AuthProvider } from '@/auth'
import { setSessionToken } from '@/auth/session'
import { __commitPanelChannel } from '@/domain/panel'
import { api } from './api'
import { CAP, initialFilters, parsePage } from './model'
import { useCredentials } from './useCredentials'

vi.mock('./api', async original => {
  const actual = await original<typeof import('./api')>()
  const list = vi.fn()
  return {
    ...actual,
    createCredentialApi: (
      mode: Parameters<typeof actual.createCredentialApi>[0],
      scope?: Parameters<typeof actual.createCredentialApi>[1]
    ) => ({
      ...actual.createCredentialApi(mode, scope),
      list,
    }),
    api: {
      ...actual.api,
      list,
    },
  }
})

const wrapper = ({ children }: { children: ReactNode }) => <AuthProvider>{children}</AuthProvider>
const renderHook = <Result, Props>(
  render: (initialProps: Props) => Result,
  options?: RenderHookOptions<Props>
) => rtlRenderHook(render, { wrapper, ...options })

const page = (filename = 'a.json', caps: string[] = Object.values(CAP), more = false) => parsePage({ items: [{ filename }], total: more ? 1001 : 1, has_more: more, panel_capabilities: caps })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
beforeEach(() => {
  vi.mocked(api.list).mockReset()
  __commitPanelChannel('antigravity')
  setSessionToken('synthetic-credential-session', false)
})
describe('credential controller isolation', () => {
  it('drops late A after B even when abort is ignored', async () => {
    const old = deferred<ReturnType<typeof page>>(); vi.mocked(api.list).mockReturnValueOnce(old.promise).mockResolvedValue(page('new.json'))
    const { result } = renderHook(useCredentials)
    act(() => result.current.applyFilters({ ...initialFilters, error: '403' }))
    await waitFor(() => expect(result.current.data?.items[0].filename).toBe('new.json'))
    await act(async () => old.resolve(page('old.json')))
    expect(result.current.data?.items[0].filename).toBe('new.json')
  })
  it('A-B-A changes clear selection and reject first A response', async () => {
    vi.mocked(api.list).mockResolvedValue(page()); const { result } = renderHook(useCredentials); await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => result.current.toggle(['a.json'], true)); const late = deferred<ReturnType<typeof page>>(); vi.mocked(api.list).mockReturnValueOnce(late.promise)
    act(() => result.current.applyFilters({ ...initialFilters, error: '403' })); act(() => result.current.applyFilters(initialFilters))
    await waitFor(() => expect(result.current.loading).toBe(false)); await act(async () => late.resolve(page('late.json')))
    expect(result.current.selected.size).toBe(0); expect(result.current.data?.items[0].filename).toBe('a.json')
  })
  it('keeps explicit selections on page changes', async () => { vi.mocked(api.list).mockResolvedValue(page()); const { result } = renderHook(useCredentials); await waitFor(() => expect(result.current.loading).toBe(false)); act(() => result.current.toggle(['a.json'], true)); act(() => result.current.setOffset(25)); await waitFor(() => expect(result.current.loading).toBe(false)); expect(result.current.selected.has('a.json')).toBe(true) })
  it('HTTP200 capability withdrawal clears old caches selection and task', async () => {
    vi.mocked(api.list).mockResolvedValueOnce(page()).mockResolvedValue(page('new.json', [])); const { result } = renderHook(useCredentials); await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => result.current.toggle(['a.json'], true)); const valid = result.current.captureTask(); act(() => result.current.refresh()); await waitFor(() => expect(result.current.caps.size).toBe(0))
    expect(result.current.selected.size).toBe(0); expect(valid()).toBe(false); expect(result.current.detailEpoch).toBeGreaterThan(0)
  })
  it('501 gets one recovery and cannot re-enable withdrawn capability in this session', async () => {
    vi.mocked(api.list).mockResolvedValue(page()); const { result } = renderHook(useCredentials); await waitFor(() => expect(result.current.loading).toBe(false))
    const error = new ApiError(501, { error_code: 'capability_unavailable', capability: CAP.group })
    vi.mocked(api.list).mockRejectedValueOnce(error).mockResolvedValue(page()); act(() => result.current.applyFilters({ ...initialFilters, group: 'any_restricted' }))
    await waitFor(() => expect(result.current.loading).toBe(false)); await waitFor(() => expect(result.current.caps.has(CAP.group)).toBe(false))
    expect(vi.mocked(api.list).mock.calls.length).toBe(3); expect(result.current.caps.has(CAP.family)).toBe(true)
    vi.mocked(api.list).mockRejectedValue(error); act(() => result.current.refresh()); await waitFor(() => expect(result.current.error).toContain('不支持')); expect(vi.mocked(api.list).mock.calls.length).toBe(4)
  })
  it.each([503, 504])('does not downgrade %s failure or auto-retry', async status => {
    vi.mocked(api.list).mockResolvedValueOnce(page()).mockRejectedValue(new ApiError(status, {})); const { result } = renderHook(useCredentials); await waitFor(() => expect(result.current.loading).toBe(false)); act(() => result.current.refresh()); await waitFor(() => expect(result.current.error).not.toBe('')); expect(result.current.caps.has(CAP.group)).toBe(true); expect(vi.mocked(api.list).mock.calls.length).toBe(2)
  })
  it('cancels selection if a later page withdraws capability', async () => {
    vi.mocked(api.list).mockResolvedValueOnce(page()).mockResolvedValueOnce(page('first.json', Object.values(CAP), true)).mockResolvedValueOnce(page('second.json', [])); const { result } = renderHook(useCredentials); await waitFor(() => expect(result.current.loading).toBe(false)); await act(async () => result.current.selectAll()); expect(result.current.selected.size).toBe(0); expect(result.current.materializing).toBe(false)
  })
  it('filter changes cancel all-selection before late response', async () => {
    const late = deferred<ReturnType<typeof page>>(); vi.mocked(api.list).mockResolvedValueOnce(page()).mockReturnValueOnce(late.promise).mockResolvedValue(page('current.json'))
    const { result } = renderHook(useCredentials); await waitFor(() => expect(result.current.loading).toBe(false)); act(() => { void result.current.selectAll() }); act(() => result.current.applyFilters({ ...initialFilters, search: 'current' })); await act(async () => late.resolve(page('old.json'))); expect(result.current.selected.size).toBe(0); expect(result.current.materializing).toBe(false)
  })
  it('manual uncheck cancels pending collection', async () => {
    const late = deferred<ReturnType<typeof page>>(); vi.mocked(api.list).mockResolvedValueOnce(page()).mockReturnValueOnce(late.promise); const { result } = renderHook(useCredentials); await waitFor(() => expect(result.current.loading).toBe(false)); act(() => { void result.current.selectAll() }); act(() => result.current.toggle(['a.json'], false)); await act(async () => late.resolve(page('old.json'))); expect(result.current.selected.size).toBe(0)
  })
  it('invalidates pending reads before a write and unmount invalidates tasks', async () => {
    const late = deferred<ReturnType<typeof page>>(); vi.mocked(api.list).mockReturnValueOnce(late.promise); const { result, unmount } = renderHook(useCredentials); const valid = result.current.captureTask(); act(() => result.current.invalidateReads()); await act(async () => late.resolve(page('old.json'))); expect(result.current.data).toBeNull(); unmount(); expect(valid()).toBe(false)
  })
})
