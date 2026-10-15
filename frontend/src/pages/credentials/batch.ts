import { isPanelScopeCurrent, registerChannelCleanup, type PanelScope } from '@/domain/panel';
import {
  getSessionSnapshot,
  getSessionValidationSnapshot,
  registerSessionCleanup,
  subscribeSessionValidation,
} from '@/auth/session';

export type BatchOperation = 'verify-project' | 'test' | 'quota' | 'preview';

export type BatchPhase = 'queued' | 'running' | 'completed' | 'not-started';

export type BatchOutcome = 'success' | 'failure' | 'unknown';

export const ALLOWED_WRITEBACK_NAMES = Object.freeze([
  'quota',
  'cooldown',
  'status',
  'model_access',
  'remark',
  'verify',
  'test',
  'preview',
] as const);

export type BatchWritebackName = (typeof ALLOWED_WRITEBACK_NAMES)[number];

export const ALLOWED_WRITEBACK_STATUSES = Object.freeze([
  'applied',
  'pending',
  'skipped',
  'failed',
  'unknown',
] as const);

export type BatchWritebackStatus = (typeof ALLOWED_WRITEBACK_STATUSES)[number];

export interface BatchWritebackUpdate {
  readonly name: string;
  readonly status: BatchWritebackStatus;
}

export interface BatchReceipt {
  readonly outcome: BatchOutcome;
  readonly httpStatus: number | null;
  readonly upstreamStatus: number | null;
  readonly verifiedReply: boolean | null;
  readonly updates: readonly BatchWritebackUpdate[];
}

export interface BatchItem {
  readonly filename: string;
  readonly phase: BatchPhase;
  readonly receipt: BatchReceipt | null;
}

export interface BatchSnapshot {
  readonly scope: PanelScope;
  readonly attempt: number;
  readonly operation: BatchOperation | null;
  readonly items: readonly BatchItem[];
  readonly running: boolean;
  readonly stopped: boolean;
}

export type BatchFileWorker = (filename: string, signal: AbortSignal) => Promise<unknown>;
export type BatchQuotaWorker = (names: readonly string[], signal: AbortSignal) => Promise<unknown>;

export interface BatchWorkers {
  readonly 'verify-project'?: BatchFileWorker;
  readonly test?: BatchFileWorker;
  readonly quota?: BatchQuotaWorker;
  readonly preview?: BatchFileWorker;
  readonly verifyProject?: BatchFileWorker;
}

export interface CreateCredentialBatchOptions {
  readonly scope: PanelScope;
  readonly isCurrentOwner: () => boolean;
  readonly workers: BatchWorkers;
}

export interface CredentialBatchController {
  start(operation: BatchOperation, names: readonly string[]): Promise<void>;
  getSnapshot(): BatchSnapshot;
  subscribe(listener: () => void): () => void;
  stop(): void;
  dispose(): void;
}

