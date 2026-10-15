import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, requestJson } from '@/api/client'
import {
  __commitPanelChannel,
  capturePanelScope,
  type PanelMode,
  type PanelScope,
} from '@/domain/panel'
import { getSessionSnapshot, setSessionToken } from '@/auth/session'
import { previewEmail, previewResult } from './fixtures'
import {
  createImportApi,
  failureMessage,
  importTokens,
  normalizeResult,
  projectPrompt,
  readEmailJobs,
  readImportCapabilities,
  uploadFiles,
} from './api'
import type {
  ImportRequestContext,
  ImportResult,
  ProjectOption,
  ProjectPrompt,
} from './types'

vi.mock('@/api/client', () => {
  class MockApiError extends Error {
    constructor(
      public status: number,
      public payload: unknown,
      message = `HTTP ${status}`,
    ) {
      super(message)
      this.name = 'ApiError'
    }
  }

  return {
    requestJson: vi.fn(),
    ApiError: MockApiError,
  }
})

function getCurrentScope(mode: PanelMode = 'antigravity'): PanelScope {
  __commitPanelChannel(mode)
  const sessionEpoch = getSessionSnapshot().sessionEpoch
  return capturePanelScope(sessionEpoch)
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('VITE_UI_FIXTURES', 'false')
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(() => {
      throw new Error('Unexpected network fetch call in test')
    }),
  )
  __commitPanelChannel('antigravity')
  setSessionToken('synthetic-test-token', false)
})

