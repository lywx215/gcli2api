/** React-free session bridge. Never log tokens. */
export const AUTH_STORAGE_KEY = "gcli2api_auth_token";

export type SessionSnapshot = { token: string | null; sessionEpoch: number };

export type SessionValidationStatus = "anonymous" | "pending" | "verified" | "unavailable";

export type SessionValidationSnapshot = { sessionEpoch: number; status: SessionValidationStatus };

export type SessionTokenOptions = { requiresValidation?: boolean };

let snapshot: SessionSnapshot | undefined;
let validationSnapshot: SessionValidationSnapshot | undefined;
const listeners = new Set<() => void>();
const validationListeners = new Set<() => void>();
const cleanups = new Set<() => void>();

function storedToken(): string | null {
  try { return window.localStorage.getItem(AUTH_STORAGE_KEY) || null; }
  catch { return null; }
}

function initSnapshots(): void {
  if (!snapshot) {
    const token = storedToken();
    snapshot = { token, sessionEpoch: 0 };
    validationSnapshot = {
      sessionEpoch: 0,
      status: token !== null ? "pending" : "anonymous",
    };
  }
}

export function getSessionSnapshot(): SessionSnapshot {
  initSnapshots();
  return snapshot!;
}

export function getSessionValidationSnapshot(): SessionValidationSnapshot {
  initSnapshots();
  return validationSnapshot!;
}

export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function subscribeSessionValidation(listener: () => void): () => void {
  validationListeners.add(listener);
  return () => { validationListeners.delete(listener); };
}

/** Register read-cache / polling / socket disposal. Drafts remain page-owned. */
export function registerSessionCleanup(cleanup: () => void): () => void {
  cleanups.add(cleanup);
  return () => { cleanups.delete(cleanup); };
}

export function setSessionToken(token: string | null, persist = true, options?: SessionTokenOptions): void {
  const nextEpoch = getSessionSnapshot().sessionEpoch + 1;
  snapshot = { token, sessionEpoch: nextEpoch };

  let nextStatus: SessionValidationStatus;
  if (token === null) {
    nextStatus = "anonymous";
  } else {
    nextStatus = options?.requiresValidation ? "pending" : "verified";
  }
  validationSnapshot = { sessionEpoch: nextEpoch, status: nextStatus };

  if (persist) {
    try {
      if (token === null) window.localStorage.removeItem(AUTH_STORAGE_KEY);
      else window.localStorage.setItem(AUTH_STORAGE_KEY, token);
    } catch { /* in-memory snapshot remains authoritative */ }
  }

  for (const cleanup of Array.from(cleanups)) {
    try { cleanup(); } catch { /* continue other readers */ }
  }

  for (const listener of Array.from(listeners)) {
    listener();
  }
  for (const listener of Array.from(validationListeners)) {
    listener();
  }
}

export function invalidateSession(epoch: number): void {
  const current = getSessionSnapshot();
  if (current.sessionEpoch === epoch && current.token !== null) setSessionToken(null);
}

export function syncSessionFromStorage(event: StorageEvent): void {
  if (event.key !== AUTH_STORAGE_KEY && event.key !== null) return;
  let token: string | null;
  try {
    if (event.storageArea && event.storageArea !== window.localStorage) return;
    // Events can be delayed: read the latest persisted value instead of replaying newValue.
    token = window.localStorage.getItem(AUTH_STORAGE_KEY) || null;
  } catch { return; /* unavailable storage must not overwrite a valid memory session */ }
  if (token !== getSessionSnapshot().token) {
    setSessionToken(token, false, token !== null ? { requiresValidation: true } : undefined);
  }
}

export function __setSessionValidationStatus(epoch: number, status: SessionValidationStatus): boolean {
  initSnapshots();
  const current = snapshot!;
  if (current.sessionEpoch !== epoch) return false;
  if (current.token === null && status !== "anonymous") return false;
  if (current.token !== null && status === "anonymous") return false;
  if (validationSnapshot && validationSnapshot.sessionEpoch === epoch && validationSnapshot.status === status) {
    return true;
  }
  validationSnapshot = { sessionEpoch: epoch, status };
  for (const listener of Array.from(validationListeners)) {
    listener();
  }
  return true;
}

