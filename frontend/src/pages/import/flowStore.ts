import {
  getSessionSnapshot,
  getSessionValidationSnapshot,
  registerSessionCleanup,
  subscribeSession,
  subscribeSessionValidation,
  type SessionValidationSnapshot,
} from "@/auth/session";
import {
  getPanelChannelSnapshot,
  isPanelMode,
  registerChannelCleanup,
  subscribePanelChannel,
  type PanelScope,
} from "@/domain/panel";

export type ImportFlowOwner = Readonly<PanelScope>;
export type FlowOwner = ImportFlowOwner;

export type ImportFlowTaskRecord = Readonly<{
  readonly id: number;
  readonly kind: "oauth" | "email";
  readonly type: "oauth" | "email";
  readonly owner: ImportFlowOwner;
  readonly signal: AbortSignal;
  readonly jobId?: string;
  readonly createdAt: number;
}>;
export type FlowRecord = ImportFlowTaskRecord;

export type ImportFlowTaskHandle = Readonly<{
  readonly id: number;
  readonly kind: "oauth" | "email";
  readonly owner: ImportFlowOwner;
  readonly signal: AbortSignal;
  readonly jobId?: string;
  readonly cancel: () => boolean;
}>;
export type FlowTaskHandle = ImportFlowTaskHandle;

export type ImportFlowSnapshot = Readonly<{
  readonly owner: ImportFlowOwner | null;
  readonly records: readonly FlowRecord[];
  readonly tasks: readonly FlowRecord[];
  readonly generation: number;
}>;
export type FlowStoreSnapshot = ImportFlowSnapshot;
export type FlowSnapshot = FlowStoreSnapshot;

const EMPTY_RECORDS: readonly FlowRecord[] = Object.freeze([]);

let isChannelCleaningUp = false;
let isSessionCleaningUp = false;
let isAborting = false;

let currentIssuedOwner: ImportFlowOwner | null = null;
let currentCapturedValidation: SessionValidationSnapshot | null = null;
const ownerValidationMap = new WeakMap<object, SessionValidationSnapshot>();

let cachedSnapshot: FlowStoreSnapshot | null = null;
let currentGeneration = 0;
let nextTaskId = 1;
const MAX_ACTIVE_RECORDS = 128;

type ActiveEntry = {
  readonly record: FlowRecord;
  readonly handle: FlowTaskHandle;
  readonly controller: AbortController;
};

const activeEntries = new Map<number, ActiveEntry>();
const subscribers = new Set<() => void>();

let isNotifying = false;
let notifyPending = false;

function isRegistrationBlocked(): boolean {
  return isChannelCleaningUp || isSessionCleaningUp || isAborting;
}

function isCurrentSessionVerified(): boolean {
  if (isChannelCleaningUp || isSessionCleaningUp) {
    return false;
  }
  const session = getSessionSnapshot();
  const validation = getSessionValidationSnapshot();
  return (
    session.token !== null &&
    validation.status === "verified" &&
    validation.sessionEpoch === session.sessionEpoch
  );
}

export function getVerifiedFlowOwner(): ImportFlowOwner | null {
  if (isRegistrationBlocked() && currentIssuedOwner === null) {
    return null;
  }
  if (!isCurrentSessionVerified()) {
    currentIssuedOwner = null;
    currentCapturedValidation = null;
    return null;
  }
  const session = getSessionSnapshot();
  const validation = getSessionValidationSnapshot();
  const channel = getPanelChannelSnapshot();

  if (
    currentIssuedOwner !== null &&
    currentCapturedValidation === validation &&
    currentIssuedOwner.mode === channel.mode &&
    currentIssuedOwner.channelEpoch === channel.channelEpoch &&
    currentIssuedOwner.sessionEpoch === session.sessionEpoch
  ) {
    return currentIssuedOwner;
  }

  const newOwner: ImportFlowOwner = Object.freeze({
    mode: channel.mode,
    channelEpoch: channel.channelEpoch,
    sessionEpoch: session.sessionEpoch,
  });
  currentIssuedOwner = newOwner;
  currentCapturedValidation = validation;
  ownerValidationMap.set(newOwner, validation);
  return newOwner;
}

export function claimImportFlowOwner(scope: PanelScope): ImportFlowOwner | null {
  if (!scope || typeof scope !== "object") {
    return null;
  }
  if (!isPanelMode(scope.mode)) {
    return null;
  }
  if (
    typeof scope.channelEpoch !== "number" ||
    !Number.isInteger(scope.channelEpoch) ||
    scope.channelEpoch < 0 ||
    typeof scope.sessionEpoch !== "number" ||
    !Number.isInteger(scope.sessionEpoch) ||
    scope.sessionEpoch < 0
  ) {
    return null;
  }
  if (!isCurrentSessionVerified()) {
    return null;
  }
  const session = getSessionSnapshot();
  const channel = getPanelChannelSnapshot();

  if (
    scope.mode !== channel.mode ||
    scope.channelEpoch !== channel.channelEpoch ||
    scope.sessionEpoch !== session.sessionEpoch
  ) {
    return null;
  }

  return getVerifiedFlowOwner();
}