describe('normalizeResult projection and boundaries', () => {
  it('handles zero, empty, and malformed inputs returning fallback unknown state', () => {
    const nullResult = normalizeResult(null)
    expect(nullResult.outcome).toBe('unknown')
    expect(nullResult.items).toEqual([{ label: '第 1 项', status: 'unknown' }])
    expect(nullResult.warnings).toBe(0)
    expect(nullResult.confirmedFilenames).toBeUndefined()

    const undefinedResult = normalizeResult(undefined)
    expect(undefinedResult.outcome).toBe('unknown')
    expect(undefinedResult.items).toEqual([{ label: '第 1 项', status: 'unknown' }])

    const emptyObjResult = normalizeResult({})
    expect(emptyObjResult.outcome).toBe('unknown')
    expect(emptyObjResult.items).toEqual([{ label: '第 1 项', status: 'unknown' }])

    const emptyResultsArray = normalizeResult({ results: [] })
    expect(emptyResultsArray.outcome).toBe('unknown')
    expect(emptyResultsArray.items).toEqual([])
    expect(emptyResultsArray.confirmedFilenames).toBeUndefined()

    const malformedString = normalizeResult('invalid-payload')
    expect(malformedString.outcome).toBe('unknown')
    expect(malformedString.items).toEqual([{ label: '第 1 项', status: 'unknown' }])

    const malformedNumber = normalizeResult(404)
    expect(malformedNumber.outcome).toBe('unknown')
    expect(malformedNumber.items).toEqual([{ label: '第 1 项', status: 'unknown' }])

    const zeroTotalResult = normalizeResult({ total_count: 0 })
    expect(zeroTotalResult.outcome).toBe('unknown')
    expect(zeroTotalResult.confirmedFilenames).toBeUndefined()

    const zeroTotalProp = normalizeResult({ total: 0 })
    expect(zeroTotalProp.outcome).toBe('unknown')
  })

  it('projects explicit single and batch successes and failures', () => {
    const singleSuccess = normalizeResult({ success: true, filename: 'cred-alpha.json' })
    expect(singleSuccess.outcome).toBe('success')
    expect(singleSuccess.items).toEqual([{ label: 'cred-alpha.json', status: 'success' }])
    expect(singleSuccess.confirmedFilenames).toEqual(['cred-alpha.json'])

    const singleStatusSuccess = normalizeResult({ status: 'success', filename: 'cred-beta.json' })
    expect(singleStatusSuccess.outcome).toBe('success')
    expect(singleStatusSuccess.confirmedFilenames).toEqual(['cred-beta.json'])

    const singleFailure = normalizeResult({ success: false, filename: 'failed.json' })
    expect(singleFailure.outcome).toBe('failed')
    expect(singleFailure.items).toEqual([{ label: 'failed.json', status: 'failed' }])
    expect(singleFailure.confirmedFilenames).toBeUndefined()

    const singleStatusFailed = normalizeResult({ status: 'failed', filename: 'failed.json' })
    expect(singleStatusFailed.outcome).toBe('failed')

    const singleStatusError = normalizeResult({ status: 'error', filename: 'failed.json' })
    expect(singleStatusError.outcome).toBe('failed')

    const singleErrorMsg = normalizeResult({ error: 'Auth failed', filename: 'failed.json' })
    expect(singleErrorMsg.outcome).toBe('failed')

    const singleErrorCode = normalizeResult({ error_code: 'RATE_LIMIT', filename: 'failed.json' })
    expect(singleErrorCode.outcome).toBe('failed')

    const batchSuccess = normalizeResult({
      results: [
        { status: 'success', filename: 'item-1.json' },
        { success: true, filename: 'item-2.json' },
      ],
    })
    expect(batchSuccess.outcome).toBe('success')
    expect(batchSuccess.items).toHaveLength(2)
    expect(batchSuccess.confirmedFilenames).toEqual(['item-1.json', 'item-2.json'])

    const batchFailure = normalizeResult({
      results: [
        { status: 'failed', filename: 'item-1.json' },
        { success: false, filename: 'item-2.json' },
      ],
    })
    expect(batchFailure.outcome).toBe('failed')
    expect(batchFailure.confirmedFilenames).toBeUndefined()
  })

  it('identifies partial outcomes and unknown rows correctly', () => {
    const partialResult = normalizeResult({
      results: [
        { status: 'success', filename: 'ok.json' },
        { status: 'failed', filename: 'fail.json' },
      ],
    })
    expect(partialResult.outcome).toBe('partial')
    expect(partialResult.confirmedFilenames).toEqual(['ok.json'])

    const unknownRowResult = normalizeResult({
      results: [
        { status: 'processing', filename: 'processing.json' },
        { status: 'success', filename: 'ok.json' },
      ],
    })
    expect(unknownRowResult.outcome).toBe('unknown')
    expect(unknownRowResult.items[0]).toEqual({ label: 'processing.json', status: 'unknown' })
    expect(unknownRowResult.items[1]).toEqual({ label: 'ok.json', status: 'success' })
    expect(unknownRowResult.confirmedFilenames).toEqual(['ok.json'])
  })

  it('marks rows with contradictory success:false and status:success as unknown without confirmed filenames', () => {
    const contradictFalseAndSuccess = normalizeResult({
      results: [{ status: 'success', success: false, filename: 'conflict.json' }],
    })
    expect(contradictFalseAndSuccess.outcome).toBe('unknown')
    expect(contradictFalseAndSuccess.items[0].status).toBe('unknown')
    expect(contradictFalseAndSuccess.confirmedFilenames).toBeUndefined()

    const contradictSuccessAndError = normalizeResult({
      results: [{ status: 'success', error: 'Internal failure', filename: 'conflict.json' }],
    })
    expect(contradictSuccessAndError.outcome).toBe('unknown')
    expect(contradictSuccessAndError.items[0].status).toBe('unknown')
    expect(contradictSuccessAndError.confirmedFilenames).toBeUndefined()

    const contradictSuccessAndErrorCode = normalizeResult({
      results: [{ status: 'success', error_code: 'ERR_001', filename: 'conflict.json' }],
    })
    expect(contradictSuccessAndErrorCode.outcome).toBe('unknown')
    expect(contradictSuccessAndErrorCode.items[0].status).toBe('unknown')
    expect(contradictSuccessAndErrorCode.confirmedFilenames).toBeUndefined()

    const contradictErrorAndSuccess = normalizeResult({
      results: [{ status: 'error', success: true, filename: 'conflict.json' }],
    })
    expect(contradictErrorAndSuccess.outcome).toBe('unknown')
    expect(contradictErrorAndSuccess.items[0].status).toBe('unknown')
    expect(contradictErrorAndSuccess.confirmedFilenames).toBeUndefined()
  })

  it('denies all-success promotion when valid aggregate counters contradict row counts', () => {
    const successCountTooLow = normalizeResult({
      results: [
        { status: 'success', filename: 'a.json' },
        { status: 'success', filename: 'b.json' },
      ],
      success_count: 1,
    })
    expect(successCountTooLow.outcome).toBe('unknown')
    expect(successCountTooLow.confirmedFilenames).toBeUndefined()

    const successCountTooHigh = normalizeResult({
      results: [{ status: 'success', filename: 'a.json' }],
      success_count: 5,
    })
    expect(successCountTooHigh.outcome).toBe('unknown')
    expect(successCountTooHigh.confirmedFilenames).toBeUndefined()

    const failedCountMismatch = normalizeResult({
      results: [{ status: 'success', filename: 'a.json' }],
      failed_count: 1,
    })
    expect(failedCountMismatch.outcome).toBe('unknown')
    expect(failedCountMismatch.confirmedFilenames).toBeUndefined()

    const totalCountMismatch = normalizeResult({
      results: [{ status: 'success', filename: 'a.json' }],
      total_count: 3,
    })
    expect(totalCountMismatch.outcome).toBe('unknown')
    expect(totalCountMismatch.confirmedFilenames).toBeUndefined()

    const aggregateSumExceedsRows = normalizeResult({
      results: [{ status: 'success', filename: 'a.json' }],
      success_count: 1,
      failed_count: 1,
    })
    expect(aggregateSumExceedsRows.outcome).toBe('unknown')
    expect(aggregateSumExceedsRows.confirmedFilenames).toBeUndefined()

    const zeroTotalWithSuccessRow = normalizeResult({
      results: [{ status: 'success', filename: 'a.json' }],
      total_count: 0,
    })
    expect(zeroTotalWithSuccessRow.outcome).toBe('unknown')
    expect(zeroTotalWithSuccessRow.confirmedFilenames).toBeUndefined()

    const consistentAggregate = normalizeResult({
      results: [
        { status: 'success', filename: 'a.json' },
        { status: 'success', filename: 'b.json' },
      ],
      success_count: 2,
      total_count: 2,
      failed_count: 0,
    })
    expect(consistentAggregate.outcome).toBe('success')
    expect(consistentAggregate.confirmedFilenames).toEqual(['a.json', 'b.json'])

    const aggregateUploadedFallback = normalizeResult({
      results: [{ status: 'success', filename: 'a.json' }],
      uploaded_count: 1,
      total: 1,
    })
    expect(aggregateUploadedFallback.outcome).toBe('success')
    expect(aggregateUploadedFallback.confirmedFilenames).toEqual(['a.json'])

    const aggregateUploadedMismatch = normalizeResult({
      results: [{ status: 'success', filename: 'a.json' }],
      uploaded_count: 0,
    })
    expect(aggregateUploadedMismatch.outcome).toBe('unknown')
    expect(aggregateUploadedMismatch.confirmedFilenames).toBeUndefined()
  })

  it('handles OAuth mode: false+file_path and error+file_path remain failed; file_path alone is unknown', () => {
    const oauthFalseWithPath = normalizeResult({ success: false, file_path: 'cred.json' }, true)
    expect(oauthFalseWithPath.outcome).toBe('failed')
    expect(oauthFalseWithPath.items).toEqual([{ label: 'OAuth 凭证', status: 'failed' }])
    expect(oauthFalseWithPath.confirmedFilenames).toBeUndefined()

    const oauthErrorWithPath = normalizeResult({ error: 'Auth failed', file_path: 'cred.json' }, true)
    expect(oauthErrorWithPath.outcome).toBe('failed')
    expect(oauthErrorWithPath.items).toEqual([{ label: 'OAuth 凭证', status: 'failed' }])
    expect(oauthErrorWithPath.confirmedFilenames).toBeUndefined()

    const oauthPathAlone = normalizeResult({ file_path: 'cred.json' }, true)
    expect(oauthPathAlone.outcome).toBe('unknown')
    expect(oauthPathAlone.items).toEqual([{ label: 'OAuth 凭证', status: 'unknown' }])
    expect(oauthPathAlone.confirmedFilenames).toBeUndefined()

    const oauthSuccessWithPath = normalizeResult({ success: true, file_path: 'cred.json' }, true)
    expect(oauthSuccessWithPath.outcome).toBe('success')
    expect(oauthSuccessWithPath.items).toEqual([{ label: 'OAuth 凭证', status: 'success' }])
    expect(oauthSuccessWithPath.confirmedFilenames).toBeUndefined()
  })

  it('rejects foreign response modes and mode mismatches', () => {
    expect(() => normalizeResult({ mode: 'unsupported_vendor' })).toThrow('Response mode mismatch')
    expect(() => normalizeResult({ mode: 'vertex' })).toThrow('Response mode mismatch')

    expect(() => normalizeResult({ mode: 'geminicli' }, false, 'antigravity')).toThrow(
      'Response mode mismatch',
    )
    expect(() => normalizeResult({ mode: 'antigravity' }, false, 'geminicli')).toThrow(
      'Response mode mismatch',
    )

    expect(() => normalizeResult({ results: [{ mode: 'unsupported' }] })).toThrow(
      'Response mode mismatch',
    )
    expect(() =>
      normalizeResult({ results: [{ mode: 'geminicli' }] }, false, 'antigravity'),
    ).toThrow('Response mode mismatch')

    const validModeResult = normalizeResult(
      {
        mode: 'antigravity',
        results: [{ mode: 'antigravity', status: 'success', filename: 'ok.json' }],
      },
      false,
      'antigravity',
    )
    expect(validModeResult.outcome).toBe('success')
  })

  it('validates strict basenames and falls back gracefully for invalid labels', () => {
    const validBasenames = normalizeResult({
      results: [
        { status: 'success', filename: 'alpha.json' },
        { status: 'success', filename: 'my_cred-123.json' },
      ],
    })
    expect(validBasenames.items[0].label).toBe('alpha.json')
    expect(validBasenames.items[1].label).toBe('my_cred-123.json')
    expect(validBasenames.confirmedFilenames).toEqual(['alpha.json', 'my_cred-123.json'])

    const forwardSlash = normalizeResult({ results: [{ status: 'success', filename: 'dir/token.json' }] })
    expect(forwardSlash.items[0].label).toBe('第 1 项')
    expect(forwardSlash.confirmedFilenames).toBeUndefined()

    const backSlash = normalizeResult({ results: [{ status: 'success', filename: 'C:\\token.json' }] })
    expect(backSlash.items[0].label).toBe('第 1 项')
    expect(backSlash.confirmedFilenames).toBeUndefined()

    const relativePath = normalizeResult({ results: [{ status: 'success', filename: '../token.json' }] })
    expect(relativePath.items[0].label).toBe('第 1 项')
    expect(relativePath.confirmedFilenames).toBeUndefined()

    const dotName = normalizeResult({ results: [{ status: 'success', filename: '.' }] })
    expect(dotName.items[0].label).toBe('第 1 项')

    const untrimmedFilename = normalizeResult({ results: [{ status: 'success', filename: ' spaced.json ' }] })
    expect(untrimmedFilename.items[0].label).toBe('第 1 项')
    expect(untrimmedFilename.confirmedFilenames).toBeUndefined()

    const controlCharFilename = normalizeResult({
      results: [{ status: 'success', filename: 'token\x00.json' }],
    })
    expect(controlCharFilename.items[0].label).toBe('第 1 项')
    expect(controlCharFilename.confirmedFilenames).toBeUndefined()

    const longFilename = normalizeResult({
      results: [{ status: 'success', filename: 'a'.repeat(251) + '.json' }],
    })
    expect(longFilename.items[0].label).toBe('第 1 项')
    expect(longFilename.confirmedFilenames).toBeUndefined()

    const oauthFallback = normalizeResult({ filename: 'invalid/oauth.json', success: true }, true)
    expect(oauthFallback.items[0].label).toBe('OAuth 凭证')
    expect(oauthFallback.confirmedFilenames).toBeUndefined()
  })

  it('accumulates top-level and per-row warning counts', () => {
    const topLevelWarnings = normalizeResult({
      warnings: ['warn1', 'warn2'],
      status: 'success',
      filename: 'a.json',
    })
    expect(topLevelWarnings.warnings).toBe(2)

    const rowLevelWarnings = normalizeResult({
      results: [
        { status: 'success', filename: 'a.json', warnings: ['w1'] },
        { status: 'success', filename: 'b.json', warnings: ['w2', 'w3'] },
      ],
    })
    expect(rowLevelWarnings.warnings).toBe(3)

    const combinedWarnings = normalizeResult({
      warnings: ['top1'],
      results: [{ status: 'success', filename: 'a.json', warnings: ['row1', 'row2'] }],
    })
    expect(combinedWarnings.warnings).toBe(3)

    const nonArrayWarnings = normalizeResult({
      warnings: 'not-an-array',
      results: [{ status: 'success', filename: 'a.json', warnings: 12345 }],
    })
    expect(nonArrayWarnings.warnings).toBe(0)
  })

  it('strips credentials, token previews, and raw errors from the projected result', () => {
    const rawPoisoned = {
      status: 'success',
      filename: 'safe-file.json',
      credential: {
        refresh_token: 'SECRET_REFRESH_TOKEN_123',
        access_token: 'SECRET_ACCESS_TOKEN_456',
        client_secret: 'SECRET_CLIENT_SECRET_789',
      },
      token_preview: 'SECRET_TOKEN_PREVIEW',
      error: 'SECRET_STACK_TRACE',
      error_code: 'SECRET_ERROR_CODE',
      private_key: 'SECRET_PRIVATE_KEY',
      other_leak: 'SECRET_LEAK',
    }
    const result = normalizeResult(rawPoisoned)
    const serialized = JSON.stringify(result)

    expect(serialized).not.toContain('SECRET_REFRESH_TOKEN_123')
    expect(serialized).not.toContain('SECRET_ACCESS_TOKEN_456')
    expect(serialized).not.toContain('SECRET_CLIENT_SECRET_789')
    expect(serialized).not.toContain('SECRET_TOKEN_PREVIEW')
    expect(serialized).not.toContain('SECRET_STACK_TRACE')
    expect(serialized).not.toContain('SECRET_ERROR_CODE')
    expect(serialized).not.toContain('SECRET_PRIVATE_KEY')
    expect(serialized).not.toContain('SECRET_LEAK')

    expect(result.outcome).toBe('unknown')
    expect(result.items).toEqual([{ label: 'safe-file.json', status: 'unknown' }])
    expect(result.confirmedFilenames).toBeUndefined()
    expect(Object.keys(result).sort()).toEqual(
      ['items', 'outcome', 'warnings'].sort(),
    )

    const cleanSuccessPoisoned = {
      status: 'success',
      filename: 'safe-file.json',
      credential: {
        refresh_token: 'SECRET_REFRESH_TOKEN_123',
        access_token: 'SECRET_ACCESS_TOKEN_456',
        client_secret: 'SECRET_CLIENT_SECRET_789',
      },
      token_preview: 'SECRET_TOKEN_PREVIEW',
      private_key: 'SECRET_PRIVATE_KEY',
      other_leak: 'SECRET_LEAK',
    }
    const cleanResult = normalizeResult(cleanSuccessPoisoned)
    const cleanSerialized = JSON.stringify(cleanResult)

    expect(cleanSerialized).not.toContain('SECRET_REFRESH_TOKEN_123')
    expect(cleanSerialized).not.toContain('SECRET_ACCESS_TOKEN_456')
    expect(cleanSerialized).not.toContain('SECRET_CLIENT_SECRET_789')
    expect(cleanSerialized).not.toContain('SECRET_TOKEN_PREVIEW')
    expect(cleanSerialized).not.toContain('SECRET_PRIVATE_KEY')
    expect(cleanSerialized).not.toContain('SECRET_LEAK')

    expect(cleanResult.outcome).toBe('success')
    expect(cleanResult.items).toEqual([{ label: 'safe-file.json', status: 'success' }])
    expect(cleanResult.confirmedFilenames).toEqual(['safe-file.json'])
    expect(Object.keys(cleanResult).sort()).toEqual(
      ['confirmedFilenames', 'items', 'outcome', 'warnings'].sort(),
    )
  })

  it('extracts valid antigravity jobId and drops invalid formats or geminicli jobId', () => {
    const validHex32 = '0123456789abcdef0123456789abcdef'
    const agResult = normalizeResult(
      {
        status: 'success',
        filename: 'a.json',
        email_enrichment: { job_id: validHex32 },
      },
      false,
      'antigravity',
    )
    expect(agResult.jobId).toBe(validHex32)

    const agInvalidJobId = normalizeResult(
      {
        status: 'success',
        filename: 'a.json',
        email_enrichment: { job_id: 'short-job-id' },
      },
      false,
      'antigravity',
    )
    expect(agInvalidJobId.jobId).toBeUndefined()

    const gcliResult = normalizeResult(
      {
        status: 'success',
        filename: 'a.json',
        email_enrichment: { job_id: validHex32 },
      },
      false,
      'geminicli',
    )
    expect(gcliResult.jobId).toBeUndefined()
  })
})

