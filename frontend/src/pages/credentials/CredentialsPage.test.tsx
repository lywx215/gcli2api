import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider } from '@/auth'
import { setSessionToken, getSessionSnapshot, __setSessionValidationStatus } from '@/auth/session'
import { PanelChannelProvider } from '@/app/channels'
import { navigatePanel } from '@/app/routes'
import { CONSOLE_READY_PAYLOAD } from '@/app/ConsoleHandshake'
import { __commitPanelChannel } from '@/domain/panel'
import CredentialsPage, { supportedPanelModes } from './index'
import { CAP, CAP_BY_MODE } from './model'

let lastDetailProps: any = null
let lastQuotaProps: any = null

vi.mock('./CredentialDetail', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./CredentialDetail')>()
  return {
    ...actual,
    CredentialDetail: (props: any) => {
      lastDetailProps = props
      return <actual.CredentialDetail {...props} />
    },
  }
})

vi.mock('./quota/QuotaDialog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./quota/QuotaDialog')>()
  return {
    ...actual,
    QuotaDialog: (props: any) => {
      lastQuotaProps = props
      return <actual.QuotaDialog {...props} />
    },
  }
})

const row = (i: number) => ({
  filename: `synthetic-${i}.json`,
  user_email: `synthetic-${i}@example.invalid`,
  disabled: false,
  permanent_disabled: false,
  tier: 'free',
  remark: '',
  enable_credit: false,
})

const DEFAULT_AG_CAPS = [...Object.values(CAP_BY_MODE.antigravity), 'antigravity.quota.summary']
const DEFAULT_GCLI_CAPS = [...Object.values(CAP_BY_MODE.geminicli), 'geminicli.quota.summary']

const status = (length = 1, caps?: string[], mode = 'antigravity') => {
  const resolvedCaps =
    caps !== undefined
      ? caps
      : mode === 'geminicli'
        ? DEFAULT_GCLI_CAPS
        : DEFAULT_AG_CAPS
  return {
    mode,
    items: Array.from({ length }, (_, i) => row(i)),
    total: length,
    has_more: false,
    panel_capabilities: resolvedCaps,
    stats: { total: length, normal: length, disabled: 0 },
    model_access_summary: {},
  }
}

function setup(
  length = 1,
  extra?: (url: URL, init?: RequestInit) => Promise<Response> | null,
  caps?: string[],
  mode = 'antigravity'
) {
  vi.mocked(fetch).mockImplementation((input, init) => {
    const url = new URL(String(input))
    const special = extra?.(url, init)
    if (special) return special
    if (url.pathname === '/creds/status') {
      const queryMode = (url.searchParams.get('mode') as 'antigravity' | 'geminicli' | null) ?? mode
      let resolvedCaps: string[]
      if (caps !== undefined) {
        if (caps.length === 0 || caps.length <= 2) {
          resolvedCaps = caps // preserve deliberate empty or restricted caps
        } else {
          resolvedCaps = queryMode === 'geminicli' ? DEFAULT_GCLI_CAPS : DEFAULT_AG_CAPS
        }
      } else {
        resolvedCaps = queryMode === 'geminicli' ? DEFAULT_GCLI_CAPS : DEFAULT_AG_CAPS
      }
      return Promise.resolve(Response.json(status(length, resolvedCaps, queryMode)))
    }
    throw new Error(`Unmocked synthetic endpoint: ${url.pathname}`)
  })
  return render(
    <AuthProvider>
      <PanelChannelProvider>
        <CredentialsPage />
      </PanelChannelProvider>
    </AuthProvider>
  )
}

