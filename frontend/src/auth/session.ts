/** React-free session bridge. Never log tokens. */
export const AUTH_STORAGE_KEY = "gcli2api_auth_token";
export type SessionSnapshot = { token: string | null; sessionEpoch: number };
let snapshot: SessionSnapshot | undefined;
const listeners = new Set<() => void>();
const cleanups = new Set<() => void>();
function storedToken(): string | null {
  try { return window.localStorage.getItem(AUTH_STORAGE_KEY) || null; }
  catch { return null; }
}
export function getSessionSnapshot(): SessionSnapshot {
  return snapshot ??= { token: storedToken(), sessionEpoch: 0 };
}
export function subscribeSession(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
/** Register read-cache / polling / socket disposal. Drafts remain page-owned. */
export function registerSessionCleanup(cleanup: () => void) {
  cleanups.add(cleanup);
  return () => { cleanups.delete(cleanup); };
}
export function setSessionToken(token: string | null, persist = true) {
  snapshot = { token, sessionEpoch: getSessionSnapshot().sessionEpoch + 1 };
  if (persist) {
    try {
      if (token === null) window.localStorage.removeItem(AUTH_STORAGE_KEY);
      else window.localStorage.setItem(AUTH_STORAGE_KEY, token);
    } catch { /* in-memory snapshot remains authoritative */ }
  }
  for (const cleanup of cleanups) { try { cleanup(); } catch { /* continue other readers */ } }
  for (const listener of listeners) listener();
}
export function invalidateSession(epoch: number) {
  const current = getSessionSnapshot();
  if (current.sessionEpoch === epoch && current.token !== null) setSessionToken(null);
}
export function syncSessionFromStorage(event: StorageEvent) {
  if (event.key !== AUTH_STORAGE_KEY && event.key !== null) return;
  let token: string | null;
  try {
    if (event.storageArea && event.storageArea !== window.localStorage) return;
    // Events can be delayed: read the latest persisted value instead of replaying newValue.
    token = window.localStorage.getItem(AUTH_STORAGE_KEY) || null;
  } catch { return; /* unavailable storage must not overwrite a valid memory session */ }
  if (token !== getSessionSnapshot().token) setSessionToken(token, false);
}