describe('Confirmed filenames derivation and exclusions', () => {
  it('deduplicates confirmed filenames across multiple successful rows', () => {
    const duplicateRows = normalizeResult({
      results: [
        { status: 'success', filename: 'duplicate.json' },
        { status: 'success', filename: 'duplicate.json' },
        { status: 'success', filename: 'unique.json' },
      ],
    })
    expect(duplicateRows.confirmedFilenames).toEqual(['duplicate.json', 'unique.json'])
  })

  it('excludes label fallbacks, failed rows, unknown rows, and conflicting rows from confirmations', () => {
    const mixedRows = normalizeResult({
      results: [
        { status: 'success', filename: 'valid.json' },
        { status: 'success', filename: 'path/fallback.json' },
        { status: 'failed', filename: 'failed.json' },
        { status: 'pending', filename: 'unknown.json' },
      ],
    })
    expect(mixedRows.confirmedFilenames).toEqual(['valid.json'])
  })

  it('omits confirmedFilenames completely when conflicting aggregate counters invalidate consistency', () => {
    const contradictoryAggregate = normalizeResult({
      results: [
        { status: 'success', filename: 'alpha.json' },
        { status: 'success', filename: 'beta.json' },
      ],
      success_count: 0,
    })
    expect(contradictoryAggregate.confirmedFilenames).toBeUndefined()
  })
})

