import '@/app/test-setup'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getSessionSnapshot,
  getSessionValidationSnapshot,
  setSessionToken,
  __setSessionValidationStatus,
} from '@/auth/session'
import {
  getPanelChannelSnapshot,
  __commitPanelChannel,
} from '@/domain/panel'
import {
  getImportFlowSnapshot,
  subscribeImportFlow,
  type ImportFlowOwner,
} from './flowStore'
import {
  cancelWorkflowOperation,
  clearFinishedWorkflowEmailJobs,
  completeWorkflowOAuth,
  getImportWorkflowSnapshot,
  importWorkflowTokens,
  resumeWorkflowEmailJob,
  startWorkflowOAuth,
  stopWorkflowEmailJob,
  subscribeImportWorkflow,
  uploadWorkflowFiles,
  type ImportWorkflowSnapshot,
} from './workflowRunner'
import type { TokenInput } from './types'

let fetchMock = vi.fn<typeof fetch>()

type RouteHandler = (url: URL, init?: RequestInit) => Promise<Response> | Response | undefined
let routeHandlers: RouteHandler[] = []

function addRoute(handler: RouteHandler): () => void {
  routeHandlers.push(handler)
  return () => {
    routeHandlers = routeHandlers.filter(h => h !== handler)
  }
}

function clearRoutes(): void {
  routeHandlers = []
}

function onPost(
  pathname: string,
  handler: (url: URL, init?: RequestInit) => Promise<Response> | Response,
): () => void {
  return addRoute((url, init) => {
    const method = (init?.method || 'GET').toUpperCase()
    if (method === 'POST' && (url.pathname === pathname || url.pathname.endsWith('/' + pathname) || url.pathname.endsWith(pathname))) {
      return handler(url, init)
    }
    return undefined
  })
}

function onGet(
  pathnameSubstring: string,
  handler: (url: URL, init?: RequestInit) => Promise<Response> | Response,
): () => void {
  return addRoute((url, init) => {
    const method = (init?.method || 'GET').toUpperCase()
    if (method === 'GET' && url.pathname.includes(pathnameSubstring)) {
      return handler(url, init)
    }
    return undefined
  })
}

function getPostCalls(): Array<Parameters<typeof fetch>> {
  return fetchMock.mock.calls.filter(([_, init]) => (init?.method || 'GET').toUpperCase() === 'POST')
}

function getEmailGetCalls(): Array<Parameters<typeof fetch>> {
  return fetchMock.mock.calls.filter(([url, init]) => {
    const method = (init?.method || 'GET').toUpperCase()
    return method === 'GET' && String(url).includes('email-enrichment')
  })
}

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

async function waitForCondition(
  predicate: (snap: ImportWorkflowSnapshot) => boolean,
  maxIterations = 50,
): Promise<ImportWorkflowSnapshot> {
  let snap = getImportWorkflowSnapshot()
  if (predicate(snap)) return snap

  for (let i = 0; i < maxIterations; i++) {
    let unsub: (() => void) | undefined
    try {
      await new Promise<void>(resolve => {
        let done = false
        const finish = () => {
          if (done) return
          done = true
          resolve()
        }
        unsub = subscribeImportWorkflow(() => {
          if (predicate(getImportWorkflowSnapshot())) {
            finish()
          }
        })
        if (typeof setImmediate === 'function') {
          setImmediate(finish)
        }
        setTimeout(finish, 0)
        Promise.resolve().then(() => {
          if (predicate(getImportWorkflowSnapshot())) {
            finish()
          }
        })
      })
    } finally {
      if (unsub) {
        unsub()
        unsub = undefined
      }
    }
    snap = getImportWorkflowSnapshot()
    if (predicate(snap)) return snap
  }
  throw new Error(`Timeout waiting for condition. Last snapshot: busy=${snap.busy}, op=${snap.operation}, msg=${snap.message}`)
}

function loginAndVerify(
  token = 'synthetic-test-token',
  mode: 'antigravity' | 'geminicli' = 'antigravity',
): ImportFlowOwner {
  if (getPanelChannelSnapshot().mode !== mode) {
    __commitPanelChannel(mode)
  }
  setSessionToken(token)
  const session = getSessionSnapshot()
  __setSessionValidationStatus(session.sessionEpoch, 'verified')
  const snap = getImportFlowSnapshot()
  if (!snap.owner) {
    throw new Error('Failed to verify owner in test setup')
  }
  return snap.owner
}

