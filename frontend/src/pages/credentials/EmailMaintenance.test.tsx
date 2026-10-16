import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  getSessionSnapshot,
  getSessionValidationSnapshot,
  setSessionToken,
  __setSessionValidationStatus,
  type SessionValidationSnapshot,
} from '@/auth/session'
import {
  __commitPanelChannel,
  capturePanelScope,
  type PanelMode,
  type PanelScope,
} from '@/domain/panel'
import {
  EmailMaintenance,
  type EmailMaintenanceProps,
  type EmailMaintenanceTarget,
} from './EmailMaintenance'

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')

beforeEach(() => {
  setSessionToken('synthetic-session')
  __commitPanelChannel('antigravity')
})

afterEach(() => {
  cleanup()
  __commitPanelChannel('antigravity')
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor)
  } else {
    Reflect.deleteProperty(navigator, 'clipboard')
  }
  vi.restoreAllMocks()
})

const respond = (body: unknown, status = 200, headers?: Record<string, string>) =>
  vi.mocked(fetch).mockResolvedValueOnce(Response.json(body, { status, headers }))

function createOwnerGuard(initial = true) {
  let isOwner = initial
  let throwOnCheck = false
  return {
    isCurrentOwner: () => {
      if (throwOnCheck) throw new Error('Ownership guard failed')
      return isOwner
    },
    setOwner: (val: boolean) => {
      isOwner = val
    },
    setThrow: (val: boolean) => {
      throwOnCheck = val
    },
  }
}

function createProps(
  target: EmailMaintenanceTarget,
  options: {
    mode?: PanelMode
    isCurrentOwner?: () => boolean
    onRefresh?: () => void
    disabled?: boolean
    ownerRevision?: object
    scope?: PanelScope
    validation?: SessionValidationSnapshot
  } = {},
): EmailMaintenanceProps {
  const sessionSnap = getSessionSnapshot()
  const mode = options.mode ?? 'antigravity'
  const scope = options.scope ?? capturePanelScope(sessionSnap.sessionEpoch)
  const validation = options.validation ?? getSessionValidationSnapshot()
  const ownerRevision = options.ownerRevision ?? {}
  const isCurrentOwner = options.isCurrentOwner ?? (() => true)

  return {
    mode,
    scope,
    validation,
    ownerRevision,
    isCurrentOwner,
    disabled: options.disabled,
    target,
    onRefresh: options.onRefresh,
  }
}

function mockClipboard(writeTextImpl?: (text: string) => Promise<void>) {
  const writeText = vi.fn(writeTextImpl ?? (async () => {}))
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    writable: true,
    configurable: true,
  })
  return writeText
}

function removeClipboard() {
  Object.defineProperty(navigator, 'clipboard', {
    value: undefined,
    writable: true,
    configurable: true,
  })
}

