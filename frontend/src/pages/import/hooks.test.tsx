import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, requestJson } from '@/api/client'
import { getSessionSnapshot, setSessionToken, __setSessionValidationStatus } from '@/auth/session'
import { getPanelChannelSnapshot, __commitPanelChannel } from '@/domain/panel'
import { useImportFlow } from './hooks'

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

const uploadResult = { results: [{ filename: 'example.json', status: 'success' }] }

function mockUpload(response: Promise<unknown>) {
  vi.mocked(requestJson).mockImplementation(path => {
    if (path === 'creds/upload-progress/capabilities') {
      return Promise.resolve({ supported: false })
    }
    if (path === 'creds/upload') return response
    return Promise.reject(new Error(`Unexpected request: ${path}`))
  })
}

function uploadCalls() {
  return vi.mocked(requestJson).mock.calls.filter(([path]) => path === 'creds/upload')
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('VITE_UI_FIXTURES', 'false')
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
    mockUpload(pending)

    const { result, rerender } = renderHook(useImportFlow)
    act(() => {
      expect(result.current.uploadFiles([new File(['{}'], 'example.json')])).toBe(true)
    })
    await waitFor(() => expect(uploadCalls()).toHaveLength(1))
    expect(result.current.busy).toBe(true)
    const oldSignal = uploadCalls()[0][1]?.signal
    expect(oldSignal?.aborted).toBe(false)

    act(() => {
      auth.authenticated = false
      auth.sessionEpoch++
      setSessionToken(null)
    })
    rerender()
    expect(oldSignal?.aborted).toBe(true)

    await act(async () => {
      resolveUpload(uploadResult)
      await pending
    })

    expect(result.current.result).toBeNull()
    expect(result.current.busy).toBe(false)
    expect(uploadCalls()).toHaveLength(1)

    act(() => {
      auth.authenticated = true
      auth.sessionEpoch++
      setSessionToken('synthetic-token-2')
      __setSessionValidationStatus(getSessionSnapshot().sessionEpoch, 'verified')
    })
    rerender()
    mockUpload(Promise.resolve(uploadResult))

    act(() => {
      expect(result.current.uploadFiles([new File(['{}'], 'example.json')])).toBe(true)
    })

    await waitFor(() => expect(result.current.result?.outcome).toBe('success'))
    expect(result.current.result?.confirmedFilenames).toEqual(['example.json'])
    expect(uploadCalls()).toHaveLength(2)
    expect(uploadCalls().every(([, options]) => options?.method === 'POST')).toBe(true)
    expect(uploadCalls()[1][1]?.scope?.sessionEpoch).toBe(getSessionSnapshot().sessionEpoch)
  })

  it('cancel stops waiting without claiming rollback and ignores later completion', async () => {
    let resolveUpload!: (value: unknown) => void
    const pending = new Promise(resolve => {
      resolveUpload = resolve
    })
    mockUpload(pending)

    const { result } = renderHook(useImportFlow)
    act(() => {
      expect(result.current.uploadFiles([new File(['{}'], 'example.json')])).toBe(true)
    })
    await waitFor(() => expect(uploadCalls()).toHaveLength(1))
    expect(result.current.busy).toBe(true)
    const signal = uploadCalls()[0][1]?.signal
    expect(signal?.aborted).toBe(false)

    act(() => {
      expect(result.current.cancel()).toBe(true)
    })
    expect(signal?.aborted).toBe(true)

    await act(async () => {
      resolveUpload(uploadResult)
      await pending
    })

    expect(result.current.result).toBeNull()
    expect(result.current.busy).toBe(false)
    expect(result.current.message).toContain('不会撤销')
    expect(uploadCalls()).toHaveLength(1)
  })

  it('404 expires email tracking without replaying import', async () => {
    const inventedJobId = '0123456789abcdef0123456789abcdef'
    const emailPath = `creds/email-enrichment/${inventedJobId}`
    vi.mocked(requestJson).mockImplementation(path => {
      if (path === 'creds/status') {
        return Promise.resolve({ panel_capabilities: ['antigravity.oauth.safe_response'] })
      }
      if (path === 'auth/callback') {
        return Promise.resolve({
          success: true,
          mode: 'antigravity',
          filename: 'example.json',
          project_id: null,
          subscription_tier: null,
          auto_detected_project: false,
          email_enrichment: { job_id: inventedJobId },
        })
      }
      if (path === emailPath) return Promise.reject(new ApiError(404, {}))
      return Promise.reject(new Error(`Unexpected request: ${path}`))
    })

    const { result } = renderHook(useImportFlow)
    act(() => {
      expect(result.current.completeOAuth(null, '')).toBe(true)
    })

    await waitFor(() => expect(result.current.emailMessage).toContain('已过期'))
    expect(result.current.emailJobs).toEqual([
      expect.objectContaining({ jobId: inventedJobId, status: 'expired', snapshot: null }),
    ])
    expect(result.current.result?.outcome).toBe('success')
    expect(result.current.busy).toBe(false)
    const postCalls = vi.mocked(requestJson).mock.calls.filter(([, options]) => options?.method === 'POST')
    expect(postCalls).toHaveLength(1)
    expect(postCalls[0][0]).toBe('auth/callback')
    expect(vi.mocked(requestJson).mock.calls.filter(([path]) => path === emailPath)).toHaveLength(1)
    act(() => {
      expect(result.current.resumeEmailJob(inventedJobId)).toBe(false)
    })
    expect(vi.mocked(requestJson).mock.calls).toHaveLength(3)
  })
})
