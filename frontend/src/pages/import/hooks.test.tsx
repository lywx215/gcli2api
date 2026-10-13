import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import { useImportFlow } from './hooks'
import { readEmailJob } from './api'
import type { ImportResult } from './types'
const auth = vi.hoisted(() => ({ authenticated: true, sessionEpoch: 1 }))
vi.mock('@/auth', () => ({ useAuth: () => auth }))
vi.mock('./api', async importOriginal => ({ ...await importOriginal<typeof import('./api')>(), readEmailJob: vi.fn() }))
const saved: ImportResult = { outcome: 'success', items: [{ label: 'example.json', status: 'success' }], warnings: 0 }
beforeEach(() => { vi.clearAllMocks(); auth.authenticated = true; auth.sessionEpoch = 1 })
describe('Import lifecycle', () => {
  it('discards old-session writes and clears data after logout', async () => {
    let resolve!: (value: ImportResult) => void
    const pending = new Promise<ImportResult>(done => { resolve = done })
    const { result, rerender } = renderHook(useImportFlow)
    let running!: Promise<void>
    act(() => { running = result.current.run(() => pending) })
    auth.authenticated = false; auth.sessionEpoch++
    rerender()
    await act(async () => { resolve(saved); await running })
    expect(result.current.result).toBeNull()
    expect(result.current.busy).toBe(false)
    auth.authenticated = true; auth.sessionEpoch++; rerender()
    await act(async () => { await result.current.run(async () => saved) })
    expect(result.current.result?.outcome).toBe('success')
  })
  it('cancel stops waiting without claiming rollback and ignores later completion', async () => {
    let resolve!: (value: ImportResult) => void
    const pending = new Promise<ImportResult>(done => { resolve = done })
    const { result } = renderHook(useImportFlow)
    let running!: Promise<void>
    act(() => { running = result.current.run(() => pending) })
    act(() => { result.current.cancel() })
    await act(async () => { resolve(saved); await running })
    expect(result.current.result).toBeNull()
    expect(result.current.message).toContain('不会撤销')
  })
  it('404 expires email tracking without replaying import', async () => {
    vi.mocked(readEmailJob).mockRejectedValue(new ApiError(404, {}))
    const { result } = renderHook(useImportFlow)
    const action = vi.fn(async () => ({ ...saved, jobId: 'example' }))
    await act(async () => { await result.current.run(action) })
    await waitFor(() => expect(result.current.emailMessage).toContain('已过期'))
    expect(action).toHaveBeenCalledTimes(1)
    expect(readEmailJob).toHaveBeenCalledTimes(1)
  })
})