describe('projectPrompt projection and ProjectOption validation', () => {
  it('projects valid projectOptions with trimmed names, control stripping, bounds, and deduplication', () => {
    const error = new ApiError(400, {
      requires_project_selection: true,
      available_projects: [
        { project_id: 'proj-valid-1', name: '  Valid Project  ' },
        { project_id: 'proj-valid-2', name: null },
        { project_id: 'proj-ctrl-name', name: 'Name\x00WithControl' },
        { project_id: 'proj-long-name', name: 'a'.repeat(251) },
        { project_id: 'proj-empty-name', name: '   ' },
        { project_id: 'proj-number-name', name: 12345 },
        { project_id: '  untrimmed-id  ', name: 'Untrimmed ID' },
        { project_id: 'ctrl\nid', name: 'Control ID' },
        { project_id: '', name: 'Empty ID' },
        { project_id: 'p'.repeat(251), name: 'Overlong ID' },
        { project_id: 'dup-id', name: 'First Occurrence' },
        { project_id: 'dup-id', name: 'Second Occurrence' },
        {
          project_id: 'proj-poisoned',
          name: 'Clean Name',
          secret_key: 'LEAKED_KEY',
          auth_token: 'LEAKED_TOKEN',
        },
      ],
    })

    const prompt = projectPrompt(error)
    expect(prompt).not.toBeNull()
    const options: ProjectOption[] = prompt!.projectOptions ?? []

    expect(options).toEqual([
      { projectId: 'proj-valid-1', name: 'Valid Project' },
      { projectId: 'proj-valid-2', name: null },
      { projectId: 'proj-ctrl-name', name: null },
      { projectId: 'proj-long-name', name: null },
      { projectId: 'proj-empty-name', name: null },
      { projectId: 'proj-number-name', name: null },
      { projectId: 'dup-id', name: 'First Occurrence' },
      { projectId: 'proj-poisoned', name: 'Clean Name' },
    ])

    const serialized = JSON.stringify(prompt)
    expect(serialized).not.toContain('LEAKED_KEY')
    expect(serialized).not.toContain('LEAKED_TOKEN')

    // Legacy projects list preserves strings under 250 length
    expect(prompt!.projects).toContain('  untrimmed-id  ')
    expect(prompt!.projects).toContain('proj-valid-1')
  })

  it('preserves exact manual-only shape when requires_manual_project_id is true', () => {
    const error = new ApiError(400, { requires_manual_project_id: true })
    const prompt: ProjectPrompt | null = projectPrompt(error)
    expect(prompt).toEqual({
      manual: true,
      projects: [],
    })
    expect(prompt?.projectOptions).toBeUndefined()
  })

  it('returns null on non-400 ApiError or when project selection is not requested', () => {
    expect(projectPrompt(new ApiError(500, { requires_project_selection: true }))).toBeNull()
    expect(
      projectPrompt(
        new ApiError(400, {
          requires_project_selection: false,
          requires_manual_project_id: false,
        }),
      ),
    ).toBeNull()
    expect(projectPrompt(new Error('Regular non-api error'))).toBeNull()
    expect(projectPrompt(null)).toBeNull()
    expect(projectPrompt(undefined)).toBeNull()
  })

  it('never dispatches network calls automatically on projectPrompt inspection', () => {
    const error = new ApiError(400, {
      requires_project_selection: true,
      available_projects: [{ project_id: 'p1', name: 'Project 1' }],
    })
    projectPrompt(error)
    expect(requestJson).not.toHaveBeenCalled()
  })
})

describe('failureMessage error formatting', () => {
  it('formats specific ApiError status messages correctly', () => {
    expect(failureMessage(new ApiError(413, {}))).toBe(
      '导入超过服务器资源预算，请缩小文件或拆分批次。此限制与部分成功不同。',
    )
    expect(failureMessage(new ApiError(401, {}))).toBe(
      '认证或授权被拒绝，请检查登录状态与上游授权。',
    )
    expect(failureMessage(new ApiError(403, {}))).toBe(
      '认证或授权被拒绝，请检查登录状态与上游授权。',
    )
    expect(failureMessage(new ApiError(400, {}))).toBe(
      '服务器拒绝了本次请求，请检查输入后再提交。',
    )
    expect(failureMessage(new ApiError(404, {}))).toBe(
      '服务器拒绝了本次请求，请检查输入后再提交。',
    )
    expect(failureMessage(new ApiError(422, {}))).toBe(
      '服务器拒绝了本次请求，请检查输入后再提交。',
    )
    expect(failureMessage(new ApiError(500, { secret: 'hidden' }))).toBe(
      '结果未知：请求可能已保存部分凭证。请先到凭证页查看，勿直接重复提交。',
    )
    expect(failureMessage(new Error('Generic network error'))).toBe(
      '结果未知：请求可能已保存部分凭证。请先到凭证页查看，勿直接重复提交。',
    )
    expect(failureMessage(null)).toBe(
      '结果未知：请求可能已保存部分凭证。请先到凭证页查看，勿直接重复提交。',
    )
  })
})

