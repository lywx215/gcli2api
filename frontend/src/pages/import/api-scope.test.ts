import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createImportApi } from './api'
import type { ImportRequestContext, TokenInput } from './types'
import { setSessionToken, getSessionSnapshot } from '@/auth/session'
import {
  __commitPanelChannel,
  __invalidatePanelChannel,
  capturePanelScope,
  getPanelChannelSnapshot,
  type PanelMode,
  type PanelScope,
} from '@/domain/panel'

let fetchMock = vi.fn<typeof fetch>()

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

function createActiveContext(
  mode: PanelMode = 'antigravity',
  oauthCapabilities?: ReadonlySet<string> | readonly string[],
): ImportRequestContext {
  __commitPanelChannel(mode)
  const session = getSessionSnapshot()
  const scope = capturePanelScope(session.sessionEpoch)
  return {
    mode,
    scope,
    oauthCapabilities,
  }
}

beforeEach(() => {
  document.head.innerHTML = '<meta name="gcli-service-base" content="/">'
  window.localStorage.clear()
  setSessionToken('synthetic-session-token')
  __commitPanelChannel('antigravity')
  vi.stubEnv('VITE_UI_FIXTURES', 'false')
  fetchMock = vi.fn<typeof fetch>(() => Promise.reject(new Error('Unexpected fetch call')))
  vi.stubGlobal('fetch', fetchMock)
})

