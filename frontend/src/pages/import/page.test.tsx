import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
  it('does not call a backend or establish a WebSocket before explicit submission', async () => {
    const user = userEvent.setup()
    render(<ImportPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh token' }))
    fireEvent.change(screen.getByLabelText('Refresh token（每行一个）'), {
      target: { value: 'synthetic-token' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'JSON / ZIP 文件' }))
    await user.upload(screen.getByLabelText('选择导入文件'), new File(['{}'], 'example.json'))
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

  it.each(['logout', 'authenticated replacement'] as const)(
    'clears sensitive drafts and the native file input on %s, allowing the same file to be selected again',
    async transition => {
      const user = userEvent.setup()
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
      const file = new File(['{}'], 'example.json', { type: 'application/json' })
      // userEvent.upload preserves the browser relationship between files and value.
      // fireEvent.change({ target: { files } }) replaces files with an unrelated own property.
      await user.upload(input, file)
      expect(screen.getByText(/已选文件 \(1\)/)).toBeInTheDocument()
      expect(input.files).toHaveLength(0)
      expect(input.value).toBe('')
      const submit = screen.getByRole('button', { name: '上传并导入' })
      expect(submit).toBeEnabled()

      act(() => {
        auth.authenticated = transition !== 'logout'
        setSessionToken(transition === 'logout' ? null : 'synthetic-replacement-token')
        auth.sessionEpoch = getSessionSnapshot().sessionEpoch
      })
      view.rerender(<ImportPage />)

      await waitFor(() => expect(screen.getByText(/已选文件 \(0\)/)).toBeInTheDocument())
      expect(screen.getByLabelText('选择导入文件')).toBe(input)
      expect(input.files).toHaveLength(0)
      expect(input.value).toBe('')
      expect(screen.queryByText('example.json')).not.toBeInTheDocument()
      expect(submit).toBeDisabled()
      await user.click(submit)
      expect(requestJson).not.toHaveBeenCalled()

      if (transition === 'logout') {
        act(() => {
          auth.authenticated = true
          setSessionToken('synthetic-next-session-token')
          auth.sessionEpoch = getSessionSnapshot().sessionEpoch
        })
        view.rerender(<ImportPage />)
      }
      expect(submit).toBeDisabled()
      await user.click(submit)
      expect(requestJson).not.toHaveBeenCalled()
      // Reuse the same DOM node and File object so a stale native selection cannot hide here.
      expect(screen.getByLabelText('选择导入文件')).toBe(input)
      await user.upload(input, file)
      expect(screen.getByText(/已选文件 \(1\)/)).toBeInTheDocument()
      expect(submit).toBeEnabled()
      expect(input.files).toHaveLength(0)
      expect(input.value).toBe('')
      fireEvent.click(screen.getByRole('button', { name: 'Refresh token' }))
      expect((screen.getByLabelText('Refresh token（每行一个）') as HTMLTextAreaElement).value).toBe('')
      expect((screen.getByLabelText('Client secret（可选）') as HTMLInputElement).value).toBe('')
      fireEvent.click(screen.getByRole('button', { name: 'OAuth 授权' }))
      expect((screen.getByLabelText('回调 URL（可选，含敏感授权码）') as HTMLInputElement).value).toBe('')
      expect(requestJson).not.toHaveBeenCalled()
    },
  )

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