beforeEach(() => {
  document.head.innerHTML = '<meta name="gcli-service-base" content="/">'
  window.localStorage.clear()
  vi.stubEnv('VITE_UI_FIXTURES', 'false')
  clearRoutes()
  fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input), 'http://localhost')
    for (let i = routeHandlers.length - 1; i >= 0; i--) {
      const res = await routeHandlers[i](url, init)
      if (res !== undefined) return res
    }
    throw new Error(`Unexpected fetch call: [${init?.method || 'GET'}] ${url.pathname}${url.search}`)
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  // Teardown owner and work before returning fake timers to real; release view/test subscribers
  setSessionToken(null)
  if (getPanelChannelSnapshot().mode !== 'antigravity') {
    __commitPanelChannel('antigravity')
  }
  clearRoutes()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('workflowRunner suite', () => {
  describe('1. Real Core/session/store/API transport, subscription, safe results & receipts', () => {
    it('provides reference-stable snapshot identity with exact owner and validation references', () => {
      const owner = loginAndVerify('synthetic-token-1', 'antigravity')
      const snap1 = getImportWorkflowSnapshot()
      const snap2 = getImportWorkflowSnapshot()

      expect(snap1).toBe(snap2)
      expect(snap1.owner).toBe(owner)
      expect(snap1.validation).toBe(getSessionValidationSnapshot())
      expect(snap1.busy).toBe(false)
      expect(snap1.operation).toBeNull()
      expect(snap1.result).toBeNull()
      expect(snap1.prompt).toBeNull()
      expect(snap1.authUrl).toBe('')
      expect(snap1.message).toBe('')
      expect(snap1.emailJobs).toEqual([])
      expect(snap1.emailWarning).toBe('')
      expect(Object.isFrozen(snap1)).toBe(true)
      expect(Object.isFrozen(snap1.emailJobs)).toBe(true)
    })

    it('survives view subscribe/unsubscribe during in-flight upload with exact one POST', async () => {
      const owner = loginAndVerify('synthetic-token-2', 'antigravity')
      let resolveFetch!: (res: Response) => void
      const pendingFetch = new Promise<Response>(resolve => {
        resolveFetch = resolve
      })
      onPost('creds/upload', () => pendingFetch)

      const file = new File(['{"invented": true}'], 'upload-test.json', { type: 'application/json' })

      let notifyCount = 0
      const unsub = subscribeImportWorkflow(() => {
        notifyCount++
      })

      const admitted = uploadWorkflowFiles(owner, [file])
      expect(admitted).toBe(true)
      expect(notifyCount).toBe(1)

      const busySnap = getImportWorkflowSnapshot()
      expect(busySnap.busy).toBe(true)
      expect(busySnap.operation).toBe('files')

      // View unmounts / unsubscribes
      unsub()

      // Resolve the HTTP POST
      resolveFetch(
        jsonResponse({
          results: [{ filename: 'upload-test.json', status: 'success' }],
        }),
      )

      const settledSnap = await waitForCondition(s => !s.busy && s.result !== null)
      expect(settledSnap.busy).toBe(false)
      expect(settledSnap.operation).toBeNull()
      expect(settledSnap.result?.outcome).toBe('success')
      expect(settledSnap.result?.items[0].label).toBe('upload-test.json')
      expect(settledSnap.result?.items[0].status).toBe('success')

      expect(getPostCalls().length).toBe(1)
      const [url, init] = getPostCalls()[0]
      const parsedUrl = new URL(String(url), 'http://localhost')
      expect(parsedUrl.pathname).toBe('/creds/upload')
      expect(parsedUrl.searchParams.get('mode')).toBe('antigravity')
      expect(init?.method).toBe('POST')
    })

    it('handles startOAuth, safe_response completeOAuth, and cleans up registry tasks', async () => {
      const owner = loginAndVerify('synthetic-token-3', 'antigravity')

      // 1. startOAuth
      onPost('auth/start', () =>
        jsonResponse({
          auth_url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=invented-client',
        }),
      )

      const startAdmitted = startWorkflowOAuth(owner, 'invented-project-id')
      expect(startAdmitted).toBe(true)
      expect(getImportFlowSnapshot().records.length).toBe(1)

      const startSnap = await waitForCondition(s => !s.busy && s.authUrl !== '')
      expect(startSnap.busy).toBe(false)
      expect(startSnap.authUrl).toBe(
        'https://accounts.google.com/o/oauth2/v2/auth?client_id=invented-client',
      )
      expect(getImportFlowSnapshot().records.length).toBe(0)
      expect(getPostCalls().length).toBe(1)

      // 2. completeOAuth with safe_response capability check + callback
      onGet('creds/status', () =>
        jsonResponse({
          panel_capabilities: ['antigravity.oauth.safe_response'],
        }),
      )
      onPost('auth/callback', () =>
        jsonResponse({
          success: true,
          mode: 'antigravity',
          filename: 'oauth-receipt.json',
          auto_detected_project: false,
          project_id: 'invented-project-id',
          subscription_tier: 'tier-standard',
          warnings: [],
        }),
      )

      const completeAdmitted = completeWorkflowOAuth(owner, null, 'invented-project-id')
      expect(completeAdmitted).toBe(true)
      expect(getImportFlowSnapshot().records.length).toBe(1)

      const completeSnap = await waitForCondition(s => !s.busy && s.result !== null)
      expect(completeSnap.busy).toBe(false)
      expect(completeSnap.authUrl).toBe('') // consumed
      expect(completeSnap.result?.outcome).toBe('success')
      expect(completeSnap.result?.oauthReceipt?.filename).toBe('oauth-receipt.json')
      expect(completeSnap.result?.oauthReceipt?.project_id).toBe('invented-project-id')
      expect(completeSnap.result?.oauthReceipt?.subscription_tier).toBe('tier-standard')
      expect(getImportFlowSnapshot().records.length).toBe(0)
      expect(getPostCalls().length).toBe(2)
    })

    it('handles HTTP 400 project prompt without clearing available authUrl', async () => {
      const owner = loginAndVerify('synthetic-token-4', 'antigravity')

      // Established authUrl
      onPost('auth/start', () =>
        jsonResponse({
          auth_url: 'https://accounts.google.com/o/oauth2/auth?client_id=test',
        }),
      )
      const startAdmitted = startWorkflowOAuth(owner, '')
      expect(startAdmitted).toBe(true)
      const startSnap = await waitForCondition(s => !s.busy && s.authUrl !== '')
      expect(startSnap.authUrl).toBe('https://accounts.google.com/o/oauth2/auth?client_id=test')

      // completeOAuth yields 400 requires_manual_project_id
      onGet('creds/status', () =>
        jsonResponse({
          panel_capabilities: ['antigravity.oauth.safe_response'],
        }),
      )
      onPost('auth/callback', () =>
        jsonResponse(
          {
            requires_manual_project_id: true,
            available_projects: [{ project_id: 'proj-discovered-1', name: 'Discovered Project' }],
          },
          400,
        ),
      )

      const completeAdmitted = completeWorkflowOAuth(owner, null, '')
      expect(completeAdmitted).toBe(true)

      const promptSnap = await waitForCondition(s => !s.busy && s.prompt !== null)
      expect(promptSnap.busy).toBe(false)
      expect(promptSnap.prompt).not.toBeNull()
      expect(promptSnap.prompt?.manual).toBe(true)
      expect(promptSnap.prompt?.projects).toEqual(['proj-discovered-1'])
      expect(promptSnap.prompt?.projectOptions?.[0].projectId).toBe('proj-discovered-1')
      expect(promptSnap.result).toBeNull()
      // authUrl remains available until completion/cancel/owner loss
      expect(promptSnap.authUrl).toBe('https://accounts.google.com/o/oauth2/auth?client_id=test')
      expect(promptSnap.message).toBe('请选择或输入关联项目。')
      expect(getPostCalls().length).toBe(2)
    })

    it('handles HTTP 400 partial import results via normalizeResult', async () => {
      const owner = loginAndVerify('synthetic-token-5', 'antigravity')

      onPost('creds/upload', () =>
        jsonResponse(
          {
            results: [
              { filename: 'good.json', status: 'success' },
              { filename: 'bad.json', status: 'error' },
            ],
          },
          400,
        ),
      )

      const file = new File(['{}'], 'batch.json', { type: 'application/json' })
      const admitted = uploadWorkflowFiles(owner, [file])
      expect(admitted).toBe(true)

      const partialSnap = await waitForCondition(s => !s.busy && s.result !== null)
      expect(partialSnap.busy).toBe(false)
      expect(partialSnap.result?.outcome).toBe('partial')
      expect(partialSnap.result?.items.length).toBe(2)
      expect(partialSnap.prompt).toBeNull()
      expect(partialSnap.message).toContain('服务器拒绝了本次请求')
      expect(getPostCalls().length).toBe(1)
    })

    it('supports fixture mode with zero network transport', async () => {
      vi.stubEnv('VITE_UI_FIXTURES', 'true')
      const owner = loginAndVerify('synthetic-token-6', 'antigravity')

      const file = new File(['{}'], 'fixture.json', { type: 'application/json' })
      const admitted = uploadWorkflowFiles(owner, [file])
      expect(admitted).toBe(true)

      const snap = await waitForCondition(s => !s.busy && s.result !== null)
      expect(snap.busy).toBe(false)
      expect(snap.result).not.toBeNull()
      expect(fetchMock).toHaveBeenCalledTimes(0)
    })
  })

  describe('2. Validation loss/restoration, channel ABA, relogin & reentry protection', () => {
    it('clears state on validation unavailable and restores fresh owner without reviving old work', async () => {
      const owner1 = loginAndVerify('synthetic-token-7', 'antigravity')
      let resolveUpload!: (res: Response) => void
      const pendingUpload = new Promise<Response>(resolve => {
        resolveUpload = resolve
      })
      onPost('creds/upload', () => pendingUpload)

      const file = new File(['{}'], 'lost-owner.json', { type: 'application/json' })
      const admitted = uploadWorkflowFiles(owner1, [file])
      expect(admitted).toBe(true)
      expect(getImportWorkflowSnapshot().busy).toBe(true)

      // Validation becomes unavailable
      const sessionEpoch = getSessionSnapshot().sessionEpoch
      __setSessionValidationStatus(sessionEpoch, 'unavailable')

      // Snapshot immediately shows invalid-owner domain
      const invalidSnap = getImportWorkflowSnapshot()
      expect(invalidSnap.owner).toBeNull()
      expect(invalidSnap.validation).toBeNull()
      expect(invalidSnap.busy).toBe(false)
      expect(invalidSnap.result).toBeNull()

      // Late network resolution
      resolveUpload(
        jsonResponse({
          results: [{ filename: 'lost-owner.json', status: 'success' }],
        }),
      )
      await Promise.resolve()
      await Promise.resolve()

      // Late resolution must not resurrect old result
      expect(getImportWorkflowSnapshot().result).toBeNull()

      // Validation restored: fresh owner can start cleanly
      __setSessionValidationStatus(sessionEpoch, 'verified')
      const owner2 = getImportFlowSnapshot().owner!
      expect(owner2).not.toBeNull()
      expect(owner2).not.toBe(owner1)

      const restoredSnap = getImportWorkflowSnapshot()
      expect(restoredSnap.owner).toBe(owner2)
      expect(restoredSnap.result).toBeNull()
      expect(restoredSnap.busy).toBe(false)
      expect(getPostCalls().length).toBe(1)
    })

    it('rejects commands with stale owner after channel ABA and relogin', async () => {
      const ownerA = loginAndVerify('synthetic-token-8', 'antigravity')

      // Channel ABA: antigravity -> geminicli -> antigravity
      __commitPanelChannel('geminicli')
      __commitPanelChannel('antigravity')

      const file = new File(['{}'], 'stale.json', { type: 'application/json' })
      const admittedOldOwner = uploadWorkflowFiles(ownerA, [file])
      expect(admittedOldOwner).toBe(false)

      // Relogin: logout then login
      setSessionToken(null)
      const ownerB = loginAndVerify('synthetic-token-9', 'antigravity')

      expect(uploadWorkflowFiles(ownerA, [file])).toBe(false)

      onPost('creds/upload', () =>
        jsonResponse({ results: [{ filename: 'stale.json', status: 'success' }] }),
      )
      const admittedB = uploadWorkflowFiles(ownerB, [file])
      expect(admittedB).toBe(true)

      const settled = await waitForCondition(s => !s.busy && s.result !== null)
      expect(settled.result?.outcome).toBe('success')
      expect(getPostCalls().length).toBe(1)
    })

    it('handles cancellation and ignores late abort responses', async () => {
      const owner = loginAndVerify('synthetic-token-10', 'antigravity')
      let rejectUpload!: (err: unknown) => void
      const pendingUpload = new Promise<Response>((_, reject) => {
        rejectUpload = reject
      })
      onPost('creds/upload', () => pendingUpload)

      const file = new File(['{}'], 'cancel.json', { type: 'application/json' })
      const admitted = uploadWorkflowFiles(owner, [file])
      expect(admitted).toBe(true)
      expect(getImportWorkflowSnapshot().busy).toBe(true)

      const cancelAdmitted = cancelWorkflowOperation(owner)
      expect(cancelAdmitted).toBe(true)

      const cancelledSnap = getImportWorkflowSnapshot()
      expect(cancelledSnap.busy).toBe(false)
      expect(cancelledSnap.message).toBe('已停止等待。服务器可能已保存凭证；此操作不会撤销导入。请到凭证页确认。')

      // Late abort rejection from transport
      rejectUpload(new DOMException('The user aborted a request.', 'AbortError'))
      await Promise.resolve()
      await Promise.resolve()

      const postLateSnap = getImportWorkflowSnapshot()
      expect(postLateSnap.busy).toBe(false)
      expect(postLateSnap.message).toBe('已停止等待。服务器可能已保存凭证；此操作不会撤销导入。请到凭证页确认。')
      expect(getPostCalls().length).toBe(1)
    })

    it('rejects reentrant admission triggered by synchronous subscribeImportFlow notification and handles cancel+replacement', async () => {
      const owner = loginAndVerify('synthetic-token-reentrant', 'antigravity')

      onPost('auth/start', () =>
        jsonResponse({
          auth_url: 'https://accounts.google.com/o/oauth2/auth?client_id=reentrant-test',
        }),
      )
      onGet('creds/status', () =>
        jsonResponse({
          panel_capabilities: ['antigravity.oauth.safe_response'],
        }),
      )
      onPost('auth/callback', () =>
        jsonResponse({
          success: true,
          mode: 'antigravity',
          filename: 'oauth-receipt.json',
          auto_detected_project: false,
          project_id: 'reentrant-complete-project',
          subscription_tier: 'tier-standard',
          warnings: [],
        }),
      )
      onPost('creds/upload', () =>
        jsonResponse({
          results: [{ filename: 'replacement.json', status: 'success' }],
        }),
      )

      // 1. Direct second-admission rejection
      let reentrantCallCount = 0
      let secondAdmitted = true
      const unsubReentrant = subscribeImportFlow(() => {
        reentrantCallCount++
        if (reentrantCallCount === 1) {
          secondAdmitted = startWorkflowOAuth(owner, 'second-reentrant-attempt')
        }
      })

      try {
        const firstAdmitted = startWorkflowOAuth(owner, 'initial-project')
        expect(firstAdmitted).toBe(true)
        expect(secondAdmitted).toBe(false)
      } finally {
        unsubReentrant()
      }

      const settledFirst = await waitForCondition(s => !s.busy && s.authUrl !== '')
      expect(settledFirst.authUrl).toContain('accounts.google.com')

      // 2. cancel+same-owner replacement from synchronous callback for startWorkflowOAuth
      const replFile = new File(['{}'], 'replacement.json', { type: 'application/json' })
      let cancelReplaceStartTriggered = false
      const unsubCancelStart = subscribeImportFlow(() => {
        if (!cancelReplaceStartTriggered) {
          cancelReplaceStartTriggered = true
          cancelWorkflowOperation(owner)
          uploadWorkflowFiles(owner, [replFile])
        }
      })

      try {
        const staleStartAdmitted = startWorkflowOAuth(owner, 'superseded-start-project')
        expect(staleStartAdmitted).toBe(false)
      } finally {
        unsubCancelStart()
      }

      // Prove stale outer OAuth had zero transport, replacement mutation owns state and completes
      const replStartSnap = await waitForCondition(s => !s.busy && s.result?.items[0]?.label === 'replacement.json')
      expect(replStartSnap.result?.outcome).toBe('success')
      const authStartCalls = getPostCalls().filter(([u]) => String(u).includes('auth/start'))
      expect(authStartCalls.length).toBe(1) // only initial-project call

      // Later explicit startWorkflowOAuth is usable
      const explicitStartAdmitted = startWorkflowOAuth(owner, 'later-usable-start-project')
      expect(explicitStartAdmitted).toBe(true)
      const explicitStartSnap = await waitForCondition(s => !s.busy && s.authUrl !== '')
      expect(explicitStartSnap.authUrl).toContain('accounts.google.com')

      // 3. cancel+same-owner replacement from synchronous callback for completeWorkflowOAuth
      let cancelReplaceCompleteTriggered = false
      const unsubCancelComplete = subscribeImportFlow(() => {
        if (!cancelReplaceCompleteTriggered) {
          cancelReplaceCompleteTriggered = true
          cancelWorkflowOperation(owner)
          uploadWorkflowFiles(owner, [replFile])
        }
      })

      try {
        const staleCompleteAdmitted = completeWorkflowOAuth(owner, null, 'superseded-complete-project')
        expect(staleCompleteAdmitted).toBe(false)
      } finally {
        unsubCancelComplete()
      }

      // Prove stale outer complete OAuth had zero transport, replacement owns state and completes
      const replCompleteSnap = await waitForCondition(s => !s.busy && s.result?.items[0]?.label === 'replacement.json')
      expect(replCompleteSnap.result?.outcome).toBe('success')
      const authCallbackCalls = getPostCalls().filter(([u]) => String(u).includes('auth/callback'))
      expect(authCallbackCalls.length).toBe(0)

      // Later explicit completeWorkflowOAuth is usable
      const explicitCompleteAdmitted = completeWorkflowOAuth(owner, null, 'reentrant-complete-project')
      expect(explicitCompleteAdmitted).toBe(true)
      const explicitCompleteSnap = await waitForCondition(s => !s.busy && s.result?.oauthReceipt?.filename === 'oauth-receipt.json')
      expect(explicitCompleteSnap.result?.oauthReceipt?.filename).toBe('oauth-receipt.json')
    })
  })

  describe('3. Independent AG email jobs, chunked polling, suppression & GCLI zero email', () => {
    it('tracks independent AG email jobs across successive imports', async () => {
      const owner = loginAndVerify('synthetic-token-11', 'antigravity')
      const JOB_ID_1 = '0123456789abcdef0123456789abcdef'
      const JOB_ID_2 = 'fedcba9876543210fedcba9876543210'

      onPost('creds/upload', (url) => {
        const mode = url.searchParams.get('mode')
        expect(mode).toBe('antigravity')
        if (getPostCalls().length === 1) {
          return jsonResponse({
            results: [{ filename: 'first.json', status: 'success' }],
            email_enrichment: { job_id: JOB_ID_1 },
          })
        }
        return jsonResponse({
          results: [{ filename: 'second.json', status: 'success' }],
          email_enrichment: { job_id: JOB_ID_2 },
        })
      })

      onGet('creds/email-enrichment', (url) => {
        if (url.pathname.includes(JOB_ID_1)) {
          return jsonResponse({
            job_id: JOB_ID_1,
            total: 1,
            complete: false,
            sealed: false,
            items: [{ filename: 'first.json', status: 'running' }],
          })
        }
        return jsonResponse({
          job_id: JOB_ID_2,
          total: 1,
          complete: false,
          sealed: false,
          items: [{ filename: 'second.json', status: 'running' }],
        })
      })

      const f1 = new File(['{}'], 'first.json', { type: 'application/json' })
      const admitted1 = uploadWorkflowFiles(owner, [f1])
      expect(admitted1).toBe(true)

      const snap1 = await waitForCondition(s => !s.busy && s.emailJobs.length === 1)
      expect(snap1.result?.items[0].label).toBe('first.json')
      expect(snap1.emailJobs[0].jobId).toBe(JOB_ID_1)
      expect(snap1.emailJobs[0].status).toBe('tracking')

      const f2 = new File(['{}'], 'second.json', { type: 'application/json' })
      const admitted2 = uploadWorkflowFiles(owner, [f2])
      expect(admitted2).toBe(true)

      const snap2 = await waitForCondition(s => !s.busy && s.emailJobs.length === 2)
      // Primary receipt updated to second upload
      expect(snap2.result?.items[0].label).toBe('second.json')
      // Both email jobs retained in insertion order
      expect(snap2.emailJobs.length).toBe(2)
      expect(snap2.emailJobs[0].jobId).toBe(JOB_ID_1)
      expect(snap2.emailJobs[1].jobId).toBe(JOB_ID_2)
      expect(getPostCalls().length).toBe(2)
    })

    it('measures max in-flight GET <= 4, no overlapping cycles, stops later chunk before request, stops in-flight without cancelling sibling, and preserves primary receipt', async () => {
      vi.useFakeTimers()
      const owner = loginAndVerify('synthetic-token-compact-poll', 'antigravity')
      const jobIds = [
        '10000000000000000000000000000001',
        '10000000000000000000000000000002',
        '10000000000000000000000000000003',
        '10000000000000000000000000000004',
        '10000000000000000000000000000005',
        '10000000000000000000000000000006',
      ]

      let currentInFlightGet = 0
      let maxInFlightGet = 0
      let cycle1Active = false
      let cycle1Settled = false
      let cycle1SettledAt = 0
      let overlappingCycles = false
      const requestedGetJobIds: string[] = []

      type Deferred = { resolve: (res: Response) => void; promise: Promise<Response> }
      function makeDeferred(): Deferred {
        let resolve!: (res: Response) => void
        const promise = new Promise<Response>(r => {
          resolve = r
        })
        return { resolve, promise }
      }

      const deferredJob0 = makeDeferred()
      const deferredJob1 = makeDeferred()
      let resolveJob0Started!: () => void
      let resolveJob1Started!: () => void
      const job0StartedPromise = new Promise<void>(r => { resolveJob0Started = r })
      const job1StartedPromise = new Promise<void>(r => { resolveJob1Started = r })

      onPost('creds/upload-by-refresh-token', (_url, init) => {
        const bodyStr = String(init?.body || '')
        let targetId = jobIds[0]
        for (let i = 0; i < 6; i++) {
          if (bodyStr.includes(`rt-${i}`)) targetId = jobIds[i]
        }
        return jsonResponse({
          results: [{ filename: `tok-${targetId.slice(-1)}.json`, status: 'success' }],
          email_enrichment: { job_id: targetId },
        })
      })

      onGet('creds/email-enrichment', async (url) => {
        if (!cycle1Active) {
          cycle1Active = true
        } else if (cycle1Settled) {
          const elapsed = Date.now() - cycle1SettledAt
          if (elapsed < 2000) {
            overlappingCycles = true
          }
        }

        currentInFlightGet++
        if (currentInFlightGet > maxInFlightGet) {
          maxInFlightGet = currentInFlightGet
        }

        const urlStr = url.pathname
        let res: Response
        try {
          if (urlStr.includes(jobIds[0])) {
            requestedGetJobIds.push(jobIds[0])
            resolveJob0Started()
            res = await deferredJob0.promise
          } else if (urlStr.includes(jobIds[1])) {
            requestedGetJobIds.push(jobIds[1])
            resolveJob1Started()
            res = await deferredJob1.promise
          } else {
            for (let i = 2; i < 6; i++) {
              if (urlStr.includes(jobIds[i])) {
                requestedGetJobIds.push(jobIds[i])
                res = jsonResponse({
                  job_id: jobIds[i],
                  total: 1,
                  complete: true,
                  sealed: true,
                  items: [{ filename: `tok-${i + 1}.json`, status: 'success', user_email: `user${i}@example.invalid` }],
                })
                return res
              }
            }
            res = jsonResponse({
              job_id: 'unknown',
              total: 1,
              complete: true,
              sealed: true,
              items: [],
            })
          }
          return res
        } finally {
          currentInFlightGet--
        }
      })

      // Register all 6 jobs sequentially via token imports
      for (let i = 0; i < 6; i++) {
        const tokInput: TokenInput = {
          tokens: [`rt-${i}`],
          clientId: 'cid',
          clientSecret: 'csec',
          projectId: 'pid',
          filename: `tok-${i + 1}.json`,
        }
        const admitted = importWorkflowTokens(owner, tokInput)
        expect(admitted).toBe(true)
        await waitForCondition(s => !s.busy && s.emailJobs.length === i + 1)
      }

      expect(getPostCalls().length).toBe(6)
      const primaryReceiptBeforePoll = getImportWorkflowSnapshot().result
      expect(primaryReceiptBeforePoll?.items[0].label).toBe('tok-6.json')

      // Stop job 5 (index 4, chunk 2) BEFORE chunk 2 is requested
      const stoppedJob5 = stopWorkflowEmailJob(owner, jobIds[4])
      expect(stoppedJob5).toBe(true)

      // Advance timers to trigger the polling cycle
      const timerPromise = vi.advanceTimersByTimeAsync(2000)

      // Await that BOTH in-flight peer (job 0) and sibling (job 1) have actually started
      await job0StartedPromise
      await job1StartedPromise
      expect(requestedGetJobIds).toContain(jobIds[0])
      expect(requestedGetJobIds).toContain(jobIds[1])

      // Now stop in-flight job 0 without cancelling sibling job 1
      const stoppedJob0 = stopWorkflowEmailJob(owner, jobIds[0])
      expect(stoppedJob0).toBe(true)

      // Now resolve chunk 1 in-flight requests
      deferredJob0.resolve(
        jsonResponse({
          job_id: jobIds[0],
          total: 1,
          complete: true,
          sealed: true,
          items: [{ filename: 'tok-1.json', status: 'success', user_email: 'user0@example.invalid' }],
        }),
      )
      deferredJob1.resolve(
        jsonResponse({
          job_id: jobIds[1],
          total: 1,
          complete: true,
          sealed: true,
          items: [{ filename: 'tok-2.json', status: 'success', user_email: 'user1@example.invalid' }],
        }),
      )

      await timerPromise
      await Promise.resolve()
      await Promise.resolve()

      cycle1Settled = true
      cycle1SettledAt = Date.now()

      const finalSnap = getImportWorkflowSnapshot()

      // Max in-flight GET measured <= 4
      expect(maxInFlightGet).toBeLessThanOrEqual(4)
      expect(maxInFlightGet).toBeGreaterThan(0)
      expect(overlappingCycles).toBe(false)

      // Job 0 was stopped while in-flight: generation suppressed late observation, remains stopped
      expect(finalSnap.emailJobs[0].status).toBe('stopped')
      // Sibling Job 1 completed without being cancelled by Job 0's stop
      expect(finalSnap.emailJobs[1].status).toBe('complete')
      // Jobs 2, 3 completed
      expect(finalSnap.emailJobs[2].status).toBe('complete')
      expect(finalSnap.emailJobs[3].status).toBe('complete')
      // Job 4 was stopped before chunk 2 request: never requested in GET
      expect(finalSnap.emailJobs[4].status).toBe('stopped')
      expect(requestedGetJobIds).not.toContain(jobIds[4])
      // Job 5 in chunk 2 completed
      expect(finalSnap.emailJobs[5].status).toBe('complete')

      // Primary receipt preserved
      expect(finalSnap.result?.items[0].label).toBe('tok-6.json')

      // Clean teardown before returning fake timers to real
      setSessionToken(null)
      vi.useRealTimers()
    })

    it('enforces GCLI zero email registration and zero email GET', async () => {
      const owner = loginAndVerify('synthetic-token-13', 'geminicli')
      const JOB_ID = '0123456789abcdef0123456789abcdef'

      onPost('creds/upload', () =>
        jsonResponse({
          mode: 'geminicli',
          results: [{ filename: 'gcli.json', status: 'success' }],
          email_enrichment: { job_id: JOB_ID },
        }),
      )

      const file = new File(['{}'], 'gcli.json', { type: 'application/json' })
      const admitted = uploadWorkflowFiles(owner, [file])
      expect(admitted).toBe(true)

      const snap = await waitForCondition(s => !s.busy && s.result !== null)
      // Positive primary receipt verified first
      expect(snap.result?.outcome).toBe('success')
      expect(snap.result?.items[0].label).toBe('gcli.json')
      expect(snap.result?.items[0].status).toBe('success')

      // Negative assertions: zero email jobs registered and zero GET calls
      expect(snap.emailJobs).toEqual([])
      expect(getEmailGetCalls().length).toBe(0)
      expect(getPostCalls().length).toBe(1)
    })
  })

  describe('4. Genuine ID, dedup, 128 cap, capacity warning, clear-finished & canary isolation', () => {
    it('rejects invalid job IDs and deduplicates identical job IDs without silent auto-resume', async () => {
      const owner = loginAndVerify('synthetic-token-14', 'antigravity')

      // Malformed job ID
      onPost('creds/upload', () => {
        if (getPostCalls().length === 1) {
          return jsonResponse({
            results: [{ filename: 'bad-id.json', status: 'success' }],
            email_enrichment: { job_id: 'not-32-hex-job-id' },
          })
        }
        return jsonResponse({
          results: [{ filename: 'valid.json', status: 'success' }],
          email_enrichment: { job_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        })
      })

      const f1 = new File(['{}'], 'bad-id.json', { type: 'application/json' })
      const admitted1 = uploadWorkflowFiles(owner, [f1])
      expect(admitted1).toBe(true)
      const snap1 = await waitForCondition(s => !s.busy && s.result !== null)
      expect(snap1.emailJobs.length).toBe(0)

      // Valid job ID
      const VALID_JOB = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      const admitted2 = uploadWorkflowFiles(owner, [f1])
      expect(admitted2).toBe(true)
      const snap2 = await waitForCondition(s => !s.busy && s.emailJobs.length === 1)
      expect(snap2.emailJobs.length).toBe(1)

      // Stop the job
      const stopped = stopWorkflowEmailJob(owner, VALID_JOB)
      expect(stopped).toBe(true)
      expect(getImportWorkflowSnapshot().emailJobs[0].status).toBe('stopped')

      // Third import with identical job ID must deduplicate and NOT silently resume it
      const admitted3 = uploadWorkflowFiles(owner, [f1])
      expect(admitted3).toBe(true)
      const dupSnap = await waitForCondition(s => !s.busy && s.result !== null)
      expect(dupSnap.emailJobs.length).toBe(1)
      expect(dupSnap.emailJobs[0].status).toBe('stopped')
      expect(getPostCalls().length).toBe(3)
    })

    it('enforces 128 retained cap, retains latest result, warns, and clears finished to free capacity', async () => {
      vi.useFakeTimers()
      const owner = loginAndVerify('synthetic-token-15', 'antigravity')

      let job0Complete = false

      onPost('creds/upload-by-refresh-token', (_url, init) => {
        const bodyStr = String(init?.body || '')
        const match = bodyStr.match(/rt-(\d+)/)
        const idx = match ? Number(match[1]) : 0
        const hex = idx.toString(16).padStart(32, '0')
        return jsonResponse({
          results: [{ filename: `job-${idx}.json`, status: 'success' }],
          email_enrichment: { job_id: hex },
        })
      })

      onGet('creds/email-enrichment', (url) => {
        const match = url.pathname.match(/([0-9a-f]{32})/i)
        const matchedJobId = match ? match[1] : '0'.repeat(32)
        const isJob0 = matchedJobId === '0'.repeat(32)

        return jsonResponse({
          job_id: matchedJobId,
          total: 1,
          complete: isJob0 && job0Complete,
          sealed: isJob0 && job0Complete,
          items: [
            {
              filename: isJob0 ? 'job-0.json' : `job-${matchedJobId.slice(-1)}.json`,
              status: isJob0 && job0Complete ? 'success' : 'running',
            },
          ],
        })
      })

      // Fill exactly 128 jobs, asserting all 128 admissions and completed receipts
      for (let i = 0; i < 128; i++) {
        const tokInput: TokenInput = {
          tokens: [`rt-${i}`],
          clientId: 'cid',
          clientSecret: 'csec',
          projectId: 'pid',
          filename: `job-${i}.json`,
        }
        const admitted = importWorkflowTokens(owner, tokInput)
        expect(admitted).toBe(true)
        await waitForCondition(s => !s.busy && s.emailJobs.length === i + 1)
      }

      let snap = getImportWorkflowSnapshot()
      expect(snap.emailJobs.length).toBe(128)
      expect(snap.emailWarning).toBe('')
      expect(getPostCalls().length).toBe(128)

      // 129th job attempt
      const tokInput129: TokenInput = {
        tokens: ['rt-128'],
        clientId: 'cid',
        clientSecret: 'csec',
        projectId: 'pid',
        filename: 'job-128.json',
      }
      const admitted129 = importWorkflowTokens(owner, tokInput129)
      expect(admitted129).toBe(true)

      snap = await waitForCondition(s => !s.busy && s.emailWarning !== '')
      expect(snap.emailJobs.length).toBe(128) // no eviction, cap retained
      expect(snap.result?.items[0].label).toBe('job-128.json') // latest receipt retained
      expect(snap.emailWarning).toContain('已达上限')
      expect(getPostCalls().length).toBe(129)

      // When no job is complete or expired, clearFinished returns false
      expect(clearFinishedWorkflowEmailJobs(owner)).toBe(false)

      // Stop job 0, stage job 0 completed, and resume
      const firstJobId = '0'.repeat(32)
      job0Complete = true
      stopWorkflowEmailJob(owner, firstJobId)
      const resumeAdmitted = resumeWorkflowEmailJob(owner, firstJobId)
      expect(resumeAdmitted).toBe(true)

      // Deliberately advance fake timers to trigger the polling cycle
      await vi.advanceTimersByTimeAsync(2000)

      await waitForCondition(s => s.emailJobs.find(j => j.jobId === firstJobId)?.status === 'complete')

      // Explicit clear removes complete/expired only, freeing capacity
      const cleared = clearFinishedWorkflowEmailJobs(owner)
      expect(cleared).toBe(true)
      const afterClearSnap = getImportWorkflowSnapshot()
      expect(afterClearSnap.emailJobs.length).toBe(127)
      expect(afterClearSnap.emailWarning).toBe('')

      setSessionToken(null)
      vi.useRealTimers()
    })

    it('guarantees secret and arbitrary payload canaries are absent from public snapshot', async () => {
      const owner = loginAndVerify('synthetic-token-16', 'antigravity')

      const CANARY_SECRET_1 = 'CANARY_SECRET_LEAK_TOKEN_12345'
      const CANARY_SECRET_2 = 'CANARY_PAYLOAD_LEAK_JUNK_67890'

      onPost('creds/upload-by-refresh-token', () =>
        jsonResponse({
          results: [
            {
              filename: 'safe-item.json',
              status: 'success',
              extra_canary: CANARY_SECRET_2,
            },
          ],
          super_secret_payload: CANARY_SECRET_1,
        }),
      )

      const input: TokenInput = {
        tokens: [CANARY_SECRET_1],
        clientId: 'cid-safe',
        clientSecret: 'csec-safe',
        projectId: 'pid-safe',
        filename: 'safe-item.json',
      }

      const admitted = importWorkflowTokens(owner, input)
      expect(admitted).toBe(true)

      const snap = await waitForCondition(s => !s.busy && s.result !== null)

      // Settled positive primary receipt verified first
      expect(snap.result?.outcome).toBe('success')
      expect(snap.result?.items[0].label).toBe('safe-item.json')

      // Assert canary absence
      const serialized = JSON.stringify(snap)
      expect(serialized).not.toContain(CANARY_SECRET_1)
      expect(serialized).not.toContain(CANARY_SECRET_2)
      expect(getPostCalls().length).toBe(1)
    })

    it('retains valid AG job ID on HTTP 400 zero-success receipt and tracks independently of successful rows', async () => {
      const owner = loginAndVerify('synthetic-token-http400-valid', 'antigravity')
      const JOB_ID_400 = 'cccccccccccccccccccccccccccccccc'

      onPost('creds/upload', () =>
        jsonResponse(
          {
            mode: 'antigravity',
            results: [{ filename: 'failed-item.json', status: 'failed' }],
            email_enrichment: { job_id: JOB_ID_400 },
          },
          400,
        ),
      )

      onGet('creds/email-enrichment', (url) => {
        if (url.pathname.includes(JOB_ID_400)) {
          return jsonResponse({
            job_id: JOB_ID_400,
            total: 1,
            complete: false,
            sealed: false,
            items: [{ filename: 'failed-item.json', status: 'running' }],
          })
        }
        return jsonResponse({}, 404)
      })

      const file = new File(['{}'], 'failed-item.json', { type: 'application/json' })
      const admitted = uploadWorkflowFiles(owner, [file])
      expect(admitted).toBe(true)

      const snap = await waitForCondition(s => !s.busy && s.result !== null)
      expect(snap.result?.outcome).toBe('failed')
      expect(snap.result?.items[0].status).toBe('failed')
      expect(snap.emailJobs.length).toBe(1)
      expect(snap.emailJobs[0].jobId).toBe(JOB_ID_400)
      expect(snap.emailJobs[0].status).toBe('tracking')
      expect(getPostCalls().length).toBe(1)
    })
  })

  describe('5. Lifecycle regression: old owner sleep & in-flight ignored-abort vs new owner polling', () => {
    it('allows new owner to immediately poll while old owner was sleeping and late old completion cannot clobber', async () => {
      vi.useFakeTimers()

      // Case 1: Old owner settled-incomplete observation, enters cancellable sleep, ownerloss cancels sleep timer, new owner starts
      const owner1 = loginAndVerify('synthetic-token-owner1', 'antigravity')
      const JOB_ID_SLEEP = '11111111111111111111111111111111'
      const JOB_ID_NEW1 = '22222222222222222222222222222222'

      onPost('creds/upload', () => {
        if (getPostCalls().length === 1) {
          return jsonResponse({
            results: [{ filename: 'sleep1.json', status: 'success' }],
            email_enrichment: { job_id: JOB_ID_SLEEP },
          })
        }
        return jsonResponse({
          results: [{ filename: 'new1.json', status: 'success' }],
          email_enrichment: { job_id: JOB_ID_NEW1 },
        })
      })

      onGet('creds/email-enrichment', (url) => {
        if (url.pathname.includes(JOB_ID_SLEEP)) {
          return jsonResponse({
            job_id: JOB_ID_SLEEP,
            total: 1,
            complete: false,
            sealed: false,
            items: [{ filename: 'sleep1.json', status: 'running' }],
          })
        }
        if (url.pathname.includes(JOB_ID_NEW1)) {
          return jsonResponse({
            job_id: JOB_ID_NEW1,
            total: 1,
            complete: true,
            sealed: true,
            items: [{ filename: 'new1.json', status: 'success', user_email: 'new1@example.invalid' }],
          })
        }
        return jsonResponse({}, 404)
      })

      // Owner 1 imports file
      const f1 = new File(['{}'], 'sleep1.json', { type: 'application/json' })
      expect(uploadWorkflowFiles(owner1, [f1])).toBe(true)
      await waitForCondition(s => !s.busy && s.emailJobs.length === 1)

      // Advance timers to complete cycle 1: observation settles incomplete, enters 2000ms sleep
      await vi.advanceTimersByTimeAsync(2000)
      const snapSleep = getImportWorkflowSnapshot()
      expect(snapSleep.emailJobs[0].status).toBe('tracking')

      // Owner 1 loses session WHILE actively sleeping; verify sleep timer cancelled & state cleared
      setSessionToken(null)
      const clearedSnap = getImportWorkflowSnapshot()
      expect(clearedSnap.owner).toBeNull()
      expect(clearedSnap.emailJobs).toEqual([])

      // Owner 2 logs in immediately
      const owner2 = loginAndVerify('synthetic-token-owner2', 'antigravity')
      const f2 = new File(['{}'], 'new1.json', { type: 'application/json' })
      expect(uploadWorkflowFiles(owner2, [f2])).toBe(true)
      await waitForCondition(s => !s.busy && s.emailJobs.length === 1)
      expect(getImportWorkflowSnapshot().emailJobs[0].jobId).toBe(JOB_ID_NEW1)

      // Owner 2 polling completes cleanly
      await vi.advanceTimersByTimeAsync(2000)
      const owner2Final = await waitForCondition(s => s.emailJobs[0]?.status === 'complete')
      expect(owner2Final.owner).toBe(owner2)
      expect(owner2Final.emailJobs[0].jobId).toBe(JOB_ID_NEW1)
      expect(owner2Final.emailJobs[0].status).toBe('complete')

      // Teardown owner2 before case 2
      setSessionToken(null)

      // Case 2: In-flight ignored-abort response vs new owner polling
      const owner3 = loginAndVerify('synthetic-token-owner3', 'antigravity')
      const JOB_ID_OLD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1'
      const JOB_ID_NEW = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2'

      let resolveOldIgnoredGet!: (res: Response) => void
      const oldIgnoredGetPending = new Promise<Response>(resolve => {
        resolveOldIgnoredGet = resolve
      })
      let resolveOldGetStarted!: () => void
      const oldGetStartedPromise = new Promise<void>(resolve => {
        resolveOldGetStarted = resolve
      })

      clearRoutes()

      onPost('creds/upload', () => {
        if (getPostCalls().length === 3) {
          return jsonResponse({
            results: [{ filename: 'owner3.json', status: 'success' }],
            email_enrichment: { job_id: JOB_ID_OLD },
          })
        }
        return jsonResponse({
          results: [{ filename: 'owner4.json', status: 'success' }],
          email_enrichment: { job_id: JOB_ID_NEW },
        })
      })

      onGet('creds/email-enrichment', (url) => {
        if (url.pathname.includes(JOB_ID_OLD)) {
          resolveOldGetStarted()
          return oldIgnoredGetPending
        }
        if (url.pathname.includes(JOB_ID_NEW)) {
          return jsonResponse({
            job_id: JOB_ID_NEW,
            total: 1,
            complete: true,
            sealed: true,
            items: [{ filename: 'owner4.json', status: 'success', user_email: 'new@example.invalid' }],
          })
        }
        return jsonResponse({}, 404)
      })

      // Owner 3 imports file
      const f3 = new File(['{}'], 'owner3.json', { type: 'application/json' })
      expect(uploadWorkflowFiles(owner3, [f3])).toBe(true)
      await waitForCondition(s => !s.busy && s.emailJobs.length === 1)
      expect(getImportWorkflowSnapshot().emailJobs[0].jobId).toBe(JOB_ID_OLD)

      // Advance timers so GET for JOB_ID_OLD starts and is held pending
      const pollTimerPromise = vi.advanceTimersByTimeAsync(2000)
      await oldGetStartedPromise

      // Owner 3 loses session while GET request is in-flight ignoring abort
      setSessionToken(null)
      expect(getImportWorkflowSnapshot().owner).toBeNull()

      // Owner 4 logs in and starts tracking new job
      const owner4 = loginAndVerify('synthetic-token-owner4', 'antigravity')
      const f4 = new File(['{}'], 'owner4.json', { type: 'application/json' })
      expect(uploadWorkflowFiles(owner4, [f4])).toBe(true)
      await waitForCondition(s => !s.busy && s.emailJobs.length === 1)
      expect(getImportWorkflowSnapshot().emailJobs[0].jobId).toBe(JOB_ID_NEW)

      // Now late resolution of old owner's ignored-abort GET arrives while Owner 4 is tracking/active
      resolveOldIgnoredGet(
        jsonResponse({
          job_id: JOB_ID_OLD,
          total: 1,
          complete: true,
          sealed: true,
          items: [{ filename: 'owner3.json', status: 'success' }],
        }),
      )

      await pollTimerPromise
      await vi.advanceTimersByTimeAsync(2000)

      // Owner 4's polling completes, unaffected by late old completion
      const owner4FinalSnap = await waitForCondition(s => s.emailJobs[0]?.status === 'complete')
      expect(owner4FinalSnap.owner).toBe(owner4)
      expect(owner4FinalSnap.emailJobs.length).toBe(1)
      expect(owner4FinalSnap.emailJobs[0].jobId).toBe(JOB_ID_NEW)
      expect(owner4FinalSnap.emailJobs[0].status).toBe('complete')

      setSessionToken(null)
      vi.useRealTimers()
    })
  })
})