describe('createImportApi real client & transport scope tests', () => {
  describe('Mode transport & exact request paths / payloads', () => {
    it.each(['antigravity', 'geminicli'] as const)('sends multipart files with exact query and FormData for %s', async mode => {
      const context = createActiveContext(mode)
      const api = createImportApi(context)
      fetchMock.mockResolvedValueOnce(jsonResponse({ results: [{ filename: 'item.json', status: 'success' }] }))

      const file = new File(['{"sample":true}'], 'item.json', { type: 'application/json' })
      const result = await api.uploadFiles([file])

      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [rawUrl, init] = fetchMock.mock.calls[0]
      const url = rawUrl instanceof URL ? rawUrl : new URL(String(rawUrl))
      expect(url.pathname).toBe('/creds/upload')
      expect(url.searchParams.get('mode')).toBe(mode)
      expect(init?.method).toBe('POST')

      const body = init?.body as FormData
      expect(body).toBeInstanceOf(FormData)
      expect(body.get('mode')).toBe(mode)
      expect(body.getAll('files')).toHaveLength(1)
      expect((body.getAll('files')[0] as File).name).toBe('item.json')
      expect(result.outcome).toBe('success')
    })

    it.each(['antigravity', 'geminicli'] as const)('routes single refresh-token JSON for %s', async mode => {
      const context = createActiveContext(mode)
      const api = createImportApi(context)
      fetchMock.mockResolvedValueOnce(jsonResponse({ results: [{ filename: 'custom.json', status: 'success' }] }))

      const input: TokenInput = {
        tokens: ['synthetic-rt-1'],
        clientId: 'cid-alpha',
        clientSecret: 'csec-alpha',
        projectId: 'project-alpha',
        filename: 'custom.json',
      }
      const result = await api.importTokens(input)

      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [rawUrl, init] = fetchMock.mock.calls[0]
      const url = rawUrl instanceof URL ? rawUrl : new URL(String(rawUrl))
      expect(url.pathname).toBe('/creds/upload-by-refresh-token')
      expect(init?.method).toBe('POST')
      expect(JSON.parse(init?.body as string)).toEqual({
        mode,
        refresh_token: 'synthetic-rt-1',
        project_id: 'project-alpha',
        client_id: 'cid-alpha',
        client_secret: 'csec-alpha',
        custom_filename: 'custom.json',
      })
      expect(result.outcome).toBe('success')
    })

    it.each(['antigravity', 'geminicli'] as const)('routes batch refresh-token JSON for %s without project_id', async mode => {
      const context = createActiveContext(mode)
      const api = createImportApi(context)
      fetchMock.mockResolvedValueOnce(jsonResponse({ results: [{ status: 'success' }, { status: 'success' }] }))

      const input: TokenInput = {
        tokens: ['rt-alpha', 'rt-beta'],
        clientId: 'cid-batch',
        clientSecret: 'csec-batch',
        projectId: 'must-be-omitted',
        filename: 'batch-prefix',
      }
      const result = await api.importTokens(input)

      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [rawUrl, init] = fetchMock.mock.calls[0]
      const url = rawUrl instanceof URL ? rawUrl : new URL(String(rawUrl))
      expect(url.pathname).toBe('/creds/upload-by-refresh-token-batch')
      expect(init?.method).toBe('POST')
      const payload = JSON.parse(init?.body as string)
      expect(payload).toEqual({
        mode,
        refresh_tokens: ['rt-alpha', 'rt-beta'],
        filename_prefix: 'batch-prefix',
        client_id: 'cid-batch',
        client_secret: 'csec-batch',
      })
      expect(payload).not.toHaveProperty('project_id')
      expect(result.outcome).toBe('success')
    })

    it.each(['antigravity', 'geminicli'] as const)('starts OAuth and validates Google origin for %s', async mode => {
      const context = createActiveContext(mode)
      const api = createImportApi(context)
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ auth_url: 'https://accounts.google.com/o/oauth2/v2/auth?state=synthetic-state' }),
      )

      const url = await api.startOAuth('proj-valid')

      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [rawUrl, init] = fetchMock.mock.calls[0]
      const requestUrl = rawUrl instanceof URL ? rawUrl : new URL(String(rawUrl))
      expect(requestUrl.pathname).toBe('/auth/start')
      expect(JSON.parse(init?.body as string)).toEqual({
        mode,
        project_id: 'proj-valid',
      })
      expect(url).toBe('https://accounts.google.com/o/oauth2/v2/auth?state=synthetic-state')
    })

    it('rejects invalid OAuth origin responses', async () => {
      const api = createImportApi(createActiveContext('antigravity'))
      fetchMock.mockResolvedValueOnce(jsonResponse({ auth_url: 'https://attacker.example.invalid/auth' }))
      await expect(api.startOAuth('')).rejects.toThrow('Invalid authorization origin')

      fetchMock.mockResolvedValueOnce(jsonResponse({ auth_url: 'https://accounts.google.com:attacker@google.com/auth' }))
      await expect(api.startOAuth('')).rejects.toThrow('Invalid authorization origin')
    })

    it.each(['antigravity', 'geminicli'] as const)(
      'completes OAuth via callback and callback-url with include_credentials:false for %s',
      async mode => {
        const exactCapability = `${mode}.oauth.safe_response`
        const context = createActiveContext(mode, [exactCapability])
        const api = createImportApi(context)

        // 1. null callbackUrl -> auth/callback
        fetchMock.mockResolvedValueOnce(
          jsonResponse({
            success: true,
            mode,
            filename: 'test-1.json',
            auto_detected_project: false,
          }),
        )
        const res1 = await api.completeOAuth(null, 'proj-1')
        expect(res1.outcome).toBe('success')
        const [url1, init1] = fetchMock.mock.calls[0]
        expect((url1 instanceof URL ? url1 : new URL(String(url1))).pathname).toBe('/auth/callback')
        expect(JSON.parse(init1?.body as string)).toEqual({
          mode,
          project_id: 'proj-1',
          include_credentials: false,
        })

        // 2. non-null callbackUrl -> auth/callback-url
        fetchMock.mockResolvedValueOnce(
          jsonResponse({
            success: true,
            mode,
            filename: 'test-2.json',
            auto_detected_project: true,
          }),
        )
        const res2 = await api.completeOAuth('https://127.0.0.1:8085/?code=synthetic-code', 'proj-2')
        expect(res2.outcome).toBe('success')
        const [url2, init2] = fetchMock.mock.calls[1]
        expect((url2 instanceof URL ? url2 : new URL(String(url2))).pathname).toBe('/auth/callback-url')
        expect(JSON.parse(init2?.body as string)).toEqual({
          mode,
          project_id: 'proj-2',
          callback_url: 'https://127.0.0.1:8085/?code=synthetic-code',
          include_credentials: false,
        })
      },
    )
  })

  describe('Capability gating & discovery', () => {
    it('rejects supplied generic capability without network call (pre-repair regression check)', async () => {
      const agApi = createImportApi(createActiveContext('antigravity', ['oauth.safe_response']))
      await expect(agApi.completeOAuth(null, '')).rejects.toThrow('当前服务不支持安全 OAuth 响应。')
      expect(fetchMock).not.toHaveBeenCalled()

      const gcliApi = createImportApi(createActiveContext('geminicli', ['oauth.safe_response']))
      await expect(gcliApi.completeOAuth(null, '')).rejects.toThrow('当前服务不支持安全 OAuth 响应。')
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('rejects supplied other-mode or absent capability without network call', async () => {
      const agApi = createImportApi(createActiveContext('antigravity', ['geminicli.oauth.safe_response']))
      await expect(agApi.completeOAuth(null, '')).rejects.toThrow('当前服务不支持安全 OAuth 响应。')
      expect(fetchMock).not.toHaveBeenCalled()

      const gcliApi = createImportApi(createActiveContext('geminicli', ['antigravity.oauth.safe_response']))
      await expect(gcliApi.completeOAuth(null, '')).rejects.toThrow('当前服务不支持安全 OAuth 响应。')
      expect(fetchMock).not.toHaveBeenCalled()

      const emptyApi = createImportApi(createActiveContext('antigravity', []))
      await expect(emptyApi.completeOAuth(null, '')).rejects.toThrow('当前服务不支持安全 OAuth 响应。')
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('permits one explicit exchange when exact matching capability is supplied', async () => {
      const api = createImportApi(createActiveContext('antigravity', ['antigravity.oauth.safe_response']))
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          mode: 'antigravity',
          filename: 'valid.json',
          auto_detected_project: false,
        }),
      )

      const result = await api.completeOAuth(null, '')
      expect(result.outcome).toBe('success')
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [rawUrl] = fetchMock.mock.calls[0]
      expect((rawUrl instanceof URL ? rawUrl : new URL(String(rawUrl))).pathname).toBe('/auth/callback')
    })

    it('blocks exchange when discovered capability is absent, other-mode, or generic', async () => {
      // 1. Discovered generic only
      const genericApi = createImportApi(createActiveContext('antigravity'))
      fetchMock.mockResolvedValueOnce(jsonResponse({ panel_capabilities: ['oauth.safe_response'] }))
      await expect(genericApi.completeOAuth(null, '')).rejects.toThrow('当前服务不支持安全 OAuth 响应。')
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url1] = fetchMock.mock.calls[0]
      expect((url1 instanceof URL ? url1 : new URL(String(url1))).pathname).toBe('/creds/status')

      // 2. Discovered other-mode only
      fetchMock.mockReset()
      const otherModeApi = createImportApi(createActiveContext('antigravity'))
      fetchMock.mockResolvedValueOnce(jsonResponse({ panel_capabilities: ['geminicli.oauth.safe_response'] }))
      await expect(otherModeApi.completeOAuth(null, '')).rejects.toThrow('当前服务不支持安全 OAuth 响应。')
      expect(fetchMock).toHaveBeenCalledTimes(1)

      // 3. Discovered empty
      fetchMock.mockReset()
      const absentApi = createImportApi(createActiveContext('antigravity'))
      fetchMock.mockResolvedValueOnce(jsonResponse({ panel_capabilities: [] }))
      await expect(absentApi.completeOAuth(null, '')).rejects.toThrow('当前服务不支持安全 OAuth 响应。')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('discovers matching capability, completes exchange, and caches discovery for subsequent calls', async () => {
      const api = createImportApi(createActiveContext('antigravity'))
      // First completion: discovery call + exchange call
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ panel_capabilities: ['antigravity.oauth.safe_response'] }))
        .mockResolvedValueOnce(
          jsonResponse({
            success: true,
            mode: 'antigravity',
            filename: 'first.json',
            auto_detected_project: false,
          }),
        )

      const res1 = await api.completeOAuth(null, 'p-1')
      expect(res1.outcome).toBe('success')
      expect(fetchMock).toHaveBeenCalledTimes(2)

      // Second completion on same api: reuses discovered capability without calling creds/status
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          mode: 'antigravity',
          filename: 'second.json',
          auto_detected_project: true,
        }),
      )
      const res2 = await api.completeOAuth(null, 'p-2')
      expect(res2.outcome).toBe('success')
      expect(fetchMock).toHaveBeenCalledTimes(3)
      const [rawUrl3] = fetchMock.mock.calls[2]
      expect((rawUrl3 instanceof URL ? rawUrl3 : new URL(String(rawUrl3))).pathname).toBe('/auth/callback')
    })
  })

  describe('Scope validation, aborts, mutation immutability & transport fences', () => {
    it('rejects mismatched mode between context and scope before network call', async () => {
      __commitPanelChannel('antigravity')
      const antigravityScope = capturePanelScope(getSessionSnapshot().sessionEpoch)
      const context: ImportRequestContext = {
        mode: 'geminicli',
        scope: antigravityScope,
      }
      const api = createImportApi(context)
      await expect(api.uploadFiles([])).rejects.toThrow('请求模式与作用域不一致。')
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('rejects stale channel or session epoch before network call', async () => {
      const context = createActiveContext('antigravity')
      const api = createImportApi(context)

      // Stale channel epoch
      __invalidatePanelChannel()
      await expect(api.uploadFiles([])).rejects.toThrow('作用域已变更，请重新读取。')
      expect(fetchMock).not.toHaveBeenCalled()

      // Stale session epoch
      const freshContext = createActiveContext('antigravity')
      const freshApi = createImportApi(freshContext)
      setSessionToken('new-synthetic-token')
      await expect(freshApi.uploadFiles([])).rejects.toThrow('作用域已变更，请重新读取。')
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('throws immediately on already-aborted signal without calling network', async () => {
      const api = createImportApi(createActiveContext('antigravity'))
      const controller = new AbortController()
      controller.abort()

      await expect(api.uploadFiles([], controller.signal)).rejects.toThrow()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('aborts inflight request when session token changes', async () => {
      const api = createImportApi(createActiveContext('antigravity'))
      let finishFetch!: (res: Response) => void
      fetchMock.mockImplementationOnce(() => new Promise(resolve => { finishFetch = resolve }))

      const promise = api.startOAuth('p-1')
      setSessionToken('session-invalidated')
      finishFetch(jsonResponse({ auth_url: 'https://accounts.google.com/o/oauth2/v2/auth?state=s' }))

      await expect(promise).rejects.toThrow(/已变更/)
    })

    it('aborts inflight request when channel epoch changes', async () => {
      const api = createImportApi(createActiveContext('antigravity'))
      let finishFetch!: (res: Response) => void
      fetchMock.mockImplementationOnce(() => new Promise(resolve => { finishFetch = resolve }))

      const promise = api.startOAuth('p-1')
      __commitPanelChannel('geminicli')
      finishFetch(jsonResponse({ auth_url: 'https://accounts.google.com/o/oauth2/v2/auth?state=s' }))

      await expect(promise).rejects.toThrow(/已变更/)
    })

    it('discards late response when transport ignores abort signal and resolves', async () => {
      const api = createImportApi(createActiveContext('antigravity'))
      const controller = new AbortController()
      let finishDelayed!: (res: Response) => void
      fetchMock.mockImplementationOnce(() => new Promise(resolve => { finishDelayed = resolve }))

      const promise = api.startOAuth('p-1', controller.signal)
      controller.abort()
      // Transport ignores abort and resolves 200 with data
      finishDelayed(jsonResponse({ auth_url: 'https://accounts.google.com/o/oauth2/v2/auth?state=late' }))

      await expect(promise).rejects.toThrow()
    })

    it('caller mutation of context, scope or capability Set cannot change bound API', async () => {
      const initialChannel = getPanelChannelSnapshot()
      const initialSession = getSessionSnapshot()
      const mutableScope: PanelScope = {
        mode: 'antigravity',
        channelEpoch: initialChannel.channelEpoch,
        sessionEpoch: initialSession.sessionEpoch,
      }
      const mutableCaps = new Set(['antigravity.oauth.safe_response'])
      const mutableContext: ImportRequestContext = {
        mode: 'antigravity',
        scope: mutableScope,
        oauthCapabilities: mutableCaps,
      }
      const api = createImportApi(mutableContext)

      // External caller attempts mutation
      ;(mutableContext as { mode: string }).mode = 'geminicli'
      ;(mutableScope as { mode: string }).mode = 'geminicli'
      ;(mutableScope as { channelEpoch: number }).channelEpoch = 9999
      mutableCaps.clear()
      mutableCaps.add('geminicli.oauth.safe_response')

      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          mode: 'antigravity',
          filename: 'immutable.json',
          auto_detected_project: false,
        }),
      )

      const result = await api.completeOAuth(null, 'p-imm')
      expect(result.outcome).toBe('success')
      expect(result.oauthReceipt?.mode).toBe('antigravity')
      expect(result.oauthReceipt?.filename).toBe('immutable.json')
    })
  })

  describe('Safe DTO parsing, booleans, metadata, extras & AG/GCLI fences', () => {
    it.each([true, false])('preserves exact boolean auto_detected_project (%s)', async flag => {
      const api = createImportApi(createActiveContext('antigravity', ['antigravity.oauth.safe_response']))
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          mode: 'antigravity',
          filename: 'valid.json',
          auto_detected_project: flag,
        }),
      )
      const res = await api.completeOAuth(null, '')
      expect(res.oauthReceipt?.auto_detected_project).toBe(flag)
    })

    it.each([
      ['missing', {}],
      ['string "true"', { auto_detected_project: 'true' }],
      ['string "false"', { auto_detected_project: 'false' }],
      ['integer 1', { auto_detected_project: 1 }],
      ['integer 0', { auto_detected_project: 0 }],
      ['null', { auto_detected_project: null }],
    ])('rejects non-boolean auto_detected_project (%s) with fixed local error (pre-repair regression check)', async (_, prop) => {
      const api = createImportApi(createActiveContext('antigravity', ['antigravity.oauth.safe_response']))
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          mode: 'antigravity',
          filename: 'valid.json',
          ...prop,
        }),
      )
      await expect(api.completeOAuth(null, '')).rejects.toThrow('Invalid auto_detected_project in OAuth response')
    })

    it('discards nested antigravity_extra fallback reads (warnings, email receipt) (pre-repair regression check)', async () => {
      const api = createImportApi(createActiveContext('antigravity', ['antigravity.oauth.safe_response']))
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          mode: 'antigravity',
          filename: 'creds.json',
          auto_detected_project: false,
          antigravity_extra: {
            warnings: ['poison-extra-warning-1', 'poison-extra-warning-2'],
            email_enrichment: { job_id: '0123456789abcdef0123456789abcdef' },
          },
        }),
      )
      const res = await api.completeOAuth(null, '')
      expect(res.warnings).toBe(0)
      expect(res.jobId).toBeUndefined()
    })

    it('discards nested geminicli_extra fallback tier diagnostics (pre-repair regression check)', async () => {
      const api = createImportApi(createActiveContext('geminicli', ['geminicli.oauth.safe_response']))
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          mode: 'geminicli',
          filename: 'creds.json',
          auto_detected_project: true,
          geminicli_extra: {
            tier_raw_id: 'extra-tier-id',
            tier_raw_name: 'extra-tier-name',
            tier_detected_at: 1700000000,
            tier_detection_status: 'extra-status',
          },
        }),
      )
      const res = await api.completeOAuth(null, '')
      expect(res.oauthReceipt?.tier_raw_id).toBeNull()
      expect(res.oauthReceipt?.tier_raw_name).toBeNull()
      expect(res.oauthReceipt?.tier_detected_at).toBeNull()
      expect(res.oauthReceipt?.tier_detection_status).toBeNull()
    })

    it('preserves top-level nullable metadata and integer zero timestamp', async () => {
      const api = createImportApi(createActiveContext('geminicli', ['geminicli.oauth.safe_response']))
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          mode: 'geminicli',
          filename: 'gcli.json',
          auto_detected_project: false,
          project_id: null,
          subscription_tier: null,
          tier_raw_id: null,
          tier_raw_name: null,
          tier_detected_at: 0,
          tier_detection_status: null,
        }),
      )
      const res = await api.completeOAuth(null, '')
      expect(res.oauthReceipt?.project_id).toBeNull()
      expect(res.oauthReceipt?.subscription_tier).toBeNull()
      expect(res.oauthReceipt?.tier_raw_id).toBeNull()
      expect(res.oauthReceipt?.tier_raw_name).toBeNull()
      expect(res.oauthReceipt?.tier_detected_at).toBe(0)
      expect(res.oauthReceipt?.tier_detection_status).toBeNull()
    })

    it('strips credentials, message and error poison properties', async () => {
      const api = createImportApi(createActiveContext('antigravity', ['antigravity.oauth.safe_response']))
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          mode: 'antigravity',
          filename: 'clean.json',
          auto_detected_project: false,
          credentials: { refresh_token: 'synthetic-poison-secret', client_secret: 'synthetic-poison-secret' },
          message: 'poison-message-leak',
          error: 'poison-error-leak',
        }),
      )
      const res = await api.completeOAuth(null, '')
      const serialized = JSON.stringify(res)
      expect(serialized).not.toContain('synthetic-poison-secret')
      expect(serialized).not.toContain('poison-message-leak')
      expect(serialized).not.toContain('poison-error-leak')
      expect((res as unknown as Record<string, unknown>).credentials).toBeUndefined()
      expect((res as unknown as Record<string, unknown>).message).toBeUndefined()
      expect((res.oauthReceipt as unknown as Record<string, unknown>).credentials).toBeUndefined()
    })

    it.each(['../escape.json', 'foo/bar.json', 'foo\\bar.json', '', '   ', '.', '..', 'name\0zero'])(
      'rejects invalid filename in OAuth completion (%s)',
      async filename => {
        const api = createImportApi(createActiveContext('antigravity', ['antigravity.oauth.safe_response']))
        fetchMock.mockResolvedValueOnce(
          jsonResponse({
            success: true,
            mode: 'antigravity',
            filename,
            auto_detected_project: false,
          }),
        )
        await expect(api.completeOAuth(null, '')).rejects.toThrow('Invalid filename in OAuth response')
      },
    )

    it('accepts valid 32-hex AG receipt ID and rejects malformed IDs', async () => {
      const api = createImportApi(createActiveContext('antigravity', ['antigravity.oauth.safe_response']))
      const validHexId = '0123456789abcdef0123456789abcdef'

      // Valid 32-hex
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          mode: 'antigravity',
          filename: 'valid.json',
          auto_detected_project: false,
          email_enrichment: { job_id: validHexId },
        }),
      )
      const res1 = await api.completeOAuth(null, '')
      expect(res1.jobId).toBe(validHexId)

      // Malformed IDs: uppercase, non-hex, wrong length
      for (const badId of ['0123456789ABCDEF0123456789ABCDEF', 'not-32-hex', '0123456789abcdef0123456789abcdeg']) {
        fetchMock.mockResolvedValueOnce(
          jsonResponse({
            success: true,
            mode: 'antigravity',
            filename: 'bad.json',
            auto_detected_project: false,
            email_enrichment: { job_id: badId },
          }),
        )
        const resBad = await api.completeOAuth(null, '')
        expect(resBad.jobId).toBeUndefined()
      }
    })

    it('never leaks receipt jobId or allows email-job requests for Gemini CLI', async () => {
      const api = createImportApi(createActiveContext('geminicli', ['geminicli.oauth.safe_response']))
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          mode: 'geminicli',
          filename: 'gcli.json',
          auto_detected_project: true,
          email_enrichment: { job_id: '0123456789abcdef0123456789abcdef' },
        }),
      )
      const res = await api.completeOAuth(null, '')
      expect(res.jobId).toBeUndefined()

      await expect(api.readEmailJob('0123456789abcdef0123456789abcdef')).rejects.toThrow('Gemini CLI 不支持邮箱任务')
      expect(fetchMock).toHaveBeenCalledTimes(1) // only OAuth completion, zero email-job calls
    })

    it('reads email job pages in Antigravity mode with offset and limit', async () => {
      const api = createImportApi(createActiveContext('antigravity'))
      const jobId = '0123456789abcdef0123456789abcdef'
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          job_id: jobId,
          items: [{ filename: 'ok.json', status: 'success', user_email: 'user@example.invalid' }],
          total: 1,
          complete: true,
          sealed: true,
        }),
      )

      const snapshot = await api.readEmailJob(jobId)
      expect(snapshot.complete).toBe(true)
      expect(snapshot.items).toHaveLength(1)
      expect(snapshot.items[0].email).toBe('user@example.invalid')

      const [rawUrl] = fetchMock.mock.calls[0]
      const url = rawUrl instanceof URL ? rawUrl : new URL(String(rawUrl))
      expect(url.pathname).toBe(`/creds/email-enrichment/${jobId}`)
      expect(url.searchParams.get('offset')).toBe('0')
      expect(url.searchParams.get('limit')).toBe('100')
    })
  })

  describe('DEV UI Fixture mode operations', () => {
    beforeEach(() => {
      vi.stubEnv('VITE_UI_FIXTURES', 'true')
    })

    it('makes zero fetch calls and returns cloned preview results for Antigravity', async () => {
      const api = createImportApi(createActiveContext('antigravity'))

      const uploadRes = await api.uploadFiles([new File(['{}'], 'preview.json')])
      expect(uploadRes.outcome).toBe('partial')

      const tokenRes = await api.importTokens({
        tokens: ['tok'],
        clientId: '',
        clientSecret: '',
        projectId: '',
        filename: '',
      })
      expect(tokenRes.outcome).toBe('partial')

      const authUrl = await api.startOAuth('')
      expect(authUrl).toBe('')

      const oauthRes = await api.completeOAuth(null, '')
      expect(oauthRes.outcome).toBe('partial')
      expect(oauthRes.jobId).toBe('example-job')

      // Verify cloning: modifying oauthRes.items does not alter next call
      oauthRes.items[0].label = 'mutated.json'
      const freshOauthRes = await api.completeOAuth(null, '')
      expect(freshOauthRes.items[0].label).toBe('example-alpha.json')

      const emailRes = await api.readEmailJob('example-job')
      expect(emailRes.complete).toBe(true)
      expect(emailRes.items[0].filename).toBe('example-alpha.json')

      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('makes zero fetch calls, strips AG jobId and blocks email jobs in Gemini CLI fixture mode', async () => {
      const api = createImportApi(createActiveContext('geminicli'))

      const oauthRes = await api.completeOAuth(null, '')
      expect(oauthRes.outcome).toBe('partial')
      expect(oauthRes.jobId).toBeUndefined() // Stripped for Gemini CLI!

      await expect(api.readEmailJob('example-job')).rejects.toThrow('Gemini CLI 不支持邮箱任务')
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
})
