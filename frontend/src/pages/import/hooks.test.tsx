import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, requestJson } from '@/api/client'
import { getSessionSnapshot, setSessionToken, __setSessionValidationStatus } from '@/auth/session'
import { getPanelChannelSnapshot, __commitPanelChannel } from '@/domain/panel'
import { useImportFlow } from './hooks'
import { readEmailJob } from './api'

const auth = vi.hoisted(() => ({ authenticated: true, sessionEpoch: 1 }))
vi.mock('@/auth', () => ({ useAuth: () => auth }))
vi.mock('@/api/client', () => ({
  getServiceBase: () => 'http://localhost:3000/',
  requestJson: vi.fn(),
  ApiError: class extends Error {
    constructor(public status: number, public payload: unknown) {
      super('safe')
    }
  },
}))

vi.mock('./api', async importOriginal => {
  const actual = await importOriginal<typeof import('./api')>()
  const mockReadEmailJob = vi.fn()
  return {
    ...actual,
    readEmailJob: mockReadEmailJob,
    createImportApi: (ctx: unknown) => {
      const api = actual.createImportApi(ctx as Parameters<typeof actual.createImportApi>[0])
      return {
        ...api,
        readEmailJob: mockReadEmailJob,
      }
    },
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  auth.authenticated = true
  auth.sessionEpoch = 1
  if (getPanelChannelSnapshot().mode !== 'antigravity') {
    __commitPanelChannel('antigravity')
  }
  setSessionToken('synthetic-token')
  const session = getSessionSnapshot()
  __setSessionValidationStatus(session.sessionEpoch, 'verified')
})

describe('Import lifecycle', () => {
  it('discards old-session writes and clears data after logout', async () => {
    let resolveUpload!: (value: unknown) => void
    const pending = new Promise(resolve => {
      resolveUpload = resolve
    })
    vi.mocked(requestJson).mockReturnValueOnce(pending)

    const { result, rerender } = renderHook(useImportFlow)
    act(() => {
      result.current.uploadFiles([new File(['{}'], 'example.json')])
    })
    expect(result.current.busy).toBe(true)

    // Logout and transition session
    auth.authenticated = false
    auth.sessionEpoch++
    setSessionToken(null)
    rerender()

    await act(async () => {
      resolveUpload({ results: [{ filename: 'example.json', status: 'success' }] })
      await pending
    })

    expect(result.current.result).toBeNull()
    expect(result.current.busy).toBe(false)

    // Log in with new session
    auth.authenticated = true
    auth.sessionEpoch++
    setSessionToken('synthetic-token-2')
    __setSessionValidationStatus(getSessionSnapshot().sessionEpoch, 'verified')
    rerender()

    vi.mocked(requestJson).mockResolvedValueOnce({
      results: [{ filename: 'example.json', status: 'success' }],
    })

    act(() => {
      result.current.uploadFiles([new File(['{}'], 'example.json')])
    })

    await waitFor(() => expect(result.current.result?.outcome).toBe('success'))
  })

  it('cancel stops waiting without claiming rollback and ignores later completion', async () => {
    let resolveUpload!: (value: unknown) => void
    const pending = new Promise(resolve => {
      resolveUpload = resolve
    })
    vi.mocked(requestJson).mockReturnValueOnce(pending)

    const { result } = renderHook(useImportFlow)
    act(() => {
      result.current.uploadFiles([new File(['{}'], 'example.json')])
    })
    expect(result.current.busy).toBe(true)

    act(() => {
      result.current.cancel()
    })

    await act(async () => {
      resolveUpload({ results: [{ filename: 'example.json', status: 'success' }] })
      await pending
    })

    expect(result.current.result).toBeNull()
    expect(result.current.message).toContain('不会撤销')
  })

  it('404 expires email tracking without replaying import', async () => {
    vi.mocked(readEmailJob).mockRejectedValue(new ApiError(404, {}))
    const inventedJobId = '0123456789abcdef0123456789abcdef'
    vi.mocked(requestJson)
      .mockResolvedValueOnce({ panel_capabilities: ['antigravity.oauth.safe_response'] })
      .mockResolvedValueOnce({
        success: true,
        mode: 'antigravity',
        filename: 'example.json',
        project_id: null,
        subscription_tier: null,
        auto_detected_project: false,
        email_enrichment: { job_id: inventedJobId },
      })

    const { result } = renderHook(useImportFlow)
    act(() => {
      result.current.completeOAuth(null, '')
    })

    await waitFor(() => expect(result.current.emailMessage).toContain('已过期'))
    expect(vi.mocked(requestJson).mock.calls.filter(c => c[0] === 'auth/callback').length).toBe(1)
    expect(readEmailJob).toHaveBeenCalledTimes(1)
  })
})