describe('Public factories and completeOAuth safe OAuth flow', () => {
  it('completeOAuth: confirms validated matching-mode receipt filename and projects receipt', async () => {
    const scope = getCurrentScope('antigravity')
    const ctx: ImportRequestContext = {
      mode: 'antigravity',
      scope,
      oauthCapabilities: ['antigravity.oauth.safe_response'],
    }
    const api = createImportApi(ctx)

    vi.mocked(requestJson).mockResolvedValueOnce({
      success: true,
      mode: 'antigravity',
      filename: 'oauth-receipt.json',
      project_id: 'project-alpha',
      subscription_tier: 'tier-pro',
      auto_detected_project: false,
      warnings: ['warning-token'],
      email_enrichment: { job_id: '0123456789abcdef0123456789abcdef' },
    })

    const result = await api.completeOAuth('http://localhost/callback?code=synthetic', 'project-alpha')

    expect(requestJson).toHaveBeenCalledWith('auth/callback-url', {
      method: 'POST',
      body: {
        mode: 'antigravity',
        project_id: 'project-alpha',
        include_credentials: false,
        callback_url: 'http://localhost/callback?code=synthetic',
      },
      signal: undefined,
      scope: expect.objectContaining({ mode: 'antigravity' }),
    })

    expect(result.outcome).toBe('success')
    expect(result.confirmedFilenames).toEqual(['oauth-receipt.json'])
    expect(result.items).toEqual([{ label: 'oauth-receipt.json', status: 'success' }])
    expect(result.warnings).toBe(1)
    expect(result.jobId).toBe('0123456789abcdef0123456789abcdef')
    expect(result.oauthReceipt).toEqual({
      success: true,
      mode: 'antigravity',
      filename: 'oauth-receipt.json',
      project_id: 'project-alpha',
      subscription_tier: 'tier-pro',
      auto_detected_project: false,
    })
  })

  it('completeOAuth: throws on safe response capability missing', async () => {
    const scope = getCurrentScope('antigravity')
    const api = createImportApi({
      mode: 'antigravity',
      scope,
      oauthCapabilities: [],
    })

    await expect(api.completeOAuth(null, 'project-alpha')).rejects.toThrow(
      '当前服务不支持安全 OAuth 响应。',
    )
  })

  it('completeOAuth: throws on response mode mismatch', async () => {
    const scope = getCurrentScope('antigravity')
    const api = createImportApi({
      mode: 'antigravity',
      scope,
      oauthCapabilities: ['antigravity.oauth.safe_response'],
    })

    vi.mocked(requestJson).mockResolvedValueOnce({
      success: true,
      mode: 'geminicli',
      filename: 'oauth-receipt.json',
      auto_detected_project: true,
    })

    await expect(api.completeOAuth(null, 'project-alpha')).rejects.toThrow(
      'OAuth completion mode mismatch',
    )
  })

  it('completeOAuth: throws on non-basename receipt filename', async () => {
    const scope = getCurrentScope('antigravity')
    const api = createImportApi({
      mode: 'antigravity',
      scope,
      oauthCapabilities: ['antigravity.oauth.safe_response'],
    })

    vi.mocked(requestJson).mockResolvedValueOnce({
      success: true,
      mode: 'antigravity',
      filename: '/root/forbidden.json',
      auto_detected_project: false,
    })

    await expect(api.completeOAuth(null, 'project-alpha')).rejects.toThrow(
      'Invalid filename in OAuth response',
    )
  })

  it('completeOAuth: throws on failed completion flag', async () => {
    const scope = getCurrentScope('antigravity')
    const api = createImportApi({
      mode: 'antigravity',
      scope,
      oauthCapabilities: ['antigravity.oauth.safe_response'],
    })

    vi.mocked(requestJson).mockResolvedValueOnce({
      success: false,
      mode: 'antigravity',
      filename: 'oauth.json',
      auto_detected_project: false,
    })

    await expect(api.completeOAuth(null, 'project-alpha')).rejects.toThrow(
      'OAuth completion failed',
    )
  })

  it('completeOAuth: preserves Gemini CLI tier fields and omits jobId', async () => {
    const scope = getCurrentScope('geminicli')
    const api = createImportApi({
      mode: 'geminicli',
      scope,
      oauthCapabilities: ['geminicli.oauth.safe_response'],
    })

    vi.mocked(requestJson).mockResolvedValueOnce({
      success: true,
      mode: 'geminicli',
      filename: 'gcli-token.json',
      project_id: 'gcli-proj',
      subscription_tier: 'tier-gcli',
      auto_detected_project: true,
      tier_raw_id: 'raw-123',
      tier_raw_name: 'Tier Alpha',
      tier_detected_at: 1729000000,
      tier_detection_status: 'active',
      email_enrichment: { job_id: '0123456789abcdef0123456789abcdef' },
    })

    const result = await api.completeOAuth(null, 'gcli-proj')

    expect(result.jobId).toBeUndefined()
    expect(result.oauthReceipt).toEqual({
      success: true,
      mode: 'geminicli',
      filename: 'gcli-token.json',
      project_id: 'gcli-proj',
      subscription_tier: 'tier-gcli',
      auto_detected_project: true,
      tier_raw_id: 'raw-123',
      tier_raw_name: 'Tier Alpha',
      tier_detected_at: 1729000000,
      tier_detection_status: 'active',
    })
  })

  it('startOAuth validates google oauth origin and parameters', async () => {
    const scope = getCurrentScope('antigravity')
    const api = createImportApi({ mode: 'antigravity', scope })

    vi.mocked(requestJson).mockResolvedValueOnce({
      auth_url: 'https://accounts.google.com/o/oauth2/v2/auth?scope=email',
    })
    const validUrl = await api.startOAuth('proj-1')
    expect(validUrl).toBe('https://accounts.google.com/o/oauth2/v2/auth?scope=email')

    vi.mocked(requestJson).mockResolvedValueOnce({
      auth_url: 'https://attacker.invalid/oauth',
    })
    await expect(api.startOAuth('proj-1')).rejects.toThrow('Invalid authorization origin')

    vi.mocked(requestJson).mockResolvedValueOnce({
      auth_url: 'https://user:pass@accounts.google.com/auth',
    })
    await expect(api.startOAuth('proj-1')).rejects.toThrow('Invalid authorization origin')

    vi.mocked(requestJson).mockResolvedValueOnce({
      auth_url: 'http://accounts.google.com/auth',
    })
    await expect(api.startOAuth('proj-1')).rejects.toThrow('Invalid authorization origin')

    vi.mocked(requestJson).mockResolvedValueOnce({})
    await expect(api.startOAuth('proj-1')).rejects.toThrow('Invalid authorization response')
  })

  it('uploadFiles dispatches FormData with query mode and no manual headers', async () => {
    const scope = getCurrentScope('antigravity')
    const api = createImportApi({ mode: 'antigravity', scope })

    vi.mocked(requestJson).mockResolvedValueOnce({
      results: [{ status: 'success', filename: 'uploaded.json' }],
    })
    const file = new File(['{}'], 'uploaded.json', { type: 'application/json' })
    const result = await api.uploadFiles([file])

    expect(requestJson).toHaveBeenCalledWith('creds/upload', {
      method: 'POST',
      query: { mode: 'antigravity' },
      body: expect.any(FormData),
      signal: undefined,
      scope: expect.objectContaining({ mode: 'antigravity' }),
    })
    expect(result.outcome).toBe('success')
    expect(result.confirmedFilenames).toEqual(['uploaded.json'])
  })

  it('importTokens handles single and batch refresh token modes', async () => {
    const scope = getCurrentScope('antigravity')
    const api = createImportApi({ mode: 'antigravity', scope })

    vi.mocked(requestJson).mockResolvedValueOnce({ success: true, filename: 'token-single.json' })
    await api.importTokens({
      tokens: ['token-1'],
      clientId: 'cid',
      clientSecret: 'csec',
      projectId: 'proj-single',
      filename: 'custom.json',
    })

    expect(requestJson).toHaveBeenCalledWith('creds/upload-by-refresh-token', {
      method: 'POST',
      body: {
        mode: 'antigravity',
        client_id: 'cid',
        client_secret: 'csec',
        refresh_token: 'token-1',
        project_id: 'proj-single',
        custom_filename: 'custom.json',
      },
      signal: undefined,
      scope: expect.objectContaining({ mode: 'antigravity' }),
    })

    vi.mocked(requestJson).mockResolvedValueOnce({
      results: [
        { status: 'success', filename: 'batch-1.json' },
        { status: 'success', filename: 'batch-2.json' },
      ],
    })
    await api.importTokens({
      tokens: ['token-1', 'token-2'],
      clientId: '',
      clientSecret: '',
      projectId: 'ignored-in-batch',
      filename: 'prefix-',
    })

    expect(requestJson).toHaveBeenCalledWith('creds/upload-by-refresh-token-batch', {
      method: 'POST',
      body: {
        mode: 'antigravity',
        client_id: undefined,
        client_secret: undefined,
        refresh_tokens: ['token-1', 'token-2'],
        filename_prefix: 'prefix-',
      },
      signal: undefined,
      scope: expect.objectContaining({ mode: 'antigravity' }),
    })
  })

  it('legacy convenience exports uploadFiles and importTokens operate in antigravity mode', async () => {
    vi.mocked(requestJson).mockResolvedValueOnce({
      results: [{ status: 'success', filename: 'legacy.json' }],
    })
    const res = await uploadFiles([new File(['{}'], 'legacy.json')])
    expect(res.outcome).toBe('success')
    expect(res.confirmedFilenames).toEqual(['legacy.json'])

    vi.mocked(requestJson).mockResolvedValueOnce({ success: true, filename: 'token.json' })
    const resTokens = await importTokens({
      tokens: ['rt'],
      clientId: '',
      clientSecret: '',
      projectId: '',
      filename: '',
    })
    expect(resTokens.outcome).toBe('success')
  })
})

describe('Scope and session invalidation assertActive', () => {
  it('throws DOMException AbortError when session token change alters sessionEpoch', async () => {
    const scope = getCurrentScope('antigravity')
    const api = createImportApi({ mode: 'antigravity', scope })

    setSessionToken('new-session-token', false)

    await expect(api.uploadFiles([new File(['{}'], 'a.json')])).rejects.toThrow(
      '作用域已变更，请重新读取。',
    )
  })

  it('throws Error when context mode mismatches scope mode', () => {
    const scope = getCurrentScope('geminicli')
    const api = createImportApi({ mode: 'antigravity', scope })

    return expect(api.uploadFiles([new File(['{}'], 'a.json')])).rejects.toThrow(
      '请求模式与作用域不一致。',
    )
  })

  it('throws immediately when signal is already aborted', async () => {
    const scope = getCurrentScope('antigravity')
    const api = createImportApi({ mode: 'antigravity', scope })
    const controller = new AbortController()
    controller.abort()

    await expect(api.uploadFiles([new File(['{}'], 'a.json')], controller.signal)).rejects.toThrow()
  })
})

