import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PanelChannelProvider } from '@/app/channels'
import { navigatePanel } from '@/app/routes'
import { getSessionSnapshot, setSessionToken, __setSessionValidationStatus } from '@/auth/session'
import OverviewPage from './index'
import { useOverview } from './useOverview'
import { overviewFixture } from './fixtures'

vi.mock('./useOverview', () => ({ useOverview: vi.fn() }))

let originalClipboardDesc: PropertyDescriptor | undefined

beforeEach(() => {
  originalClipboardDesc = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  navigatePanel('overview', 'antigravity')
})

afterEach(() => {
  vi.useRealTimers()
  if (originalClipboardDesc) {
    Object.defineProperty(navigator, 'clipboard', originalClipboardDesc)
  } else {
    delete (navigator as unknown as { clipboard?: unknown }).clipboard
  }
  document.head.innerHTML = '<meta name="gcli-service-base" content="/">'
  setSessionToken(null, false)
  navigatePanel('overview', 'antigravity')
})

it('renders only endpoint metrics and shows unavailable explicitly', () => {
  const refresh = vi.fn()
  vi.mocked(useOverview).mockReturnValue({
    data: { ...overviewFixture, today: { value: null, issue: '后端报告此统计不可用' } },
    loading: false,
    refresh,
  })
  render(
    <PanelChannelProvider>
      <OverviewPage />
    </PanelChannelProvider>
  )

  expect(useOverview).toHaveBeenCalledWith('antigravity')
  expect(screen.getByText('后端报告此统计不可用')).toBeTruthy()

  const todayTotalTitle = screen.getByText('今日逻辑请求')
  const metricsContainer =
    todayTotalTitle.closest('.grid') ?? todayTotalTitle.parentElement?.parentElement?.parentElement!
  const findMetricCard = (label: string) => {
    const card = Array.from(metricsContainer.children).find(child =>
      within(child as HTMLElement).queryByText(label) !== null
    ) as HTMLElement
    expect(card).toBeTruthy()
    return card
  }

  expect(within(findMetricCard('今日逻辑请求')).getByText('不可用')).toBeTruthy()
  expect(within(findMetricCard('成功')).getByText('不可用')).toBeTruthy()
  expect(within(findMetricCard('失败')).getByText('不可用')).toBeTruthy()
  expect(within(findMetricCard('成功率')).getByText('不可用')).toBeTruthy()
  expect(within(findMetricCard('当前 RPM')).getByText('3')).toBeTruthy()

  expect(screen.getByText(/每日按北京时间结算/)).toBeTruthy()
  expect(screen.queryByText(/CPU|RAM|账单|成本/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '刷新统计' }))
  expect(refresh).toHaveBeenCalledTimes(1)
})

it('provides explicit selectable manual-copy fallback and usage help in AG mode with prefixed service base when clipboard is unavailable', () => {
  vi.useFakeTimers()
  document.head.innerHTML = '<meta name="gcli-service-base" content="/custom/service/root/">'
  setSessionToken('synthetic-overview-token', false)
  navigatePanel('overview', 'antigravity')

  Object.defineProperty(navigator, 'clipboard', {
    value: undefined,
    configurable: true,
    writable: true,
  })

  vi.mocked(useOverview).mockReturnValue({
    data: overviewFixture,
    loading: false,
    refresh: vi.fn(),
    nodeData: {
      version: { value: { version: '1.0.0', display_version: 'v1.0.0' }, issue: null },
      codeAssistEndpoint: {
        value: 'http://localhost:3000/custom/service/root/code-assist',
        issue: null,
      },
    },
    nodeLoading: false,
    refreshNode: vi.fn(),
  })

  render(
    <PanelChannelProvider>
      <OverviewPage />
    </PanelChannelProvider>
  )

  expect(screen.getByText('使用说明')).toBeTruthy()
  expect(screen.getByText(/保留服务根路径前缀/)).toBeTruthy()

  const openLink = screen.getByRole('link', { name: '打开 OpenAI 服务地址' })
  expect(openLink.getAttribute('href')).toBe('http://localhost:3000/custom/service/root/antigravity/v1')
  expect(openLink.getAttribute('target')).toBe('_blank')
  expect(openLink.getAttribute('rel')).toContain('noopener')
  expect(openLink.getAttribute('rel')).toContain('noreferrer')

  const copyButton = screen.getByRole('button', { name: '复制 OpenAI 服务地址' })
  fireEvent.click(copyButton)

  const fallbackInput = screen.getByRole('textbox', {
    name: /OpenAI.*手动复制/,
  }) as HTMLInputElement
  expect(fallbackInput).toBeTruthy()
  expect(fallbackInput.readOnly).toBe(true)
  expect(fallbackInput.value).toBe('http://localhost:3000/custom/service/root/antigravity/v1')

  expect(vi.mocked(fetch)).not.toHaveBeenCalled()

  expect(screen.getByText('复制失败')).toBeTruthy()
  act(() => {
    vi.advanceTimersByTime(2500)
  })
  expect(screen.queryByText('复制失败')).toBeNull()
  expect(screen.getByRole('textbox', { name: /OpenAI.*手动复制/ })).toBe(fallbackInput)
  expect(fallbackInput.value).toBe('http://localhost:3000/custom/service/root/antigravity/v1')
})

