import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { PanelMode } from '@/domain/panel'
import { CredentialDetail } from './CredentialDetail'
import type { createCredentialApi } from './api'
import { CAP, CAP_BY_MODE, manualResult, type Outcome } from './model'

const row = { filename: 'detail-synthetic.json', disabled: false, permanent_disabled: false, remark: '' }
const caps = new Set(Object.values(CAP))
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
const outcome = (kind: Outcome['kind']): Outcome => ({ kind, succeeded: kind === 'success' ? 1 : kind === 'partial' ? 1 : null, failed: kind === 'partial' ? 1 : null, total: kind === 'partial' ? 2 : 1, message: kind === 'partial' ? '成功 1 / 2，失败 1。' : '安全动作摘要。' })
function props(action = vi.fn(async () => outcome('success'))) {
  return { row, caps, close: vi.fn(), restoreFocus: vi.fn(), busy: false, action, beforeManual: vi.fn(), afterManual: vi.fn(), captureTask: () => () => true, revoke: vi.fn(() => false) }
}

describe('detail action feedback lifecycle', () => {
  it.each([
    ['success', '操作成功'], ['partial', '部分成功'], ['unknown', '结果未知'], ['rejected', '操作失败'],
  ] as const)('announces %s in the portaled drawer rather than its hidden parent', async (kind, label) => {
    const pending = deferred<Outcome>()
    const action = vi.fn(() => pending.promise)
    render(<CredentialDetail {...props(action)} />)
    const drawer = within(screen.getByRole('dialog'))
    const status = drawer.getByRole('status', { name: '凭证操作状态' })
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(status).toHaveAttribute('aria-atomic', 'true')
    fireEvent.click(drawer.getByRole('button', { name: '启用' }))
    expect(status).toHaveTextContent('正在执行凭证操作')
    expect(drawer.getByRole('button', { name: '禁用' })).toBeDisabled()
    await act(async () => pending.resolve(outcome(kind)))
    expect(status).toHaveTextContent(label)
    if (kind === 'partial') expect(status).toHaveTextContent('失败 1')
    expect(action).toHaveBeenCalledTimes(1)
  })

  it('does not let a completion from a previous detail instance update its replacement', async () => {
    const pending = deferred<Outcome>()
    const old = props(vi.fn(() => pending.promise))
    const { rerender } = render(<CredentialDetail key="old" {...old} />)
    fireEvent.click(screen.getByRole('button', { name: '启用' }))
    rerender(<CredentialDetail key="new" {...props()} row={{ ...row, filename: 'new-detail.json' }} />)
    await act(async () => pending.resolve(outcome('success')))
    expect(screen.getByRole('status', { name: '凭证操作状态' })).toBeEmptyDOMElement()
    expect(screen.getByRole('heading', { name: 'new-detail.json' })).toBeInTheDocument()
  })

  it('discards completion after the task scope is withdrawn', async () => {
    const pending = deferred<Outcome>(); let current = true
    render(<CredentialDetail {...props(vi.fn(() => pending.promise))} captureTask={() => () => current} />)
    fireEvent.click(screen.getByRole('button', { name: '启用' }))
    current = false
    await act(async () => pending.resolve(outcome('success')))
    expect(screen.getByRole('status', { name: '凭证操作状态' })).not.toHaveTextContent('操作成功')
  })

  it('keeps delete success visible and disables further writes until the user closes', async () => {
    const p = props()
    render(<CredentialDetail {...p} />)
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    await waitFor(() => expect(screen.getByRole('status', { name: '凭证操作状态' })).toHaveTextContent('操作成功'))
    expect(screen.getByText('该凭证已删除，关闭后可返回列表。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '启用' })).toBeDisabled()
    expect(p.close).not.toHaveBeenCalled()
  })
})

describe('mode presentation, capability binding, and dismissal regressions', () => {
  it('binds permanent-disable and remark capabilities to CAP_BY_MODE[mode]', async () => {
    const action = vi.fn(async () => outcome('success'))
    const gcliCaps = new Set<string>([CAP_BY_MODE.geminicli.permanent, CAP_BY_MODE.geminicli.remark])
    const p1 = { ...props(action), caps: gcliCaps, mode: 'geminicli' as PanelMode }
    const { rerender } = render(<CredentialDetail {...p1} />)

    const permBtn = screen.getByRole('button', { name: '永久禁用' })
    expect(permBtn).not.toBeDisabled()
    const remarkInput = screen.getByLabelText('备注')
    expect(remarkInput).not.toBeDisabled()
    const saveRemarkBtn = screen.getByRole('button', { name: '保存备注' })
    expect(saveRemarkBtn).not.toBeDisabled()
    expect(screen.queryByText('服务未声明备注编辑能力，仅可查看。')).not.toBeInTheDocument()

    fireEvent.click(permBtn)
    fireEvent.click(screen.getByRole('button', { name: '确认永久禁用' }))
    await waitFor(() => expect(action).toHaveBeenCalledWith(['detail-synthetic.json'], 'permanent_disable', undefined))

    fireEvent.change(remarkInput, { target: { value: 'gcli-remark' } })
    fireEvent.click(saveRemarkBtn)
    await waitFor(() => expect(action).toHaveBeenCalledWith(['detail-synthetic.json'], 'remark', 'gcli-remark'))

    const agOnlyCaps = new Set<string>([CAP_BY_MODE.antigravity.permanent, CAP_BY_MODE.antigravity.remark])
    rerender(<CredentialDetail {...props(action)} caps={agOnlyCaps} mode="geminicli" />)

    expect(screen.getByRole('button', { name: '永久禁用' })).toBeDisabled()
    expect(screen.getByLabelText('备注')).toBeDisabled()
    expect(screen.getByRole('button', { name: '保存备注' })).toBeDisabled()
    expect(screen.getByText('服务未声明备注编辑能力，仅可查看。')).toBeInTheDocument()
  })

  it('hides the entire credit section in geminicli mode and preserves AG credit behavior', async () => {
    const action = vi.fn(async () => outcome('success'))
    const credRow = { ...row, enable_credit: true }
    const capsWithCredit = new Set<string>([CAP.credit])

    const { rerender } = render(<CredentialDetail {...props(action)} row={credRow} caps={capsWithCredit} mode="geminicli" />)
    expect(screen.queryByText(/信用额度/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /信用额度/ })).not.toBeInTheDocument()
    expect(screen.queryByText('服务未声明信用额度开关能力。')).not.toBeInTheDocument()

    rerender(<CredentialDetail {...props(action)} row={credRow} caps={capsWithCredit} mode="antigravity" />)
    expect(screen.getByText('信用额度：开启')).toBeInTheDocument()
    const toggleCreditBtn = screen.getByRole('button', { name: '关闭信用额度' })
    expect(toggleCreditBtn).not.toBeDisabled()
    fireEvent.click(toggleCreditBtn)
    fireEvent.click(screen.getByRole('button', { name: '确认关闭信用额度' }))
    await waitFor(() => expect(action).toHaveBeenCalledWith(['detail-synthetic.json'], 'disable_credit', undefined))

    rerender(<CredentialDetail {...props(action)} row={credRow} caps={new Set()} mode="antigravity" />)
    expect(screen.getByText('信用额度：开启')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '关闭信用额度' })).toBeDisabled()
    expect(screen.getByText('服务未声明信用额度开关能力。')).toBeInTheDocument()

    rerender(<CredentialDetail {...props(action)} row={{ ...row, enable_credit: undefined }} caps={capsWithCredit} mode="antigravity" />)
    expect(screen.getByText('信用额度：未知')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '开启信用额度' })).toBeDisabled()
  })

  it('supports Sheet dismissal and passes mode without triggering automatic network or manual operations', async () => {
    const p = props()
    const mockErrors = vi.fn(async () => ({}))
    const mockManual = vi.fn(async () => manualResult({
      success: true,
      status_code: 200,
      verified_reply: true,
      state_update: {
        quota: { status: 'applied' },
        'claude-gpt-shared': { status: 'applied' },
      },
    }))
    const mockCredentialApi = {
      errors: mockErrors,
      manual: mockManual,
    } as unknown as ReturnType<typeof createCredentialApi>

    const { rerender } = render(<CredentialDetail {...p} credentialApi={mockCredentialApi} />)

    expect(screen.getByText(/Opus 5.5：/)).toBeInTheDocument()
    expect(mockErrors).not.toHaveBeenCalled()
    expect(mockManual).not.toHaveBeenCalled()
    expect(p.action).not.toHaveBeenCalled()
    expect(p.beforeManual).not.toHaveBeenCalled()
    expect(p.afterManual).not.toHaveBeenCalled()

    rerender(<CredentialDetail {...p} mode="geminicli" credentialApi={mockCredentialApi} />)
    expect(screen.queryByText(/Opus 5.5：/)).not.toBeInTheDocument()
    expect(mockErrors).not.toHaveBeenCalled()
    expect(mockManual).not.toHaveBeenCalled()
    expect(p.action).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '刷新额度并同步状态' }))
    expect(p.beforeManual).toHaveBeenCalledTimes(1)
    expect(mockManual).toHaveBeenCalledWith('detail-synthetic.json', 'quota', 'gemini-2.5-flash')
    await waitFor(() => expect(screen.getByLabelText('人工操作结果')).toBeInTheDocument())
    expect(screen.getByText('quota：applied')).toBeInTheDocument()
    expect(screen.queryByText('claude-gpt-shared：applied')).not.toBeInTheDocument()
    expect(p.afterManual).toHaveBeenCalledTimes(1)

    const closeBtn = screen.getByRole('button', { name: 'Close' })
    fireEvent.click(closeBtn)
    expect(p.close).toHaveBeenCalledTimes(1)
    expect(mockErrors).not.toHaveBeenCalled()
    expect(mockManual).toHaveBeenCalledTimes(1)
  })
})