describe('Fixture mode handling', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_UI_FIXTURES', 'true')
  })

  it('clones and validates fixture confirmations without inventing from labels; fixture transport stays zero and example-job is not remapped', async () => {
    const scope = getCurrentScope('antigravity')
    const api = createImportApi({ mode: 'antigravity', scope })

    const fixtureSample: ImportResult = previewResult()
    expect(fixtureSample.confirmedFilenames).toBeUndefined()
    expect(fixtureSample.jobId).toBe('example-job')

    const uploadRes = await api.uploadFiles([new File(['{}'], 'real.json')])
    expect(uploadRes.outcome).toBe('partial')
    expect(uploadRes.jobId).toBe('example-job')
    expect(uploadRes.confirmedFilenames).toBeUndefined()
    expect(requestJson).not.toHaveBeenCalled()

    // Deep clone check: mutating output should not mutate subsequent calls
    uploadRes.items[0].label = 'mutated-name.json'
    const tokenRes = await api.importTokens({
      tokens: ['token'],
      clientId: '',
      clientSecret: '',
      projectId: '',
      filename: '',
    })
    expect(tokenRes.items[0].label).toBe('example-alpha.json')
    expect(tokenRes.confirmedFilenames).toBeUndefined()
    expect(requestJson).not.toHaveBeenCalled()

    const oauthRes = await api.completeOAuth(null, '')
    expect(oauthRes.outcome).toBe('partial')
    expect(oauthRes.confirmedFilenames).toBeUndefined()
    expect(requestJson).not.toHaveBeenCalled()

    const previewEmailData = previewEmail()
    expect(previewEmailData.complete).toBe(true)
    const emailRes = await api.readEmailJob('example-job')
    expect(emailRes.complete).toBe(true)
    expect(emailRes.items).toEqual(previewEmailData.items)
    expect(requestJson).not.toHaveBeenCalled()
  })

  it('omits jobId from fixture result when in Gemini CLI mode', async () => {
    const scope = getCurrentScope('geminicli')
    const api = createImportApi({ mode: 'geminicli', scope })

    const uploadRes = await api.uploadFiles([new File(['{}'], 'gcli.json')])
    expect(uploadRes.jobId).toBeUndefined()
    expect(requestJson).not.toHaveBeenCalled()
  })
})

describe('Capabilities and Email Job Observation', () => {
  it('readImportCapabilities reads from creds/status or fixture fallback', async () => {
    const scope = getCurrentScope('antigravity')
    const ctx: ImportRequestContext = { mode: 'antigravity', scope }

    vi.mocked(requestJson).mockResolvedValueOnce({
      panel_capabilities: ['antigravity.oauth.safe_response', 'extra_cap'],
    })

    const caps = await readImportCapabilities(new AbortController().signal, ctx)
    expect(caps.has('antigravity.oauth.safe_response')).toBe(true)
    expect(caps.has('extra_cap')).toBe(true)

    vi.stubEnv('VITE_UI_FIXTURES', 'true')
    const fixtureCaps = await readImportCapabilities(new AbortController().signal, ctx)
    expect(fixtureCaps.has('antigravity.oauth.safe_response')).toBe(true)
  })

  it('readEmailJob rejects geminicli mode and invalid job IDs', async () => {
    const gcliScope = getCurrentScope('geminicli')
    const gcliApi = createImportApi({ mode: 'geminicli', scope: gcliScope })

    await expect(gcliApi.readEmailJob('0123456789abcdef0123456789abcdef')).rejects.toThrow(
      'Gemini CLI 不支持邮箱任务',
    )

    const agScope = getCurrentScope('antigravity')
    const agApi = createImportApi({ mode: 'antigravity', scope: agScope })

    await expect(agApi.readEmailJob('invalid@job-id!')).rejects.toThrow('Invalid job')
  })

  it('readEmailJob detects duplicate filenames and throws', async () => {
    const scope = getCurrentScope('antigravity')
    const api = createImportApi({ mode: 'antigravity', scope })

    vi.mocked(requestJson).mockResolvedValueOnce({
      job_id: 'job123',
      total: 2,
      complete: true,
      sealed: true,
      items: [
        { filename: 'dup.json', status: 'success' },
        { filename: 'dup.json', status: 'success' },
      ],
    })

    await expect(api.readEmailJob('job123')).rejects.toThrow('Duplicate filename in job')
  })

  it('readEmailJobs handles empty lists, deduplication, 404 expiration, and failures', async () => {
    const scope = getCurrentScope('antigravity')
    const ctx: ImportRequestContext = { mode: 'antigravity', scope }
    const signal = new AbortController().signal

    const empty = await readEmailJobs([], signal, ctx)
    expect(empty).toEqual([])

    await expect(readEmailJobs(['not-a-hex-job'], signal, ctx)).rejects.toThrow('Invalid job ID')

    const hex1 = '0123456789abcdef0123456789abcdef'
    const hex2 = 'fedcba9876543210fedcba9876543210'

    // Mock first job success, second job 404
    vi.mocked(requestJson)
      .mockResolvedValueOnce({
        job_id: hex1,
        total: 1,
        complete: true,
        sealed: true,
        items: [{ filename: 'ok.json', status: 'success', user_email: 'user@example.invalid' }],
      })
      .mockRejectedValueOnce(new ApiError(404, {}))

    const obs = await readEmailJobs([hex1, hex2, hex1], signal, ctx)
    expect(obs).toHaveLength(2)

    expect(obs[0]).toEqual({
      jobId: hex1,
      status: 'observed',
      snapshot: {
        complete: true,
        items: [{ filename: 'ok.json', status: 'success', email: 'user@example.invalid' }],
      },
    })

    expect(obs[1]).toEqual({
      jobId: hex2,
      status: 'expired',
      snapshot: null,
    })
  })

  it('readEmailJobs rejects Gemini CLI mode', async () => {
    const scope = getCurrentScope('geminicli')
    const ctx: ImportRequestContext = { mode: 'geminicli', scope }
    const signal = new AbortController().signal

    await expect(
      readEmailJobs(['0123456789abcdef0123456789abcdef'], signal, ctx),
    ).rejects.toThrow('Gemini CLI 不支持邮箱任务')
  })
})

describe('Regression Group 1: RT single and batch routes return project/tier only for both modes', () => {
  it('antigravity RT single import retains project_id and subscription_tier in receipt without tier diagnostics', async () => {
    const scope = getCurrentScope('antigravity')
    const api = createImportApi({ mode: 'antigravity', scope })

    vi.mocked(requestJson).mockResolvedValueOnce({
      success: true,
      mode: 'antigravity',
      filename: 'ag-token.json',
      project_id: 'ag-proj-1',
      subscription_tier: 'tier-pro',
      tier_raw_id: 'raw-ignored',
    })

    const result = await api.importTokens({
      tokens: ['rt-ag-single'],
      clientId: 'cid-ag',
      clientSecret: 'csec-ag',
      projectId: 'ag-proj-input',
      filename: 'ag-token.json',
    })

    expect(result.outcome).toBe('success')
    expect(result.confirmedFilenames).toEqual(['ag-token.json'])
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toEqual({
      label: 'ag-token.json',
      status: 'success',
      receipt: {
        project_id: 'ag-proj-1',
        subscription_tier: 'tier-pro',
      },
    })
    expect(result.items[0].receipt?.tier_raw_id).toBeUndefined()
  })

  it('antigravity RT batch import retains per-row project_id and subscription_tier', async () => {
    const scope = getCurrentScope('antigravity')
    const api = createImportApi({ mode: 'antigravity', scope })

    vi.mocked(requestJson).mockResolvedValueOnce({
      mode: 'antigravity',
      success_count: 2,
      total_count: 2,
      results: [
        {
          index: 0,
          success: true,
          filename: 'ag-batch-1.json',
          project_id: 'proj-batch-1',
          subscription_tier: 'tier-ag-standard',
        },
        {
          index: 1,
          success: true,
          filename: 'ag-batch-2.json',
          project_id: 'proj-batch-2',
          subscription_tier: 'tier-ag-plus',
        },
      ],
    })

    const result = await api.importTokens({
      tokens: ['rt-1', 'rt-2'],
      clientId: 'cid',
      clientSecret: 'csec',
      projectId: '',
      filename: 'batch-',
    })

    expect(result.outcome).toBe('success')
    expect(result.confirmedFilenames).toEqual(['ag-batch-1.json', 'ag-batch-2.json'])
    expect(result.items).toHaveLength(2)
    expect(result.items[0].receipt).toEqual({
      project_id: 'proj-batch-1',
      subscription_tier: 'tier-ag-standard',
    })
    expect(result.items[1].receipt).toEqual({
      project_id: 'proj-batch-2',
      subscription_tier: 'tier-ag-plus',
    })
  })

  it('geminicli RT single import retains project_id and subscription_tier in receipt', async () => {
    const scope = getCurrentScope('geminicli')
    const api = createImportApi({ mode: 'geminicli', scope })

    vi.mocked(requestJson).mockResolvedValueOnce({
      success: true,
      mode: 'geminicli',
      filename: 'gcli-token.json',
      project_id: 'gcli-proj-1',
      subscription_tier: 'tier-gcli-pro',
    })

    const result = await api.importTokens({
      tokens: ['rt-gcli-single'],
      clientId: 'cid-gcli',
      clientSecret: 'csec-gcli',
      projectId: 'gcli-proj-input',
      filename: 'gcli-token.json',
    })

    expect(result.outcome).toBe('success')
    expect(result.confirmedFilenames).toEqual(['gcli-token.json'])
    expect(result.items[0]).toEqual({
      label: 'gcli-token.json',
      status: 'success',
      receipt: {
        project_id: 'gcli-proj-1',
        subscription_tier: 'tier-gcli-pro',
      },
    })
  })

  it('geminicli RT batch import retains per-row project_id and subscription_tier', async () => {
    const scope = getCurrentScope('geminicli')
    const api = createImportApi({ mode: 'geminicli', scope })

    vi.mocked(requestJson).mockResolvedValueOnce({
      mode: 'geminicli',
      success_count: 2,
      total_count: 2,
      results: [
        {
          index: 0,
          success: true,
          filename: 'gcli-batch-1.json',
          project_id: 'gcli-p1',
          subscription_tier: 'tier-g1',
        },
        {
          index: 1,
          success: true,
          filename: 'gcli-batch-2.json',
          project_id: 'gcli-p2',
          subscription_tier: 'tier-g2',
        },
      ],
    })

    const result = await api.importTokens({
      tokens: ['rt-g1', 'rt-g2'],
      clientId: '',
      clientSecret: '',
      projectId: '',
      filename: 'gcli-prefix',
    })

    expect(result.outcome).toBe('success')
    expect(result.confirmedFilenames).toEqual(['gcli-batch-1.json', 'gcli-batch-2.json'])
    expect(result.items[0].receipt).toEqual({
      project_id: 'gcli-p1',
      subscription_tier: 'tier-g1',
    })
    expect(result.items[1].receipt).toEqual({
      project_id: 'gcli-p2',
      subscription_tier: 'tier-g2',
    })
  })
})

