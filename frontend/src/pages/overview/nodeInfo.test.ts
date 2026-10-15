import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setSessionToken } from '@/auth/session'
import { __commitPanelChannel, __invalidatePanelChannel, type PanelMode } from '@/domain/panel'
import type { Counts } from './types'
import {
  getOverviewApiAddresses,
  getOverviewSuccessRate,
  loadNodeInfo,
  normalizeCodeAssistEndpoint,
  normalizeNodeVersion,
} from './nodeInfo'

function createVersionPayload(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    version: '1.2.3',
    display_version: 'v1.2.3',
    full_hash: 'abcdef1234567890',
    message: 'release 1.2.3',
    date: '2026-10-14',
    source_ref: 'refs/tags/v1.2.3',
    commit_date: '2026-10-14T10:00:00Z',
    ...overrides,
  }
}

function createSafeConfigPayload(endpoint?: string) {
  return {
    config: endpoint !== undefined ? { code_assist_endpoint: endpoint } : {},
    capabilities: ['quota', 'code_assist'],
    env_locked: [],
    security: {},
    secret_fields: {
      api_password: { configured: false },
      panel_password: { configured: false },
      password: { configured: false },
    },
  }
}

function mockTransport({
  versionData,
  versionStatus = 200,
  configData,
  configStatus = 200,
  delayMs = 0,
}: {
  versionData?: unknown
  versionStatus?: number
  configData?: unknown
  configStatus?: number
  delayMs?: number
} = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
    if (init?.signal?.aborted) {
      throw new DOMException('The user aborted a request.', 'AbortError')
    }
    if (url.includes('version/info')) {
      if (versionStatus >= 400) {
        return new Response(JSON.stringify({ detail: 'Version request failed' }), {
          status: versionStatus,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify(versionData ?? createVersionPayload()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url.includes('config/get')) {
      if (configStatus >= 400) {
        return new Response(JSON.stringify({ detail: 'Config request failed' }), {
          status: configStatus,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(
        JSON.stringify(configData ?? createSafeConfigPayload('https://codeassist.example.com')),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }
    return new Response(JSON.stringify({ detail: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('normalizeNodeVersion', () => {
  it('normalizes strict successful version and extracts fresh 7-field allowlist excluding raw extras', () => {
    const raw = {
      success: true,
      version: '1.2.3',
      display_version: 'v1.2.3',
      full_hash: 'abcdef1234567890',
      message: 'release 1.2.3',
      date: '2026-10-14',
      source_ref: 'refs/tags/v1.2.3',
      commit_date: '2026-10-14T10:00:00Z',
      extra_field: 'should be excluded',
      check_update: false,
      update_available: true,
      metadata: { author: 'admin' },
    }

    const result = normalizeNodeVersion(raw)

    expect(result).toEqual({
      value: {
        version: '1.2.3',
        display_version: 'v1.2.3',
        full_hash: 'abcdef1234567890',
        message: 'release 1.2.3',
        date: '2026-10-14',
        source_ref: 'refs/tags/v1.2.3',
        commit_date: '2026-10-14T10:00:00Z',
      },
      issue: null,
    })

    // Strict allowlist checks
    expect(result.value).not.toBeNull()
    const keys = Object.keys(result.value!)
    expect(keys).toEqual([
      'version',
      'display_version',
      'full_hash',
      'message',
      'date',
      'source_ref',
      'commit_date',
    ])
    expect('extra_field' in result.value!).toBe(false)
    expect('success' in result.value!).toBe(false)
    expect('check_update' in result.value!).toBe(false)
    expect('update_available' in result.value!).toBe(false)
    expect('metadata' in result.value!).toBe(false)
  })

  it('accepts version when only display_version is usable and version is unknown or missing', () => {
    const raw = {
      success: true,
      version: 'unknown',
      display_version: 'v2.0.0-rc1',
    }

    const result = normalizeNodeVersion(raw)

    expect(result).toEqual({
      value: {
        version: 'unknown',
        display_version: 'v2.0.0-rc1',
      },
      issue: null,
    })
  })

  it('accepts version when only version is usable and display_version is missing', () => {
    const raw = {
      success: true,
      version: '3.1.4',
    }

    const result = normalizeNodeVersion(raw)

    expect(result).toEqual({
      value: {
        version: '3.1.4',
      },
      issue: null,
    })
  })

  it('omits non-string allowed fields from the normalized result', () => {
    const raw = {
      success: true,
      version: '1.0.0',
      display_version: 100,
      full_hash: null,
      message: undefined,
      date: 20261014,
      source_ref: true,
      commit_date: {},
    }

    const result = normalizeNodeVersion(raw)

    expect(result).toEqual({
      value: {
        version: '1.0.0',
      },
      issue: null,
    })
  })

  it('rejects payload when success is not boolean true', () => {
    expect(normalizeNodeVersion({ success: false, version: '1.0.0' })).toEqual({
      value: null,
      issue: '版本信息不可用',
    })
    expect(normalizeNodeVersion({ success: 'true', version: '1.0.0' })).toEqual({
      value: null,
      issue: '版本信息不可用',
    })
    expect(normalizeNodeVersion({ success: 1, version: '1.0.0' })).toEqual({
      value: null,
      issue: '版本信息不可用',
    })
    expect(normalizeNodeVersion({ version: '1.0.0' })).toEqual({
      value: null,
      issue: '版本信息不可用',
    })
  })

  it('rejects payload when both version and display_version are missing or unusable', () => {
    expect(normalizeNodeVersion({ success: true })).toEqual({
      value: null,
      issue: '版本信息不可用',
    })
    expect(normalizeNodeVersion({ success: true, version: '', display_version: '   ' })).toEqual({
      value: null,
      issue: '版本信息不可用',
    })
    expect(
      normalizeNodeVersion({ success: true, version: 'unknown', display_version: 'UNKNOWN' }),
    ).toEqual({
      value: null,
      issue: '版本信息不可用',
    })
    expect(normalizeNodeVersion({ success: true, version: 123, display_version: null })).toEqual({
      value: null,
      issue: '版本信息不可用',
    })
  })

  it('rejects non-object, null, array, and primitive payloads', () => {
    expect(normalizeNodeVersion(null)).toEqual({ value: null, issue: '版本信息不可用' })
    expect(normalizeNodeVersion(undefined)).toEqual({ value: null, issue: '版本信息不可用' })
    expect(normalizeNodeVersion([])).toEqual({ value: null, issue: '版本信息不可用' })
    expect(normalizeNodeVersion('1.0.0')).toEqual({ value: null, issue: '版本信息不可用' })
    expect(normalizeNodeVersion(123)).toEqual({ value: null, issue: '版本信息不可用' })
    expect(normalizeNodeVersion(true)).toEqual({ value: null, issue: '版本信息不可用' })
  })
})

describe('normalizeCodeAssistEndpoint', () => {
  it('normalizes valid HTTP(S) URL string directly', () => {
    expect(normalizeCodeAssistEndpoint('https://codeassist.google.com')).toEqual({
      value: 'https://codeassist.google.com',
      issue: null,
    })
    expect(normalizeCodeAssistEndpoint('http://127.0.0.1:8080/v1')).toEqual({
      value: 'http://127.0.0.1:8080/v1',
      issue: null,
    })
    expect(normalizeCodeAssistEndpoint('https://example.com/subpath/endpoint')).toEqual({
      value: 'https://example.com/subpath/endpoint',
      issue: null,
    })
  })

  it('extracts valid endpoint from SafeConfigResponse config object', () => {
    const safeConfig = createSafeConfigPayload('https://codeassist.google.com/v1')
    expect(normalizeCodeAssistEndpoint(safeConfig)).toEqual({
      value: 'https://codeassist.google.com/v1',
      issue: null,
    })
  })

  it('extracts valid endpoint from flat object with code_assist_endpoint', () => {
    const flat = { code_assist_endpoint: 'http://localhost:3000/api' }
    expect(normalizeCodeAssistEndpoint(flat)).toEqual({
      value: 'http://localhost:3000/api',
      issue: null,
    })
  })

  it('rejects URLs containing userinfo (@)', () => {
    expect(normalizeCodeAssistEndpoint('https://user:pass@example.com')).toEqual({
      value: null,
      issue: '代码助手端点不可用',
    })
    expect(normalizeCodeAssistEndpoint('http://admin@localhost:8080')).toEqual({
      value: null,
      issue: '代码助手端点不可用',
    })
  })

  it('rejects URLs containing query string (?)', () => {
    expect(normalizeCodeAssistEndpoint('https://example.com?query=1')).toEqual({
      value: null,
      issue: '代码助手端点不可用',
    })
    expect(normalizeCodeAssistEndpoint('http://127.0.0.1:8080/v1?')).toEqual({
      value: null,
      issue: '代码助手端点不可用',
    })
  })

  it('rejects URLs containing hash (#)', () => {
    expect(normalizeCodeAssistEndpoint('https://example.com#section')).toEqual({
      value: null,
      issue: '代码助手端点不可用',
    })
    expect(normalizeCodeAssistEndpoint('http://127.0.0.1:8080/v1/#')).toEqual({
      value: null,
      issue: '代码助手端点不可用',
    })
  })

  it('rejects URLs with leading, trailing, or embedded whitespace', () => {
    expect(normalizeCodeAssistEndpoint(' https://example.com')).toEqual({
      value: null,
      issue: '代码助手端点不可用',
    })
    expect(normalizeCodeAssistEndpoint('https://example.com ')).toEqual({
      value: null,
      issue: '代码助手端点不可用',
    })
    expect(normalizeCodeAssistEndpoint('https://exam ple.com')).toEqual({
      value: null,
      issue: '代码助手端点不可用',
    })
  })

  it('rejects URLs with control characters', () => {
    expect(normalizeCodeAssistEndpoint('https://example.com\n')).toEqual({
      value: null,
      issue: '代码助手端点不可用',
    })
    expect(normalizeCodeAssistEndpoint('https://example.com\x00')).toEqual({
      value: null,
      issue: '代码助手端点不可用',
    })
    expect(normalizeCodeAssistEndpoint('https://example.com\t')).toEqual({
      value: null,
      issue: '代码助手端点不可用',
    })
  })

  it('rejects non-HTTP(S) schemes and invalid formats', () => {
    expect(normalizeCodeAssistEndpoint('ftp://example.com')).toEqual({
      value: null,
      issue: '代码助手端点不可用',
    })
    expect(normalizeCodeAssistEndpoint('ws://example.com')).toEqual({
      value: null,
      issue: '代码助手端点不可用',
    })
    expect(normalizeCodeAssistEndpoint('file:///path/to/resource')).toEqual({
      value: null,
      issue: '代码助手端点不可用',
    })
    expect(normalizeCodeAssistEndpoint('javascript:alert(1)')).toEqual({
      value: null,
      issue: '代码助手端点不可用',
    })
    expect(normalizeCodeAssistEndpoint('/relative/endpoint')).toEqual({
      value: null,
      issue: '代码助手端点不可用',
    })
    expect(normalizeCodeAssistEndpoint('http://')).toEqual({
      value: null,
      issue: '代码助手端点不可用',
    })
    expect(normalizeCodeAssistEndpoint('not-a-url')).toEqual({
      value: null,
      issue: '代码助手端点不可用',
    })
  })

  it('rejects missing, empty, or non-string candidate inputs', () => {
    expect(normalizeCodeAssistEndpoint('')).toEqual({
      value: null,
      issue: '代码助手端点不可用',
    })
    expect(normalizeCodeAssistEndpoint('   ')).toEqual({
      value: null,
      issue: '代码助手端点不可用',
    })
    expect(normalizeCodeAssistEndpoint(null)).toEqual({
      value: null,
      issue: '代码助手端点不可用',
    })
    expect(normalizeCodeAssistEndpoint(undefined)).toEqual({
      value: null,
      issue: '代码助手端点不可用',
    })
    expect(normalizeCodeAssistEndpoint({})).toEqual({
      value: null,
      issue: '代码助手端点不可用',
    })
    expect(normalizeCodeAssistEndpoint({ config: {} })).toEqual({
      value: null,
      issue: '代码助手端点不可用',
    })
    expect(normalizeCodeAssistEndpoint({ config: { code_assist_endpoint: null } })).toEqual({
      value: null,
      issue: '代码助手端点不可用',
    })
    expect(normalizeCodeAssistEndpoint({ code_assist_endpoint: 12345 })).toEqual({
      value: null,
      issue: '代码助手端点不可用',
    })
  })
})

describe('getOverviewApiAddresses', () => {
  beforeEach(() => {
    document.head.innerHTML = '<meta name="gcli-service-base" content="/">'
  })

  it('produces antigravity OpenAI, Claude, and Gemini endpoint addresses', () => {
    const result = getOverviewApiAddresses('antigravity')

    expect(result.issue).toBeNull()
    expect(result.value).toEqual([
      { id: 'openai', label: 'OpenAI', url: 'http://localhost:3000/antigravity/v1' },
      { id: 'claude', label: 'Claude', url: 'http://localhost:3000/antigravity/v1' },
      { id: 'gemini', label: 'Gemini', url: 'http://localhost:3000/antigravity' },
    ])
    expect(Object.isFrozen(result.value)).toBe(true)
    for (const item of result.value!) {
      expect(Object.isFrozen(item)).toBe(true)
    }
  })

  it('produces geminicli OpenAI, Claude, and Gemini endpoint addresses', () => {
    const result = getOverviewApiAddresses('geminicli')

    expect(result.issue).toBeNull()
    expect(result.value).toEqual([
      { id: 'openai', label: 'OpenAI', url: 'http://localhost:3000/v1' },
      { id: 'claude', label: 'Claude', url: 'http://localhost:3000/v1' },
      { id: 'gemini', label: 'Gemini', url: 'http://localhost:3000/' },
    ])
    expect(Object.isFrozen(result.value)).toBe(true)
    for (const item of result.value!) {
      expect(Object.isFrozen(item)).toBe(true)
    }
  })

  it('preserves injected service-root prefix in both antigravity and geminicli endpoints', () => {
    document.head.innerHTML = '<meta name="gcli-service-base" content="/custom/service/root/">'

    const agResult = getOverviewApiAddresses('antigravity')
    expect(agResult.issue).toBeNull()
    expect(agResult.value).toEqual([
      {
        id: 'openai',
        label: 'OpenAI',
        url: 'http://localhost:3000/custom/service/root/antigravity/v1',
      },
      {
        id: 'claude',
        label: 'Claude',
        url: 'http://localhost:3000/custom/service/root/antigravity/v1',
      },
      {
        id: 'gemini',
        label: 'Gemini',
        url: 'http://localhost:3000/custom/service/root/antigravity',
      },
    ])

    const gcliResult = getOverviewApiAddresses('geminicli')
    expect(gcliResult.issue).toBeNull()
    expect(gcliResult.value).toEqual([
      { id: 'openai', label: 'OpenAI', url: 'http://localhost:3000/custom/service/root/v1' },
      { id: 'claude', label: 'Claude', url: 'http://localhost:3000/custom/service/root/v1' },
      { id: 'gemini', label: 'Gemini', url: 'http://localhost:3000/custom/service/root/' },
    ])
  })

  it('reports unavailable issue for invalid panel modes', () => {
    expect(getOverviewApiAddresses('invalid' as PanelMode)).toEqual({
      value: null,
      issue: '服务地址不可用',
    })
    expect(getOverviewApiAddresses('' as PanelMode)).toEqual({
      value: null,
      issue: '服务地址不可用',
    })
    expect(getOverviewApiAddresses(null as unknown as PanelMode)).toEqual({
      value: null,
      issue: '服务地址不可用',
    })
  })

  it('reports unavailable issue when service base meta is invalid or missing trailing slash', () => {
    document.head.innerHTML = '<meta name="gcli-service-base" content="/invalid-without-slash">'
    expect(getOverviewApiAddresses('antigravity')).toEqual({
      value: null,
      issue: '服务地址不可用',
    })
  })

  it('reports unavailable issue when service base is cross-origin', () => {
    document.head.innerHTML = '<meta name="gcli-service-base" content="http://cross-origin.com/">'
    expect(getOverviewApiAddresses('geminicli')).toEqual({
      value: null,
      issue: '服务地址不可用',
    })
  })
})

describe('getOverviewSuccessRate', () => {
  it('preserves zero when success is zero and total is positive', () => {
    expect(getOverviewSuccessRate({ success: 0, failure: 10, total: 10 })).toBe(0)
    expect(getOverviewSuccessRate({ success: 0, failure: 1, total: 1 })).toBe(0)
    expect(getOverviewSuccessRate({ success: 0, failure: 0, total: 5 })).toBe(0)
  })

  it('computes correct finite percentages for valid counts', () => {
    expect(getOverviewSuccessRate({ success: 100, failure: 0, total: 100 })).toBe(100)
    expect(getOverviewSuccessRate({ success: 50, failure: 50, total: 100 })).toBe(50)
    expect(getOverviewSuccessRate({ success: 1, failure: 3, total: 4 })).toBe(25)
    expect(getOverviewSuccessRate({ success: 1, failure: 2, total: 3 })).toBeCloseTo(33.333, 2)
  })

  it('rejects zero or negative total denominator', () => {
    expect(getOverviewSuccessRate({ success: 0, failure: 0, total: 0 })).toBeNull()
    expect(getOverviewSuccessRate({ success: 5, failure: 0, total: 0 })).toBeNull()
    expect(getOverviewSuccessRate({ success: 0, failure: 0, total: -1 })).toBeNull()
    expect(getOverviewSuccessRate({ success: 5, failure: 0, total: -10 })).toBeNull()
  })

  it('rejects missing or non-numeric total', () => {
    expect(getOverviewSuccessRate({ success: 10, failure: 0, total: null })).toBeNull()
    expect(getOverviewSuccessRate({ success: 10, failure: 0 } as Counts)).toBeNull()
    expect(getOverviewSuccessRate({ success: 10, failure: 0, total: Infinity })).toBeNull()
    expect(getOverviewSuccessRate({ success: 10, failure: 0, total: NaN })).toBeNull()
    expect(
      getOverviewSuccessRate({ success: 10, failure: 0, total: '10' as unknown as number }),
    ).toBeNull()
  })

  it('rejects missing or invalid success values', () => {
    expect(getOverviewSuccessRate({ success: null, failure: 0, total: 10 })).toBeNull()
    expect(getOverviewSuccessRate({ failure: 0, total: 10 } as Counts)).toBeNull()
    expect(getOverviewSuccessRate({ success: -1, failure: 11, total: 10 })).toBeNull()
    expect(getOverviewSuccessRate({ success: Infinity, failure: 0, total: 10 })).toBeNull()
    expect(getOverviewSuccessRate({ success: NaN, failure: 0, total: 10 })).toBeNull()
    expect(
      getOverviewSuccessRate({ success: '5' as unknown as number, failure: 0, total: 10 }),
    ).toBeNull()
  })

  it('rejects counts when success exceeds total', () => {
    expect(getOverviewSuccessRate({ success: 11, failure: 0, total: 10 })).toBeNull()
    expect(getOverviewSuccessRate({ success: 100, failure: 0, total: 50 })).toBeNull()
  })

  it('rejects non-object, null, and primitive inputs', () => {
    expect(getOverviewSuccessRate(null as unknown as Counts)).toBeNull()
    expect(getOverviewSuccessRate(undefined as unknown as Counts)).toBeNull()
    expect(getOverviewSuccessRate('invalid' as unknown as Counts)).toBeNull()
    expect(getOverviewSuccessRate(123 as unknown as Counts)).toBeNull()
    expect(getOverviewSuccessRate([] as unknown as Counts)).toBeNull()
  })
})

describe('loadNodeInfo', () => {
  beforeEach(() => {
    document.head.innerHTML = '<meta name="gcli-service-base" content="/">'
    setSessionToken(null)
    vi.stubEnv('VITE_UI_FIXTURES', 'false')
  })

  it('loads version/info with check_update:false and readSafeConfig independently on success', async () => {
    const fetchMock = mockTransport({
      versionData: createVersionPayload({
        version: '2.5.0',
        display_version: 'v2.5.0',
        full_hash: '1234567890abcdef',
        message: 'v2.5.0 release',
        date: '2026-10-14',
        source_ref: 'refs/tags/v2.5.0',
        commit_date: '2026-10-14T08:00:00Z',
      }),
      configData: createSafeConfigPayload('https://codeassist.enterprise.internal'),
    })

    const controller = new AbortController()
    const result = await loadNodeInfo(controller.signal)

    expect(result.version).toEqual({
      value: {
        version: '2.5.0',
        display_version: 'v2.5.0',
        full_hash: '1234567890abcdef',
        message: 'v2.5.0 release',
        date: '2026-10-14',
        source_ref: 'refs/tags/v2.5.0',
        commit_date: '2026-10-14T08:00:00Z',
      },
      issue: null,
    })
    expect(result.codeAssistEndpoint).toEqual({
      value: 'https://codeassist.enterprise.internal',
      issue: null,
    })

    // Verify calls and exact query parameters
    const calledUrls = fetchMock.mock.calls.map((call) => {
      const input = call[0]
      return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    })
    expect(calledUrls).toHaveLength(2)
    expect(calledUrls.some((u) => u.includes('version/info?check_update=false'))).toBe(true)
    expect(calledUrls.some((u) => u.includes('config/get?include_secrets=false'))).toBe(true)
  })

  it('reports independent fixed unavailability when version endpoint fails', async () => {
    mockTransport({
      versionStatus: 500,
      configData: createSafeConfigPayload('https://codeassist.google.com'),
    })

    const controller = new AbortController()
    const result = await loadNodeInfo(controller.signal)

    expect(result.version).toEqual({
      value: null,
      issue: '版本信息不可用',
    })
    expect(result.codeAssistEndpoint).toEqual({
      value: 'https://codeassist.google.com',
      issue: null,
    })
  })

  it('reports independent fixed unavailability when config endpoint fails', async () => {
    mockTransport({
      versionData: createVersionPayload({ version: '1.0.0' }),
      configStatus: 500,
    })

    const controller = new AbortController()
    const result = await loadNodeInfo(controller.signal)

    expect(result.version).toEqual({
      value: {
        version: '1.0.0',
        display_version: 'v1.2.3',
        full_hash: 'abcdef1234567890',
        message: 'release 1.2.3',
        date: '2026-10-14',
        source_ref: 'refs/tags/v1.2.3',
        commit_date: '2026-10-14T10:00:00Z',
      },
      issue: null,
    })
    expect(result.codeAssistEndpoint).toEqual({
      value: null,
      issue: '代码助手端点不可用',
    })
  })

  it('reports independent fixed unavailability when version throws network TypeError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (url.includes('version/info')) {
          throw new TypeError('Network connection refused for version')
        }
        if (url.includes('config/get')) {
          return new Response(
            JSON.stringify(createSafeConfigPayload('https://codeassist.google.com')),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            },
          )
        }
        return new Response('Not found', { status: 404 })
      }),
    )

    const controller = new AbortController()
    const result = await loadNodeInfo(controller.signal)

    expect(result.version).toEqual({
      value: null,
      issue: '版本信息不可用',
    })
    expect(result.codeAssistEndpoint).toEqual({
      value: 'https://codeassist.google.com',
      issue: null,
    })
  })

  it('reports independent fixed unavailability when config throws network TypeError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (url.includes('version/info')) {
          return new Response(JSON.stringify(createVersionPayload({ version: '1.0.0' })), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        if (url.includes('config/get')) {
          throw new TypeError('Network connection reset for config')
        }
        return new Response('Not found', { status: 404 })
      }),
    )

    const controller = new AbortController()
    const result = await loadNodeInfo(controller.signal)

    expect(result.version.value?.version).toBe('1.0.0')
    expect(result.version.issue).toBeNull()
    expect(result.codeAssistEndpoint).toEqual({
      value: null,
      issue: '代码助手端点不可用',
    })
  })

  it('reports both fixed unavailability issues when both endpoints fail', async () => {
    mockTransport({
      versionStatus: 500,
      configStatus: 503,
    })

    const controller = new AbortController()
    const result = await loadNodeInfo(controller.signal)

    expect(result).toEqual({
      version: { value: null, issue: '版本信息不可用' },
      codeAssistEndpoint: { value: null, issue: '代码助手端点不可用' },
    })
  })

  it('fences pre-aborted signal synchronously before executing requests', async () => {
    const fetchMock = mockTransport()
    const controller = new AbortController()
    controller.abort(new DOMException('Operation aborted early.', 'AbortError'))

    await expect(loadNodeInfo(controller.signal)).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('re-throws when signal is aborted during in-flight fetch', async () => {
    const controller = new AbortController()
    mockTransport({
      delayMs: 20,
    })

    const promise = loadNodeInfo(controller.signal)
    controller.abort(new DOMException('Aborted in flight.', 'AbortError'))

    await expect(promise).rejects.toThrow()
  })

  it('fences and rejects when signal is aborted even if transport ignores the abort', async () => {
    const controller = new AbortController()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        // Transport deliberately ignores signal abort and resolves data
        controller.abort()
        return new Response(JSON.stringify(createVersionPayload()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }),
    )

    await expect(loadNodeInfo(controller.signal)).rejects.toThrow()
  })

  it('rejects with session error when session epoch changes during in-flight fetch', async () => {
    const controller = new AbortController()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        // Simulate session invalidation or token update while request is in flight
        setSessionToken('new-session-token')
        return new Response(JSON.stringify(createVersionPayload()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }),
    )

    await expect(loadNodeInfo(controller.signal)).rejects.toThrow('会话已变更，请重新读取。')
  })

  it('keeps loadNodeInfo channel-independent when panel channel switches in flight', async () => {
    const controller = new AbortController()
    mockTransport({
      versionData: createVersionPayload({ version: '3.0.0' }),
      configData: createSafeConfigPayload('https://codeassist.example.com'),
    })

    const promise = loadNodeInfo(controller.signal)

    // Switching channel or invalidating channel must not abort or disrupt loadNodeInfo
    __commitPanelChannel('geminicli')
    __invalidatePanelChannel()

    const result = await promise
    expect(result.version.value?.version).toBe('3.0.0')
    expect(result.codeAssistEndpoint.value).toBe('https://codeassist.example.com')
  })

  it('returns fixed unavailable structure and calls neither transport when DEV fixture mode is enabled', async () => {
    vi.stubEnv('VITE_UI_FIXTURES', 'true')
    const fetchMock = vi.fn(() => Promise.reject(new Error('Transport should not be called')))
    vi.stubGlobal('fetch', fetchMock)

    const controller = new AbortController()
    const result = await loadNodeInfo(controller.signal)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result).toEqual({
      version: { value: null, issue: '版本信息不可用' },
      codeAssistEndpoint: { value: null, issue: '代码助手端点不可用' },
    })
  })
})