function produceSnapshot(): FlowStoreSnapshot {
  const currentOwner = getVerifiedFlowOwner();
  const records =
    activeEntries.size === 0
      ? EMPTY_RECORDS
      : Object.freeze(Array.from(activeEntries.values(), (e) => e.record));

  const snap: FlowStoreSnapshot = Object.freeze({
    owner: currentOwner,
    records,
    tasks: records,
    generation: currentGeneration,
  });
  cachedSnapshot = snap;
  return snap;
}

export function getFlowStoreSnapshot(): FlowStoreSnapshot {
  const currentOwner = getVerifiedFlowOwner();
  if (cachedSnapshot !== null) {
    if (cachedSnapshot.owner === currentOwner) {
      return cachedSnapshot;
    }
    currentGeneration++;
    return produceSnapshot();
  }
  return produceSnapshot();
}

export function getImportFlowSnapshot(): ImportFlowSnapshot {
  return getFlowStoreSnapshot();
}

function notifySubscribers(): void {
  if (isNotifying) {
    notifyPending = true;
    return;
  }
  isNotifying = true;
  try {
    do {
      notifyPending = false;
      const currentListeners = Array.from(subscribers);
      for (const listener of currentListeners) {
        if (subscribers.has(listener)) {
          try {
            listener();
          } catch {
            // Isolate subscriber exceptions
          }
        }
      }
    } while (notifyPending);
  } finally {
    isNotifying = false;
  }
}

export function subscribeFlowStore(listener: () => void): () => void {
  if (typeof listener !== "function") {
    return () => {};
  }
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

export function subscribeImportFlow(listener: () => void): () => void {
  return subscribeFlowStore(listener);
}

function isAdmissibleOwner(owner: unknown): owner is ImportFlowOwner {
  if (isRegistrationBlocked()) {
    return false;
  }
  if (!owner || typeof owner !== "object") {
    return false;
  }
  if (currentIssuedOwner === null || owner !== currentIssuedOwner) {
    return false;
  }
  const currentValidation = getSessionValidationSnapshot();
  if (ownerValidationMap.get(owner) !== currentValidation) {
    return false;
  }
  if (currentCapturedValidation !== currentValidation) {
    return false;
  }
  if (!isCurrentSessionVerified()) {
    return false;
  }
  const session = getSessionSnapshot();
  const channel = getPanelChannelSnapshot();
  const o = owner as ImportFlowOwner;
  if (
    o.mode !== channel.mode ||
    o.channelEpoch !== channel.channelEpoch ||
    o.sessionEpoch !== session.sessionEpoch
  ) {
    return false;
  }
  return true;
}

export function beginImportFlowTask(
  owner: ImportFlowOwner,
  kind: "oauth" | "email",
  jobId?: string,
): ImportFlowTaskHandle | null {
  if (!isAdmissibleOwner(owner)) {
    return null;
  }
  if (kind !== "oauth" && kind !== "email") {
    return null;
  }

  if (kind === "email") {
    if (owner.mode !== "antigravity") {
      return null;
    }
    if (typeof jobId !== "string" || !/^[0-9a-f]{32}$/.test(jobId)) {
      return null;
    }
    // Deduplicate same-owner email jobs
    for (const entry of activeEntries.values()) {
      if (
        entry.record.kind === "email" &&
        entry.record.owner === owner &&
        entry.record.jobId === jobId
      ) {
        return entry.handle;
      }
    }
  }

  if (activeEntries.size >= MAX_ACTIVE_RECORDS) {
    return null;
  }

  const id = nextTaskId++;
  const controller = new AbortController();
  const createdAt = Date.now();
  const handleRef: { current?: FlowTaskHandle } = {};

  const record: FlowRecord = Object.freeze({
    id,
    kind,
    type: kind,
    owner,
    ...(kind === "email" ? { jobId } : {}),
    signal: controller.signal,
    createdAt,
  });

  const handle: FlowTaskHandle = Object.freeze({
    id,
    kind,
    owner,
    ...(kind === "email" ? { jobId } : {}),
    signal: controller.signal,
    cancel: () => {
      if (handleRef.current) {
        return stopImportFlowTask(owner, handleRef.current);
      }
      return false;
    },
  });
  handleRef.current = handle;

  activeEntries.set(id, {
    record,
    handle,
    controller,
  });

  currentGeneration++;
  produceSnapshot();
  notifySubscribers();
  return handle;
}

export function stopImportFlowTask(
  owner: ImportFlowOwner,
  handle: ImportFlowTaskHandle,
): boolean {
  if (!isAdmissibleOwner(owner)) {
    return false;
  }
  if (!handle || typeof handle !== "object") {
    return false;
  }
  const id = handle.id;
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
    return false;
  }

  const entry = activeEntries.get(id);
  if (!entry) {
    return false;
  }

  if (handle !== entry.handle && (handle as unknown) !== entry.record) {
    return false;
  }

  if (entry.record.owner !== owner) {
    return false;
  }

  activeEntries.delete(id);
  currentGeneration++;
  produceSnapshot();

  isAborting = true;
  try {
    entry.controller.abort();
  } catch {
    // Isolate abort exceptions
  } finally {
    isAborting = false;
  }

  notifySubscribers();
  return true;
}