describe('Regression Group 2: GCLI file diagnostics versus honest AG omission', () => {
  it('geminicli file upload projects all six safe receipt diagnostics', async () => {
    const scope = getCurrentScope('geminicli')
    const api = createImportApi({ mode: 'geminicli', scope })

    vi.mocked(requestJson).mockResolvedValueOnce({
      mode: 'geminicli',
      uploaded_count: 1,
      total_count: 1,
      results: [
        {
          status: 'success',
          filename: 'gcli-file.json',
          project_id: 'gcli-file-proj',
          subscription_tier: 'tier-advanced',
          tier_raw_id: 'raw-100',
          tier_raw_name: 'Advanced Tier',
          tier_detected_at: 1729000000,
          tier_detection_status: 'verified',
        },
      ],
    })

    const file = new File(['{}'], 'gcli-file.json', { type: 'application/json' })
    const result = await api.uploadFiles([file])

    expect(result.outcome).toBe('success')
    expect(result.confirmedFilenames).toEqual(['gcli-file.json'])
    expect(result.items[0]).toEqual({
      label: 'gcli-file.json',
      status: 'success',
      receipt: {
        project_id: 'gcli-file-proj',
        subscription_tier: 'tier-advanced',
        tier_raw_id: 'raw-100',
        tier_raw_name: 'Advanced Tier',
        tier_detected_at: 1729000000,
        tier_detection_status: 'verified',
      },
    })
  })

  it('antigravity file upload honestly omits receipt metadata when absent from response', async () => {
    const scope = getCurrentScope('antigravity')
    const api = createImportApi({ mode: 'antigravity', scope })

    vi.mocked(requestJson).mockResolvedValueOnce({
      mode: 'antigravity',
      uploaded_count: 1,
      total_count: 1,
      results: [
        {
          status: 'success',
          filename: 'ag-upload.json',
          message: 'Saved successfully',
        },
      ],
    })

    const file = new File(['{}'], 'ag-upload.json', { type: 'application/json' })
    const result = await api.uploadFiles([file])

    expect(result.outcome).toBe('success')
    expect(result.confirmedFilenames).toEqual(['ag-upload.json'])
    expect(result.items[0]).toEqual({
      label: 'ag-upload.json',
      status: 'success',
    })
    expect(result.items[0].receipt).toBeUndefined()
    expect('receipt' in result.items[0]).toBe(false)
    expect(Object.keys(result.items[0]).sort()).toEqual(['label', 'status'].sort())
  })

  it('antigravity mode never projects tier diagnostics even if response includes them', async () => {
    const scope = getCurrentScope('antigravity')
    const api = createImportApi({ mode: 'antigravity', scope })

    vi.mocked(requestJson).mockResolvedValueOnce({
      mode: 'antigravity',
      results: [
        {
          status: 'success',
          filename: 'ag-injected.json',
          tier_raw_id: 'raw-injected',
          tier_raw_name: 'Injected Tier',
          tier_detected_at: 1729000000,
          tier_detection_status: 'injected',
        },
      ],
    })

    const file = new File(['{}'], 'ag-injected.json', { type: 'application/json' })
    const result = await api.uploadFiles([file])

    expect(result.outcome).toBe('success')
    expect(result.items[0].receipt).toBeUndefined()
    expect(result.items[0]).toEqual({
      label: 'ag-injected.json',
      status: 'success',
    })
  })
})