describe('EmailMaintenance: real component and API client synthetic transport', () => {
  it('single target: cached-aware fetch and re-fetch displays honest text and dispatches correct requests', async () => {
    const ownerGuard = createOwnerGuard(true)
    const onRefresh = vi.fn()
    const target: EmailMaintenanceTarget = { kind: 'single', filename: 'cred-alpha.json' }
    const props = createProps(target, {
      isCurrentOwner: ownerGuard.isCurrentOwner,
      onRefresh,
    })

    render(<EmailMaintenance {...props} />)

    // Explains that existing cached email may be returned
    expect(
      screen.getByText(/获取指定凭证绑定的邮箱。后端优先返回已缓存的邮箱，可能返回现有缓存数据；不承诺强制向上游刷新或清除缓存。/),
    ).toBeInTheDocument()

    // No fetch on mount
    expect(fetch).not.toHaveBeenCalled()

    // First fetch
    respond({ filename: 'cred-alpha.json', user_email: 'alpha@example.invalid' })
    fireEvent.click(screen.getByRole('button', { name: '获取/再次获取邮箱' }))

    await waitFor(() => {
      expect(screen.getByText('alpha@example.invalid')).toBeInTheDocument()
    })

    expect(fetch).toHaveBeenCalledTimes(1)
    const [url1, init1] = vi.mocked(fetch).mock.calls[0]
    const parsed1 = new URL(String(url1))
    expect(parsed1.pathname).toBe('/creds/fetch-email/cred-alpha.json')
    expect(parsed1.searchParams.get('mode')).toBe('antigravity')
    expect(init1?.method).toBe('POST')
    expect(init1?.body).toBeUndefined()
    expect(onRefresh).toHaveBeenCalledTimes(1)

    // Re-fetch
    respond({ filename: 'cred-alpha.json', user_email: 'alpha-refreshed@example.invalid' })
    fireEvent.click(screen.getByRole('button', { name: '获取/再次获取邮箱' }))

    await waitFor(() => {
      expect(screen.getByText('alpha-refreshed@example.invalid')).toBeInTheDocument()
    })

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(onRefresh).toHaveBeenCalledTimes(2)
  })

  it('single target: copy email with clipboard success, rejection fallback, and missing clipboard', async () => {
    const ownerGuard = createOwnerGuard(true)
    const target: EmailMaintenanceTarget = { kind: 'single', filename: 'cred-copy.json' }
    const props = createProps(target, { isCurrentOwner: ownerGuard.isCurrentOwner })

    // Setup initial email
    respond({ filename: 'cred-copy.json', user_email: 'copy@example.invalid' })
    const { rerender } = render(<EmailMaintenance {...props} />)

    fireEvent.click(screen.getByRole('button', { name: '获取/再次获取邮箱' }))
    await waitFor(() => {
      expect(screen.getByText('copy@example.invalid')).toBeInTheDocument()
    })

    // Case 1: Clipboard success
    const writeText = mockClipboard()
    fireEvent.click(screen.getByRole('button', { name: '复制邮箱' }))

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('copy@example.invalid')
      expect(screen.getByText('已复制到剪贴板')).toBeInTheDocument()
    })
    expect(screen.queryByLabelText('手动复制邮箱内容')).not.toBeInTheDocument()

    // Case 2: Clipboard rejection fallback
    mockClipboard(() => Promise.reject(new Error('Clipboard access denied')))
    fireEvent.click(screen.getByRole('button', { name: '复制邮箱' }))

    await waitFor(() => {
      expect(screen.getByText('无法访问剪贴板，请手动复制以下邮箱：')).toBeInTheDocument()
    })
    const fallbackTextarea = screen.getByLabelText('手动复制邮箱内容') as HTMLTextAreaElement
    expect(fallbackTextarea.value).toBe('copy@example.invalid')

    // Case 3: Clipboard missing fallback
    removeClipboard()
    rerender(<EmailMaintenance {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '复制邮箱' }))

    await waitFor(() => {
      expect(screen.getByText('无法访问剪贴板，请手动复制以下邮箱：')).toBeInTheDocument()
    })
  })

  it('selection target: exact filenames, max100 limit, and independent matched/missing/unique counts', async () => {
    const ownerGuard = createOwnerGuard(true)
    const onRefresh = vi.fn()
    const target: EmailMaintenanceTarget = {
      kind: 'selection',
      filenames: ['cred-1.json', 'cred-2.json', 'cred-3.json'],
    }
    const props = createProps(target, {
      isCurrentOwner: ownerGuard.isCurrentOwner,
      onRefresh,
    })

    render(<EmailMaintenance {...props} />)

    mockClipboard()
    respond({
      emails: ['shared@example.invalid'],
      matched_count: 2,
      missing_count: 1,
    })

    fireEvent.click(screen.getByRole('button', { name: '复制选中邮箱' }))

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1)
    })

    const [url, init] = vi.mocked(fetch).mock.calls[0]
    const parsed = new URL(String(url))
    expect(parsed.pathname).toBe('/creds/copy-emails')
    expect(parsed.searchParams.get('mode')).toBe('antigravity')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({
      filenames: ['cred-1.json', 'cred-2.json', 'cred-3.json'],
    })

    // Independent counts verification
    await waitFor(() => {
      expect(screen.getByText('匹配凭证数:')).toBeInTheDocument()
      expect(screen.getByText('缺失凭证数:')).toBeInTheDocument()
      expect(screen.getByText('独立邮箱数:')).toBeInTheDocument()
    })
    const matchedContainer = screen.getByText('匹配凭证数:').parentElement!
    const missingContainer = screen.getByText('缺失凭证数:').parentElement!
    const uniqueContainer = screen.getByText('独立邮箱数:').parentElement!
    expect(within(matchedContainer).getByText('2')).toBeInTheDocument()
    expect(within(missingContainer).getByText('1')).toBeInTheDocument()
    expect(within(uniqueContainer).getByText('1')).toBeInTheDocument()
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('selection target: invalid selection (empty, >100, duplicates, empty string) cannot issue requests', async () => {
    const ownerGuard = createOwnerGuard(true)

    // Empty selection
    const { rerender } = render(
      <EmailMaintenance
        {...createProps({ kind: 'selection', filenames: [] }, { isCurrentOwner: ownerGuard.isCurrentOwner })}
      />,
    )
    expect(screen.getByText('请至少选择 1 项凭证。')).toBeInTheDocument()
    const buttonEmpty = screen.getByRole('button', { name: '复制选中邮箱' })
    expect(buttonEmpty).toBeDisabled()
    fireEvent.click(buttonEmpty)
    expect(fetch).not.toHaveBeenCalled()

    // Oversize > 100
    const over100 = Array.from({ length: 101 }, (_, i) => `cred-${i}.json`)
    rerender(
      <EmailMaintenance
        {...createProps({ kind: 'selection', filenames: over100 }, { isCurrentOwner: ownerGuard.isCurrentOwner })}
      />,
    )
    expect(screen.getByText(/已选凭证数量（101 项）超过上限，最多支持 100 项。/)).toBeInTheDocument()
    const buttonOver = screen.getByRole('button', { name: '复制选中邮箱' })
    expect(buttonOver).toBeDisabled()
    fireEvent.click(buttonOver)
    expect(fetch).not.toHaveBeenCalled()

    // Duplicates
    rerender(
      <EmailMaintenance
        {...createProps(
          { kind: 'selection', filenames: ['dup.json', 'dup.json'] },
          { isCurrentOwner: ownerGuard.isCurrentOwner },
        )}
      />,
    )
    expect(screen.getByText('选择项中包含重复凭证。')).toBeInTheDocument()
    const buttonDup = screen.getByRole('button', { name: '复制选中邮箱' })
    expect(buttonDup).toBeDisabled()
    fireEvent.click(buttonDup)
    expect(fetch).not.toHaveBeenCalled()

    // Empty string item
    rerender(
      <EmailMaintenance
        {...createProps(
          { kind: 'selection', filenames: ['valid.json', '   '] },
          { isCurrentOwner: ownerGuard.isCurrentOwner },
        )}
      />,
    )
    expect(screen.getByText('选择项中包含无效凭证标识。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '复制选中邮箱' })).toBeDisabled()
  })

  it('selection target: clipboard success, rejection fallback, and missing clipboard', async () => {
    const ownerGuard = createOwnerGuard(true)
    const target: EmailMaintenanceTarget = {
      kind: 'selection',
      filenames: ['sel-1.json', 'sel-2.json'],
    }
    const props = createProps(target, { isCurrentOwner: ownerGuard.isCurrentOwner })

    // Case 1: Clipboard success
    const writeText = mockClipboard()
    respond({
      emails: ['a@example.invalid', 'b@example.invalid'],
      matched_count: 2,
      missing_count: 0,
    })

    const { rerender } = render(<EmailMaintenance {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '复制选中邮箱' }))

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('a@example.invalid\nb@example.invalid')
      expect(screen.getByText('已复制 2 个邮箱到剪贴板')).toBeInTheDocument()
    })
    expect(screen.queryByLabelText('手动复制批量邮箱内容')).not.toBeInTheDocument()

    // Case 2: Clipboard rejection fallback
    mockClipboard(() => Promise.reject(new Error('Permission denied')))
    respond({
      emails: ['a@example.invalid', 'b@example.invalid'],
      matched_count: 2,
      missing_count: 0,
    })

    fireEvent.click(screen.getByRole('button', { name: '复制选中邮箱' }))

    await waitFor(() => {
      expect(
        screen.getByText('剪贴板不可用或复制被拒绝，请手动复制以下邮箱：'),
      ).toBeInTheDocument()
    })
    const textarea = screen.getByLabelText('手动复制批量邮箱内容') as HTMLTextAreaElement
    expect(textarea.value).toBe('a@example.invalid\nb@example.invalid')
    expect(screen.queryByText(/已复制 \d+ 个邮箱到剪贴板/)).not.toBeInTheDocument()

    // Case 3: Clipboard missing fallback
    removeClipboard()
    respond({
      emails: ['c@example.invalid'],
      matched_count: 1,
      missing_count: 1,
    })
    rerender(<EmailMaintenance {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '复制选中邮箱' }))

    await waitFor(() => {
      expect(
        screen.getByText('剪贴板不可用或复制被拒绝，请手动复制以下邮箱：'),
      ).toBeInTheDocument()
    })
  })

  it('channel refresh: distinguishes new, cached skipped, and failed rows in antigravity and geminicli', async () => {
    const ownerGuard = createOwnerGuard(true)
    const onRefresh = vi.fn()

    // Antigravity channel
    const target: EmailMaintenanceTarget = { kind: 'channel' }
    const propsAg = createProps(target, {
      mode: 'antigravity',
      isCurrentOwner: ownerGuard.isCurrentOwner,
      onRefresh,
    })

    const { rerender } = render(<EmailMaintenance {...propsAg} />)

    expect(screen.getByText('当前整个渠道:')).toBeInTheDocument()
    expect(screen.getByText('Antigravity')).toBeInTheDocument()
    expect(
      screen.getByText(/全渠道刷新将同步当前渠道所有凭证邮箱，可能访问上游服务或使用刷新令牌；已缓存凭证将被跳过。/),
    ).toBeInTheDocument()

    respond({
      success_count: 1,
      skipped_count: 1,
      total_count: 3,
      results: [
        { filename: 'new.json', user_email: 'new@example.invalid', success: true, skipped: false },
        { filename: 'cached.json', user_email: 'cached@example.invalid', success: true, skipped: true },
        { filename: 'fail.json', user_email: null, success: false, skipped: false },
      ],
    })

    fireEvent.click(screen.getByRole('button', { name: '全渠道刷新邮箱' }))

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1)
    })

    const [urlAg, initAg] = vi.mocked(fetch).mock.calls[0]
    expect(new URL(String(urlAg)).pathname).toBe('/creds/refresh-all-emails')
    expect(new URL(String(urlAg)).searchParams.get('mode')).toBe('antigravity')
    expect(initAg?.method).toBe('POST')
    expect(initAg?.body).toBeUndefined()

    await waitFor(() => {
      expect(screen.getByText('新获取:')).toBeInTheDocument()
      expect(screen.getByText('已跳过（使用缓存）:')).toBeInTheDocument()
      expect(screen.getByText('失败:')).toBeInTheDocument()
      expect(screen.getByText('总计:')).toBeInTheDocument()
    })

    expect(screen.getByText('new.json')).toBeInTheDocument()
    expect(screen.getByText('新获取')).toBeInTheDocument()
    expect(screen.getByText('cached.json')).toBeInTheDocument()
    expect(screen.getByText('已跳过（缓存）')).toBeInTheDocument()
    expect(screen.getByText('fail.json')).toBeInTheDocument()
    expect(screen.getByText('失败')).toBeInTheDocument()
    expect(onRefresh).toHaveBeenCalledTimes(1)

    // Gemini CLI channel
    __commitPanelChannel('geminicli')
    const scopeGcli = capturePanelScope(getSessionSnapshot().sessionEpoch)
    const propsGcli = createProps(target, {
      mode: 'geminicli',
      scope: scopeGcli,
      isCurrentOwner: ownerGuard.isCurrentOwner,
      onRefresh,
    })

    rerender(<EmailMaintenance {...propsGcli} />)

    expect(screen.getByText('Gemini CLI')).toBeInTheDocument()

    respond({
      success_count: 0,
      skipped_count: 1,
      total_count: 1,
      results: [
        { filename: 'gcli-cached.json', user_email: 'gcli@example.invalid', success: true, skipped: true },
      ],
    })

    fireEvent.click(screen.getByRole('button', { name: '全渠道刷新邮箱' }))

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(2)
    })

    const [urlGcli] = vi.mocked(fetch).mock.calls[1]
    expect(new URL(String(urlGcli)).searchParams.get('mode')).toBe('geminicli')
  })

  it('channel dedup: cancel 0 requests, confirm 1 request, genuine success, partial outcome, and raw canary exclusion', async () => {
    const ownerGuard = createOwnerGuard(true)
    const onRefresh = vi.fn()
    const target: EmailMaintenanceTarget = { kind: 'channel' }
    const props = createProps(target, {
      mode: 'antigravity',
      isCurrentOwner: ownerGuard.isCurrentOwner,
      onRefresh,
    })

    render(<EmailMaintenance {...props} />)

    // Cancel sends 0 requests
    fireEvent.click(screen.getByRole('button', { name: '按邮箱去重' }))
    expect(screen.getByText('确认按邮箱去重')).toBeInTheDocument()
    expect(
      screen.getByText(/此操作将在当前整个渠道（Antigravity）中按用户邮箱执行去重，保留首个凭证，删除其余重复凭证。此操作为破坏性操作，不可回滚。确定要继续吗？/),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(fetch).not.toHaveBeenCalled()
    expect(onRefresh).not.toHaveBeenCalled()

    // Confirm sends 1 request and renders genuine success receipt
    fireEvent.click(screen.getByRole('button', { name: '按邮箱去重' }))
    respond({
      deleted_count: 2,
      kept_count: 1,
      total_count: 3,
      unique_emails_count: 1,
      no_email_count: 0,
      duplicate_groups: [
        {
          email: 'dup@example.invalid',
          kept_file: 'keep-1.json',
          deleted_files: ['del-1.json', 'del-2.json'],
          duplicate_count: 2,
        },
      ],
      delete_errors: [],
    })

    fireEvent.click(screen.getByRole('button', { name: '确认去重' }))

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1)
    })

    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(new URL(String(url)).pathname).toBe('/creds/deduplicate-by-email')
    expect(new URL(String(url)).searchParams.get('mode')).toBe('antigravity')
    expect(init?.method).toBe('POST')
    expect(init?.body).toBeUndefined()

    await waitFor(() => {
      expect(screen.getByText('去重完成')).toBeInTheDocument()
    })
    expect(screen.getByText('已删除:')).toBeInTheDocument()
    expect(screen.getByText('已保留:')).toBeInTheDocument()
    expect(screen.getByText('总凭证数:')).toBeInTheDocument()
    expect(screen.getByText('dup@example.invalid')).toBeInTheDocument()
    expect(screen.getByText('keep-1.json')).toBeInTheDocument()
    expect(screen.getByText('del-1.json, del-2.json')).toBeInTheDocument()
    expect(onRefresh).toHaveBeenCalledTimes(1)

    // Partial outcome with raw canary exclusion
    const canaryRawError = 'CANARY_RAW_SECRET_DELETE_ERROR_9999'
    fireEvent.click(screen.getByRole('button', { name: '按邮箱去重' }))
    respond({
      deleted_count: 1,
      kept_count: 2,
      total_count: 3,
      unique_emails_count: 1,
      no_email_count: 1,
      duplicate_groups: [
        {
          email: 'dup2@example.invalid',
          kept_file: 'keep-2.json',
          deleted_files: ['del-3.json'],
          duplicate_count: 1,
        },
      ],
      delete_errors: [canaryRawError],
    })

    fireEvent.click(screen.getByRole('button', { name: '确认去重' }))

    await waitFor(() => {
      expect(screen.getByText('部分成功')).toBeInTheDocument()
    })
    expect(screen.getByText('错误数:')).toBeInTheDocument()

    // Raw canary MUST NOT appear anywhere in the document
    expect(screen.queryByText(new RegExp(canaryRawError))).not.toBeInTheDocument()
    expect(document.body.textContent).not.toContain(canaryRawError)
  })
})

