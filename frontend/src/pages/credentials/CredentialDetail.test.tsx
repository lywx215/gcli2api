import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CredentialDetail } from './CredentialDetail'
import { CAP, type Outcome } from './model'

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