const callsTo = (path: string) => vi.mocked(fetch).mock.calls.filter(([url]) => new URL(String(url)).pathname === path)
const loaded = () => screen.findByRole('button', { name: 'synthetic-0.json' })
const openDetail = () => fireEvent.click(screen.getAllByRole('button', { name: '详情与操作' })[0])
const startQuota = async () => {
  fireEvent.click(screen.getByRole('button', { name: '选择当前页' }))
  fireEvent.click(screen.getByRole('button', { name: '批量刷新额度' }))
  fireEvent.click(screen.getByRole('button', { name: '确认批量刷新额度' }))
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

beforeEach(() => {
  lastDetailProps = null
  lastQuotaProps = null
  __commitPanelChannel('antigravity')
  setSessionToken('synthetic-session')
})

describe('credential workspace components', () => {
  it('logout during an action prevents late completion from entering a new session drawer', async () => {
    const pending = deferred<Response>()
    setup(1, url => url.pathname === '/creds/action' ? pending.promise : null)
    await loaded()
    openDetail()
    fireEvent.click(screen.getByRole('button', { name: '启用' }))
    expect(screen.getByRole('status', { name: '凭证操作状态' })).toHaveTextContent('正在执行')
    act(() => setSessionToken(null))
    act(() => setSessionToken('replacement-synthetic-session'))
    await loaded()
    openDetail()
    await act(async () => pending.resolve(Response.json({ message: 'synthetic old success' })))
    expect(screen.getByRole('status', { name: '凭证操作状态' })).toBeEmptyDOMElement()
    expect(screen.getByRole('button', { name: '启用' })).toBeEnabled()
    expect(callsTo('/creds/action')).toHaveLength(1)
  })

  it('capability withdrawal closes the old drawer and never publishes its late action feedback', async () => {
    setup(1, url => url.pathname === '/creds/action' ? Promise.resolve(Response.json({ error_code: 'capability_unavailable', capability: CAP.permanent }, { status: 501 })) : null)
    await loaded()
    openDetail()
    fireEvent.click(screen.getByRole('button', { name: '永久禁用' }))
    fireEvent.click(screen.getByRole('button', { name: '确认永久禁用' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await loaded()
    openDetail()
    expect(screen.getByRole('button', { name: '永久禁用' })).toBeDisabled()
    expect(screen.getByRole('status', { name: '凭证操作状态' })).toBeEmptyDOMElement()
    expect(callsTo('/creds/action')).toHaveLength(1)
  })

  it.each([
    [{ message: 'synthetic backend success' }, 200, '操作成功'],
    [{ success: false, message: 'synthetic backend rejection' }, 200, '操作失败'],
    [{}, 200, '结果未知'],
    [{ detail: 'private-payload-marker' }, 400, '操作失败'],
    [{ detail: 'private-payload-marker' }, 503, '结果未知'],
  ] as const)('shows safe drawer outcome for response %j HTTP%s', async (body, http, label) => {
    setup(1, url => url.pathname === '/creds/action' ? Promise.resolve(Response.json(body, { status: http })) : null)
    await loaded()
    openDetail()
    const drawer = within(screen.getByRole('dialog'))
    fireEvent.click(drawer.getByRole('button', { name: '启用' }))
    await waitFor(() => expect(drawer.getByRole('status', { name: '凭证操作状态' })).toHaveTextContent(label))
    expect(drawer.queryByText(/private-payload-marker|synthetic backend/)).not.toBeInTheDocument()
    expect(callsTo('/creds/action')).toHaveLength(1)
  })

  it('returns Escape focus to the current row button after refresh replaces the opener', async () => {
    setup(1, url => url.pathname === '/creds/action' ? Promise.resolve(Response.json({ message: 'synthetic saved' })) : null)
    await loaded()
    const oldButton = screen.getAllByRole('button', { name: '详情与操作' })[0]
    fireEvent.click(oldButton)
    fireEvent.click(screen.getByRole('button', { name: '启用' }))
    await waitFor(() => expect(screen.getByRole('status', { name: '凭证操作状态' })).toHaveTextContent('操作成功'))
    await waitFor(() => expect(document.querySelector('[data-credential-trigger="desktop-detail"]')).not.toBeNull())
    const currentButton = document.querySelector('[data-credential-trigger="desktop-detail"]')!
    expect(oldButton.isConnected).toBe(false)
    expect(currentButton).not.toBe(oldButton)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await waitFor(() => expect(document.querySelector('[data-credential-trigger="desktop-detail"]')).toHaveFocus())
  })

  it('returns focus to the list title when closing during a pending list refresh', async () => {
    const refresh = deferred<Response>()
    let reads = 0
    setup(1, url => {
      if (url.pathname === '/creds/status' && ++reads > 1) return refresh.promise
      return url.pathname === '/creds/action' ? Promise.resolve(Response.json({ message: 'synthetic saved' })) : null
    })
    await loaded()
    openDetail()
    fireEvent.click(screen.getByRole('button', { name: '启用' }))
    await waitFor(() => expect(screen.getByRole('status', { name: '凭证操作状态' })).toHaveTextContent('操作成功'))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    const title = await screen.findByRole('heading', { name: 'Antigravity 凭证' })
    await waitFor(() => expect(title).toHaveFocus())
    await act(async () => refresh.resolve(Response.json(status())))
    expect(title).toHaveFocus()
  })

  it('retains deletion outcome in the drawer and falls back to the list title after closing', async () => {
    let deleted = false
    setup(1, url => {
      if (url.pathname === '/creds/action') {
        deleted = true
        return Promise.resolve(Response.json({ message: 'synthetic deleted' }))
      }
      if (url.pathname === '/creds/status' && deleted) return Promise.resolve(Response.json(status(0)))
      return null
    })
    await loaded()
    openDetail()
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    await waitFor(() => expect(screen.getByRole('status', { name: '凭证操作状态' })).toHaveTextContent('操作成功'))
    expect(screen.getByRole('button', { name: '启用' })).toBeDisabled()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Antigravity 凭证' })).toHaveFocus())
    expect(document.querySelector('[data-credential-filename]')).toBeNull()
  })

  it('mobile tools collapse all panels by default and expose keyboard-compatible aria controls', async () => {
    setup()
    await loaded()
    const tools = within(screen.getByRole('region', { name: '移动凭证工具' }))
    for (const label of ['统计与权限', '筛选条件', '批量操作']) {
      const button = tools.getByRole('button', { name: label })
      expect(button).toHaveAttribute('type', 'button')
      expect(button).toHaveAttribute('aria-expanded', 'false')
      const panel = document.getElementById(button.getAttribute('aria-controls')!)!
      expect(panel).toHaveClass('hidden', 'md:block')
      fireEvent.click(button)
      expect(button).toHaveAttribute('aria-expanded', 'true')
      expect(panel).toHaveClass('block')
      expect(panel).not.toHaveClass('hidden')
      fireEvent.click(button)
      expect(button).toHaveAttribute('aria-expanded', 'false')
      expect(panel).toHaveClass('hidden', 'md:block')
    }
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('mobile collapse preserves the same filter draft and shared selection without extra requests', async () => {
    setup()
    await loaded()
    const tools = within(screen.getByRole('region', { name: '移动凭证工具' }))
    const filterToggle = tools.getByRole('button', { name: '筛选条件' })
    fireEvent.click(filterToggle)
    const input = screen.getByRole('textbox', { name: '搜索文件名或已保存邮箱' })
    fireEvent.change(input, { target: { value: 'unsaved-synthetic' } })
    fireEvent.click(filterToggle)
    fireEvent.click(filterToggle)
    expect(screen.getByRole('textbox', { name: '搜索文件名或已保存邮箱' })).toBe(input)
    expect(input).toHaveValue('unsaved-synthetic')
    const bulkToggle = tools.getByRole('button', { name: '批量操作' })
    fireEvent.click(bulkToggle)
    fireEvent.click(screen.getByRole('button', { name: '选择当前页' }))
    fireEvent.click(bulkToggle)
    expect(screen.getByRole('checkbox', { name: '移动选择 synthetic-0.json' })).toBeChecked()
    expect(screen.getByText('已跨页选择 1 项')).toBeInTheDocument()
    expect(tools.getAllByText('1', { selector: 'strong' })).toHaveLength(2)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('does not read while logged out', () => {
    setSessionToken(null)
    setup()
    expect(screen.getByText('请登录后查看凭证。')).toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('opening and focusing details never calls quota test verify or full detail', async () => {
    setup()
    await loaded()
    openDetail()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.focus(screen.getByRole('button', { name: '刷新额度并同步状态' }))
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(callsTo('/creds/detail/synthetic-0.json')).toHaveLength(0)
  })

  it('desktop table and mobile card share selection', async () => {
    setup()
    await loaded()
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 synthetic-0.json' }))
    expect(screen.getByRole('checkbox', { name: '移动选择 synthetic-0.json' })).toBeChecked()
    expect(screen.getByText('已跨页选择 1 项')).toBeInTheDocument()
  })

  it('logout clears portaled details while page remains mounted; new epoch has no selection', async () => {
    setup()
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: '选择当前页' }))
    openDetail()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    act(() => setSessionToken(null))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByText('synthetic-0@example.invalid')).not.toBeInTheDocument()
    act(() => setSessionToken('new-synthetic'))
    await loaded()
    expect(screen.getByText('已跨页选择 0 项')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('storage token changes close confirmation portal and clear old selection', async () => {
    const safeFixture = {
      config: {},
      capabilities: [],
      env_locked: [],
      security: {},
      secret_fields: {
        api_password: { configured: false },
        panel_password: { configured: false },
        password: { configured: false },
      },
    }
    const configPending = deferred<Response>()
    let statusCalls = 0
    setup(1, url => {
      if (url.pathname === '/config/get') {
        return configPending.promise
      }
      if (url.pathname === '/creds/status') {
        statusCalls++
        return Promise.resolve(Response.json(status(1)))
      }
      return null
    })
    await loaded()
    const initialStatusCalls = statusCalls
    fireEvent.click(screen.getByRole('button', { name: '选择当前页' }))
    fireEvent.click(screen.getByRole('button', { name: '批量删除' }))
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()

    act(() => {
      localStorage.setItem('gcli2api_auth_token', 'storage-synthetic')
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'gcli2api_auth_token',
          newValue: 'storage-synthetic',
        })
      )
    })

    // Exactly one GET /config/get?include_secrets=false
    const configCalls = callsTo('/config/get')
    expect(configCalls).toHaveLength(1)
    const [configUrl, configInit] = configCalls[0]
    expect(new URL(String(configUrl)).searchParams.get('include_secrets')).toBe('false')
    expect(configInit?.method ?? 'GET').toBe('GET')

    // Pending removes old content/portal and starts no new list
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(screen.getByText('请登录后查看凭证。')).toBeInTheDocument()
    expect(statusCalls).toBe(initialStatusCalls)

    // Resolve safe public config
    await act(async () => configPending.resolve(Response.json(safeFixture)))

    // List reload with zero selection and no reopened portal
    await loaded()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(screen.getByText('已跨页选择 0 项')).toBeInTheDocument()
  })

  it('late old-session list cannot overwrite re-login state', async () => {
    const late = deferred<Response>()
    vi.mocked(fetch).mockReturnValueOnce(late.promise).mockResolvedValue(Response.json(status()))
    render(
      <AuthProvider>
        <PanelChannelProvider>
          <CredentialsPage />
        </PanelChannelProvider>
      </AuthProvider>
    )
    act(() => setSessionToken(null))
    act(() => setSessionToken('new'))
    await loaded()
    await act(async () => late.resolve(Response.json({ ...status(), items: [{ filename: 'old-session.json' }] })))
    expect(screen.queryByText('old-session.json')).not.toBeInTheDocument()
  })

  it('101 selections disable selected tools but retain legal bulk operations', async () => {
    setup(101)
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: '读取并选择全部匹配' }))
    await screen.findByText('已跨页选择 101 项')
    expect(screen.getByRole('button', { name: '下载选中' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '复制邮箱' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '批量启用' })).toBeEnabled()
    expect(screen.getByText(/下载和复制邮箱最多 100 项/)).toBeInTheDocument()
  })

  it('partial HTTP200 action shows failed count and performs just one write', async () => {
    setup(2, url => url.pathname === '/creds/batch-action' ? Promise.resolve(Response.json({ success_count: 1, total_count: 2, errors: ['synthetic failure'] })) : null)
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: '选择当前页' }))
    fireEvent.click(screen.getByRole('button', { name: '批量启用' }))
    await screen.findByText('部分成功：成功 1 / 2，失败 1。')
    expect(callsTo('/creds/batch-action')).toHaveLength(1)
    expect(callsTo('/creds/status')).toHaveLength(2)
  })

  it('missing capability leaves controls read-only', async () => {
    setup(1, undefined, [])
    await loaded()
    expect(screen.getByRole('textbox', { name: '搜索文件名或已保存邮箱' })).toBeDisabled()
    openDetail()
    expect(screen.getByRole('button', { name: '永久禁用' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '保存备注' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '开启信用额度' })).toBeDisabled()
  })

  it('manual fixed reply false200 remains false and state update pending remains visible', async () => {
    setup(1, url => url.pathname.startsWith('/creds/test/') ? Promise.resolve(Response.json({ success: false, verified_reply: false, upstream_status: 200, state_update: { model_access: { status: 'pending' } } })) : null)
    await loaded()
    openDetail()
    fireEvent.click(screen.getByRole('button', { name: '发送固定回复模型测试' }))
    await screen.findByText('固定回复校验：未通过')
    expect(screen.getByText('model_access：pending')).toBeInTheDocument()
    expect(callsTo('/creds/test/synthetic-0.json')).toHaveLength(1)
  })

  it.each(['missing', 'duplicate', 'unexpected'])('first quota batch %s identifiers stops all later side-effect batches', async kind => {
    setup(11, (url, init) => {
      if (url.pathname !== '/creds/batch-refresh-cooldown') return null
      const names: string[] = JSON.parse(String(init?.body)).filenames
      const returned = kind === 'missing' ? names.slice(0, -1) : kind === 'duplicate' ? [...names.slice(0, -1), names[0]] : [...names.slice(0, -1), 'unexpected.json']
      return Promise.resolve(Response.json({ results: returned.map(filename => ({ filename, success: true })) }))
    })
    await loaded()
    await startQuota()
    await screen.findByText(/操作结果未知.*已返回 0\/11 项/)
    expect(callsTo('/creds/batch-refresh-cooldown')).toHaveLength(1)
  })

  it('stop waits for current ten results and does not start final batch', async () => {
    const pending = deferred<Response>()
    let names: string[] = []
    setup(11, (url, init) => {
      if (url.pathname !== '/creds/batch-refresh-cooldown') return null
      names = JSON.parse(String(init?.body)).filenames
      return pending.promise
    })
    await loaded()
    await startQuota()
    await waitFor(() => expect(callsTo('/creds/batch-refresh-cooldown')).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: '停止后续批次' }))
    await act(async () => pending.resolve(Response.json({ results: names.map(filename => ({ filename, success: true, state_update: { quota: { status: 'applied' } } })) })))
    await screen.findByText('已停止后续批次：已返回 10/11 项。已执行的操作不会回滚。')
    expect(callsTo('/creds/batch-refresh-cooldown')).toHaveLength(1)
    expect(within(screen.getByRole('region', { name: '批量额度逐项结果' })).getAllByText(/上游成功/)).toHaveLength(10)
  })

  it('failed second batch retains first confirmed results', async () => {
    let batches = 0
    setup(11, (url, init) => {
      if (url.pathname !== '/creds/batch-refresh-cooldown') return null
      batches++
      const names: string[] = JSON.parse(String(init?.body)).filenames
      return Promise.resolve(Response.json(batches === 1 ? { results: names.map(filename => ({ filename, success: true })) } : { results: [] }))
    })
    await loaded()
    await startQuota()
    await screen.findByText(/操作结果未知.*已返回 10\/11 项/)
    expect(callsTo('/creds/batch-refresh-cooldown')).toHaveLength(2)
    expect(screen.getByRole('region', { name: '批量额度逐项结果' })).toBeInTheDocument()
  })

  it('filter_1: renders real GCLI controls and sends exact representative values only upon explicit apply', async () => {
    act(() => {
      __commitPanelChannel('geminicli')
    })
    const gcliCaps = Object.values(CAP_BY_MODE.geminicli)
    setup(1, undefined, gcliCaps, 'geminicli')
    await loaded()

    const previewSelect = screen.getByRole('combobox', { name: 'Preview' })
    const previewOptions = within(previewSelect).getAllByRole('option').map(o => o.getAttribute('value'))
    expect(previewOptions).toEqual(['all', 'preview', 'no_preview'])

    const cdSelect = screen.getByRole('combobox', { name: 'CD' })
    const cdOptions = within(cdSelect).getAllByRole('option').map(o => o.getAttribute('value'))
    expect(cdOptions).toEqual(['all', 'in_cooldown', 'pro_no_cooldown', 'flash_no_cooldown', 'no_cooldown'])

    const tierSelect = screen.getByRole('combobox', { name: '订阅等级' })
    const tierOptions = within(tierSelect).getAllByRole('option').map(o => o.getAttribute('value'))
    expect(tierOptions).toEqual([
      'all',
      'code_assist_standard',
      'code_assist_enterprise',
      'free',
      'pro',
      'ultra',
      'unknown',
    ])

    // Draft changes send nothing to backend
    fireEvent.change(previewSelect, { target: { value: 'preview' } })
    fireEvent.change(cdSelect, { target: { value: 'in_cooldown' } })
    fireEvent.change(tierSelect, { target: { value: 'code_assist_standard' } })
    expect(callsTo('/creds/status')).toHaveLength(1)

    // Explicit Apply sends exact representative values through actual listQuery/API
    fireEvent.click(screen.getByRole('button', { name: '应用筛选' }))
    await waitFor(() => expect(callsTo('/creds/status')).toHaveLength(2))

    const secondUrl = new URL(String(callsTo('/creds/status')[1][0]))
    expect(secondUrl.searchParams.get('mode')).toBe('geminicli')
    expect(secondUrl.searchParams.get('preview_filter')).toBe('preview')
    expect(secondUrl.searchParams.get('cooldown_filter')).toBe('in_cooldown')
    expect(secondUrl.searchParams.get('tier_filter')).toBe('code_assist_standard')
  })

  it('filter_2: applying GCLI CD then switching channel to AG applies AG group without stale GCLI CD', async () => {
    act(() => {
      __commitPanelChannel('geminicli')
    })
    const gcliCaps = Object.values(CAP_BY_MODE.geminicli)
    setup(1, undefined, gcliCaps, 'geminicli')
    await loaded()

    const cdSelect = screen.getByRole('combobox', { name: 'CD' })
    fireEvent.change(cdSelect, { target: { value: 'pro_no_cooldown' } })
    fireEvent.click(screen.getByRole('button', { name: '应用筛选' }))
    await waitFor(() => expect(callsTo('/creds/status')).toHaveLength(2))

    // Switch real channel to AG
    act(() => {
      __commitPanelChannel('antigravity')
    })
    await loaded()

    const groupSelect = screen.getByRole('combobox', { name: '额度组' })
    fireEvent.change(groupSelect, { target: { value: 'claude_gpt_restricted' } })
    fireEvent.click(screen.getByRole('button', { name: '应用筛选' }))

    await waitFor(() => {
      const calls = callsTo('/creds/status')
      const latestUrl = new URL(String(calls[calls.length - 1][0]))
      expect(latestUrl.searchParams.get('mode')).toBe('antigravity')
      expect(latestUrl.searchParams.get('cooldown_filter')).toBe('claude_gpt_restricted')
      expect(latestUrl.searchParams.has('preview_filter')).toBe(false)
    })
  })

  it('filter_3: capability withdrawal clears gated choices without automatic Apply and preserves 400/500 options', async () => {
    setup(1, url =>
      url.pathname === '/creds/action'
        ? Promise.resolve(Response.json({ error_code: 'capability_unavailable', capability: CAP.permanent }, { status: 501 }))
        : null
    )
    await loaded()

    // Status filter has permanent_disabled initially
    const statusSelect = screen.getByRole('combobox', { name: '状态' })
    expect(within(statusSelect).getByRole('option', { name: '永久禁用' })).toBeInTheDocument()
    fireEvent.change(statusSelect, { target: { value: 'permanent_disabled' } })

    // Verify 400 and 500 options exist in error filter
    const errorSelect = screen.getByRole('combobox', { name: '错误分组' })
    expect(within(errorSelect).getByRole('option', { name: '400' })).toBeInTheDocument()
    expect(within(errorSelect).getByRole('option', { name: '500' })).toBeInTheDocument()

    const initialStatusCalls = callsTo('/creds/status').length

    // Trigger capability withdrawal via permanent_disable action
    openDetail()
    fireEvent.click(screen.getByRole('button', { name: '永久禁用' }))
    fireEvent.click(screen.getByRole('button', { name: '确认永久禁用' }))

    // Drawer closes on withdrawal
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    // Await legitimate cap-withdrawal list reload
    await waitFor(() => expect(callsTo('/creds/status').length).toBe(initialStatusCalls + 1))
    await loaded()

    // Notice is displayed and stale gated choice is cleared
    expect(screen.getByText(/服务能力已撤回/)).toBeInTheDocument()

    // Baseline request count: normalization/draft edits must not Apply
    const baselineStatusCalls = callsTo('/creds/status').length

    // Assert permanent_disabled -> all and option removed
    const currentStatusSelect = screen.getByRole('combobox', { name: '状态' })
    expect(currentStatusSelect).toHaveValue('all')
    expect(within(currentStatusSelect).queryByRole('option', { name: '永久禁用' })).not.toBeInTheDocument()

    // Error filter still retains 400 and 500 options
    const currentErrorSelect = screen.getByRole('combobox', { name: '错误分组' })
    expect(within(currentErrorSelect).getByRole('option', { name: '400' })).toBeInTheDocument()
    expect(within(currentErrorSelect).getByRole('option', { name: '500' })).toBeInTheDocument()

    // Normalization/draft edits must not Apply
    fireEvent.change(currentErrorSelect, { target: { value: '400' } })
    expect(callsTo('/creds/status').length).toBe(baselineStatusCalls)
  })

  it('native_and_ownership: verified GCLI list, limit 10, no credit controls, actions carry mode', async () => {
    act(() => {
      __commitPanelChannel('geminicli')
    })
    const gcliCaps = Object.values(CAP_BY_MODE.geminicli)
    setup(
      1,
      url => {
        if (url.pathname === '/creds/action') return Promise.resolve(Response.json({ message: 'gcli action success' }))
        if (url.pathname.startsWith('/creds/test/')) return Promise.resolve(Response.json({ success: true, verified_reply: true }))
        return null
      },
      gcliCaps,
      'geminicli'
    )
    await screen.findByRole('heading', { name: 'Gemini CLI 凭证' })
    await loaded()

    // Selectable size 10 sends limit=10
    const limitSelect = screen.getByRole('combobox', { name: '每页数量' })
    expect(within(limitSelect).getByRole('option', { name: '10' })).toBeInTheDocument()
    fireEvent.change(limitSelect, { target: { value: '10' } })
    await waitFor(() => {
      const calls = callsTo('/creds/status')
      const latest = new URL(String(calls[calls.length - 1][0]))
      expect(latest.searchParams.get('limit')).toBe('10')
      expect(latest.searchParams.get('mode')).toBe('geminicli')
    })

    // AG credit controls are absent in GCLI
    expect(screen.queryByRole('button', { name: '批量开启信用额度' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '批量关闭信用额度' })).not.toBeInTheDocument()

    // Detail has no credit section and actions carry mode=geminicli
    openDetail()
    expect(screen.queryByText(/信用额度：/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '启用' }))
    await waitFor(() => {
      const call = callsTo('/creds/action').at(-1)
      expect(call).toBeDefined()
      expect(new URL(String(call![0])).searchParams.get('mode')).toBe('geminicli')
    })

    // Manual test carries mode=geminicli
    fireEvent.click(screen.getByRole('button', { name: '发送固定回复模型测试' }))
    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([u]) => String(u).includes('/creds/test/'))
      expect(call).toBeDefined()
      expect(new URL(String(call![0])).searchParams.get('mode')).toBe('geminicli')
    })
  })

  it('native_and_ownership: retained Detail manual and loadErrors handlers execute with zero transport across same-Scope validation ABA', async () => {
    setup(1, url => {
      if (url.pathname.startsWith('/creds/errors/')) return Promise.resolve(Response.json({ error_codes: [] }))
      if (url.pathname.startsWith('/creds/test/')) return Promise.resolve(Response.json({ success: true, verified_reply: true }))
      if (url.pathname.startsWith('/creds/quota/')) return Promise.resolve(Response.json({ success: true }))
      if (url.pathname.startsWith('/creds/verify-project/')) return Promise.resolve(Response.json({ success: true }))
      return null
    })
    await loaded()
    openDetail()

    const capturedProps = lastDetailProps
    expect(capturedProps).not.toBeNull()

    // Execute same-Scope validation ABA: verified -> unavailable -> verified on the SAME session epoch
    const epoch = getSessionSnapshot().sessionEpoch
    act(() => {
      __setSessionValidationStatus(epoch, 'unavailable')
    })
    act(() => {
      __setSessionValidationStatus(epoch, 'verified')
    })

    // Invoke the retained actual React handlers directly in act (never use detached DOM clicks as proof)
    await act(async () => {
      try { await capturedProps.credentialApi.errors('synthetic-0.json') } catch {}
      try { await capturedProps.credentialApi.manual('synthetic-0.json', 'test') } catch {}
      try { await capturedProps.credentialApi.manual('synthetic-0.json', 'quota') } catch {}
      try { await capturedProps.credentialApi.manual('synthetic-0.json', 'verify-project') } catch {}
      await capturedProps.action(['synthetic-0.json'], 'enable')
      capturedProps.close()
      capturedProps.restoreFocus()
    })

    // Assert zero transport for the stale retained handlers
    expect(callsTo('/creds/errors/synthetic-0.json')).toHaveLength(0)
    expect(callsTo('/creds/test/synthetic-0.json')).toHaveLength(0)
    expect(callsTo('/creds/quota/synthetic-0.json')).toHaveLength(0)
    expect(callsTo('/creds/verify-project/synthetic-0.json')).toHaveLength(0)
    expect(callsTo('/creds/action')).toHaveLength(0)

    // Fresh Detail manual/errors in the new workspace work normally
    await loaded()
    openDetail()
    const freshProps = lastDetailProps
    expect(freshProps).not.toBe(capturedProps)
    await act(async () => {
      await freshProps.credentialApi.errors('synthetic-0.json')
    })
    await waitFor(() => expect(callsTo('/creds/errors/synthetic-0.json')).toHaveLength(1))
  })

  it('native_and_ownership: deferred work across AG->GCLI->AG switch causes no replacement mutation or subsequent quota chunks', async () => {
    const pendingAction = deferred<Response>()
    let actionCalls = 0

    setup(1, url => {
      if (url.pathname === '/creds/action') {
        actionCalls++
        return pendingAction.promise
      }
      return null
    })
    await loaded()
    openDetail()

    // Start an action in AG
    fireEvent.click(screen.getByRole('button', { name: '启用' }))
    expect(actionCalls).toBe(1)

    // Channel switch: AG -> GCLI
    act(() => {
      __commitPanelChannel('geminicli')
    })
    await screen.findByRole('heading', { name: 'Gemini CLI 凭证' })

    // Channel switch: GCLI -> AG
    act(() => {
      __commitPanelChannel('antigravity')
    })
    await screen.findByRole('heading', { name: 'Antigravity 凭证' })
    await loaded()

    // Settle old action from original AG lifetime
    await act(async () => {
      pendingAction.resolve(Response.json({ message: 'old stale completion' }))
    })

    // Replacement-owner workspace is not mutated: no drawer, zero new action transport
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(actionCalls).toBe(1)

    // Fresh action in new workspace operates normally
    openDetail()
    fireEvent.click(screen.getByRole('button', { name: '启用' }))
    await waitFor(() => expect(actionCalls).toBe(2))
  })

  it('native_and_ownership: retained Detail handlers produce zero stale transport or mutation across same-file close and reopen', async () => {
    setup(1, url => {
      if (url.pathname.startsWith('/creds/errors/')) return Promise.resolve(Response.json({ error_codes: [] }))
      if (url.pathname.startsWith('/creds/quota/')) return Promise.resolve(Response.json({ success: true }))
      if (url.pathname === '/creds/action') return Promise.resolve(Response.json({ message: 'synthetic ok' }))
      return null
    })
    await loaded()
    openDetail()
    const oldProps = lastDetailProps
    expect(oldProps).not.toBeNull()
    expect(oldProps.row.filename).toBe('synthetic-0.json')

    // Legitimate close restores connected trigger/title
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    const trigger = document.querySelector('[data-credential-trigger="desktop-detail"]')!
    await waitFor(() => expect(trigger).toHaveFocus())

    // Reopen same file
    openDetail()
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    const freshProps = lastDetailProps
    expect(freshProps).not.toBe(oldProps)

    // Retained manual/errors/action/close/focus produce zero stale transport or replacement busy/result/portal/focus changes
    await act(async () => {
      try { await oldProps.credentialApi.errors('synthetic-0.json') } catch {}
      try { await oldProps.credentialApi.manual('synthetic-0.json', 'quota') } catch {}
      await oldProps.action(['synthetic-0.json'], 'enable')
      oldProps.close()
      oldProps.restoreFocus()
    })

    expect(callsTo('/creds/errors/synthetic-0.json')).toHaveLength(0)
    expect(callsTo('/creds/quota/synthetic-0.json')).toHaveLength(0)
    expect(callsTo('/creds/action')).toHaveLength(0)
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    // Fresh manual/errors/action work
    await act(async () => {
      await freshProps.action(['synthetic-0.json'], 'enable')
    })
    await waitFor(() => expect(callsTo('/creds/action')).toHaveLength(1))

    // Legitimate close restores connected trigger/title
    const currentDialog = screen.queryByRole('dialog')
    if (currentDialog) {
      fireEvent.click(within(currentDialog).getByRole('button', { name: 'Close' }))
    }
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() =>
      expect(
        document.querySelector('[data-credential-trigger="desktop-detail"]') ||
          screen.getByRole('heading', { name: 'Antigravity 凭证' })
      ).toHaveFocus()
    )
  })

  it('native_and_ownership: deferred manual settles after replacement with zero stale transport or workspace mutation', async () => {
    const pendingManual = deferred<Response>()
    let manualPromise: Promise<unknown> | undefined
    let settled = false
    let initialProps: any = null

    setup(1, url => {
      if (url.pathname.startsWith('/creds/quota/')) return pendingManual.promise
      if (url.pathname.startsWith('/creds/test/')) return Promise.resolve(Response.json({ success: true, verified_reply: true }))
      return null
    })

    try {
      await loaded()
      openDetail()
      initialProps = lastDetailProps
      expect(initialProps).not.toBeNull()

      // In-flight manual
      await act(async () => {
        manualPromise = initialProps.credentialApi.manual('synthetic-0.json', 'quota')
      })
      expect(callsTo('/creds/quota/synthetic-0.json')).toHaveLength(1)

      // Replacement occurs: channel AG -> GCLI -> AG
      act(() => {
        __commitPanelChannel('geminicli')
      })
      await screen.findByRole('heading', { name: 'Gemini CLI 凭证' })
      act(() => {
        __commitPanelChannel('antigravity')
      })
      await screen.findByRole('heading', { name: 'Antigravity 凭证' })
      await loaded()

      // Settle deferred manual from old opening
      await act(async () => {
        pendingManual.resolve(Response.json({ success: true, state_update: { quota: { status: 'applied' } } }))
        settled = true
        try {
          await manualPromise
        } catch {}
      })

      // Replacement workspace is clean: no open dialog, zero new quota transport
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(callsTo('/creds/quota/synthetic-0.json')).toHaveLength(1)

      // Fresh manual works
      openDetail()
      const freshProps = lastDetailProps
      expect(freshProps).not.toBe(initialProps)
      await act(async () => {
        await freshProps.credentialApi.manual('synthetic-0.json', 'test')
      })
      await waitFor(() => expect(callsTo('/creds/test/synthetic-0.json')).toHaveLength(1))
    } finally {
      if (!settled) {
        await act(async () => {
          pendingManual.resolve(Response.json({ success: false }))
          try {
            await manualPromise
          } catch {}
          try {
            initialProps?.close?.()
          } catch {}
        })
      }
    }
  })

  it('native_and_ownership: retained old quota refresh after target or opening replacement sends zero requests and fresh refresh works', async () => {
    let quotaSummaryCalls: string[] = []
    setup(2, url => {
      if (url.pathname.startsWith('/creds/quota-summary/')) {
        quotaSummaryCalls.push(url.pathname)
        return Promise.resolve(Response.json({
          source: 'antigravity_quota_summary',
          status: 'ok',
          groups: {},
          buckets: [],
        }))
      }
      return null
    })
    await loaded()

    // Open QuotaDialog for first row
    const firstTarget = document.querySelector<HTMLButtonElement>(
      'button[data-credential-filename="synthetic-0.json"][data-credential-trigger="desktop-quota"]'
    ) ?? screen.getAllByRole('button', { name: '查看额度' })[0]
    fireEvent.click(firstTarget)
    await screen.findByRole('dialog')
    const oldQuota = lastQuotaProps
    expect(oldQuota).not.toBeNull()
    expect(oldQuota.filename).toBe('synthetic-0.json')

    // Close real dialog via scoped Close button and wait until removed
    const firstDialog = screen.getByRole('dialog')
    fireEvent.click(within(firstDialog).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    // Query fresh current DOM by both attributes and verify exact target
    const secondTarget = document.querySelector<HTMLButtonElement>(
      'button[data-credential-filename="synthetic-1.json"][data-credential-trigger="desktop-quota"]'
    )
    expect(secondTarget).not.toBeNull()
    expect(secondTarget?.getAttribute('data-credential-filename')).toBe('synthetic-1.json')
    expect(secondTarget?.getAttribute('data-credential-trigger')).toBe('desktop-quota')
    fireEvent.click(secondTarget!)

    // Wait for actual new dialog with synthetic-1.json
    await screen.findByRole('dialog')
    await waitFor(() => expect(lastQuotaProps?.filename).toBe('synthetic-1.json'))
    const freshQuota = lastQuotaProps
    expect(freshQuota).not.toBe(oldQuota)

    // Settle target-open transport before measurement baseline
    await waitFor(() => expect(quotaSummaryCalls.some(url => url.includes('synthetic-1.json'))).toBe(true))

    quotaSummaryCalls = []

    // Retained old quota refresh sends zero requests
    act(() => {
      oldQuota.onRefresh()
    })
    expect(quotaSummaryCalls).toHaveLength(0)

    // Fresh quota refresh works
    act(() => {
      freshQuota.onRefresh()
    })
    await waitFor(() => expect(quotaSummaryCalls.length).toBeGreaterThan(0))
    expect(quotaSummaryCalls[0]).toContain('synthetic-1.json')
  })
})