describe('Regression Group 3: Own, null, malformed, prototype and secret canaries plus contradictory counts', () => {
  it('prototype pollution directly returned from transport mock does not leak into receipt or label', async () => {
    const scope = getCurrentScope('geminicli')
    const api = createImportApi({ mode: 'geminicli', scope })

    const protoCanary = {
      project_id: 'SECRET_PROTO_PROJECT',
      subscription_tier: 'SECRET_PROTO_TIER',
      tier_raw_id: 'SECRET_PROTO_RAW_ID',
      tier_raw_name: 'SECRET_PROTO_RAW_NAME',
      tier_detected_at: 1729000000,
      tier_detection_status: 'SECRET_PROTO_STATUS',
      filename: 'SECRET_PROTO_FILENAME.json',
      token_preview: 'SECRET_PROTO_TOKEN_PREVIEW',
    }

    const protoRow = Object.create(protoCanary)
    protoRow.filename = 'own-file.json'
    protoRow.status = 'success'

    vi.mocked(requestJson).mockResolvedValueOnce({
      mode: 'geminicli',
      results: [protoRow],
    })

    const result = await api.uploadFiles([new File(['{}'], 'own-file.json')])

    expect(result.items[0].label).toBe('own-file.json')
    expect(result.items[0].status).toBe('success')
    expect(result.items[0].receipt).toBeUndefined()
    expect('receipt' in result.items[0]).toBe(false)

    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('SECRET_PROTO_PROJECT')
    expect(serialized).not.toContain('SECRET_PROTO_TIER')
    expect(serialized).not.toContain('SECRET_PROTO_RAW_ID')
    expect(serialized).not.toContain('SECRET_PROTO_RAW_NAME')
    expect(serialized).not.toContain('SECRET_PROTO_STATUS')
    expect(serialized).not.toContain('SECRET_PROTO_FILENAME.json')
    expect(serialized).not.toContain('SECRET_PROTO_TOKEN_PREVIEW')
  })

  it('row with filename on prototype only falls back to label and gains no receipt', () => {
    const protoCanary = {
      filename: 'proto-filename.json',
      project_id: 'own-project',
      subscription_tier: 'own-tier',
    }
    const protoRow = Object.create(protoCanary)
    protoRow.status = 'success'
    protoRow.project_id = 'own-project'
    protoRow.subscription_tier = 'own-tier'

    const result = normalizeResult({
      results: [protoRow],
    })

    expect(result.items[0].label).toBe('第 1 项')
    expect(result.items[0].receipt).toBeUndefined()
    expect(result.confirmedFilenames).toBeUndefined()
  })

  it('omits null, empty, untrimmed, control-character, and out-of-range fields from receipt', () => {
    const result = normalizeResult(
      {
        mode: 'geminicli',
        results: [
          {
            status: 'success',
            filename: 'boundary.json',
            project_id: null,
            subscription_tier: '',
            tier_raw_id: '  untrimmed  ',
            tier_raw_name: 'Bad\x00Control',
            tier_detection_status: 'a'.repeat(251),
            tier_detected_at: -1,
          },
        ],
      },
      false,
      'geminicli',
    )

    expect(result.items[0].receipt).toBeUndefined()
    expect(result.items[0]).toEqual({
      label: 'boundary.json',
      status: 'success',
    })

    const floatDetectedAt = normalizeResult(
      {
        mode: 'geminicli',
        results: [{ status: 'success', filename: 'valid.json', tier_detected_at: 1729000000.5 }],
      },
      false,
      'geminicli',
    )
    expect(floatDetectedAt.items[0].receipt).toBeUndefined()

    const futureOutOfRangeDetectedAt = normalizeResult(
      {
        mode: 'geminicli',
        results: [{ status: 'success', filename: 'valid.json', tier_detected_at: 9999999999999 }],
      },
      false,
      'geminicli',
    )
    expect(futureOutOfRangeDetectedAt.items[0].receipt).toBeUndefined()

    const zeroDetectedAt = normalizeResult(
      {
        mode: 'geminicli',
        results: [{ status: 'success', filename: 'valid.json', tier_detected_at: 0 }],
      },
      false,
      'geminicli',
    )
    expect(zeroDetectedAt.items[0].receipt).toEqual({ tier_detected_at: 0 })
  })

  it('strips secret canaries from receipt and leaves only explicitly permitted fields', () => {
    const cleanSuccessRow = {
      status: 'success',
      filename: 'secure.json',
      project_id: 'valid-project',
      subscription_tier: 'tier-valid',
      refresh_token: 'CANARY_REFRESH_TOKEN_DO_NOT_LEAK',
      client_secret: 'CANARY_CLIENT_SECRET_DO_NOT_LEAK',
      access_token: 'CANARY_ACCESS_TOKEN_DO_NOT_LEAK',
      token_preview: 'CANARY_TOKEN_PREVIEW_DO_NOT_LEAK',
      callback_url: 'https://oauth.example.invalid/callback',
      file_path: '/etc/credentials/secret.json',
      message: 'CANARY_RAW_MESSAGE',
      detail: 'CANARY_RAW_DETAIL',
      payload: { leak: 'CANARY_PAYLOAD' },
      arbitrary_extra_property: { secret: true },
    }

    const result = normalizeResult({ results: [cleanSuccessRow] })

    expect(result.outcome).toBe('success')
    expect(result.items[0].status).toBe('success')
    expect(result.items[0].receipt).toEqual({
      project_id: 'valid-project',
      subscription_tier: 'tier-valid',
    })
    expect(Object.keys(result.items[0].receipt!).sort()).toEqual(['project_id', 'subscription_tier'].sort())
    expect(result.confirmedFilenames).toEqual(['secure.json'])

    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('CANARY_REFRESH_TOKEN_DO_NOT_LEAK')
    expect(serialized).not.toContain('CANARY_CLIENT_SECRET_DO_NOT_LEAK')
    expect(serialized).not.toContain('CANARY_ACCESS_TOKEN_DO_NOT_LEAK')
    expect(serialized).not.toContain('CANARY_TOKEN_PREVIEW_DO_NOT_LEAK')
    expect(serialized).not.toContain('https://oauth.example.invalid/callback')
    expect(serialized).not.toContain('/etc/credentials/secret.json')
    expect(serialized).not.toContain('CANARY_RAW_MESSAGE')
    expect(serialized).not.toContain('CANARY_RAW_DETAIL')
    expect(serialized).not.toContain('CANARY_PAYLOAD')
    expect(serialized).not.toContain('arbitrary_extra_property')
  })

  it('contradictory success-with-error row is treated as unknown without leaking receipt or canaries', () => {
    const poisonedRow = {
      status: 'success',
      filename: 'secure.json',
      project_id: 'valid-project',
      subscription_tier: 'tier-valid',
      refresh_token: 'CANARY_REFRESH_TOKEN_DO_NOT_LEAK',
      client_secret: 'CANARY_CLIENT_SECRET_DO_NOT_LEAK',
      access_token: 'CANARY_ACCESS_TOKEN_DO_NOT_LEAK',
      token_preview: 'CANARY_TOKEN_PREVIEW_DO_NOT_LEAK',
      callback_url: 'https://oauth.example.invalid/callback',
      file_path: '/etc/credentials/secret.json',
      error: 'CANARY_RAW_ERROR',
      error_code: 'CANARY_RAW_CODE',
      message: 'CANARY_RAW_MESSAGE',
      detail: 'CANARY_RAW_DETAIL',
      payload: { leak: 'CANARY_PAYLOAD' },
      arbitrary_extra_property: { secret: true },
    }

    const result = normalizeResult({ results: [poisonedRow] })

    expect(result.outcome).toBe('unknown')
    expect(result.items[0].status).toBe('unknown')
    expect(result.items[0].receipt).toBeUndefined()
    expect(result.confirmedFilenames).toBeUndefined()

    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('CANARY_REFRESH_TOKEN_DO_NOT_LEAK')
    expect(serialized).not.toContain('CANARY_CLIENT_SECRET_DO_NOT_LEAK')
    expect(serialized).not.toContain('CANARY_ACCESS_TOKEN_DO_NOT_LEAK')
    expect(serialized).not.toContain('CANARY_TOKEN_PREVIEW_DO_NOT_LEAK')
    expect(serialized).not.toContain('https://oauth.example.invalid/callback')
    expect(serialized).not.toContain('/etc/credentials/secret.json')
    expect(serialized).not.toContain('CANARY_RAW_ERROR')
    expect(serialized).not.toContain('CANARY_RAW_CODE')
    expect(serialized).not.toContain('CANARY_RAW_MESSAGE')
    expect(serialized).not.toContain('CANARY_RAW_DETAIL')
    expect(serialized).not.toContain('CANARY_PAYLOAD')
    expect(serialized).not.toContain('arbitrary_extra_property')
  })

  it('contradictory aggregate counts invalidate outcome and confirmed filenames while receipt remains inert', () => {
    const contradictoryAggregate = normalizeResult({
      results: [
        {
          status: 'success',
          filename: 'cred-1.json',
          project_id: 'proj-1',
          subscription_tier: 'tier-1',
        },
      ],
      success_count: 0,
      total_count: 1,
    })

    expect(contradictoryAggregate.outcome).toBe('unknown')
    expect(contradictoryAggregate.confirmedFilenames).toBeUndefined()
    expect(contradictoryAggregate.items[0].receipt).toEqual({
      project_id: 'proj-1',
      subscription_tier: 'tier-1',
    })
  })

  it('row contradictory status prevents receipt assignment', () => {
    const rowContradiction = normalizeResult({
      results: [
        {
          status: 'success',
          success: false,
          filename: 'contradict.json',
          project_id: 'proj-1',
          subscription_tier: 'tier-1',
        },
      ],
    })

    expect(rowContradiction.outcome).toBe('unknown')
    expect(rowContradiction.items[0].status).toBe('unknown')
    expect(rowContradiction.items[0].receipt).toBeUndefined()
    expect(rowContradiction.confirmedFilenames).toBeUndefined()
  })
})
