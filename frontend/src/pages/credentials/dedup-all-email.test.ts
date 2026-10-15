import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as clientModule from '@/api/client'
import { ApiError } from '@/api/client'
import { getSessionSnapshot, setSessionToken } from '@/auth/session'
import {
  __commitPanelChannel,
  capturePanelScope,
} from '@/domain/panel'
import {
  api,
  createCredentialApi,
  type DeduplicateByEmailResult,
  type RefreshAllEmailsResult,
} from './api'

beforeEach(() => {
  setSessionToken('synthetic-session')
})

afterEach(() => {
  __commitPanelChannel('antigravity')
})

const respond = (body: unknown, status = 200, headers?: Record<string, string>) =>
  vi.mocked(fetch).mockResolvedValueOnce(Response.json(body, { status, headers }))

describe('credential maintenance adapters: refreshAllEmails and deduplicateByEmail', () => {
  describe('Group 1: both-mode exact routes, no body, and inert factory', () => {
    it('factory constructor is inert and performs zero network transport upon creation', () => {
      createCredentialApi('antigravity')
      createCredentialApi('geminicli')
      expect(fetch).not.toHaveBeenCalled()
    })

    it('refreshAllEmails in antigravity mode explicitly POSTs creds/refresh-all-emails?mode=antigravity with no body', async () => {
      respond({
        success_count: 1,
        skipped_count: 0,
        total_count: 1,
        results: [{ filename: 'cred-ag.json', user_email: 'ag@example.invalid', success: true, skipped: false }],
        message: '完成',
      })

      const result = await api.refreshAllEmails()

      expect(result.success_count).toBe(1)
      expect(fetch).toHaveBeenCalledTimes(1)

      const [url, init] = vi.mocked(fetch).mock.calls[0]
      const parsed = new URL(String(url))
      expect(parsed.pathname).toBe('/creds/refresh-all-emails')
      expect(parsed.searchParams.get('mode')).toBe('antigravity')
      expect(init?.method).toBe('POST')
      expect(init?.body).toBeUndefined()
    })

    it('refreshAllEmails in geminicli mode explicitly POSTs creds/refresh-all-emails?mode=geminicli with no body', async () => {
      const gcliApi = createCredentialApi('geminicli')
      respond({
        success_count: 0,
        skipped_count: 1,
        total_count: 1,
        results: [{ filename: 'cred-gcli.json', user_email: 'gcli@example.invalid', success: true, skipped: true }],
        message: '完成',
      })

      const result = await gcliApi.refreshAllEmails()

      expect(result.skipped_count).toBe(1)
      expect(fetch).toHaveBeenCalledTimes(1)

      const [url, init] = vi.mocked(fetch).mock.calls[0]
      const parsed = new URL(String(url))
      expect(parsed.pathname).toBe('/creds/refresh-all-emails')
      expect(parsed.searchParams.get('mode')).toBe('geminicli')
      expect(init?.method).toBe('POST')
      expect(init?.body).toBeUndefined()
    })

    it('deduplicateByEmail in antigravity mode explicitly POSTs creds/deduplicate-by-email?mode=antigravity with no body', async () => {
      respond({
        deleted_count: 0,
        kept_count: 2,
        total_count: 2,
        unique_emails_count: 2,
        no_email_count: 0,
        duplicate_groups: [],
        delete_errors: [],
        message: '去重完成',
      })

      const result = await api.deduplicateByEmail()

      expect(result.deleted_count).toBe(0)
      expect(fetch).toHaveBeenCalledTimes(1)

      const [url, init] = vi.mocked(fetch).mock.calls[0]
      const parsed = new URL(String(url))
      expect(parsed.pathname).toBe('/creds/deduplicate-by-email')
      expect(parsed.searchParams.get('mode')).toBe('antigravity')
      expect(init?.method).toBe('POST')
      expect(init?.body).toBeUndefined()
    })

    it('deduplicateByEmail in geminicli mode explicitly POSTs creds/deduplicate-by-email?mode=geminicli with no body', async () => {
      const gcliApi = createCredentialApi('geminicli')
      respond({
        deleted_count: 0,
        kept_count: 1,
        total_count: 1,
        unique_emails_count: 1,
        no_email_count: 0,
        duplicate_groups: [],
        delete_errors: [],
        message: '去重完成',
      })

      const result = await gcliApi.deduplicateByEmail()

      expect(result.kept_count).toBe(1)
      expect(fetch).toHaveBeenCalledTimes(1)

      const [url, init] = vi.mocked(fetch).mock.calls[0]
      const parsed = new URL(String(url))
      expect(parsed.pathname).toBe('/creds/deduplicate-by-email')
      expect(parsed.searchParams.get('mode')).toBe('geminicli')
      expect(init?.method).toBe('POST')
      expect(init?.body).toBeUndefined()
    })
  })

  describe('Group 2: refresh mixed cached/new/failure and malformed counts', () => {
    it('validates own nonnegative safe-integer counts, computes failed=total-success-skipped, treats cached skipped as non-failure without success:true requirement', async () => {
      const canarySecret = 'SECRET-CANARY-RAW-ERROR-MSG'
      respond({
        success_count: 2,
        skipped_count: 3,
        total_count: 7,
        results: [
          { filename: 'new-1.json', user_email: 'new1@example.invalid', success: true, skipped: false },
          { filename: 'new-2.json', user_email: 'new2@example.invalid', success: true, skipped: false },
          { filename: 'cached-1.json', user_email: 'cached1@example.invalid', success: true, skipped: true },
          { filename: 'cached-2.json', user_email: 'cached2@example.invalid', success: true, skipped: true },
          { filename: 'cached-3.json', user_email: 'cached3@example.invalid', success: true, skipped: true },
          { filename: 'fail-1.json', user_email: null, success: false, skipped: false, error: canarySecret },
          { filename: 'fail-2.json', user_email: null, success: false, skipped: false, error: canarySecret },
        ],
        message: `内部信息: ${canarySecret}`,
      })

      const result: RefreshAllEmailsResult = await api.refreshAllEmails()

      expect(result.success_count).toBe(2)
      expect(result.skipped_count).toBe(3)
      expect(result.total_count).toBe(7)
      expect(result.failed_count).toBe(2)
      expect(result.failed).toBe(2)
      expect(result.results).toHaveLength(7)

      // Verified cached rows have success: true, skipped: true
      const cachedRows = result.results.filter(r => r.skipped)
      expect(cachedRows).toHaveLength(3)
      expect(cachedRows.every(r => r.success && r.user_email !== null)).toBe(true)

      // Verified failed rows have success: false, user_email: null
      const failedRows = result.results.filter(r => !r.success)
      expect(failedRows).toHaveLength(2)
      expect(failedRows.every(r => r.user_email === null && !r.skipped)).toBe(true)

      // Raw message and error strings are stripped completely
      expect(JSON.stringify(result)).not.toContain(canarySecret)
      expect((result as unknown as Record<string, unknown>).message).toBeUndefined()
      for (const row of result.results) {
        expect((row as unknown as Record<string, unknown>).error).toBeUndefined()
      }
    })

    it('rejects when success_count + skipped_count > total_count', async () => {
      respond({
        success_count: 5,
        skipped_count: 6,
        total_count: 10,
        results: [],
      })
      await expect(api.refreshAllEmails()).rejects.toThrow('刷新邮箱响应格式无效')
    })

    it('rejects negative, non-integer, or unsafe integer counters', async () => {
      respond({ success_count: -1, skipped_count: 0, total_count: 10 })
      await expect(api.refreshAllEmails()).rejects.toThrow('刷新邮箱响应格式无效')

      respond({ success_count: 1, skipped_count: 0, total_count: 5.5 })
      await expect(api.refreshAllEmails()).rejects.toThrow('刷新邮箱响应格式无效')

      respond({ success_count: 1, skipped_count: 0, total_count: Infinity })
      await expect(api.refreshAllEmails()).rejects.toThrow('刷新邮箱响应格式无效')
    })

    it('rejects missing counters safely and never fabricates zero', async () => {
      respond({ skipped_count: 0, total_count: 10 })
      await expect(api.refreshAllEmails()).rejects.toThrow('刷新邮箱响应格式无效')

      respond({ success_count: 1, total_count: 10 })
      await expect(api.refreshAllEmails()).rejects.toThrow('刷新邮箱响应格式无效')

      respond({ success_count: 1, skipped_count: 0 })
      await expect(api.refreshAllEmails()).rejects.toThrow('刷新邮箱响应格式无效')
    })

    it('rejects when aggregate counters are inherited from prototype', async () => {
      const proto = { success_count: 1, skipped_count: 1, total_count: 2 }
      const envelope = Object.create(proto) as Record<string, unknown>
      envelope.results = []

      const spy = vi.spyOn(clientModule, 'requestJson').mockResolvedValueOnce(envelope as never)
      try {
        await expect(api.refreshAllEmails()).rejects.toThrow('刷新邮箱响应格式无效')
      } finally {
        spy.mockRestore()
      }
    })

    it('rejects malformed results rows', async () => {
      // Row missing filename
      respond({
        success_count: 1,
        skipped_count: 0,
        total_count: 1,
        results: [{ user_email: 'a@example.invalid', success: true }],
      })
      await expect(api.refreshAllEmails()).rejects.toThrow('刷新邮箱响应格式无效')

      // Row missing boolean success
      respond({
        success_count: 1,
        skipped_count: 0,
        total_count: 1,
        results: [{ filename: 'a.json', success: 'yes' }],
      })
      await expect(api.refreshAllEmails()).rejects.toThrow('刷新邮箱响应格式无效')
    })
  })

  describe('Group 3: dedup zero/success/partial with prototype fields and secret canaries', () => {
    it('zero duplicates returns full zero-deletion envelope with outcome: success and error_count: 0', async () => {
      respond({
        deleted_count: 0,
        kept_count: 5,
        total_count: 5,
        unique_emails_count: 4,
        no_email_count: 1,
        duplicate_groups: [],
        delete_errors: [],
        message: '未发现重复邮箱',
      })

      const result: DeduplicateByEmailResult = await api.deduplicateByEmail()

      expect(result.deleted_count).toBe(0)
      expect(result.kept_count).toBe(5)
      expect(result.total_count).toBe(5)
      expect(result.unique_emails_count).toBe(4)
      expect(result.no_email_count).toBe(1)
      expect(result.duplicate_groups).toEqual([])
      expect(result.outcome).toBe('success')
      expect(result.error_count).toBe(0)
      expect((result as unknown as Record<string, unknown>).message).toBeUndefined()
    })

    it('validates duplicate_groups metadata, sum of duplicate_counts matching deleted_count, and projects clean outcome', async () => {
      respond({
        deleted_count: 3,
        kept_count: 2,
        total_count: 5,
        unique_emails_count: 2,
        no_email_count: 0,
        duplicate_groups: [
          {
            email: 'user1@example.invalid',
            kept_file: 'a.json',
            deleted_files: ['b.json', 'c.json'],
            duplicate_count: 2,
          },
          {
            email: 'user2@example.invalid',
            kept_file: 'd.json',
            deleted_files: ['e.json'],
            duplicate_count: 1,
          },
        ],
        delete_errors: [],
        message: '去重成功 3 项',
      })

      const result: DeduplicateByEmailResult = await api.deduplicateByEmail()

      expect(result.deleted_count).toBe(3)
      expect(result.kept_count).toBe(2)
      expect(result.total_count).toBe(5)
      expect(result.outcome).toBe('success')
      expect(result.error_count).toBe(0)
      expect(result.duplicate_groups).toHaveLength(2)
      expect(result.duplicate_groups[0].email).toBe('user1@example.invalid')
      expect(result.duplicate_groups[0].kept_file).toBe('a.json')
      expect(result.duplicate_groups[0].deleted_files).toEqual(['b.json', 'c.json'])
      expect(result.duplicate_groups[0].duplicate_count).toBe(2)
      expect(result.duplicate_groups[1].deleted_files).toEqual(['e.json'])
      expect(result.duplicate_groups[1].duplicate_count).toBe(1)
    })

    it('delete_errors with partial deletions projects outcome: partial and hides raw exception canary strings', async () => {
      const canarySecret = 'SECRET-CANARY-DATABASE-LOCKED-ON-FILE-C'
      respond({
        deleted_count: 1,
        kept_count: 4,
        total_count: 5,
        unique_emails_count: 2,
        no_email_count: 1,
        duplicate_groups: [
          {
            email: 'user1@example.invalid',
            kept_file: 'a.json',
            deleted_files: ['b.json'],
            duplicate_count: 1,
          },
        ],
        delete_errors: [`SQLite error: ${canarySecret}`],
        message: `去重部分完成: ${canarySecret}`,
      })

      const result: DeduplicateByEmailResult = await api.deduplicateByEmail()

      expect(result.deleted_count).toBe(1)
      expect(result.outcome).toBe('partial')
      expect(result.error_count).toBe(1)
      expect(JSON.stringify(result)).not.toContain(canarySecret)
      expect((result as unknown as Record<string, unknown>).delete_errors).toBeUndefined()
      expect((result as unknown as Record<string, unknown>).message).toBeUndefined()
    })

    it('delete_errors with zero deletions projects outcome: failed and never unconditional success', async () => {
      const canarySecret = 'SECRET-CANARY-STORAGE-DEADLOCK'
      respond({
        deleted_count: 0,
        kept_count: 5,
        total_count: 5,
        unique_emails_count: 2,
        no_email_count: 1,
        duplicate_groups: [],
        delete_errors: [`Disk failure: ${canarySecret}`],
        message: `完全失败: ${canarySecret}`,
      })

      const result: DeduplicateByEmailResult = await api.deduplicateByEmail()

      expect(result.deleted_count).toBe(0)
      expect(result.outcome).toBe('failed')
      expect(result.error_count).toBe(1)
      expect(JSON.stringify(result)).not.toContain(canarySecret)
      expect((result as unknown as Record<string, unknown>).delete_errors).toBeUndefined()
    })

    it('rejects inconsistent counters: deleted_count + kept_count !== total_count', async () => {
      respond({
        deleted_count: 1,
        kept_count: 3,
        total_count: 5, // 1 + 3 !== 5
        unique_emails_count: 2,
        no_email_count: 1,
        duplicate_groups: [{ email: 'u@example.invalid', kept_file: 'a.json', deleted_files: ['b.json'], duplicate_count: 1 }],
      })
      await expect(api.deduplicateByEmail()).rejects.toThrow('凭证去重响应格式无效')
    })

    it('rejects when sum of duplicate_counts does not match deleted_count', async () => {
      respond({
        deleted_count: 2,
        kept_count: 3,
        total_count: 5,
        unique_emails_count: 2,
        no_email_count: 1,
        duplicate_groups: [
          { email: 'u@example.invalid', kept_file: 'a.json', deleted_files: ['b.json'], duplicate_count: 1 }, // sum=1 !== 2
        ],
      })
      await expect(api.deduplicateByEmail()).rejects.toThrow('凭证去重响应格式无效')
    })

    it('rejects when deleted_files.length !== duplicate_count', async () => {
      respond({
        deleted_count: 2,
        kept_count: 3,
        total_count: 5,
        unique_emails_count: 2,
        no_email_count: 1,
        duplicate_groups: [
          { email: 'u@example.invalid', kept_file: 'a.json', deleted_files: ['b.json'], duplicate_count: 2 }, // 1 !== 2
        ],
      })
      await expect(api.deduplicateByEmail()).rejects.toThrow('凭证去重响应格式无效')
    })

    it('rejects inherited prototype counters and metadata in deduplicateByEmail', async () => {
      const proto = {
        deleted_count: 0,
        kept_count: 5,
        total_count: 5,
        unique_emails_count: 4,
        no_email_count: 1,
        duplicate_groups: [],
      }
      const envelope = Object.create(proto) as Record<string, unknown>

      const spy = vi.spyOn(clientModule, 'requestJson').mockResolvedValueOnce(envelope as never)
      try {
        await expect(api.deduplicateByEmail()).rejects.toThrow('凭证去重响应格式无效')
      } finally {
        spy.mockRestore()
      }
    })

    it('rejects inherited prototype properties within duplicate_groups', async () => {
      const groupProto = { email: 'inherited@example.invalid' }
      const group = Object.create(groupProto) as Record<string, unknown>
      group.kept_file = 'a.json'
      group.deleted_files = ['b.json']
      group.duplicate_count = 1

      const envelope = {
        deleted_count: 1,
        kept_count: 4,
        total_count: 5,
        unique_emails_count: 2,
        no_email_count: 1,
        duplicate_groups: [group],
      }

      const spy = vi.spyOn(clientModule, 'requestJson').mockResolvedValueOnce(envelope as never)
      try {
        await expect(api.deduplicateByEmail()).rejects.toThrow('凭证去重响应格式无效')
      } finally {
        spy.mockRestore()
      }
    })

    it('sanitizes ApiError 400 and 500 without leaking raw payload or canary', async () => {
      const canary = 'API-ERROR-SECRET-CANARY-TOKEN'
      respond({ error: 'dedup_failed', message: `Leaked secret: ${canary}`, payload: { canary } }, 400)

      let caughtErr: unknown
      try {
        await api.deduplicateByEmail()
      } catch (err) {
        caughtErr = err
      }

      expect(caughtErr).toBeInstanceOf(ApiError)
      const apiErr = caughtErr as ApiError
      expect(apiErr.status).toBe(400)
      expect(apiErr.payload).toBeNull()
      expect(apiErr.message).toBe('请求被拒绝（HTTP 400）。')
      expect(JSON.stringify(apiErr)).not.toContain(canary)
    })
  })

  describe('Group 4: real session, channel, abort, and fixture boundaries', () => {
    it('pre-call aborted signal throws AbortError without transport', async () => {
      const controller = new AbortController()
      controller.abort()

      await expect(api.refreshAllEmails(controller.signal)).rejects.toSatisfy((err: unknown) => {
        return (err instanceof DOMException && err.name === 'AbortError') || (err as Error).name === 'AbortError'
      })
      await expect(api.deduplicateByEmail(controller.signal)).rejects.toSatisfy((err: unknown) => {
        return (err instanceof DOMException && err.name === 'AbortError') || (err as Error).name === 'AbortError'
      })
      expect(fetch).not.toHaveBeenCalled()
    })

    it('throws AbortError even if transport ignores abort and resolves late', async () => {
      const controller = new AbortController()
      vi.mocked(fetch).mockImplementationOnce(async () => {
        controller.abort()
        return Response.json({
          success_count: 0,
          skipped_count: 0,
          total_count: 0,
          results: [],
        })
      })
      await expect(api.refreshAllEmails(controller.signal)).rejects.toSatisfy((err: unknown) => {
        return (err instanceof DOMException && err.name === 'AbortError') || (err as Error).name === 'AbortError'
      })

      const controller2 = new AbortController()
      vi.mocked(fetch).mockImplementationOnce(async () => {
        controller2.abort()
        return Response.json({
          deleted_count: 0,
          kept_count: 0,
          total_count: 0,
          unique_emails_count: 0,
          no_email_count: 0,
          duplicate_groups: [],
        })
      })
      await expect(api.deduplicateByEmail(controller2.signal)).rejects.toSatisfy((err: unknown) => {
        return (err instanceof DOMException && err.name === 'AbortError') || (err as Error).name === 'AbortError'
      })
    })

    it('session invalidation during transport throws AbortError on post-ownership check', async () => {
      vi.mocked(fetch).mockImplementationOnce(async () => {
        setSessionToken('session-changed-mid-flight')
        return Response.json({
          success_count: 0,
          skipped_count: 0,
          total_count: 0,
          results: [],
        })
      })
      await expect(api.refreshAllEmails()).rejects.toSatisfy((err: unknown) => {
        return err instanceof DOMException && err.name === 'AbortError'
      })

      vi.mocked(fetch).mockImplementationOnce(async () => {
        setSessionToken('session-changed-mid-flight-2')
        return Response.json({
          deleted_count: 0,
          kept_count: 0,
          total_count: 0,
          unique_emails_count: 0,
          no_email_count: 0,
          duplicate_groups: [],
        })
      })
      await expect(api.deduplicateByEmail()).rejects.toSatisfy((err: unknown) => {
        return err instanceof DOMException && err.name === 'AbortError'
      })
    })

    it('channel switch on scoped API throws AbortError on post-ownership check', async () => {
      const epoch = getSessionSnapshot().sessionEpoch
      const scope = capturePanelScope(epoch)
      const scopedApi = createCredentialApi('antigravity', scope)

      vi.mocked(fetch).mockImplementationOnce(async () => {
        __commitPanelChannel('geminicli')
        return Response.json({
          success_count: 0,
          skipped_count: 0,
          total_count: 0,
          results: [],
        })
      })
      await expect(scopedApi.refreshAllEmails()).rejects.toSatisfy((err: unknown) => {
        return err instanceof DOMException && err.name === 'AbortError'
      })

      __commitPanelChannel('antigravity')
      const scope2 = capturePanelScope(getSessionSnapshot().sessionEpoch)
      const scopedApi2 = createCredentialApi('antigravity', scope2)

      vi.mocked(fetch).mockImplementationOnce(async () => {
        __commitPanelChannel('geminicli')
        return Response.json({
          deleted_count: 0,
          kept_count: 0,
          total_count: 0,
          unique_emails_count: 0,
          no_email_count: 0,
          duplicate_groups: [],
        })
      })
      await expect(scopedApi2.deduplicateByEmail()).rejects.toSatisfy((err: unknown) => {
        return err instanceof DOMException && err.name === 'AbortError'
      })
    })

    it('fixture mode fails closed without transport or fabricated plaintext', async () => {
      vi.stubEnv('VITE_UI_FIXTURES', 'true')
      const agApi = createCredentialApi('antigravity')
      const gcliApi = createCredentialApi('geminicli')

      await expect(agApi.refreshAllEmails()).rejects.toThrow('暂不支持预览数据')
      await expect(agApi.deduplicateByEmail()).rejects.toThrow('暂不支持预览数据')

      await expect(gcliApi.refreshAllEmails()).rejects.toThrow('Gemini CLI 暂不支持预览数据')
      await expect(gcliApi.deduplicateByEmail()).rejects.toThrow('Gemini CLI 暂不支持预览数据')

      expect(fetch).not.toHaveBeenCalled()
    })
  })
})
