import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as clientModule from '@/api/client'
import { ApiError } from '@/api/client'
import { getSessionSnapshot, setSessionToken } from '@/auth/session'
import {
  __commitPanelChannel,
  capturePanelScope,
} from '@/domain/panel'
import { api, createCredentialApi } from './api'

beforeEach(() => {
  setSessionToken('synthetic-session')
})

afterEach(() => {
  __commitPanelChannel('antigravity')
})

const respond = (body: unknown, status = 200, headers?: Record<string, string>) =>
  vi.mocked(fetch).mockResolvedValueOnce(Response.json(body, { status, headers }))

describe('credential readContent and fetchEmail endpoints', () => {
  describe('Case 1: readContent detail read and full JSON content projection', () => {
    it('explicitly GETs creds/detail/{filename}?mode and returns only {filename,content}, dropping extra envelope fields', async () => {
      const canaryContent = {
        client_id: 'synthetic-client-id',
        client_secret: 'synthetic-canary-secret-123',
        nested: { refresh_token: 'synthetic-rt', quota: [100, 200] },
      }
      const envelope = {
        filename: 'cred-1.json',
        content: canaryContent,
        status: { disabled: false, error_codes: [] },
        backend_type: 'oauth',
        user_email: 'canary@example.invalid',
        model_cooldowns: { 'claude-opus': 12345 },
        preview: false,
        enable_credit: true,
      }
      respond(envelope)

      const result = await api.readContent('cred-1.json')

      expect(result).toEqual({
        filename: 'cred-1.json',
        content: canaryContent,
      })
      expect(Object.keys(result).sort()).toEqual(['content', 'filename'])
      expect(fetch).toHaveBeenCalledTimes(1)

      const [url, init] = vi.mocked(fetch).mock.calls[0]
      const parsed = new URL(String(url))
      expect(parsed.pathname).toBe('/creds/detail/cred-1.json')
      expect(parsed.searchParams.get('mode')).toBe('antigravity')
      expect(init?.method).toBe('GET')
      expect(init?.body).toBeUndefined()
    })

    it('preserves full own JSON-object content without filtering nested fields', async () => {
      const richContent = {
        type: 'authorized_user',
        client_id: 'client-xyz',
        secret_key: 'secret-canary-val',
        deep: { a: { b: { c: [1, null, true, 'canary-leaf'] } } },
        metadata: { tags: ['alpha', 'beta'], score: 99.5 },
      }
      respond({ filename: 'rich.json', content: richContent })

      const result = await api.readContent('rich.json')

      expect(result.content).toEqual(richContent)
      expect(result.content.deep).toEqual(richContent.deep)
    })

    it('encodes filename exactly once as a single path segment and requires matching response filename', async () => {
      const specialName = 'cred space #1 (test).json'
      respond({ filename: specialName, content: { key: 'value' } })

      const result = await api.readContent(specialName)

      expect(result.filename).toBe(specialName)
      const [url] = vi.mocked(fetch).mock.calls[0]
      const parsed = new URL(String(url))
      expect(parsed.pathname).toBe(`/creds/detail/${encodeURIComponent(specialName)}`)
    })

    it('queries mode parameter for geminicli mode', async () => {
      const gcliApi = createCredentialApi('geminicli')
      respond({ filename: 'gcli.json', content: { token: 'gcli-canary' } })

      const result = await gcliApi.readContent('gcli.json')

      expect(result.filename).toBe('gcli.json')
      const [url] = vi.mocked(fetch).mock.calls[0]
      const parsed = new URL(String(url))
      expect(parsed.searchParams.get('mode')).toBe('geminicli')
    })
  })

  describe('Case 2: fetchEmail user_email retrieval and envelope dropping', () => {
    it('explicitly POSTs creds/fetch-email/{filename}?mode with no body/force', async () => {
      respond({ filename: 'a.json', user_email: 'test@example.invalid', message: '成功获取用户邮箱' })

      const result = await api.fetchEmail('a.json')

      expect(result).toEqual({ filename: 'a.json', email: 'test@example.invalid' })
      expect(fetch).toHaveBeenCalledTimes(1)

      const [url, init] = vi.mocked(fetch).mock.calls[0]
      const parsed = new URL(String(url))
      expect(parsed.pathname).toBe('/creds/fetch-email/a.json')
      expect(parsed.searchParams.get('mode')).toBe('antigravity')
      expect(parsed.searchParams.has('force')).toBe(false)
      expect(init?.method).toBe('POST')
      expect(init?.body).toBeUndefined()
    })

    it('accepts real HTTP200 own user_email nonempty string without requiring success:true', async () => {
      respond({ filename: 'no-success-flag.json', user_email: 'real.user@domain.invalid', message: 'ok' })

      const result = await api.fetchEmail('no-success-flag.json')

      expect(result).toEqual({ filename: 'no-success-flag.json', email: 'real.user@domain.invalid' })
    })

    it('returns only {filename, email} and drops message and extra envelope fields', async () => {
      respond({
        filename: 'envelope.json',
        user_email: 'user@example.invalid',
        message: '成功获取用户邮箱',
        extra_field_1: 'drop_me',
        extra_field_2: 123,
      })

      const result = await api.fetchEmail('envelope.json')

      expect(result).toEqual({ filename: 'envelope.json', email: 'user@example.invalid' })
      expect(Object.keys(result).sort()).toEqual(['email', 'filename'])
    })

    it('keeps raw strings unchanged without guessed email validation', async () => {
      const rawString = 'raw+string#without-domain-guess'
      respond({ filename: 'unconventional.json', user_email: rawString })

      const result = await api.fetchEmail('unconventional.json')

      expect(result.email).toBe(rawString)
    })

    it('queries mode parameter for geminicli mode in fetchEmail', async () => {
      const gcliApi = createCredentialApi('geminicli')
      respond({ filename: 'gcli-email.json', user_email: 'gcli@example.invalid' })

      const result = await gcliApi.fetchEmail('gcli-email.json')

      expect(result).toEqual({ filename: 'gcli-email.json', email: 'gcli@example.invalid' })
      const [url, init] = vi.mocked(fetch).mock.calls[0]
      expect(new URL(String(url)).searchParams.get('mode')).toBe('geminicli')
      expect(init?.method).toBe('POST')
    })
  })

  describe('Case 3: error sanitization, canary protection, and fixture mode fail-closed', () => {
    it('rejects malformed success envelopes safely without exposing internal details', async () => {
      // Mismatched filename for readContent
      respond({ filename: 'other.json', content: { key: 'val' } })
      await expect(api.readContent('target.json')).rejects.toThrow('凭证标识不一致')

      // Missing / non-object / array content for readContent
      respond({ filename: 'target.json', content: null })
      await expect(api.readContent('target.json')).rejects.toThrow('凭证内容格式无效')
      respond({ filename: 'target.json', content: 'not-an-object' })
      await expect(api.readContent('target.json')).rejects.toThrow('凭证内容格式无效')
      respond({ filename: 'target.json', content: [1, 2, 3] })
      await expect(api.readContent('target.json')).rejects.toThrow('凭证内容格式无效')

      // Mismatched filename for fetchEmail
      respond({ filename: 'other.json', user_email: 'a@example.invalid' })
      await expect(api.fetchEmail('target.json')).rejects.toThrow('凭证标识不一致')

      // Empty or non-string user_email for fetchEmail
      respond({ filename: 'target.json', user_email: '' })
      await expect(api.fetchEmail('target.json')).rejects.toThrow('邮箱响应格式无效')
      respond({ filename: 'target.json', user_email: null })
      await expect(api.fetchEmail('target.json')).rejects.toThrow('邮箱响应格式无效')
      respond({ filename: 'target.json', user_email: 12345 })
      await expect(api.fetchEmail('target.json')).rejects.toThrow('邮箱响应格式无效')
    })

    it('catches ApiError without exposing raw payload, message, cause or secret canary', async () => {
      const canarySecret = 'TOP-SECRET-CANARY-TOKEN-XYZ'
      respond({ error: 'credential_invalid', message: `Token ${canarySecret} expired`, secret_leak: canarySecret }, 400)

      let caughtError: unknown
      try {
        await api.readContent('canary.json')
      } catch (err) {
        caughtError = err
      }
      expect(caughtError).toBeInstanceOf(ApiError)
      const apiErr = caughtError as ApiError
      expect(apiErr.status).toBe(400)
      expect(apiErr.payload).toBeNull()
      expect((apiErr as Error).cause).toBeUndefined()
      expect(apiErr.message).not.toContain(canarySecret)
      expect(JSON.stringify(apiErr)).not.toContain(canarySecret)

      // Test fetchEmail with 404 containing canary
      respond({ error: 'not_found', message: `No email for ${canarySecret}` }, 404)
      let caughtEmailErr: unknown
      try {
        await api.fetchEmail('canary.json')
      } catch (err) {
        caughtEmailErr = err
      }
      expect(caughtEmailErr).toBeInstanceOf(ApiError)
      const apiErr404 = caughtEmailErr as ApiError
      expect(apiErr404.status).toBe(404)
      expect(apiErr404.payload).toBeNull()
      expect((apiErr404 as Error).cause).toBeUndefined()
      expect(apiErr404.message).not.toContain(canarySecret)
    })

    it('catches transport/network error without exposing raw message or secret canary in cause', async () => {
      const canarySecret = 'NETWORK-SECRET-CANARY-999'
      vi.mocked(fetch).mockRejectedValueOnce(new TypeError(`Connection failed to https://upstream.invalid/key=${canarySecret}`))

      let caughtError: unknown
      try {
        await api.readContent('network.json')
      } catch (err) {
        caughtError = err
      }
      expect(caughtError).toBeInstanceOf(Error)
      expect(caughtError).not.toBeInstanceOf(ApiError)
      expect((caughtError as Error).cause).toBeUndefined()
      expect((caughtError as Error).message).not.toContain(canarySecret)
      expect(String(caughtError)).not.toContain(canarySecret)
    })

    it('fixture mode fails closed without transport or fabricated plaintext', async () => {
      vi.stubEnv('VITE_UI_FIXTURES', 'true')
      const agApi = createCredentialApi('antigravity')
      const gcliApi = createCredentialApi('geminicli')

      await expect(agApi.readContent('preview.json')).rejects.toThrow('暂不支持预览数据')
      await expect(agApi.fetchEmail('preview.json')).rejects.toThrow('暂不支持预览数据')

      await expect(gcliApi.readContent('preview.json')).rejects.toThrow('Gemini CLI 暂不支持预览数据')
      await expect(gcliApi.fetchEmail('preview.json')).rejects.toThrow('Gemini CLI 暂不支持预览数据')

      expect(fetch).not.toHaveBeenCalled()
    })

    describe('former keyword bypass cannot expose unknown error text across readContent and fetchEmail', () => {
      const FORMER_BYPASS_KEYWORDS = ['邮箱', '凭证', '暂不支持', 'Gemini CLI', '服务根'] as const
      const SECRET_CANARY = 'SECRET_CANARY'

      describe.each(FORMER_BYPASS_KEYWORDS)('keyword: %s', (kw) => {
        it(`readContent rejects unknown Error/TypeError containing "${kw}" and canary safely`, async () => {
          const original = kw.length % 2 === 0
            ? new TypeError(`类型错误 ${kw} 泄漏: ${SECRET_CANARY}`)
            : new Error(`业务错误 ${kw} 泄漏: ${SECRET_CANARY}`)
          Object.assign(original, {
            cause: new Error(`cause-${kw}-${SECRET_CANARY}`),
            payload: { canary: `${kw}-${SECRET_CANARY}` },
          })
          vi.mocked(fetch).mockRejectedValueOnce(original)

          let caught: unknown
          try {
            await api.readContent('target.json')
            expect.unreachable('readContent should reject')
          } catch (err) {
            caught = err
          }

          expect(caught).not.toBe(original)
          expect(caught).toBeInstanceOf(Error)
          expect((caught as Error).message).toBe('请求未完成，请稍后重试。')
          expect(String(caught)).not.toContain(SECRET_CANARY)
          expect(String(caught)).not.toContain(kw)
          if ((caught as Error).stack) {
            expect((caught as Error).stack).not.toContain(SECRET_CANARY)
            expect((caught as Error).stack).not.toContain(kw)
          }
          expect((caught as { cause?: unknown }).cause).toBeUndefined()
          expect((caught as { payload?: unknown }).payload).toBeUndefined()
          expect(JSON.stringify(caught)).not.toContain(SECRET_CANARY)
          expect(JSON.stringify(caught)).not.toContain(kw)
        })

        it(`fetchEmail rejects unknown Error/TypeError containing "${kw}" and canary safely`, async () => {
          const original = kw.length % 2 === 1
            ? new TypeError(`类型错误 ${kw} 泄漏: ${SECRET_CANARY}`)
            : new Error(`业务错误 ${kw} 泄漏: ${SECRET_CANARY}`)
          Object.assign(original, {
            cause: new Error(`cause-fetch-${kw}-${SECRET_CANARY}`),
            payload: { canary: `${kw}-${SECRET_CANARY}` },
          })
          vi.mocked(fetch).mockRejectedValueOnce(original)

          let caught: unknown
          try {
            await api.fetchEmail('target.json')
            expect.unreachable('fetchEmail should reject')
          } catch (err) {
            caught = err
          }

          expect(caught).not.toBe(original)
          expect(caught).toBeInstanceOf(Error)
          expect((caught as Error).message).toBe('请求未完成，请稍后重试。')
          expect(String(caught)).not.toContain(SECRET_CANARY)
          expect(String(caught)).not.toContain(kw)
          if ((caught as Error).stack) {
            expect((caught as Error).stack).not.toContain(SECRET_CANARY)
            expect((caught as Error).stack).not.toContain(kw)
          }
          expect((caught as { cause?: unknown }).cause).toBeUndefined()
          expect((caught as { payload?: unknown }).payload).toBeUndefined()
          expect(JSON.stringify(caught)).not.toContain(SECRET_CANARY)
          expect(JSON.stringify(caught)).not.toContain(kw)
        })
      })

      it('rejects longer canary-bearing messages containing validation phrases as generic safe failure without classification bypass', async () => {
        for (const phrase of ['凭证标识不一致', '凭证内容格式无效', '邮箱响应格式无效']) {
          const originalRead = new Error(`${phrase} - ${SECRET_CANARY}`)
          Object.assign(originalRead, {
            cause: new Error(`cause-${SECRET_CANARY}`),
            payload: { canary: SECRET_CANARY },
          })
          vi.mocked(fetch).mockRejectedValueOnce(originalRead)

          let caughtRead: unknown
          try {
            await api.readContent('target.json')
            expect.unreachable('readContent should reject')
          } catch (err) {
            caughtRead = err
          }

          expect(caughtRead).not.toBe(originalRead)
          expect(caughtRead).toBeInstanceOf(Error)
          expect((caughtRead as Error).message).toBe('请求未完成，请稍后重试。')
          expect((caughtRead as Error).message).not.toBe(phrase)
          expect(String(caughtRead)).not.toContain(SECRET_CANARY)
          expect((caughtRead as { cause?: unknown }).cause).toBeUndefined()
          expect((caughtRead as { payload?: unknown }).payload).toBeUndefined()

          const originalEmail = new Error(`${phrase} - ${SECRET_CANARY}`)
          Object.assign(originalEmail, {
            cause: new Error(`cause-${SECRET_CANARY}`),
            payload: { canary: SECRET_CANARY },
          })
          vi.mocked(fetch).mockRejectedValueOnce(originalEmail)

          let caughtEmail: unknown
          try {
            await api.fetchEmail('target.json')
            expect.unreachable('fetchEmail should reject')
          } catch (err) {
            caughtEmail = err
          }

          expect(caughtEmail).not.toBe(originalEmail)
          expect(caughtEmail).toBeInstanceOf(Error)
          expect((caughtEmail as Error).message).toBe('请求未完成，请稍后重试。')
          expect((caughtEmail as Error).message).not.toBe(phrase)
          expect(String(caughtEmail)).not.toContain(SECRET_CANARY)
          expect((caughtEmail as { cause?: unknown }).cause).toBeUndefined()
          expect((caughtEmail as { payload?: unknown }).payload).toBeUndefined()
        }
      })
    })

    describe('AbortError retains cancellation classification without retaining original secrets', () => {
      const SECRET_CANARY = 'SECRET_CANARY'

      it('sanitizes genuine DOMException AbortError carrying canary for readContent and fetchEmail', async () => {
        const domAbortRead = new DOMException(`DOMException cancelled: ${SECRET_CANARY}`, 'AbortError')
        Object.assign(domAbortRead, {
          cause: new Error(`cause-dom-${SECRET_CANARY}`),
          payload: { leak: SECRET_CANARY },
        })
        vi.mocked(fetch).mockRejectedValueOnce(domAbortRead)

        let caughtRead: unknown
        try {
          await api.readContent('target.json')
          expect.unreachable('readContent should reject')
        } catch (err) {
          caughtRead = err
        }

        expect(caughtRead).not.toBe(domAbortRead)
        expect(caughtRead).toBeInstanceOf(DOMException)
        expect((caughtRead as DOMException).name).toBe('AbortError')
        expect((caughtRead as DOMException).message).toBe('操作已取消。')
        expect(String(caughtRead)).not.toContain(SECRET_CANARY)
        if ((caughtRead as Error).stack) {
          expect((caughtRead as Error).stack).not.toContain(SECRET_CANARY)
        }
        expect((caughtRead as { cause?: unknown }).cause).toBeUndefined()
        expect((caughtRead as { payload?: unknown }).payload).toBeUndefined()
        expect(JSON.stringify(caughtRead)).not.toContain(SECRET_CANARY)

        const domAbortEmail = new DOMException(`DOMException cancelled: ${SECRET_CANARY}`, 'AbortError')
        Object.assign(domAbortEmail, {
          cause: new Error(`cause-dom-email-${SECRET_CANARY}`),
          payload: { leak: SECRET_CANARY },
        })
        vi.mocked(fetch).mockRejectedValueOnce(domAbortEmail)

        let caughtEmail: unknown
        try {
          await api.fetchEmail('target.json')
          expect.unreachable('fetchEmail should reject')
        } catch (err) {
          caughtEmail = err
        }

        expect(caughtEmail).not.toBe(domAbortEmail)
        expect(caughtEmail).toBeInstanceOf(DOMException)
        expect((caughtEmail as DOMException).name).toBe('AbortError')
        expect((caughtEmail as DOMException).message).toBe('操作已取消。')
        expect(String(caughtEmail)).not.toContain(SECRET_CANARY)
        if ((caughtEmail as Error).stack) {
          expect((caughtEmail as Error).stack).not.toContain(SECRET_CANARY)
        }
        expect((caughtEmail as { cause?: unknown }).cause).toBeUndefined()
        expect((caughtEmail as { payload?: unknown }).payload).toBeUndefined()
        expect(JSON.stringify(caughtEmail)).not.toContain(SECRET_CANARY)
      })

      it('sanitizes Error named AbortError with explicit cause for readContent and fetchEmail', async () => {
        const errAbortRead = new Error(`Error cancelled: ${SECRET_CANARY}`)
        errAbortRead.name = 'AbortError'
        Object.assign(errAbortRead, {
          cause: new Error(`cause-err-${SECRET_CANARY}`),
          payload: { leak: SECRET_CANARY },
        })
        vi.mocked(fetch).mockRejectedValueOnce(errAbortRead)

        let caughtRead: unknown
        try {
          await api.readContent('target.json')
          expect.unreachable('readContent should reject')
        } catch (err) {
          caughtRead = err
        }

        expect(caughtRead).not.toBe(errAbortRead)
        expect((caughtRead as { name?: string }).name).toBe('AbortError')
        expect((caughtRead as Error).message).toBe('操作已取消。')
        expect(String(caughtRead)).not.toContain(SECRET_CANARY)
        if ((caughtRead as Error).stack) {
          expect((caughtRead as Error).stack).not.toContain(SECRET_CANARY)
        }
        expect((caughtRead as { cause?: unknown }).cause).toBeUndefined()
        expect((caughtRead as { payload?: unknown }).payload).toBeUndefined()
        expect(JSON.stringify(caughtRead)).not.toContain(SECRET_CANARY)

        const errAbortEmail = new Error(`Error cancelled: ${SECRET_CANARY}`)
        errAbortEmail.name = 'AbortError'
        Object.assign(errAbortEmail, {
          cause: new Error(`cause-err-email-${SECRET_CANARY}`),
          payload: { leak: SECRET_CANARY },
        })
        vi.mocked(fetch).mockRejectedValueOnce(errAbortEmail)

        let caughtEmail: unknown
        try {
          await api.fetchEmail('target.json')
          expect.unreachable('fetchEmail should reject')
        } catch (err) {
          caughtEmail = err
        }

        expect(caughtEmail).not.toBe(errAbortEmail)
        expect((caughtEmail as { name?: string }).name).toBe('AbortError')
        expect((caughtEmail as Error).message).toBe('操作已取消。')
        expect(String(caughtEmail)).not.toContain(SECRET_CANARY)
        if ((caughtEmail as Error).stack) {
          expect((caughtEmail as Error).stack).not.toContain(SECRET_CANARY)
        }
        expect((caughtEmail as { cause?: unknown }).cause).toBeUndefined()
        expect((caughtEmail as { payload?: unknown }).payload).toBeUndefined()
        expect(JSON.stringify(caughtEmail)).not.toContain(SECRET_CANARY)
      })
    })

    describe('required success-envelope fields must be own properties', () => {
      it('rejects readContent when filename is inherited from prototype', async () => {
        const proto = { filename: 'inherited-read-filename.json' }
        const envelope = Object.create(proto) as { filename: string; content: Record<string, unknown> }
        envelope.content = { legitimate_key: 'nested-val' }

        expect(Object.prototype.hasOwnProperty.call(envelope, 'filename')).toBe(false)
        expect(Object.prototype.hasOwnProperty.call(envelope, 'content')).toBe(true)
        expect(envelope.filename).toBe('inherited-read-filename.json')

        const spy = vi.spyOn(clientModule, 'requestJson').mockResolvedValueOnce(envelope as never)
        try {
          let caught: unknown
          try {
            await api.readContent('inherited-read-filename.json')
            expect.unreachable('readContent should reject inherited filename')
          } catch (err) {
            caught = err
          }
          expect(caught).toBeInstanceOf(Error)
          expect((caught as Error).message).toBe('凭证标识不一致')
        } finally {
          spy.mockRestore()
        }
      })

      it('rejects readContent when content is inherited from prototype', async () => {
        const proto = { content: { legitimate_key: 'nested-val' } }
        const envelope = Object.create(proto) as { filename: string; content: Record<string, unknown> }
        envelope.filename = 'own-read-filename.json'

        expect(Object.prototype.hasOwnProperty.call(envelope, 'content')).toBe(false)
        expect(Object.prototype.hasOwnProperty.call(envelope, 'filename')).toBe(true)
        expect(envelope.content).toEqual({ legitimate_key: 'nested-val' })

        const spy = vi.spyOn(clientModule, 'requestJson').mockResolvedValueOnce(envelope as never)
        try {
          let caught: unknown
          try {
            await api.readContent('own-read-filename.json')
            expect.unreachable('readContent should reject inherited content')
          } catch (err) {
            caught = err
          }
          expect(caught).toBeInstanceOf(Error)
          expect((caught as Error).message).toBe('凭证内容格式无效')
        } finally {
          spy.mockRestore()
        }
      })

      it('rejects fetchEmail when filename is inherited from prototype', async () => {
        const proto = { filename: 'inherited-email-filename.json' }
        const envelope = Object.create(proto) as { filename: string; user_email: string }
        envelope.user_email = 'legit@example.invalid'

        expect(Object.prototype.hasOwnProperty.call(envelope, 'filename')).toBe(false)
        expect(Object.prototype.hasOwnProperty.call(envelope, 'user_email')).toBe(true)
        expect(envelope.filename).toBe('inherited-email-filename.json')

        const spy = vi.spyOn(clientModule, 'requestJson').mockResolvedValueOnce(envelope as never)
        try {
          let caught: unknown
          try {
            await api.fetchEmail('inherited-email-filename.json')
            expect.unreachable('fetchEmail should reject inherited filename')
          } catch (err) {
            caught = err
          }
          expect(caught).toBeInstanceOf(Error)
          expect((caught as Error).message).toBe('凭证标识不一致')
        } finally {
          spy.mockRestore()
        }
      })

      it('rejects fetchEmail when user_email is inherited from prototype', async () => {
        const proto = { user_email: 'inherited@example.invalid' }
        const envelope = Object.create(proto) as { filename: string; user_email: string }
        envelope.filename = 'own-email-filename.json'

        expect(Object.prototype.hasOwnProperty.call(envelope, 'user_email')).toBe(false)
        expect(Object.prototype.hasOwnProperty.call(envelope, 'filename')).toBe(true)
        expect(envelope.user_email).toBe('inherited@example.invalid')

        const spy = vi.spyOn(clientModule, 'requestJson').mockResolvedValueOnce(envelope as never)
        try {
          let caught: unknown
          try {
            await api.fetchEmail('own-email-filename.json')
            expect.unreachable('fetchEmail should reject inherited user_email')
          } catch (err) {
            caught = err
          }
          expect(caught).toBeInstanceOf(Error)
          expect((caught as Error).message).toBe('邮箱响应格式无效')
        } finally {
          spy.mockRestore()
        }
      })

      it('rejects inherited required fields through real-client response parse mock without losing prototype', async () => {
        const proto = { filename: 'inherited-parse-filename.json' }
        const envelope = Object.create(proto) as { filename: string; content: Record<string, unknown> }
        envelope.content = { legitimate_key: 'nested-val' }

        expect(Object.prototype.hasOwnProperty.call(envelope, 'filename')).toBe(false)
        expect(envelope.filename).toBe('inherited-parse-filename.json')

        vi.mocked(fetch).mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => envelope,
          text: async () => '',
          headers: new Headers({ 'content-type': 'application/json' }),
        } as unknown as Response)

        let caught: unknown
        try {
          await api.readContent('inherited-parse-filename.json')
          expect.unreachable('readContent should reject inherited filename via parse mock')
        } catch (err) {
          caught = err
        }
        expect(caught).toBeInstanceOf(Error)
        expect((caught as Error).message).toBe('凭证标识不一致')
      })

      it('accepts legitimate nested content containing prototype properties while preserving own envelope fields', async () => {
        const nestedProto = { inheritedConfig: 'proto-setting' }
        const nestedContent = Object.create(nestedProto) as Record<string, unknown>
        nestedContent.ownField = 'valid-value'

        const envelope = {
          filename: 'legit-nested.json',
          content: nestedContent,
        }
        expect(Object.prototype.hasOwnProperty.call(envelope, 'filename')).toBe(true)
        expect(Object.prototype.hasOwnProperty.call(envelope, 'content')).toBe(true)

        const spy = vi.spyOn(clientModule, 'requestJson').mockResolvedValueOnce(envelope as never)
        try {
          const result = await api.readContent('legit-nested.json')
          expect(result.filename).toBe('legit-nested.json')
          expect(result.content.ownField).toBe('valid-value')
          expect((result.content as typeof nestedContent & typeof nestedProto).inheritedConfig).toBe('proto-setting')
        } finally {
          spy.mockRestore()
        }
      })
    })
  })

  describe('Case 4: real session and channel ownership with cancellation semantics', () => {
    it('pre-call aborted signal throws AbortError without transport', async () => {
      const controller = new AbortController()
      controller.abort()

      await expect(api.readContent('abort.json', controller.signal)).rejects.toSatisfy((err: unknown) => {
        return (err instanceof DOMException && err.name === 'AbortError') || (err as Error).name === 'AbortError'
      })
      await expect(api.fetchEmail('abort.json', controller.signal)).rejects.toSatisfy((err: unknown) => {
        return (err instanceof DOMException && err.name === 'AbortError') || (err as Error).name === 'AbortError'
      })
      expect(fetch).not.toHaveBeenCalled()
    })

    it('throws AbortError even if mocked transport ignores abort and resolves', async () => {
      const controller = new AbortController()
      vi.mocked(fetch).mockImplementationOnce(async () => {
        controller.abort()
        return Response.json({ filename: 'ignored.json', content: { key: 'val' } })
      })
      await expect(api.readContent('ignored.json', controller.signal)).rejects.toSatisfy((err: unknown) => {
        return (err instanceof DOMException && err.name === 'AbortError') || (err as Error).name === 'AbortError'
      })

      const controller2 = new AbortController()
      vi.mocked(fetch).mockImplementationOnce(async () => {
        controller2.abort()
        return Response.json({ filename: 'ignored.json', user_email: 'canary@example.invalid' })
      })
      await expect(api.fetchEmail('ignored.json', controller2.signal)).rejects.toSatisfy((err: unknown) => {
        return (err instanceof DOMException && err.name === 'AbortError') || (err as Error).name === 'AbortError'
      })
    })

    it('session invalidation during transport throws AbortError on post-ownership check', async () => {
      vi.mocked(fetch).mockImplementationOnce(async () => {
        setSessionToken('session-changed-token')
        return Response.json({ filename: 'session.json', content: { key: 'val' } })
      })
      await expect(api.readContent('session.json')).rejects.toSatisfy((err: unknown) => {
        return err instanceof DOMException && err.name === 'AbortError'
      })

      vi.mocked(fetch).mockImplementationOnce(async () => {
        setSessionToken('session-changed-token-2')
        return Response.json({ filename: 'session.json', user_email: 'a@example.invalid' })
      })
      await expect(api.fetchEmail('session.json')).rejects.toSatisfy((err: unknown) => {
        return err instanceof DOMException && err.name === 'AbortError'
      })
    })

    it('channel switch on scoped API throws AbortError on post-ownership check', async () => {
      const epoch = getSessionSnapshot().sessionEpoch
      const scope = capturePanelScope(epoch)
      const scopedApi = createCredentialApi('antigravity', scope)

      vi.mocked(fetch).mockImplementationOnce(async () => {
        __commitPanelChannel('geminicli')
        return Response.json({ filename: 'channel.json', content: { key: 'val' } })
      })
      await expect(scopedApi.readContent('channel.json')).rejects.toSatisfy((err: unknown) => {
        return err instanceof DOMException && err.name === 'AbortError'
      })

      __commitPanelChannel('antigravity')
      const scope2 = capturePanelScope(getSessionSnapshot().sessionEpoch)
      const scopedApi2 = createCredentialApi('antigravity', scope2)

      vi.mocked(fetch).mockImplementationOnce(async () => {
        __commitPanelChannel('geminicli')
        return Response.json({ filename: 'channel.json', user_email: 'a@example.invalid' })
      })
      await expect(scopedApi2.fetchEmail('channel.json')).rejects.toSatisfy((err: unknown) => {
        return err instanceof DOMException && err.name === 'AbortError'
      })
    })
  })
})
