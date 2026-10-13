// This store contains booleans only. Non-sensitive carried drafts remain owned
// by useSettings, so refresh protection can survive an internal hash navigation.
type Source = 'configuration' | 'configuration-secrets' | 'management-token';
const dirty = new Set<Source>();
const listeners = new Set<() => void>();
const discarders = new Set<(scope: 'all' | 'secrets') => void>();
const beforeUnload = (event: BeforeUnloadEvent) => {
  if (!dirty.size) return;
  event.preventDefault();
  event.returnValue = '';
};
export const hasExitChanges = () => dirty.size > 0;
export const hasSecretExitChanges = () => dirty.has('configuration-secrets') || dirty.has('management-token');
export function setExitDirty(source: Source, value: boolean) {
  const previous = dirty.has(source), wasActive = hasExitChanges();
  if (value) dirty.add(source); else dirty.delete(source);
  if (previous === value) return;
  if (!wasActive && hasExitChanges()) window.addEventListener('beforeunload', beforeUnload);
  if (wasActive && !hasExitChanges()) window.removeEventListener('beforeunload', beforeUnload);
  listeners.forEach(listener => listener());
}
export function subscribeExitChanges(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function registerExitDiscard(discard: (scope: 'all' | 'secrets') => void) {
  discarders.add(discard);
  return () => { discarders.delete(discard); };
}
export function discardExitChanges(scope: 'all' | 'secrets' = 'all') {
  discarders.forEach(discard => discard(scope));
  if (scope === 'all') setExitDirty('configuration', false);
  setExitDirty('configuration-secrets', false);
  setExitDirty('management-token', false);
}
export function leavesDocument(anchor: HTMLAnchorElement, event: MouseEvent): boolean {
  if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || anchor.hasAttribute('download')) return false;
  if (anchor.target && anchor.target.toLowerCase() !== '_self') return false;
  const destination = new URL(anchor.href, location.href), current = new URL(location.href);
  if (!['http:', 'https:'].includes(destination.protocol)) return false;
  // Same-document hash routes retain the settings draft in memory.
  return !(destination.origin === current.origin && destination.pathname === current.pathname && destination.search === current.search && destination.hash);
}
export function navigateFromSettings(href: string) { window.location.assign(href); }