it('shows labelled readonly fallback with exact current GCLI URL when clipboard.writeText rejects', async () => {
  document.head.innerHTML = '<meta name="gcli-service-base" content="/">'
  setSessionToken('synthetic-overview-token', false)
  navigatePanel('overview', 'geminicli')

  const writeTextMock = vi.fn().mockRejectedValue(new Error('Permission denied'))
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: writeTextMock },
    configurable: true,
    writable: true,
  })

  vi.mocked(useOverview).mockReturnValue({
    data: overviewFixture,
    loading: false,
    refresh: vi.fn(),
    nodeData: {
      version: { value: { version: '2.0.0', display_version: 'v2.0.0' }, issue: null },
      codeAssistEndpoint: { value: 'http://localhost:3000/code-assist', issue: null },
    },
    nodeLoading: false,
    refreshNode: vi.fn(),
  })

  render(
    <PanelChannelProvider>
      <OverviewPage />
    </PanelChannelProvider>
  )

  const copyGeminiBtn = screen.getByRole('button', { name: '复制 Gemini 服务地址' })
  await act(async () => {
    fireEvent.click(copyGeminiBtn)
    await Promise.resolve()
  })

  expect(writeTextMock).toHaveBeenCalledWith('http://localhost:3000/')

  const fallbackInput = screen.getByRole('textbox', {
    name: /Gemini.*手动复制/,
  }) as HTMLInputElement
  expect(fallbackInput).toBeTruthy()
  expect(fallbackInput.readOnly).toBe(true)
  expect(fallbackInput.value).toBe('http://localhost:3000/')
  expect(fallbackInput.value).not.toContain('antigravity')
  expect(fallbackInput.value).not.toContain('secret')
  expect(fallbackInput.value).not.toContain('password')
  expect(fallbackInput.value).not.toContain('token')

  const geminiLink = screen.getByRole('link', { name: '打开 Gemini 服务地址' })
  expect(geminiLink.getAttribute('href')).toBe('http://localhost:3000/')
  expect(geminiLink.getAttribute('target')).toBe('_blank')
  expect(geminiLink.getAttribute('rel')).toContain('noopener')
  expect(geminiLink.getAttribute('rel')).toContain('noreferrer')
})

