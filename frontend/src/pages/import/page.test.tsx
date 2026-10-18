import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, requestJson } from '@/api/client'
import { getSessionSnapshot, setSessionToken, __setSessionValidationStatus } from '@/auth/session'
import { getPanelChannelSnapshot, __commitPanelChannel } from '@/domain/panel'
import ImportPage from './index'

const auth = vi.hoisted(() => ({ authenticated: true, sessionEpoch: 1 }))
vi.mock('@/auth', () => ({ useAuth: () => auth }))
vi.mock('@/api/client', () => ({
  getServiceBase: () => 'http://localhost:3000/',
  requestJson: vi.fn(),
  ApiError: class extends Error {
    constructor(public status: number, public payload: unknown) {
      super('safe')
    }
  },
}))

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('VITE_UI_FIXTURES', 'false')
  auth.authenticated = true
  auth.sessionEpoch = 1
  if (getPanelChannelSnapshot().mode !== 'antigravity') {
    __commitPanelChannel('antigravity')
  }
  setSessionToken('synthetic-token')
  const session = getSessionSnapshot()
  __setSessionValidationStatus(session.sessionEpoch, 'verified')
  vi.stubGlobal('WebSocket', vi.fn())
})

describe('Import page interactions', () => {
  it('does not call a backend or establish a WebSocket before explicit submission', () => {
    render(<ImportPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh token' }))
    fireEvent.change(screen.getByLabelText('Refresh token（每行一个）'), {
      target: { value: 'synthetic-token' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'JSON / ZIP 文件' }))
    fireEvent.change(screen.getByLabelText('选择导入文件'), {
      target: { files: [new File(['{}'], 'example.json')] },
    })
    expect(requestJson).not.toHaveBeenCalled()
    expect(WebSocket).not.toHaveBeenCalled()
    expect(
      screen.getByRole('link', { name: '旧 AG 面板：手动获取邮箱与高级工具' }),
    ).toHaveAttribute('href', 'http://localhost:3000/legacy#antigravity-manage')
  })

  it('keeps a manual-project 400 in the flow and continues only after a second click', async () => {
    vi.mocked(requestJson)
      .mockResolvedValueOnce({
        auth_url: 'https://accounts.google.com/o/oauth2/auth?state=synthetic',
      })
      .mockResolvedValueOnce({ panel_capabilities: ['antigravity.oauth.safe_response'] })
      .mockRejectedValueOnce(new ApiError(400, { requires_manual_project_id: true }))
      .mockResolvedValueOnce({ panel_capabilities: ['antigravity.oauth.safe_response'] })
      .mockResolvedValueOnce({
        success: true,
        mode: 'antigravity',
        filename: 'example.json',
        project_id: 'project-example',
        subscription_tier: null,
        auto_detected_project: false,
        credentials: { secret: 'synthetic-hidden' },
      })

    render(<ImportPage />)
    fireEvent.click(screen.getByRole('button', { name: '生成授权链接' }))
    await screen.findByRole('link', { name: '打开 Google 授权页面' })
    fireEvent.click(screen.getByRole('button', { name: '完成授权' }))
    await screen.findByText('需要手动填写项目 ID')
    fireEvent.change(screen.getByLabelText('项目 ID（可选，留空自动检测）'), {
      target: { value: 'project-example' },
    })
    expect(requestJson).toHaveBeenCalledTimes(3)
    fireEvent.click(screen.getByRole('button', { name: '完成授权' }))
    await screen.findByText('全部成功')
    expect(vi.mocked(requestJson).mock.calls[4]).toMatchObject([
      'auth/callback',
      { body: { mode: 'antigravity', project_id: 'project-example', include_credentials: false } },
    ])
    expect(document.body.textContent).not.toContain('synthetic-hidden')
  })

  it('clears callback, tokens, client secret and selected files across session changes', async () => {
    const view = render(<ImportPage />)
    fireEvent.change(screen.getByLabelText('回调 URL（可选，含敏感授权码）'), {
      target: { value: 'http://localhost/?code=synthetic' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh token' }))
    fireEvent.change(screen.getByLabelText('Refresh token（每行一个）'), {
      target: { value: 'synthetic-token' },
    })
    fireEvent.change(screen.getByLabelText('Client secret（可选）'), {
      target: { value: 'synthetic-secret' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'JSON / ZIP 文件' }))
    const input = screen.getByLabelText('选择导入文件') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['{}'], 'example.json')] } })
    expect(screen.getByText(/已选文件 \(1\)/)).toBeTruthy()

    auth.authenticated = false
    auth.sessionEpoch++
    setSessionToken(null)
    view.rerender(<ImportPage />)

    await waitFor(() => expect(screen.getByText(/已选文件 \(0\)/)).toBeTruthy())
    expect((screen.getByLabelText('选择导入文件') as HTMLInputElement).files).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh token' }))
    expect((screen.getByLabelText('Refresh token（每行一个）') as HTMLTextAreaElement).value).toBe('')
    expect((screen.getByLabelText('Client secret（可选）') as HTMLInputElement).value).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'OAuth 授权' }))
    expect((screen.getByLabelText('回调 URL（可选，含敏感授权码）') as HTMLInputElement).value).toBe('')
    expect(requestJson).not.toHaveBeenCalled()
  })

  it('ignores an old email response after a new explicit import begins', async () => {
    let resolveEmail!: (value: unknown) => void
    const oldEmail = new Promise(resolve => {
      resolveEmail = resolve
    })
    const inventedJobId = '0123456789abcdef0123456789abcdef'
    vi.mocked(requestJson)
      .mockResolvedValueOnce({ panel_capabilities: ['antigravity.oauth.safe_response'] })
      .mockResolvedValueOnce({
        success: true,
        mode: 'antigravity',
        filename: 'example.json',
        project_id: null,
        subscription_tier: null,
        auto_detected_project: false,
        email_enrichment: { job_id: inventedJobId },
      })
      .mockReturnValueOnce(oldEmail)
      .mockResolvedValueOnce({ auth_url: 'https://accounts.google.com/o/oauth2/auth?state=next' })

    render(<ImportPage />)
    fireEvent.change(screen.getByLabelText('回调 URL（可选，含敏感授权码）'), {
      target: { value: 'http://localhost/?code=synthetic' },
    })
    fireEvent.click(screen.getByRole('button', { name: '完成授权' }))
    await waitFor(() => expect(requestJson).toHaveBeenCalledTimes(3))
    const oldSignal = vi.mocked(requestJson).mock.calls[2][1]?.signal

    fireEvent.click(screen.getByRole('button', { name: '生成授权链接' }))
    await screen.findByRole('link', { name: '打开 Google 授权页面' })
    await act(async () => {
      resolveEmail({
        job_id: inventedJobId,
        items: [{ filename: 'old.json', status: 'success', user_email: 'old@example.invalid' }],
        total: 1,
        complete: true,
        sealed: true,
      })
      await oldEmail
    })

    // Under deliberate independent-job semantics, older email jobs are not aborted by new primary imports
    expect(oldSignal?.aborted).toBe(false)
    // Old email job resolution does not overwrite primary receipt or state
    expect(screen.getByRole('link', { name: '打开 Google 授权页面' })).toBeInTheDocument()
    // Old job updates in its own independent panel
    expect(screen.getByText('old@example.invalid')).toBeInTheDocument()
  })
})
