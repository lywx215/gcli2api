import { createServiceUrl, getServiceBase, requestJson } from '@/api/client'
import { readSafeConfig } from '@/api/config'
import { getSessionSnapshot } from '@/auth/session'
import { isPanelMode, type PanelMode } from '@/domain/panel'
import type { Counts, Observation } from './types'

export type NodeVersion = {
  version?: string
  display_version?: string
  full_hash?: string
  message?: string
  date?: string
  source_ref?: string
  commit_date?: string
}

export type NodeOverviewData = {
  version: Observation<NodeVersion>
  codeAssistEndpoint: Observation<string>
}

export type OverviewApiAddress = {
  id: 'openai' | 'claude' | 'gemini'
  label: string
  url: string
}

const UNAVAILABLE_VERSION = '版本信息不可用'
const UNAVAILABLE_CODE_ASSIST = '代码助手端点不可用'
const UNAVAILABLE_API_ADDRESSES = '服务地址不可用'

const ALLOWED_VERSION_FIELDS = [
  'version',
  'display_version',
  'full_hash',
  'message',
  'date',
  'source_ref',
  'commit_date',
] as const

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true
  if (error instanceof Error && error.name === 'AbortError') return true
  if (typeof error === 'object' && error !== null && 'name' in error && (error as { name: unknown }).name === 'AbortError') return true
  return false
}

function assertSessionAndSignal(signal: AbortSignal, expectedSessionEpoch: number): void {
  if (signal.aborted) {
    if (typeof signal.throwIfAborted === 'function') {
      signal.throwIfAborted()
    }
    throw new DOMException(signal.reason ? String(signal.reason) : '操作已被中止。', 'AbortError')
  }
  if (getSessionSnapshot().sessionEpoch !== expectedSessionEpoch) {
    throw new DOMException('会话已变更，请重新读取。', 'AbortError')
  }
}

export function normalizeNodeVersion(raw: unknown): Observation<NodeVersion> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { value: null, issue: UNAVAILABLE_VERSION }
  }
  const rec = raw as Record<string, unknown>
  if (rec.success !== true) {
    return { value: null, issue: UNAVAILABLE_VERSION }
  }

  const isUsable = (val: unknown): val is string =>
    typeof val === 'string' && val.trim().length > 0 && val.trim().toLowerCase() !== 'unknown'

  const hasUsableVersion = isUsable(rec.version) || isUsable(rec.display_version)
  if (!hasUsableVersion) {
    return { value: null, issue: UNAVAILABLE_VERSION }
  }

  const versionData: NodeVersion = {}
  for (const field of ALLOWED_VERSION_FIELDS) {
    const val = rec[field]
    if (typeof val === 'string') {
      versionData[field] = val
    }
  }

  return { value: versionData, issue: null }
}

function extractRawCodeAssistEndpoint(raw: unknown): unknown {
  if (typeof raw === 'string') {
    return raw
  }
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const rec = raw as Record<string, unknown>
    if (typeof rec.config === 'object' && rec.config !== null && !Array.isArray(rec.config)) {
      return (rec.config as Record<string, unknown>).code_assist_endpoint
    }
    if ('code_assist_endpoint' in rec) {
      return rec.code_assist_endpoint
    }
  }
  return undefined
}

function isValidCodeAssistUrl(raw: string): boolean {
  if (typeof raw !== 'string') return false
  const trimmed = raw.trim()
  if (!trimmed || trimmed !== raw) return false

  // Reject control characters (0x00-0x1F, 0x7F) and any whitespace
  if (/[\x00-\x1f\x7f\s]/.test(raw)) return false

  // Reject userinfo (@), query (?), hash (#)
  if (raw.includes('@') || raw.includes('?') || raw.includes('#')) return false

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return false
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false
  }

  if (parsed.username || parsed.password) {
    return false
  }

  if (parsed.search || parsed.hash) {
    return false
  }

  if (!parsed.hostname) {
    return false
  }

  return true
}

export function normalizeCodeAssistEndpoint(raw: unknown): Observation<string> {
  const candidate = extractRawCodeAssistEndpoint(raw)
  if (typeof candidate !== 'string' || !isValidCodeAssistUrl(candidate)) {
    return { value: null, issue: UNAVAILABLE_CODE_ASSIST }
  }

  return { value: candidate, issue: null }
}