function hasOwn(obj: object, prop: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

function parseStatus(
  source: Record<string, unknown>,
  camelKey: string,
  snakeKey: string
): { value: number | null; invalid: boolean } {
  const hasCamel = hasOwn(source, camelKey);
  const hasSnake = hasOwn(source, snakeKey);

  if (!hasCamel && !hasSnake) {
    return { value: null, invalid: false };
  }

  let invalid = false;
  let resolvedValue: number | null = null;

  if (hasCamel) {
    const val = source[camelKey];
    if (val === null || val === undefined) {
      // valid empty
    } else if (typeof val === 'number' && Number.isInteger(val) && val >= 100 && val <= 599) {
      resolvedValue = val;
    } else {
      invalid = true;
    }
  }

  if (hasSnake) {
    const val = source[snakeKey];
    if (val === null || val === undefined) {
      // valid empty
    } else if (typeof val === 'number' && Number.isInteger(val) && val >= 100 && val <= 599) {
      if (resolvedValue === null) {
        resolvedValue = val;
      }
    } else {
      invalid = true;
    }
  }

  return { value: resolvedValue, invalid };
}

function createUnknownReceipt(): BatchReceipt {
  return Object.freeze({
    outcome: 'unknown' as const,
    httpStatus: null,
    upstreamStatus: null,
    verifiedReply: null,
    updates: Object.freeze([]),
  });
}

function projectReceipt(raw: unknown): BatchReceipt {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return createUnknownReceipt();
  }

  let source = raw as Record<string, unknown>;
  if (
    hasOwn(raw, 'receipt') &&
    typeof (raw as Record<string, unknown>).receipt === 'object' &&
    (raw as Record<string, unknown>).receipt !== null &&
    !Array.isArray((raw as Record<string, unknown>).receipt)
  ) {
    source = (raw as Record<string, unknown>).receipt as Record<string, unknown>;
  }

  const http = parseStatus(source, 'httpStatus', 'status_code');
  const upstream = parseStatus(source, 'upstreamStatus', 'upstream_status');

  const httpStatus = http.value;
  const upstreamStatus = upstream.value;
  const hasInvalidStatus = http.invalid || upstream.invalid;

  let verifiedReply: boolean | null = null;
  if (hasOwn(source, 'verifiedReply')) {
    const val = source.verifiedReply;
    if (typeof val === 'boolean') {
      verifiedReply = val;
    }
  } else if (hasOwn(source, 'verified_reply')) {
    const val = source.verified_reply;
    if (typeof val === 'boolean') {
      verifiedReply = val;
    }
  }

  const validUpdates: BatchWritebackUpdate[] = [];
  let rawUpdates: unknown = undefined;
  if (hasOwn(source, 'updates')) {
    rawUpdates = source.updates;
  } else if (hasOwn(source, 'state_update')) {
    rawUpdates = source.state_update;
  }

  if (Array.isArray(rawUpdates)) {
    for (const item of rawUpdates) {
      if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
        if (hasOwn(item, 'name') && hasOwn(item, 'status')) {
          const name = (item as Record<string, unknown>).name;
          const status = (item as Record<string, unknown>).status;
          if (
            typeof name === 'string' &&
            ALLOWED_WRITEBACK_NAMES.includes(name as BatchWritebackName) &&
            typeof status === 'string' &&
            ALLOWED_WRITEBACK_STATUSES.includes(status as BatchWritebackStatus)
          ) {
            validUpdates.push(
              Object.freeze({
                name: name as BatchWritebackName,
                status: status as BatchWritebackStatus,
              })
            );
          }
        }
      }
    }
  } else if (typeof rawUpdates === 'object' && rawUpdates !== null) {
    for (const [key, val] of Object.entries(rawUpdates)) {
      if (ALLOWED_WRITEBACK_NAMES.includes(key as BatchWritebackName)) {
        if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
          if (hasOwn(val, 'status')) {
            const st = (val as Record<string, unknown>).status;
            if (typeof st === 'string' && ALLOWED_WRITEBACK_STATUSES.includes(st as BatchWritebackStatus)) {
              validUpdates.push(
                Object.freeze({
                  name: key as BatchWritebackName,
                  status: st as BatchWritebackStatus,
                })
              );
            }
          }
        }
      }
    }
  }

  const hasOutcome = hasOwn(source, 'outcome');
  const rawOutcome = hasOutcome ? source.outcome : undefined;
  const hasSuccess = hasOwn(source, 'success');
  const rawSuccess = hasSuccess ? source.success : undefined;

  const claimsSuccess =
    rawOutcome === 'success' || (!hasOutcome && rawSuccess === true);
  const claimsFailure =
    rawOutcome === 'failure' || (!hasOutcome && rawSuccess === false);

  let outcome: BatchOutcome = 'unknown';

  if (hasInvalidStatus) {
    outcome = 'unknown';
  } else if (claimsSuccess) {
    const rawError = hasOwn(source, 'error') ? source.error : undefined;
    const hasContradictoryFailure =
      Boolean(rawError) ||
      (httpStatus !== null && httpStatus >= 400) ||
      (upstreamStatus !== null && upstreamStatus >= 400);

    if (
      verifiedReply !== false &&
      !hasContradictoryFailure &&
      httpStatus !== null &&
      httpStatus >= 200 &&
      httpStatus < 300
    ) {
      outcome = 'success';
    } else {
      outcome = 'unknown';
    }
  } else if (claimsFailure) {
    const hasConfirmedFailureEvidence =
      (httpStatus !== null && httpStatus >= 400 && httpStatus <= 599) ||
      (upstreamStatus !== null && upstreamStatus >= 400 && upstreamStatus <= 599);

    if (hasConfirmedFailureEvidence) {
      outcome = 'failure';
    } else {
      outcome = 'unknown';
    }
  }

  return Object.freeze({
    outcome,
    httpStatus,
    upstreamStatus,
    verifiedReply,
    updates: Object.freeze(validUpdates),
  });
}