describe('EmailMaintenance: real Core/session validation identity and actor lifecycles', () => {
  it('exact validation identity: non-matching object reference or unverified status returns null', () => {
    const ownerGuard = createOwnerGuard(true)
    const target: EmailMaintenanceTarget = { kind: 'channel' }

    // Case 1: Fabricated cloned validation snapshot object (reference inequality)
    const clonedValidation: SessionValidationSnapshot = {
      ...getSessionValidationSnapshot(),
    }
    const { container, rerender } = render(
      <EmailMaintenance
        {...createProps(target, {
          isCurrentOwner: ownerGuard.isCurrentOwner,
          validation: clonedValidation,
        })}
      />,
    )
    expect(container.firstChild).toBeNull()

    // Case 2: Validation status is pending
    __setSessionValidationStatus(getSessionSnapshot().sessionEpoch, 'pending')
    const pendingValidation = getSessionValidationSnapshot()
    rerender(
      <EmailMaintenance
        {...createProps(target, {
          isCurrentOwner: ownerGuard.isCurrentOwner,
          validation: pendingValidation,
        })}
      />,
    )
    expect(container.firstChild).toBeNull()

    // Case 3: Session token is null
    setSessionToken(null)
    const anonValidation = getSessionValidationSnapshot()
    rerender(
      <EmailMaintenance
        {...createProps(target, {
          isCurrentOwner: ownerGuard.isCurrentOwner,
          validation: anonValidation,
        })}
      />,
    )
    expect(container.firstChild).toBeNull()

    // Case 4: Owner guard returns false or throws
    setSessionToken('valid-token')
    const validValidation = getSessionValidationSnapshot()
    ownerGuard.setOwner(false)
    rerender(
      <EmailMaintenance
        {...createProps(target, {
          isCurrentOwner: ownerGuard.isCurrentOwner,
          validation: validValidation,
        })}
      />,
    )
    expect(container.firstChild).toBeNull()

    ownerGuard.setOwner(true)
    ownerGuard.setThrow(true)
    rerender(
      <EmailMaintenance
        {...createProps(target, {
          isCurrentOwner: ownerGuard.isCurrentOwner,
          validation: validValidation,
        })}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('stable equivalent rerenders preserve actor, state, and in-flight operations', async () => {
    const ownerGuard = createOwnerGuard(true)
    const ownerRevision = {}
    const onRefreshInitial = vi.fn()
    const target: EmailMaintenanceTarget = { kind: 'single', filename: 'stable.json' }
    const props = createProps(target, {
      ownerRevision,
      isCurrentOwner: ownerGuard.isCurrentOwner,
      onRefresh: onRefreshInitial,
    })

    const { rerender } = render(<EmailMaintenance {...props} />)

    respond({ filename: 'stable.json', user_email: 'stable@example.invalid' })
    fireEvent.click(screen.getByRole('button', { name: '获取/再次获取邮箱' }))

    await waitFor(() => {
      expect(screen.getByText('stable@example.invalid')).toBeInTheDocument()
    })
    expect(onRefreshInitial).toHaveBeenCalledTimes(1)

    // Re-render with new onRefresh instance, equivalent target, same ownerRevision
    const onRefreshNew = vi.fn()
    rerender(
      <EmailMaintenance
        {...props}
        target={{ kind: 'single', filename: 'stable.json' }}
        onRefresh={onRefreshNew}
      />,
    )

    // Email remains preserved
    expect(screen.getByText('stable@example.invalid')).toBeInTheDocument()
    // No extra fetch
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('new target or ownerRevision retires actor and aborts previous in-flight operation', async () => {
    const ownerGuard = createOwnerGuard(true)
    let abortSignalCaptured: AbortSignal | undefined
    let resolveDeferred: (val: Response) => void = () => {}

    vi.mocked(fetch).mockImplementationOnce((_url, init) => {
      abortSignalCaptured = init?.signal ?? undefined
      return new Promise<Response>(resolve => {
        resolveDeferred = resolve
      })
    })

    const initialRevision = {}
    const props = createProps(
      { kind: 'single', filename: 'abort-1.json' },
      {
        ownerRevision: initialRevision,
        isCurrentOwner: ownerGuard.isCurrentOwner,
      },
    )

    const { rerender } = render(<EmailMaintenance {...props} />)

    fireEvent.click(screen.getByRole('button', { name: '获取/再次获取邮箱' }))
    expect(abortSignalCaptured).toBeDefined()
    expect(abortSignalCaptured?.aborted).toBe(false)

    // New ownerRevision retires actor and aborts in-flight request
    rerender(
      <EmailMaintenance
        {...props}
        ownerRevision={{}}
      />,
    )

    expect(abortSignalCaptured?.aborted).toBe(true)

    // Target change with same revision also aborts
    let abortSignalTarget: AbortSignal | undefined
    vi.mocked(fetch).mockImplementationOnce((_url, init) => {
      abortSignalTarget = init?.signal ?? undefined
      return new Promise<Response>(resolve => {
        resolveDeferred = resolve
      })
    })

    fireEvent.click(screen.getByRole('button', { name: '获取/再次获取邮箱' }))
    expect(abortSignalTarget?.aborted).toBe(false)

    rerender(
      <EmailMaintenance
        {...props}
        target={{ kind: 'single', filename: 'abort-2.json' }}
      />,
    )

    expect(abortSignalTarget?.aborted).toBe(true)

    // Clean up deferred
    resolveDeferred(Response.json({ filename: 'abort-1.json', user_email: 'x@example.invalid' }))
  })

  it('same-Scope validation revoke and reverify cannot revive old actor', async () => {
    const ownerGuard = createOwnerGuard(true)
    const onRefresh = vi.fn()
    let resolveDeferred: (val: Response) => void = () => {}

    vi.mocked(fetch).mockImplementationOnce(() => {
      return new Promise<Response>(resolve => {
        resolveDeferred = resolve
      })
    })

    const sessionEpoch = getSessionSnapshot().sessionEpoch
    const props = createProps(
      { kind: 'single', filename: 'revoke.json' },
      {
        isCurrentOwner: ownerGuard.isCurrentOwner,
        onRefresh,
      },
    )

    const { rerender } = render(<EmailMaintenance {...props} />)

    fireEvent.click(screen.getByRole('button', { name: '获取/再次获取邮箱' }))

    // Revoke validation in same Scope
    act(() => {
      __setSessionValidationStatus(sessionEpoch, 'pending')
    })

    // Reverify in same Scope
    act(() => {
      __setSessionValidationStatus(sessionEpoch, 'verified')
    })

    // Late resolution of old deferred call
    await act(async () => {
      resolveDeferred(Response.json({ filename: 'revoke.json', user_email: 'late@example.invalid' }))
    })

    // Old callback not invoked
    expect(onRefresh).not.toHaveBeenCalled()

    // Fresh operation works on new verified validation
    const freshValidation = getSessionValidationSnapshot()
    rerender(
      <EmailMaintenance
        {...props}
        validation={freshValidation}
        ownerRevision={{}}
      />,
    )

    respond({ filename: 'revoke.json', user_email: 'fresh@example.invalid' })
    fireEvent.click(screen.getByRole('button', { name: '获取/再次获取邮箱' }))

    await waitFor(() => {
      expect(screen.getByText('fresh@example.invalid')).toBeInTheDocument()
    })
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('channel ABA cannot revive old actor or update fresh UI', async () => {
    const ownerGuard = createOwnerGuard(true)
    const onRefresh = vi.fn()
    let abortSignal: AbortSignal | undefined
    let resolveDeferred: (val: Response) => void = () => {}

    vi.mocked(fetch).mockImplementationOnce((_url, init) => {
      abortSignal = init?.signal ?? undefined
      return new Promise<Response>(resolve => {
        resolveDeferred = resolve
      })
    })

    const target: EmailMaintenanceTarget = { kind: 'channel' }
    const props = createProps(target, {
      mode: 'antigravity',
      isCurrentOwner: ownerGuard.isCurrentOwner,
      onRefresh,
    })

    render(<EmailMaintenance {...props} />)

    fireEvent.click(screen.getByRole('button', { name: '全渠道刷新邮箱' }))
    expect(abortSignal?.aborted).toBe(false)

    // Switch to Gemini CLI (B)
    act(() => {
      __commitPanelChannel('geminicli')
    })
    expect(abortSignal?.aborted).toBe(true)

    // Switch back to Antigravity (A)
    act(() => {
      __commitPanelChannel('antigravity')
    })

    // Late deferred resolution cannot call onRefresh
    await act(async () => {
      resolveDeferred(
        Response.json({
          success_count: 1,
          skipped_count: 0,
          total_count: 1,
          results: [{ filename: 'aba.json', user_email: 'aba@example.invalid', success: true, skipped: false }],
        }),
      )
    })

    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('held old confirm/cancel handlers and rapid double click cannot operate on fresh actor', async () => {
    const ownerGuard = createOwnerGuard(true)
    const onRefresh = vi.fn()
    const target: EmailMaintenanceTarget = { kind: 'channel' }
    const initialRevision = {}
    const props = createProps(target, {
      ownerRevision: initialRevision,
      isCurrentOwner: ownerGuard.isCurrentOwner,
      onRefresh,
    })

    const { rerender } = render(<EmailMaintenance {...props} />)

    // Open dedup dialog
    fireEvent.click(screen.getByRole('button', { name: '按邮箱去重' }))
    const oldConfirmBtn = screen.getByRole('button', { name: '确认去重' })

    // Change owner revision (Actor 2)
    rerender(
      <EmailMaintenance
        {...props}
        ownerRevision={{}}
      />,
    )

    // Clicking old confirm button does nothing (0 requests)
    fireEvent.click(oldConfirmBtn)
    expect(fetch).not.toHaveBeenCalled()

    // Fresh actor opens dialog and confirms
    fireEvent.click(screen.getByRole('button', { name: '按邮箱去重' }))
    const newConfirmBtn = screen.getByRole('button', { name: '确认去重' })

    respond({
      deleted_count: 0,
      kept_count: 1,
      total_count: 1,
      unique_emails_count: 1,
      no_email_count: 0,
      duplicate_groups: [],
      delete_errors: [],
    })

    // Rapid double click on confirm consumes admission on first click; second click is ignored
    fireEvent.click(newConfirmBtn)
    fireEvent.click(newConfirmBtn)

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1)
    })
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('late ignored-abort resolutions cannot update fresh UI, clipboard, or invoke onRefresh', async () => {
    const ownerGuard = createOwnerGuard(true)
    const onRefresh = vi.fn()
    const writeText = mockClipboard()
    let resolveDeferred: (val: Response) => void = () => {}

    vi.mocked(fetch).mockImplementationOnce(() => {
      return new Promise<Response>(resolve => {
        resolveDeferred = resolve
      })
    })

    const props = createProps(
      { kind: 'single', filename: 'unmount.json' },
      {
        isCurrentOwner: ownerGuard.isCurrentOwner,
        onRefresh,
      },
    )

    const { unmount } = render(<EmailMaintenance {...props} />)

    fireEvent.click(screen.getByRole('button', { name: '获取/再次获取邮箱' }))

    // Component unmounts
    unmount()

    // Deferred promise settles after unmount
    await act(async () => {
      resolveDeferred(
        Response.json({
          filename: 'unmount.json',
          user_email: 'late-unmounted@example.invalid',
        }),
      )
    })

    expect(onRefresh).not.toHaveBeenCalled()
    expect(writeText).not.toHaveBeenCalled()
  })

  it('pending fetch is aborted on disabled, settlement cannot update UI, and re-enable with same owner allows fresh explicit action without permanent busy', async () => {
    const ownerGuard = createOwnerGuard(true)
    const onRefresh = vi.fn()
    const ownerRevision = {}
    let abortSignal: AbortSignal | undefined
    let resolveDeferred: (val: Response) => void = () => {}

    vi.mocked(fetch).mockImplementationOnce((_url, init) => {
      abortSignal = init?.signal ?? undefined
      return new Promise<Response>(resolve => {
        resolveDeferred = resolve
      })
    })

    const target: EmailMaintenanceTarget = { kind: 'single', filename: 'pending-disabled.json' }
    const props = createProps(target, {
      ownerRevision,
      isCurrentOwner: ownerGuard.isCurrentOwner,
      onRefresh,
      disabled: false,
    })

    const { rerender } = render(<EmailMaintenance {...props} />)

    // Trigger fetch while enabled
    fireEvent.click(screen.getByRole('button', { name: '获取/再次获取邮箱' }))
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(abortSignal).toBeDefined()
    expect(abortSignal?.aborted).toBe(false)
    expect(screen.getByRole('button', { name: '获取中...' })).toBeInTheDocument()

    // Transition to disabled with same ownerRevision
    rerender(<EmailMaintenance {...props} disabled={true} />)

    // Transport is aborted immediately
    expect(abortSignal?.aborted).toBe(true)

    // Old fetch promise settles after disabled
    await act(async () => {
      resolveDeferred(
        Response.json({ filename: 'pending-disabled.json', user_email: 'stale@example.invalid' }),
      )
    })

    // Stale resolution cannot update UI or call onRefresh
    expect(screen.queryByText('stale@example.invalid')).not.toBeInTheDocument()
    expect(onRefresh).not.toHaveBeenCalled()

    // Re-enable with same ownerRevision (no revision increment required)
    rerender(<EmailMaintenance {...props} disabled={false} />)

    // Not permanently busy; action button is available and enabled
    const actionButton = screen.getByRole('button', { name: '获取/再次获取邮箱' })
    expect(actionButton).toBeEnabled()
    expect(screen.queryByRole('button', { name: '获取中...' })).not.toBeInTheDocument()

    // Fresh explicit action works
    respond({ filename: 'pending-disabled.json', user_email: 'fresh@example.invalid' })
    fireEvent.click(actionButton)

    await waitFor(() => {
      expect(screen.getByText('fresh@example.invalid')).toBeInTheDocument()
    })

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('disabled invalidates pending local clipboard and an open dedup confirmation, stale settlement cannot restore UI or confirmation, and fresh opening confirms exactly once', async () => {
    const ownerGuard = createOwnerGuard(true)
    const onRefresh = vi.fn()
    const ownerRevision = {}

    // --- Sequence A: pending clipboard copy invalidated on disabled ---
    const singleTarget: EmailMaintenanceTarget = { kind: 'single', filename: 'clip-disabled.json' }
    const singleProps = createProps(singleTarget, {
      ownerRevision,
      isCurrentOwner: ownerGuard.isCurrentOwner,
      onRefresh,
      disabled: false,
    })

    respond({ filename: 'clip-disabled.json', user_email: 'clip-disabled@example.invalid' })
    const { rerender } = render(<EmailMaintenance {...singleProps} />)

    // Fetch email so copy button appears
    fireEvent.click(screen.getByRole('button', { name: '获取/再次获取邮箱' }))
    await waitFor(() => {
      expect(screen.getByText('clip-disabled@example.invalid')).toBeInTheDocument()
    })
    expect(onRefresh).toHaveBeenCalledTimes(1)

    // Mock clipboard with a pending promise that rejects
    let rejectClipboard: (err: unknown) => void = () => {}
    mockClipboard(
      () =>
        new Promise<void>((_, reject) => {
          rejectClipboard = reject
        }),
    )

    // Trigger copy
    fireEvent.click(screen.getByRole('button', { name: '复制邮箱' }))

    // Transition to disabled while clipboard promise is pending
    rerender(<EmailMaintenance {...singleProps} disabled={true} />)

    // Settle clipboard rejection while disabled
    await act(async () => {
      rejectClipboard(new Error('Clipboard permission denied'))
    })

    // Stale rejection cannot write fallback or status while disabled
    expect(screen.queryByText('无法访问剪贴板，请手动复制以下邮箱：')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('手动复制邮箱内容')).not.toBeInTheDocument()
    expect(screen.queryByText('已复制到剪贴板')).not.toBeInTheDocument()

    // Re-enable with same owner
    rerender(<EmailMaintenance {...singleProps} disabled={false} />)

    // Stale fallback/status was not restored after re-enable
    expect(screen.queryByText('无法访问剪贴板，请手动复制以下邮箱：')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('手动复制邮箱内容')).not.toBeInTheDocument()

    // --- Sequence B: open dedup confirmation invalidated on disabled ---
    const channelTarget: EmailMaintenanceTarget = { kind: 'channel' }
    const channelProps = createProps(channelTarget, {
      ownerRevision,
      isCurrentOwner: ownerGuard.isCurrentOwner,
      onRefresh,
      disabled: false,
    })

    rerender(<EmailMaintenance {...channelProps} disabled={false} />)

    // Open dedup confirmation dialog
    fireEvent.click(screen.getByRole('button', { name: '按邮箱去重' }))
    expect(screen.getByText('确认按邮箱去重')).toBeInTheDocument()
    const oldConfirmBtn = screen.getByRole('button', { name: '确认去重' })

    // Transition to disabled with dialog open
    rerender(<EmailMaintenance {...channelProps} disabled={true} />)

    // Dialog is closed and retired
    expect(screen.queryByText('确认按邮箱去重')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '确认去重' })).not.toBeInTheDocument()

    // Attempting to invoke old confirm closure does nothing
    fireEvent.click(oldConfirmBtn)
    expect(fetch).toHaveBeenCalledTimes(1) // only initial fetch from Sequence A

    // Re-enable with same owner
    rerender(<EmailMaintenance {...channelProps} disabled={false} />)

    // Dialog is not restored / does not reopen automatically
    expect(screen.queryByText('确认按邮箱去重')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '确认去重' })).not.toBeInTheDocument()

    // Old confirm closure still cannot fire after re-enable
    fireEvent.click(oldConfirmBtn)
    expect(fetch).toHaveBeenCalledTimes(1)

    // Fresh explicit opening and confirmation
    fireEvent.click(screen.getByRole('button', { name: '按邮箱去重' }))
    expect(screen.getByText('确认按邮箱去重')).toBeInTheDocument()
    const freshConfirmBtn = screen.getByRole('button', { name: '确认去重' })

    respond({
      deleted_count: 0,
      kept_count: 1,
      total_count: 1,
      unique_emails_count: 1,
      no_email_count: 0,
      duplicate_groups: [],
      delete_errors: [],
    })

    // Fresh confirm works and confirms exactly once
    fireEvent.click(freshConfirmBtn)

    await waitFor(() => {
      expect(screen.getByText('去重完成')).toBeInTheDocument()
    })

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(onRefresh).toHaveBeenCalledTimes(2)
  })
})
