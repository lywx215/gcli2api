import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, requestJson } from '@/api/client'
import { completeOAuth, failureMessage, importTokens, normalizeResult, projectPrompt, readEmailJob, uploadFiles } from './api'
vi.mock('@/api/client', () => ({ requestJson: vi.fn(), ApiError: class extends Error { constructor(public status: number, public payload: unknown) { super('safe') } } }))
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv('VITE_UI_FIXTURES', 'false') })
describe('Import adapter', () => {
  it('preserves partial and unknown results and drops credential secrets', () => {
    const result = normalizeResult({ results: [{ filename: 'example.json', status: 'success', credential: { refresh_token: 'synthetic-secret' } }, { status: 'error' }], credentials: 'synthetic-secret' })
    expect(result.outcome).toBe('partial')
    expect(JSON.stringify(result)).not.toContain('synthetic-secret')
    expect(normalizeResult({}).outcome).toBe('unknown')
    expect(normalizeResult({ results: [{ success: true }, { success: false }] }).outcome).toBe('partial')
    expect(normalizeResult({ success: false, file_path: 'example.json' }, true).outcome).toBe('failed')
    expect(normalizeResult({ error: 'rejected', file_path: 'example.json' }, true).outcome).toBe('failed')
  })
  it('sends multipart files with query mode and no manual headers', async () => {
    vi.mocked(requestJson).mockResolvedValue({ results: [{ status: 'success' }] })
    await uploadFiles([new File(['{}'], 'example.json')], new AbortController().signal)
    const [path, options] = vi.mocked(requestJson).mock.calls[0]
    expect(path).toBe('creds/upload')
    expect(options?.query).toEqual({ mode: 'antigravity' })
    expect((options?.body as FormData).getAll('files')).toHaveLength(1)
  })
  it('routes single and batch refresh tokens through JSON mode', async () => {
    vi.mocked(requestJson).mockResolvedValue({ success: true })
    const input = { tokens: ['synthetic-token'], clientId: '', clientSecret: '', projectId: 'project-example', filename: '' }
    await importTokens(input, new AbortController().signal)
    expect(vi.mocked(requestJson).mock.calls[0][1]?.body).toMatchObject({ mode: 'antigravity', refresh_token: 'synthetic-token', project_id: 'project-example' })
    await importTokens({ ...input, tokens: ['one', 'two'] }, new AbortController().signal)
    expect(vi.mocked(requestJson).mock.calls[1][1]?.body).not.toHaveProperty('project_id')
  })
  it('handles project selection as a flow state and separates 413', () => {
    expect(projectPrompt(new ApiError(400, { requires_manual_project_id: true }))).toEqual({ manual: true, projects: [] })
    expect(projectPrompt(new ApiError(400, { requires_project_selection: true, available_projects: [{ project_id: 'example' }] }))?.projects).toEqual(['example'])
    expect(failureMessage(new ApiError(413, {}))).toContain('资源预算')
    expect(failureMessage(new ApiError(500, { secret: 'hidden' }))).toContain('结果未知')
  })
  it('paginates using items and total, ignoring counts and status_url', async () => {
    vi.mocked(requestJson).mockResolvedValueOnce({ job_id: 'example', items: [{ filename: 'a', status: 'settlement_pending' }], total: 2, counts: { skipped: 999 }, complete: false, sealed: true, status_url: 'https://example.invalid' })
      .mockResolvedValueOnce({ job_id: 'example', items: [{ filename: 'b', status: 'superseded' }], total: 2, complete: false, sealed: true })
    const result = await readEmailJob('example', new AbortController().signal)
    expect(result.items).toHaveLength(2)
    expect(result.complete).toBe(false)
    expect(vi.mocked(requestJson).mock.calls[1]).toMatchObject(['creds/email-enrichment/example', { query: { offset: 1, limit: 100 } }])
  })
  it('does not replay OAuth exchange on failure', async () => {
    vi.mocked(requestJson).mockRejectedValue(new ApiError(500, {}))
    await expect(completeOAuth('http://localhost/?code=synthetic', '', new AbortController().signal)).rejects.toThrow()
    expect(requestJson).toHaveBeenCalledTimes(1)
  })
  it('rejects empty incomplete email pages', async () => {
    vi.mocked(requestJson).mockResolvedValue({ job_id: 'example', items: [], total: 1, complete: true, sealed: true })
    await expect(readEmailJob('example', new AbortController().signal)).rejects.toThrow()
  })
  it('preview mode never calls the transport', async () => {
    vi.stubEnv('VITE_UI_FIXTURES', 'true')
    const result = await completeOAuth(null, '', new AbortController().signal)
    expect(result.outcome).toBe('partial')
    expect(requestJson).not.toHaveBeenCalled()
  })
})