export function getOverviewApiAddresses(
  mode: PanelMode,
): Observation<readonly OverviewApiAddress[]> {
  if (!isPanelMode(mode)) {
    return { value: null, issue: UNAVAILABLE_API_ADDRESSES }
  }

  let base: string
  try {
    base = getServiceBase()
  } catch {
    return { value: null, issue: UNAVAILABLE_API_ADDRESSES }
  }

  try {
    if (mode === 'antigravity') {
      const openAiUrl = createServiceUrl('antigravity/v1').href
      const claudeUrl = createServiceUrl('antigravity/v1').href
      const geminiUrl = createServiceUrl('antigravity').href
      const addresses: readonly OverviewApiAddress[] = Object.freeze([
        Object.freeze({ id: 'openai', label: 'OpenAI', url: openAiUrl }),
        Object.freeze({ id: 'claude', label: 'Claude', url: claudeUrl }),
        Object.freeze({ id: 'gemini', label: 'Gemini', url: geminiUrl }),
      ])
      return { value: addresses, issue: null }
    } else {
      const openAiUrl = createServiceUrl('v1').href
      const claudeUrl = createServiceUrl('v1').href
      const geminiUrl = base
      const addresses: readonly OverviewApiAddress[] = Object.freeze([
        Object.freeze({ id: 'openai', label: 'OpenAI', url: openAiUrl }),
        Object.freeze({ id: 'claude', label: 'Claude', url: claudeUrl }),
        Object.freeze({ id: 'gemini', label: 'Gemini', url: geminiUrl }),
      ])
      return { value: addresses, issue: null }
    }
  } catch {
    return { value: null, issue: UNAVAILABLE_API_ADDRESSES }
  }
}

export function getOverviewSuccessRate(counts: Counts): number | null {
  if (!counts || typeof counts !== 'object') {
    return null
  }
  const { success, total } = counts
  if (
    typeof success !== 'number' ||
    !Number.isFinite(success) ||
    success < 0 ||
    typeof total !== 'number' ||
    !Number.isFinite(total) ||
    total <= 0 ||
    success > total
  ) {
    return null
  }
  return (100 * success) / total
}

async function fetchVersionObservation(
  signal: AbortSignal,
  expectedSessionEpoch: number,
): Promise<Observation<NodeVersion>> {
  assertSessionAndSignal(signal, expectedSessionEpoch)
  try {
    const raw = await requestJson<unknown>('version/info', {
      method: 'GET',
      query: { check_update: false },
      signal,
    })
    assertSessionAndSignal(signal, expectedSessionEpoch)
    return normalizeNodeVersion(raw)
  } catch (error) {
    assertSessionAndSignal(signal, expectedSessionEpoch)
    if (signal.aborted || isAbortError(error)) {
      throw error
    }
    return { value: null, issue: UNAVAILABLE_VERSION }
  }
}

async function fetchCodeAssistObservation(
  signal: AbortSignal,
  expectedSessionEpoch: number,
): Promise<Observation<string>> {
  assertSessionAndSignal(signal, expectedSessionEpoch)
  try {
    const safeConfig = await readSafeConfig(signal)
    assertSessionAndSignal(signal, expectedSessionEpoch)
    return normalizeCodeAssistEndpoint(safeConfig)
  } catch (error) {
    assertSessionAndSignal(signal, expectedSessionEpoch)
    if (signal.aborted || isAbortError(error)) {
      throw error
    }
    return { value: null, issue: UNAVAILABLE_CODE_ASSIST }
  }
}

export async function loadNodeInfo(signal: AbortSignal): Promise<NodeOverviewData> {
  const sessionEpoch = getSessionSnapshot().sessionEpoch
  assertSessionAndSignal(signal, sessionEpoch)

  if (import.meta.env.DEV && import.meta.env.VITE_UI_FIXTURES === 'true') {
    return {
      version: { value: null, issue: UNAVAILABLE_VERSION },
      codeAssistEndpoint: { value: null, issue: UNAVAILABLE_CODE_ASSIST },
    }
  }

  assertSessionAndSignal(signal, sessionEpoch)
  try {
    const [version, codeAssistEndpoint] = await Promise.all([
      fetchVersionObservation(signal, sessionEpoch),
      fetchCodeAssistObservation(signal, sessionEpoch),
    ])
    assertSessionAndSignal(signal, sessionEpoch)
    return { version, codeAssistEndpoint }
  } catch (error) {
    assertSessionAndSignal(signal, sessionEpoch)
    if (signal.aborted || isAbortError(error)) {
      throw error
    }
    return {
      version: { value: null, issue: UNAVAILABLE_VERSION },
      codeAssistEndpoint: { value: null, issue: UNAVAILABLE_CODE_ASSIST },
    }
  }
}
