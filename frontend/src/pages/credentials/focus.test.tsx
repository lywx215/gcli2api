import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { restoreCredentialFocus } from './focus'

function view({ mobile = false, disabled = false, filename = 'synthetic.json' } = {}) {
  render(<section data-testid="root">
    <h1 tabIndex={-1}>凭证列表</h1>
    <div style={{ display: mobile ? 'none' : 'block' }}>
      <button data-credential-filename={filename} data-credential-trigger="desktop-name" disabled={disabled}>文件名</button>
      <button data-credential-filename={filename} data-credential-trigger="desktop-detail" disabled={disabled}>桌面详情</button>
    </div>
    <div style={{ display: mobile ? 'block' : 'none' }}>
      <button data-credential-filename={filename} data-credential-trigger="mobile-detail" disabled={disabled}>手机详情</button>
    </div>
  </section>)
  return { root: screen.getByTestId('root'), title: screen.getByRole('heading') }
}

describe('stable credential focus target', () => {
  it('restores the original filename link when still available', () => {
    const { root, title } = view()
    restoreCredentialFocus(root, 'synthetic.json', 'desktop-name', title)
    expect(screen.getByRole('button', { name: '文件名' })).toHaveFocus()
  })
  it('chooses a visible mobile trigger after a viewport change hides the desktop opener', () => {
    const { root, title } = view({ mobile: true })
    restoreCredentialFocus(root, 'synthetic.json', 'desktop-detail', title)
    expect(screen.getByRole('button', { name: '手机详情' })).toHaveFocus()
  })
  it('never focuses the hidden mobile duplicate on desktop', () => {
    const { root, title } = view()
    restoreCredentialFocus(root, 'synthetic.json', 'mobile-detail', title)
    expect(screen.getByRole('button', { name: '文件名' })).toHaveFocus()
  })
  it('uses the title for disabled or missing rows', () => {
    const { root, title } = view({ disabled: true })
    restoreCredentialFocus(root, 'synthetic.json', 'desktop-detail', title)
    expect(title).toHaveFocus()
    root.querySelectorAll('button').forEach(button => button.remove())
    restoreCredentialFocus(root, 'synthetic.json', 'desktop-detail', title)
    expect(title).toHaveFocus()
  })
  it('compares unusual filename values without interpolating them into selectors', () => {
    const filename = 'synthetic-%-"[]-凭证.json'
    const { root, title } = view({ filename })
    restoreCredentialFocus(root, filename, 'desktop-detail', title)
    expect(screen.getByRole('button', { name: '桌面详情' })).toHaveFocus()
  })
  it('does not steal focus after the workspace becomes inert or disconnected', () => {
    const { root, title } = view()
    const outside = document.createElement('button'); document.body.append(outside); outside.focus()
    root.setAttribute('inert', '')
    restoreCredentialFocus(root, 'synthetic.json', 'desktop-detail', title)
    expect(outside).toHaveFocus()
    const container = root.parentElement!; container.remove()
    restoreCredentialFocus(root, 'synthetic.json', 'desktop-detail', title)
    expect(outside).toHaveFocus()
    document.body.append(container)
    outside.remove()
  })
})