export function resetImportFlow(expectedOwner: ImportFlowOwner): boolean {
  if (!isAdmissibleOwner(expectedOwner)) {
    return false;
  }

  currentIssuedOwner = null;
  currentCapturedValidation = null;

  const entriesToAbort = Array.from(activeEntries.values());
  activeEntries.clear();
  currentGeneration++;
  produceSnapshot();

  isAborting = true;
  try {
    for (const entry of entriesToAbort) {
      try {
        entry.controller.abort();
      } catch {
        // Isolate abort exceptions
      }
    }
  } finally {
    isAborting = false;
  }

  notifySubscribers();
  return true;
}

export function registerOAuthTask(owner?: FlowOwner): FlowTaskHandle | null {
  if (owner === undefined || owner === null) {
    return null;
  }
  return beginImportFlowTask(owner, "oauth");
}

export function registerEmailJob(
  ownerOrJobId: FlowOwner | string,
  maybeJobId?: string,
): FlowTaskHandle | null {
  if (typeof ownerOrJobId === "string" || !ownerOrJobId) {
    return null;
  }
  if (typeof maybeJobId !== "string") {
    return null;
  }
  return beginImportFlowTask(ownerOrJobId, "email", maybeJobId);
}

export function cancelFlowTask(
  target: unknown,
  owner?: FlowOwner,
): boolean {
  if (owner === undefined || owner === null) {
    return false;
  }
  if (!target || typeof target !== "object") {
    return false;
  }

  const targetObj = target as Record<string, unknown>;
  const id = targetObj.id;
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
    return false;
  }

  const entry = activeEntries.get(id);
  if (!entry) {
    return false;
  }

  if (target !== entry.handle && target !== entry.record) {
    return false;
  }

  return stopImportFlowTask(owner, entry.handle);
}

function clearAndAbortAllTasks(): void {
  currentIssuedOwner = null;
  currentCapturedValidation = null;

  const hadEntries = activeEntries.size > 0;
  if (!hadEntries) {
    const currentOwner = getVerifiedFlowOwner();
    if (!cachedSnapshot || cachedSnapshot.owner !== currentOwner) {
      currentGeneration++;
      produceSnapshot();
      notifySubscribers();
    }
    return;
  }

  isAborting = true;
  const entriesToAbort = Array.from(activeEntries.values());
  activeEntries.clear();
  currentGeneration++;
  produceSnapshot();

  try {
    for (const entry of entriesToAbort) {
      try {
        entry.controller.abort();
      } catch {
        // Isolate abort exceptions
      }
    }
  } finally {
    isAborting = false;
  }

  notifySubscribers();
}

// 1. Channel prepublication cleanup & post-publication channel listener
registerChannelCleanup(() => {
  isChannelCleaningUp = true;
  try {
    clearAndAbortAllTasks();
  } catch {
    // Isolate cleanup exceptions
  }
});

subscribePanelChannel(() => {
  isChannelCleaningUp = false;
  try {
    const currentOwner = getVerifiedFlowOwner();
    if (!cachedSnapshot || cachedSnapshot.owner !== currentOwner) {
      currentGeneration++;
      produceSnapshot();
      notifySubscribers();
    }
  } catch {
    // Isolate listener exceptions
  }
});

// 2. Session prepublication cleanup & post-cleanup session listener
registerSessionCleanup(() => {
  isSessionCleaningUp = true;
  try {
    clearAndAbortAllTasks();
  } catch {
    // Isolate cleanup exceptions
  }
});

subscribeSession(() => {
  isSessionCleaningUp = false;
  try {
    const currentOwner = getVerifiedFlowOwner();
    if (!cachedSnapshot || cachedSnapshot.owner !== currentOwner) {
      currentGeneration++;
      produceSnapshot();
      notifySubscribers();
    }
  } catch {
    // Isolate listener exceptions
  }
});

// 3. Validation loss & restoration listener
subscribeSessionValidation(() => {
  try {
    const session = getSessionSnapshot();
    const validation = getSessionValidationSnapshot();
    if (
      session.token === null ||
      validation.status !== "verified" ||
      validation.sessionEpoch !== session.sessionEpoch
    ) {
      clearAndAbortAllTasks();
    } else {
      const owner = getVerifiedFlowOwner();
      if (!cachedSnapshot || cachedSnapshot.owner !== owner) {
        currentGeneration++;
        produceSnapshot();
        notifySubscribers();
      }
    }
  } catch {
    // Isolate listener exceptions
  }
});

export function __resetFlowStore(): void {
  isChannelCleaningUp = false;
  isSessionCleaningUp = false;
  isAborting = false;
  isNotifying = false;
  notifyPending = false;
  clearAndAbortAllTasks();
  subscribers.clear();
  nextTaskId = 1;
  currentGeneration = 0;
  currentIssuedOwner = null;
  currentCapturedValidation = null;
  cachedSnapshot = null;
}
