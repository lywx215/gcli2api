export type DetailTrigger = 'desktop-name' | 'desktop-detail' | 'mobile-detail'

function available(element: HTMLElement) {
  if (!element.isConnected || (element instanceof HTMLButtonElement && element.disabled)) return false
  for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor.hidden || ancestor.hasAttribute('inert')) return false
    const style = getComputedStyle(ancestor)
    if (style.display === 'none' || style.visibility === 'hidden') return false
  }
  return true
}

/** Called by Radix after its focus scope closes; never retain an old row node. */
export function restoreCredentialFocus(root: HTMLElement | null, filename: string, preferred: DetailTrigger, fallback: HTMLElement | null) {
  if (!root?.isConnected) return
  const candidates = Array.from(root.querySelectorAll<HTMLButtonElement>('button[data-credential-filename]'))
    .filter(button => button.dataset.credentialFilename === filename && available(button))
  const target = candidates.find(button => button.dataset.credentialTrigger === preferred) ?? candidates[0]
  if (target) {
    target.focus()
    if (document.activeElement === target) return
  }
  if (fallback && root.contains(fallback) && available(fallback)) fallback.focus()
}