function checkQuotaBijection(
  expectedNames: readonly string[],
  res: unknown
): { ok: true; receipts: Map<string, BatchReceipt> } | { ok: false } {
  if (!Array.isArray(res) || res.length !== expectedNames.length) {
    return { ok: false };
  }

  const expectedSet = new Set(expectedNames);
  const seenNames = new Set<string>();
  const receipts = new Map<string, BatchReceipt>();

  for (const item of res) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return { ok: false };
    }
    if (!hasOwn(item, 'filename')) {
      return { ok: false };
    }
    const filename = (item as Record<string, unknown>).filename;
    if (typeof filename !== 'string' || !expectedSet.has(filename) || seenNames.has(filename)) {
      return { ok: false };
    }
    seenNames.add(filename);
    receipts.set(filename, projectReceipt(item));
  }

  if (seenNames.size !== expectedNames.length) {
    return { ok: false };
  }

  return { ok: true, receipts };
}

export function createCredentialBatch(options: CreateCredentialBatchOptions): CredentialBatchController {
  if (!options || typeof options !== 'object') {
    throw new TypeError('Options must be provided');
  }

  const frozenScope: PanelScope = Object.freeze({
    mode: options.scope.mode,
    channelEpoch: options.scope.channelEpoch,
    sessionEpoch: options.scope.sessionEpoch,
  });

  const isCurrentOwner = typeof options.isCurrentOwner === 'function' ? options.isCurrentOwner : () => false;
  const frozenWorkers: BatchWorkers = Object.freeze({ ...options.workers });

  let disposed = false;
  let running = false;
  let stopped = false;
  let attemptCounter = 0;
  let activeWorkerCalls = 0;
  let currentOperation: BatchOperation | null = null;
  let items: readonly BatchItem[] = Object.freeze([]);
  let currentSnapshot: BatchSnapshot = Object.freeze({
    scope: frozenScope,
    attempt: 0,
    operation: null,
    items: Object.freeze([]),
    running: false,
    stopped: false,
  });

  const listeners = new Set<() => void>();
  let abortController: AbortController | null = null;
  let currentAttemptResolver: (() => void) | null = null;
  let activePerFileQueue: number[] | null = null;
  let activeChunkList: { names: string[]; itemIndices: number[] }[] | null = null;

  let unregChannel: () => void = () => {};
  let unregSession: () => void = () => {};
  let unregValidation: () => void = () => {};

  function isOwnerValid(): boolean {
    try {
      if (disposed) return false;
      const sessionSnap = getSessionSnapshot();
      if (!sessionSnap || sessionSnap.token === null) return false;
      if (!isPanelScopeCurrent(frozenScope, sessionSnap.sessionEpoch)) return false;
      const valSnap = getSessionValidationSnapshot();
      if (!valSnap) return false;
      if (valSnap.sessionEpoch !== frozenScope.sessionEpoch || valSnap.status !== 'verified') {
        return false;
      }
      if (!isCurrentOwner()) return false;
      return true;
    } catch {
      return false;
    }
  }

  function updateSnapshot(): void {
    currentSnapshot = Object.freeze({
      scope: frozenScope,
      attempt: attemptCounter,
      operation: currentOperation,
      items: Object.freeze([...items]),
      running,
      stopped,
    });
  }

  function notifyListeners(): void {
    if (disposed) return;
    const snapAttempt = attemptCounter;
    const currentListeners = Array.from(listeners);
    for (const listener of currentListeners) {
      if (disposed || attemptCounter !== snapAttempt) {
        break;
      }
      if (!isOwnerValid()) {
        dispose();
        break;
      }
      try {
        listener();
      } catch {
        // Isolate listener exceptions
      }
      if (disposed || attemptCounter !== snapAttempt) {
        break;
      }
      if (!isOwnerValid()) {
        dispose();
        break;
      }
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    attemptCounter++;
    running = false;
    stopped = true;
    activeWorkerCalls = 0;

    if (activePerFileQueue) {
      activePerFileQueue.length = 0;
      activePerFileQueue = null;
    }
    if (activeChunkList) {
      activeChunkList.length = 0;
      activeChunkList = null;
    }

    if (abortController) {
      try {
        abortController.abort();
      } catch {
        // Isolate abort exceptions
      }
      abortController = null;
    }

    if (currentAttemptResolver) {
      const resolver = currentAttemptResolver;
      currentAttemptResolver = null;
      resolver();
    }

    items = Object.freeze([]);
    updateSnapshot();

    listeners.clear();
    unregChannel();
    unregSession();
    unregValidation();
  }

  unregChannel = registerChannelCleanup(() => {
    dispose();
  });

  unregSession = registerSessionCleanup(() => {
    dispose();
  });

  unregValidation = subscribeSessionValidation(() => {
    if (!isOwnerValid()) {
      dispose();
    }
  });

  function stop(): void {
    if (disposed || !running || stopped) return;
    if (!isOwnerValid()) {
      dispose();
      return;
    }

    stopped = true;

    if (activePerFileQueue) {
      activePerFileQueue.length = 0;
      activePerFileQueue = null;
    }
    if (activeChunkList) {
      activeChunkList.length = 0;
      activeChunkList = null;
    }

    items = Object.freeze(
      items.map((item) => {
        if (item.phase === 'queued') {
          return Object.freeze({
            filename: item.filename,
            phase: 'not-started' as const,
            receipt: null,
          });
        }
        return item;
      })
    );

    if (activeWorkerCalls === 0) {
      running = false;
      updateSnapshot();
      if (currentAttemptResolver) {
        const resolver = currentAttemptResolver;
        currentAttemptResolver = null;
        resolver();
      }
      notifyListeners();
    } else {
      updateSnapshot();
      notifyListeners();
    }
  }

  function getSnapshot(): BatchSnapshot {
    return currentSnapshot;
  }

  function subscribe(listener: () => void): () => void {
    if (typeof listener !== 'function' || disposed) {
      return () => {};
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  async function start(operation: BatchOperation, names: readonly string[]): Promise<void> {
    if (disposed) {
      throw new Error('批量控制器已销毁');
    }
    if (running) {
      throw new Error('批量操作正在执行中，请勿重复启动');
    }
    if (!isOwnerValid()) {
      dispose();
      throw new Error('当前会话或作用域已失效');
    }

    const validOperations: readonly BatchOperation[] = ['verify-project', 'test', 'quota', 'preview'];
    if (!validOperations.includes(operation)) {
      throw new TypeError(`不支持的操作类型: ${String(operation)}`);
    }

    const uniqueNames: string[] = [];
    const seen = new Set<string>();
    if (Array.isArray(names)) {
      for (const name of names) {
        if (typeof name === 'string' && name.length > 0) {
          if (!seen.has(name)) {
            seen.add(name);
            uniqueNames.push(name);
          }
        }
      }
    }

    attemptCounter++;
    const currentAttempt = attemptCounter;
    currentOperation = operation;
    running = true;
    stopped = false;
    abortController = new AbortController();

    items = Object.freeze(
      uniqueNames.map((filename) =>
        Object.freeze({
          filename,
          phase: 'queued' as const,
          receipt: null,
        })
      )
    );

    updateSnapshot();
    notifyListeners();

    if (disposed || attemptCounter !== currentAttempt) {
      return;
    }
    if (!isOwnerValid()) {
      dispose();
      return;
    }
    if (stopped || !running) {
      return;
    }

    if (uniqueNames.length === 0) {
      running = false;
      updateSnapshot();
      notifyListeners();
      return;
    }

    let worker: BatchFileWorker | BatchQuotaWorker | undefined;
    if (operation === 'quota') {
      worker = frozenWorkers.quota;
    } else if (operation === 'verify-project') {
      worker = frozenWorkers['verify-project'] ?? frozenWorkers.verifyProject;
    } else if (operation === 'test') {
      worker = frozenWorkers.test;
    } else if (operation === 'preview') {
      worker = frozenWorkers.preview;
    }

    if (!worker) {
      items = Object.freeze(
        items.map((item) =>
          Object.freeze({
            filename: item.filename,
            phase: 'not-started' as const,
            receipt: null,
          })
        )
      );
      running = false;
      updateSnapshot();
      notifyListeners();
      return;
    }

    return new Promise<void>((resolve) => {
      let settled = false;
      const settleThisAttempt = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      currentAttemptResolver = settleThisAttempt;

      const finishOperation = () => {
        if (disposed || attemptCounter !== currentAttempt) {
          if (currentAttemptResolver === settleThisAttempt) {
            currentAttemptResolver = null;
          }
          settleThisAttempt();
          return;
        }
        if (!running) {
          settleThisAttempt();
          return;
        }
        running = false;
        updateSnapshot();
        if (currentAttemptResolver === settleThisAttempt) {
          currentAttemptResolver = null;
        }
        settleThisAttempt();
        notifyListeners();
      };

      if (operation === 'quota') {
        runQuotaChunks(worker as BatchQuotaWorker, currentAttempt, finishOperation);
      } else {
        runPerFileItems(worker as BatchFileWorker, currentAttempt, finishOperation);
      }
    });
  }

  function runQuotaChunks(
    quotaWorker: BatchQuotaWorker,
    currentAttempt: number,
    onComplete: () => void
  ): void {
    const chunkList: { names: string[]; itemIndices: number[] }[] = [];
    for (let i = 0; i < items.length; i += 10) {
      const chunkItems = items.slice(i, i + 10);
      chunkList.push({
        names: chunkItems.map((it) => it.filename),
        itemIndices: chunkItems.map((_, idx) => i + idx),
      });
    }
    activeChunkList = chunkList;

    function checkFinished(): void {
      if (activeWorkerCalls === 0 && (chunkList.length === 0 || stopped)) {
        if (activeChunkList === chunkList) {
          activeChunkList = null;
        }
        onComplete();
      }
    }

    function pump(): void {
      if (disposed || attemptCounter !== currentAttempt) return;
      if (!isOwnerValid()) {
        dispose();
        return;
      }
      if (stopped) {
        checkFinished();
        return;
      }

      while (activeWorkerCalls < 2 && chunkList.length > 0 && !stopped) {
        const nextChunk = chunkList.shift()!;
        activeWorkerCalls++;

        items = Object.freeze(
          items.map((it, idx) => {
            if (nextChunk.itemIndices.includes(idx)) {
              return Object.freeze({
                filename: it.filename,
                phase: 'running' as const,
                receipt: null,
              });
            }
            return it;
          })
        );
        updateSnapshot();
        notifyListeners();

        if (disposed || attemptCounter !== currentAttempt) return;
        if (!isOwnerValid()) {
          dispose();
          return;
        }
        if (stopped) {
          activeWorkerCalls = Math.max(0, activeWorkerCalls - 1);
          items = Object.freeze(
            items.map((it, idx) => {
              if (nextChunk.itemIndices.includes(idx)) {
                return Object.freeze({
                  filename: it.filename,
                  phase: 'not-started' as const,
                  receipt: null,
                });
              }
              return it;
            })
          );
          updateSnapshot();
          notifyListeners();
          checkFinished();
          return;
        }

        const signal = abortController?.signal ?? new AbortController().signal;

        Promise.resolve().then(() => {
          if (disposed || attemptCounter !== currentAttempt) {
            activeWorkerCalls = Math.max(0, activeWorkerCalls - 1);
            return;
          }
          if (!isOwnerValid()) {
            activeWorkerCalls = Math.max(0, activeWorkerCalls - 1);
            dispose();
            return;
          }
          if (stopped) {
            activeWorkerCalls = Math.max(0, activeWorkerCalls - 1);
            items = Object.freeze(
              items.map((it, idx) => {
                if (nextChunk.itemIndices.includes(idx)) {
                  return Object.freeze({
                    filename: it.filename,
                    phase: 'not-started' as const,
                    receipt: null,
                  });
                }
                return it;
              })
            );
            updateSnapshot();
            notifyListeners();
            checkFinished();
            return;
          }

          let workerPromise: Promise<unknown>;
          try {
            workerPromise = Promise.resolve(quotaWorker(Object.freeze([...nextChunk.names]), signal));
          } catch (err) {
            workerPromise = Promise.reject(err);
          }

          workerPromise.then(
            (res) => {
              activeWorkerCalls--;
              if (disposed || attemptCounter !== currentAttempt) return;
              if (!isOwnerValid()) {
                dispose();
                return;
              }

              const valid = checkQuotaBijection(nextChunk.names, res);
              if (valid.ok) {
                items = Object.freeze(
                  items.map((it, idx) => {
                    if (nextChunk.itemIndices.includes(idx)) {
                      const receipt = valid.receipts.get(it.filename) ?? createUnknownReceipt();
                      return Object.freeze({
                        filename: it.filename,
                        phase: 'completed' as const,
                        receipt,
                      });
                    }
                    return it;
                  })
                );
              } else {
                stopped = true;
                chunkList.length = 0;

                items = Object.freeze(
                  items.map((it, idx) => {
                    if (nextChunk.itemIndices.includes(idx)) {
                      return Object.freeze({
                        filename: it.filename,
                        phase: 'completed' as const,
                        receipt: createUnknownReceipt(),
                      });
                    }
                    if (it.phase === 'queued') {
                      return Object.freeze({
                        filename: it.filename,
                        phase: 'not-started' as const,
                        receipt: null,
                      });
                    }
                    return it;
                  })
                );
              }

              updateSnapshot();
              notifyListeners();

              if (!stopped && chunkList.length > 0) {
                pump();
              } else {
                checkFinished();
              }
            },
            () => {
              activeWorkerCalls--;
              if (disposed || attemptCounter !== currentAttempt) return;
              if (!isOwnerValid()) {
                dispose();
                return;
              }

              stopped = true;
              chunkList.length = 0;

              items = Object.freeze(
                items.map((it, idx) => {
                  if (nextChunk.itemIndices.includes(idx)) {
                    return Object.freeze({
                      filename: it.filename,
                      phase: 'completed' as const,
                      receipt: createUnknownReceipt(),
                    });
                  }
                  if (it.phase === 'queued') {
                    return Object.freeze({
                      filename: it.filename,
                      phase: 'not-started' as const,
                      receipt: null,
                    });
                  }
                  return it;
                })
              );

              updateSnapshot();
              notifyListeners();

              checkFinished();
            }
          );
        });
      }
    }

    pump();
  }

  function runPerFileItems(
    fileWorker: BatchFileWorker,
    currentAttempt: number,
    onComplete: () => void
  ): void {
    const queue: number[] = items.map((_, idx) => idx);
    activePerFileQueue = queue;

    function checkFinished(): void {
      if (activeWorkerCalls === 0 && (queue.length === 0 || stopped)) {
        if (activePerFileQueue === queue) {
          activePerFileQueue = null;
        }
        onComplete();
      }
    }

    function pump(): void {
      if (disposed || attemptCounter !== currentAttempt) return;
      if (!isOwnerValid()) {
        dispose();
        return;
      }
      if (stopped) {
        checkFinished();
        return;
      }

      while (activeWorkerCalls < 2 && queue.length > 0 && !stopped) {
        const itemIndex = queue.shift()!;
        activeWorkerCalls++;

        const targetItem = items[itemIndex];
        items = Object.freeze(
          items.map((it, idx) => {
            if (idx === itemIndex) {
              return Object.freeze({
                filename: it.filename,
                phase: 'running' as const,
                receipt: null,
              });
            }
            return it;
          })
        );
        updateSnapshot();
        notifyListeners();

        if (disposed || attemptCounter !== currentAttempt) return;
        if (!isOwnerValid()) {
          dispose();
          return;
        }
        if (stopped) {
          activeWorkerCalls = Math.max(0, activeWorkerCalls - 1);
          items = Object.freeze(
            items.map((it, idx) => {
              if (idx === itemIndex) {
                return Object.freeze({
                  filename: it.filename,
                  phase: 'not-started' as const,
                  receipt: null,
                });
              }
              return it;
            })
          );
          updateSnapshot();
          notifyListeners();
          checkFinished();
          return;
        }

        const signal = abortController?.signal ?? new AbortController().signal;

        Promise.resolve().then(() => {
          if (disposed || attemptCounter !== currentAttempt) {
            activeWorkerCalls = Math.max(0, activeWorkerCalls - 1);
            return;
          }
          if (!isOwnerValid()) {
            activeWorkerCalls = Math.max(0, activeWorkerCalls - 1);
            dispose();
            return;
          }
          if (stopped) {
            activeWorkerCalls = Math.max(0, activeWorkerCalls - 1);
            items = Object.freeze(
              items.map((it, idx) => {
                if (idx === itemIndex) {
                  return Object.freeze({
                    filename: it.filename,
                    phase: 'not-started' as const,
                    receipt: null,
                  });
                }
                return it;
              })
            );
            updateSnapshot();
            notifyListeners();
            checkFinished();
            return;
          }

          let workerPromise: Promise<unknown>;
          try {
            workerPromise = Promise.resolve(fileWorker(targetItem.filename, signal));
          } catch (err) {
            workerPromise = Promise.reject(err);
          }

          workerPromise.then(
            (res) => {
              activeWorkerCalls--;
              if (disposed || attemptCounter !== currentAttempt) return;
              if (!isOwnerValid()) {
                dispose();
                return;
              }

              const receipt = projectReceipt(res);
              items = Object.freeze(
                items.map((it, idx) => {
                  if (idx === itemIndex) {
                    return Object.freeze({
                      filename: it.filename,
                      phase: 'completed' as const,
                      receipt,
                    });
                  }
                  return it;
                })
              );

              updateSnapshot();
              notifyListeners();

              if (!stopped && queue.length > 0) {
                pump();
              } else {
                checkFinished();
              }
            },
            () => {
              activeWorkerCalls--;
              if (disposed || attemptCounter !== currentAttempt) return;
              if (!isOwnerValid()) {
                dispose();
                return;
              }

              items = Object.freeze(
                items.map((it, idx) => {
                  if (idx === itemIndex) {
                    return Object.freeze({
                      filename: it.filename,
                      phase: 'completed' as const,
                      receipt: createUnknownReceipt(),
                    });
                  }
                  return it;
                })
              );

              updateSnapshot();
              notifyListeners();

              if (!stopped && queue.length > 0) {
                pump();
              } else {
                checkFinished();
              }
            }
          );
        });
      }
    }

    pump();
  }

  return {
    start,
    getSnapshot,
    subscribe,
    stop,
    dispose,
  };
}
