import { getSessionSnapshot, registerSessionCleanup } from "@/auth/session";

export type PanelMode = "antigravity" | "geminicli";

export const PANEL_MODES: readonly PanelMode[] = Object.freeze(["antigravity", "geminicli"] as const);

export function isPanelMode(value: unknown): value is PanelMode {
  return value === "antigravity" || value === "geminicli";
}

export type PanelChannelSnapshot = {
  readonly mode: PanelMode;
  readonly channelEpoch: number;
};

export type PanelScope = {
  readonly mode: PanelMode;
  readonly channelEpoch: number;
  readonly sessionEpoch: number;
};

export type CredentialChange = {
  readonly mode: PanelMode;
  readonly sessionEpoch: number;
  readonly filenames?: readonly string[];
};

export function credentialIdentityKey(mode: PanelMode, filename: string): string {
  if (!isPanelMode(mode)) {
    throw new TypeError(`Invalid panel mode: ${String(mode)}`);
  }
  if (typeof filename !== "string") {
    throw new TypeError("Filename must be a string");
  }
  return JSON.stringify([mode, filename]);
}

let currentSnapshot: PanelChannelSnapshot = Object.freeze({
  mode: "antigravity",
  channelEpoch: 0,
});

const channelListeners = new Set<() => void>();
const channelCleanups = new Set<() => void>();
const credentialListeners = new Set<(change: CredentialChange) => void>();

function runCleanups(): void {
  for (const cleanup of Array.from(channelCleanups)) {
    try {
      cleanup();
    } catch {
      // Isolate cleanup exceptions
    }
  }
}

function notifyChannelListeners(): void {
  for (const listener of Array.from(channelListeners)) {
    try {
      listener();
    } catch {
      // Isolate listener exceptions
    }
  }
}

export function getPanelChannelSnapshot(): PanelChannelSnapshot {
  return currentSnapshot;
}

export function subscribePanelChannel(listener: () => void): () => void {
  if (typeof listener !== "function") {
    return () => {};
  }
  channelListeners.add(listener);
  return () => {
    channelListeners.delete(listener);
  };
}

export function registerChannelCleanup(cleanup: () => void): () => void {
  if (typeof cleanup !== "function") {
    return () => {};
  }
  channelCleanups.add(cleanup);
  return () => {
    channelCleanups.delete(cleanup);
  };
}

export function capturePanelScope(sessionEpoch: number): PanelScope {
  const current = currentSnapshot;
  return Object.freeze({
    mode: current.mode,
    channelEpoch: current.channelEpoch,
    sessionEpoch,
  });
}

export function isPanelScopeCurrent(scope: PanelScope, currentSessionEpoch: number): boolean {
  if (!scope || typeof scope !== "object") {
    return false;
  }
  const current = currentSnapshot;
  return (
    scope.mode === current.mode &&
    scope.channelEpoch === current.channelEpoch &&
    scope.sessionEpoch === currentSessionEpoch
  );
}

function extractBasename(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.endsWith("/") || trimmed.endsWith("\\")) return null;
  const parts = trimmed.split(/[/\\]/);
  const base = parts[parts.length - 1]?.trim();
  if (!base || base === "." || base === "..") return null;
  return base;
}

export function notifyCredentialChange(change: CredentialChange): void {
  if (!change || typeof change !== "object") {
    return;
  }
  if (!isPanelMode(change.mode)) {
    return;
  }
  if (
    typeof change.sessionEpoch !== "number" ||
    !Number.isInteger(change.sessionEpoch) ||
    change.sessionEpoch < 0
  ) {
    return;
  }

  // Drop stale-session events
  const currentSessionEpoch = getSessionSnapshot().sessionEpoch;
  if (change.sessionEpoch !== currentSessionEpoch) {
    return;
  }

  let sanitizedFilenames: readonly string[] | undefined = undefined;
  if (change.filenames !== undefined) {
    if (!Array.isArray(change.filenames)) {
      return;
    }
    const seen = new Set<string>();
    for (const item of change.filenames) {
      const name = extractBasename(item);
      if (name) {
        seen.add(name);
        if (seen.size >= 5000) {
          break;
        }
      }
    }
    sanitizedFilenames = Object.freeze(Array.from(seen));
  }

  const cleanEvent: CredentialChange = Object.freeze({
    mode: change.mode,
    sessionEpoch: change.sessionEpoch,
    ...(sanitizedFilenames !== undefined ? { filenames: sanitizedFilenames } : {}),
  });

  for (const listener of Array.from(credentialListeners)) {
    try {
      listener(cleanEvent);
    } catch {
      // Isolate listener exceptions
    }
  }
}

export function subscribeCredentialChanges(listener: (change: CredentialChange) => void): () => void {
  if (typeof listener !== "function") {
    return () => {};
  }
  credentialListeners.add(listener);
  return () => {
    credentialListeners.delete(listener);
  };
}

export function __commitPanelChannel(mode: PanelMode): void {
  if (!isPanelMode(mode)) {
    throw new TypeError(`Invalid panel mode: ${String(mode)}`);
  }
  if (mode === currentSnapshot.mode) {
    return;
  }
  const nextEpoch = currentSnapshot.channelEpoch + 1;
  const nextSnapshot: PanelChannelSnapshot = Object.freeze({
    mode,
    channelEpoch: nextEpoch,
  });

  // Synchronous cleanup before publishing
  runCleanups();

  // Publish new snapshot
  currentSnapshot = nextSnapshot;

  // Notify listeners
  notifyChannelListeners();
}

export function __invalidatePanelChannel(): void {
  const nextEpoch = currentSnapshot.channelEpoch + 1;
  const nextSnapshot: PanelChannelSnapshot = Object.freeze({
    mode: currentSnapshot.mode,
    channelEpoch: nextEpoch,
  });

  // Synchronous cleanup before publishing
  runCleanups();

  // Publish new snapshot
  currentSnapshot = nextSnapshot;

  // Notify listeners
  notifyChannelListeners();
}

// Session cleanup integrates once and invalidates channel scope without resetting mode.
let sessionCleanupRegistered = false;
function initSessionIntegration(): void {
  if (!sessionCleanupRegistered) {
    sessionCleanupRegistered = true;
    registerSessionCleanup(() => {
      __invalidatePanelChannel();
    });
  }
}
initSessionIntegration();