it('ignores deferred rejection after route and channel transition and allows subsequent successful copy', async () => {
  document.head.innerHTML = '<meta name="gcli-service-base" content="/">'
  setSessionToken('synthetic-overview-token', false)
  navigatePanel('overview', 'antigravity')

  let rejectDeferredCopy!: (err: unknown) => void
  const deferredPromise = new Promise<void>((_, reject) => {
    rejectDeferredCopy = reject
  })
  const writeTextMock = vi.fn().mockImplementation(() => deferredPromise)

  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: writeTextMock },
    configurable: true,
    writable: true,
  })

  vi.mocked(useOverview).mockReturnValue({
    data: overviewFixture,
    loading: false,
    refresh: vi.fn(),
    nodeData: {
      version: { value: { version: '1.0.0', display_version: 'v1.0.0' }, issue: null },
      codeAssistEndpoint: { value: 'http://localhost:3000/code-assist', issue: null },
    },
    nodeLoading: false,
    refreshNode: vi.fn(),
  })

  render(
    <PanelChannelProvider>
      <OverviewPage />
    </PanelChannelProvider>
  )

  const agCopyBtn = screen.getByRole('button', { name: '复制 OpenAI 服务地址' })
  fireEvent.click(agCopyBtn)
  expect(writeTextMock).toHaveBeenCalledWith('http://localhost:3000/antigravity/v1')

  act(() => {
    navigatePanel('overview', 'geminicli')
  })

  await act(async () => {
    rejectDeferredCopy(new Error('Deferred copy failure from previous mode'))
    await Promise.resolve()
  })

  expect(screen.queryByRole('textbox', { name: /手动复制/ })).toBeNull()
  expect(screen.queryByText('复制失败')).toBeNull()

  writeTextMock.mockResolvedValueOnce(undefined)
  const gcliCopyBtn = screen.getByRole('button', { name: '复制 OpenAI 服务地址' })
  await act(async () => {
    fireEvent.click(gcliCopyBtn)
    await Promise.resolve()
  })

  expect(writeTextMock).toHaveBeenLastCalledWith('http://localhost:3000/v1')
  expect(screen.getByText('已复制')).toBeTruthy()
  expect(screen.queryByRole('textbox', { name: /手动复制/ })).toBeNull()

  // Trigger a copy failure so a manual-copy fallback is actively present.
  writeTextMock.mockRejectedValueOnce(new Error('Manual copy fallback triggered'))
  await act(async () => {
    fireEvent.click(gcliCopyBtn)
    await Promise.resolve()
  })

  const manualFallback = screen.getByRole('textbox', { name: /OpenAI.*手动复制/ }) as HTMLInputElement
  expect(manualFallback).toBeTruthy()
  expect(manualFallback.value).toBe('http://localhost:3000/v1')
  expect(screen.getByText('复制失败')).toBeTruthy()

  // Revoking validation clears the already-present fallback, copy status and timer immediately.
  const sessionEpoch = getSessionSnapshot().sessionEpoch
  act(() => {
    expect(__setSessionValidationStatus(sessionEpoch, 'unavailable')).toBe(true)
  })

  expect(screen.queryByRole('textbox', { name: /手动复制/ })).toBeNull()
  expect(screen.queryByText('复制失败')).toBeNull()

  // Reverifying does not restore the previous fallback.
  act(() => {
    expect(__setSessionValidationStatus(sessionEpoch, 'verified')).toBe(true)
  })

  expect(screen.queryByRole('textbox', { name: /手动复制/ })).toBeNull()

  // Start a pending clipboard copy with deferred settlement before revocation.
  let rejectPostReverifyDeferredCopy!: (err: unknown) => void
  const postReverifyDeferredPromise = new Promise<void>((_, reject) => {
    rejectPostReverifyDeferredCopy = reject
  })
  writeTextMock.mockImplementationOnce(() => postReverifyDeferredPromise)

  fireEvent.click(gcliCopyBtn)
  expect(writeTextMock).toHaveBeenLastCalledWith('http://localhost:3000/v1')

  // Validation is revoked and reverified while the copy operation is pending.
  act(() => {
    expect(__setSessionValidationStatus(sessionEpoch, 'unavailable')).toBe(true)
  })
  act(() => {
    expect(__setSessionValidationStatus(sessionEpoch, 'verified')).toBe(true)
  })

  // The stale deferred copy rejects after reverify.
  await act(async () => {
    rejectPostReverifyDeferredCopy(new Error('Deferred copy failure after reverify'))
    await Promise.resolve()
  })

  // Ownership mismatch prevents setting old fallback, status, or taking focus.
  expect(screen.queryByRole('textbox', { name: /手动复制/ })).toBeNull()
  expect(screen.queryByText('复制失败')).toBeNull()
  expect(document.activeElement).not.toBe(manualFallback)

  // A fresh copy dispatch under the reverified identity succeeds.
  writeTextMock.mockResolvedValueOnce(undefined)
  await act(async () => {
    fireEvent.click(gcliCopyBtn)
    await Promise.resolve()
  })

  expect(writeTextMock).toHaveBeenLastCalledWith('http://localhost:3000/v1')
  expect(screen.getByText('已复制')).toBeTruthy()
  expect(screen.queryByRole('textbox', { name: /手动复制/ })).toBeNull()
})