describe('CredentialsPage supportedPanelModes declaration', () => {
  it('declares frozen readonly supportedPanelModes for dual-channel credentials activation', () => {
    expect(supportedPanelModes).toEqual(['antigravity', 'geminicli'])
    expect(Object.isFrozen(supportedPanelModes)).toBe(true)
  })
})

describe('ConsoleHandshake integration in real verified CredentialsPage', () => {
  let originalParentDesc: PropertyDescriptor | undefined
  let originalReferrerDesc: PropertyDescriptor | undefined
  let originalAncestorOriginsDesc: PropertyDescriptor | undefined
  let mockPostMessage: ReturnType<typeof vi.fn>

  function setMetaPolicy(policyContent: string | null) {
    document.querySelectorAll('meta[name="gcli-embed-policy"]').forEach(el => el.remove())
    if (policyContent !== null) {
      const meta = document.createElement('meta')
      meta.setAttribute('name', 'gcli-embed-policy')
      meta.setAttribute('content', policyContent)
      document.head.appendChild(meta)
    }
  }

  beforeEach(() => {
    originalParentDesc = Object.getOwnPropertyDescriptor(window, 'parent')
    originalReferrerDesc = Object.getOwnPropertyDescriptor(document, 'referrer')
    originalAncestorOriginsDesc = Object.getOwnPropertyDescriptor(window.location, 'ancestorOrigins')

    mockPostMessage = vi.fn()
    Object.defineProperty(window, 'parent', {
      configurable: true,
      writable: true,
      value: { postMessage: mockPostMessage },
    })

    setMetaPolicy(JSON.stringify({ mode: 'exact', origins: ['https://console.example.com'] }))
    Object.defineProperty(document, 'referrer', {
      configurable: true,
      writable: true,
      value: 'https://console.example.com',
    })
  })

  afterEach(() => {
    if (originalParentDesc !== undefined) {
      Object.defineProperty(window, 'parent', originalParentDesc)
    } else {
      delete (window as unknown as Record<string, unknown>).parent
    }

    if (originalReferrerDesc !== undefined) {
      Object.defineProperty(document, 'referrer', originalReferrerDesc)
    } else {
      delete (document as unknown as Record<string, unknown>).referrer
    }

    if (originalAncestorOriginsDesc !== undefined) {
      Object.defineProperty(window.location, 'ancestorOrigins', originalAncestorOriginsDesc)
    } else {
      delete (window.location as unknown as Record<string, unknown>).ancestorOrigins
    }

    setMetaPolicy(null)
    act(() => {
      navigatePanel('credentials', 'antigravity')
    })
  })

  it('proves one exact ready payload emitted only for mounted verified GCLI credentials', async () => {
    act(() => {
      navigatePanel('credentials', 'geminicli')
    })
    setSessionToken('synthetic-handshake-token')

    setup(1, undefined, undefined, 'geminicli')
    await loaded()

    expect(mockPostMessage).toHaveBeenCalledTimes(1)
    expect(mockPostMessage).toHaveBeenCalledWith(CONSOLE_READY_PAYLOAD, 'https://console.example.com')
  })

  it('zero ready messages for unverified, anonymous, or Antigravity mode', async () => {
    // 1. Antigravity mode
    act(() => {
      navigatePanel('credentials', 'antigravity')
    })
    setSessionToken('synthetic-ag-token')
    setup(1, undefined, undefined, 'antigravity')
    await loaded()
    expect(mockPostMessage).not.toHaveBeenCalled()

    // 2. Unverified session in GCLI mode
    act(() => {
      expect(
        __setSessionValidationStatus(getSessionSnapshot().sessionEpoch, 'unavailable')
      ).toBe(true)
      navigatePanel('credentials', 'geminicli')
    })
    expect(screen.getByText('请登录后查看凭证。')).toBeInTheDocument()
    expect(mockPostMessage).not.toHaveBeenCalled()

    // 3. Anonymous in GCLI mode
    act(() => {
      setSessionToken(null)
    })
    expect(screen.getByText('请登录后查看凭证。')).toBeInTheDocument()
    expect(mockPostMessage).not.toHaveBeenCalled()
  })

  it('same activation rerender emits no duplicate ready message', async () => {
    act(() => {
      navigatePanel('credentials', 'geminicli')
    })
    setSessionToken('synthetic-rerender-token')

    setup(1, undefined, undefined, 'geminicli')
    await loaded()

    expect(mockPostMessage).toHaveBeenCalledTimes(1)

    // Switch view mode from table to cards (triggers re-render of CredentialWorkspace)
    fireEvent.click(screen.getByRole('radio', { name: '额度卡片' }))
    expect(await screen.findByRole('radio', { name: '额度卡片', checked: true })).toBeInTheDocument()

    // Zero duplicate ready messages
    expect(mockPostMessage).toHaveBeenCalledTimes(1)

    // Switch view mode back to table
    fireEvent.click(screen.getByRole('radio', { name: '表格' }))
    expect(await screen.findByRole('radio', { name: '表格', checked: true })).toBeInTheDocument()

    // Still exactly 1
    expect(mockPostMessage).toHaveBeenCalledTimes(1)
  })

  it('same-session validation loss and reverify emits ready once for fresh activation', async () => {
    act(() => {
      navigatePanel('credentials', 'geminicli')
    })
    setSessionToken('synthetic-reverify-token')

    setup(1, undefined, undefined, 'geminicli')
    await loaded()
    expect(mockPostMessage).toHaveBeenCalledTimes(1)

    // Same-session validation loss: workspace unmounts
    act(() => {
      expect(
        __setSessionValidationStatus(getSessionSnapshot().sessionEpoch, 'unavailable')
      ).toBe(true)
    })
    expect(screen.getByText('请登录后查看凭证。')).toBeInTheDocument()
    expect(mockPostMessage).toHaveBeenCalledTimes(1)

    // Same-session reverify: workspace remounts with fresh validation incarnation
    act(() => {
      expect(
        __setSessionValidationStatus(getSessionSnapshot().sessionEpoch, 'verified')
      ).toBe(true)
    })
    await loaded()

    // Exactly one new message for fresh verified activation
    expect(mockPostMessage).toHaveBeenCalledTimes(2)
  })

  it('channel ABA (geminicli -> antigravity -> geminicli) emits ready once per fresh GCLI activation', async () => {
    act(() => {
      navigatePanel('credentials', 'geminicli')
    })
    setSessionToken('synthetic-aba-token')

    setup(1, undefined, undefined, 'geminicli')
    await loaded()
    expect(mockPostMessage).toHaveBeenCalledTimes(1)

    // Switch channel to Antigravity
    act(() => {
      navigatePanel('credentials', 'antigravity')
    })
    await screen.findByRole('heading', { level: 1, name: 'Antigravity 凭证' })
    expect(mockPostMessage).toHaveBeenCalledTimes(1) // No new message

    // Switch channel back to Gemini CLI (channel ABA)
    act(() => {
      navigatePanel('credentials', 'geminicli')
    })
    await screen.findByRole('heading', { level: 1, name: 'Gemini CLI 凭证' })
    expect(mockPostMessage).toHaveBeenCalledTimes(2) // Fresh activation emits once
  })
})
