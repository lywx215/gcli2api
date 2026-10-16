import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { PanelMode, PanelScope } from '@/domain/panel';
import { isPanelMode, isPanelScopeCurrent, subscribePanelChannel } from '@/domain/panel';
import type { SessionValidationSnapshot } from '@/auth/session';
import {
  getSessionSnapshot,
  getSessionValidationSnapshot,
  subscribeSession,
  subscribeSessionValidation,
} from '@/auth/session';
import { createCredentialApi, SAFE_ERROR_CODE_LABELS, SAFE_WRITEBACK_REASON_LABELS } from './api';
import { createAdvancedCredentialApi } from './advancedApi';
import {
  createCredentialBatch,
  type BatchFileWorker,
  type BatchOperation,
  type BatchQuotaWorker,
  type BatchSnapshot,
  type BatchWorkers,
  type CredentialBatchController,
} from './batch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

export interface CredentialBatchPanelProps {
  readonly mode: PanelMode;
  readonly scope: Readonly<PanelScope>;
  readonly validation: SessionValidationSnapshot;
  readonly ownerRevision: object;
  readonly isCurrentOwner: () => boolean;
  readonly filenames: readonly string[];
  readonly disabled?: boolean;
  readonly onRefresh?: () => void | Promise<void>;
}

interface ComponentLifetime {
  readonly id: number;
  readonly mode: PanelMode;
  readonly scope: Readonly<PanelScope>;
  readonly validation: SessionValidationSnapshot;
  readonly ownerRevision: object;
  readonly filenames: readonly string[];
  retired: boolean;
}

interface ConfirmationActor {
  readonly id: number;
  readonly lifetime: ComponentLifetime;
  readonly operation: BatchOperation;
  readonly testChoice?: 'default' | 'chosen';
  readonly filenames: readonly string[];
  readonly mode: PanelMode;
  readonly testModel: string;
  readonly scope: PanelScope;
  readonly validation: SessionValidationSnapshot;
  readonly ownerRevision: object;
  readonly isCurrentOwner: () => boolean;
  readonly onRefresh?: () => void | Promise<void>;
  consumed: boolean;
  retired: boolean;
  refreshFired?: boolean;
}

function dedupeFilenames(names: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  if (Array.isArray(names)) {
    for (const name of names) {
      if (typeof name === 'string' && name.length > 0 && !seen.has(name)) {
        seen.add(name);
        result.push(name);
      }
    }
  }
  return Object.freeze(result);
}

function areFilenamesEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  const dedupA = dedupeFilenames(a);
  const dedupB = dedupeFilenames(b);
  if (dedupA.length !== dedupB.length) return false;
  for (let i = 0; i < dedupA.length; i++) {
    if (dedupA[i] !== dedupB[i]) return false;
  }
  return true;
}

export function CredentialBatchPanel(props: CredentialBatchPanelProps): React.JSX.Element {
  const [testModel, setTestModel] = useState<string>('');
  const [confirmation, setConfirmation] = useState<ConfirmationActor | null>(null);
  const [snapshot, setSnapshot] = useState<BatchSnapshot | null>(null);
  const [localErrorMessage, setLocalErrorMessage] = useState<string | null>(null);
  const [, setTick] = useState<number>(0);

  const isMountedRef = useRef<boolean>(true);
  const wasCleanedUpRef = useRef<boolean>(false);
  const currentLifetimeRef = useRef<ComponentLifetime | null>(null);
  const lifetimeIdCounterRef = useRef<number>(0);
  const confirmationRef = useRef<ConfirmationActor | null>(null);
  const activeActorRef = useRef<ConfirmationActor | null>(null);
  const activeControllerRef = useRef<CredentialBatchController | null>(null);
  const confirmationIdCounterRef = useRef<number>(0);
  const delayedRefreshTimerRef = useRef<{ timer: ReturnType<typeof setTimeout>; actor: ConfirmationActor } | null>(null);

  const clearDelayedRefreshTimer = () => {
    if (delayedRefreshTimerRef.current) {
      clearTimeout(delayedRefreshTimerRef.current.timer);
      delayedRefreshTimerRef.current = null;
    }
  };

  const uniqueFilenames = useMemo(() => dedupeFilenames(props.filenames), [props.filenames]);

  const retireLifetime = (lifetimeToRetire: ComponentLifetime) => {
    lifetimeToRetire.retired = true;
    clearDelayedRefreshTimer();
    if (confirmationRef.current?.lifetime === lifetimeToRetire) {
      confirmationRef.current.retired = true;
      confirmationRef.current = null;
    }
    if (activeActorRef.current?.lifetime === lifetimeToRetire) {
      activeActorRef.current.retired = true;
      activeActorRef.current = null;
    }
    if (activeControllerRef.current) {
      const ctrl = activeControllerRef.current;
      activeControllerRef.current = null;
      ctrl.dispose();
    }
  };

  const retireAllCurrentAndActive = () => {
    clearDelayedRefreshTimer();
    if (currentLifetimeRef.current) {
      currentLifetimeRef.current.retired = true;
      currentLifetimeRef.current = null;
    }
    if (confirmationRef.current) {
      confirmationRef.current.retired = true;
      confirmationRef.current = null;
      setConfirmation(null);
    }
    if (activeActorRef.current) {
      activeActorRef.current.retired = true;
      activeActorRef.current = null;
    }
    if (activeControllerRef.current) {
      const ctrl = activeControllerRef.current;
      activeControllerRef.current = null;
      ctrl.dispose();
      setSnapshot(null);
    }
  };

  // Synchronously evaluate lifetime match during render
  const existingLifetime = currentLifetimeRef.current;
  const isLifetimeMatch =
    existingLifetime !== null &&
    !existingLifetime.retired &&
    !props.disabled &&
    existingLifetime.mode === props.mode &&
    existingLifetime.scope.mode === props.scope.mode &&
    existingLifetime.scope.channelEpoch === props.scope.channelEpoch &&
    existingLifetime.scope.sessionEpoch === props.scope.sessionEpoch &&
    existingLifetime.validation === props.validation &&
    existingLifetime.ownerRevision === props.ownerRevision &&
    areFilenamesEqual(existingLifetime.filenames, uniqueFilenames);

  if (!isLifetimeMatch) {
    if (existingLifetime !== null) {
      retireLifetime(existingLifetime);
      currentLifetimeRef.current = null;
    }
    if (!props.disabled) {
      lifetimeIdCounterRef.current += 1;
      const newLifetime: ComponentLifetime = {
        id: lifetimeIdCounterRef.current,
        mode: props.mode,
        scope: Object.freeze({
          mode: props.scope.mode,
          channelEpoch: props.scope.channelEpoch,
          sessionEpoch: props.scope.sessionEpoch,
        }),
        validation: props.validation,
        ownerRevision: props.ownerRevision,
        filenames: uniqueFilenames,
        retired: false,
      };
      currentLifetimeRef.current = newLifetime;
    }
  }

  const renderLifetime = currentLifetimeRef.current;

  const isActorValid = (actor: ConfirmationActor): boolean => {
    if (!isMountedRef.current) return false;
    if (actor.retired) return false;
    const currentLifetime = currentLifetimeRef.current;
    if (!currentLifetime || currentLifetime.retired) return false;
    if (actor.lifetime !== currentLifetime) return false;
    if (props.disabled) return false;

    if (actor.mode !== currentLifetime.mode) return false;
    if (actor.ownerRevision !== currentLifetime.ownerRevision) return false;
    if (actor.validation !== currentLifetime.validation) return false;

    const currentSession = getSessionSnapshot();
    if (currentSession.token === null) return false;
    if (currentSession.sessionEpoch !== actor.scope.sessionEpoch) return false;
    if (!isPanelScopeCurrent(actor.scope, currentSession.sessionEpoch)) return false;

    const currentValidation = getSessionValidationSnapshot();
    if (currentValidation !== actor.validation) return false;
    if (currentValidation.status !== 'verified') return false;
    if (currentValidation.sessionEpoch !== actor.scope.sessionEpoch) return false;

    try {
      if (!actor.isCurrentOwner()) return false;
      if (!props.isCurrentOwner()) return false;
    } catch {
      return false;
    }

    return true;
  };

  const isOwnerCurrent = useMemo(() => {
    if (props.disabled) return false;
    if (!renderLifetime || renderLifetime.retired) return false;
    if (!isPanelMode(props.mode) || props.mode !== props.scope.mode) return false;

    const currentSession = getSessionSnapshot();
    if (currentSession.token === null) return false;
    if (!isPanelScopeCurrent(props.scope, currentSession.sessionEpoch)) return false;

    const currentValidation = getSessionValidationSnapshot();
    if (currentValidation !== props.validation) return false;
    if (currentValidation.status !== 'verified') return false;
    if (currentValidation.sessionEpoch !== props.scope.sessionEpoch) return false;

    try {
      if (!props.isCurrentOwner()) return false;
    } catch {
      return false;
    }

    return true;
  }, [props.disabled, renderLifetime, props.mode, props.scope, props.validation, props.isCurrentOwner]);

  const activeConfirmation =
    confirmation !== null &&
    !confirmation.retired &&
    renderLifetime !== null &&
    confirmation.lifetime === renderLifetime
      ? confirmation
      : null;

  const activeSnapshot =
    snapshot !== null &&
    activeActorRef.current !== null &&
    !activeActorRef.current.retired &&
    renderLifetime !== null &&
    activeActorRef.current.lifetime === renderLifetime
      ? snapshot
      : null;

  useEffect(() => {
    if (confirmation !== null && activeConfirmation === null) {
      setConfirmation(null);
    }
    if (snapshot !== null && activeSnapshot === null) {
      setSnapshot(null);
    }
  });

  useEffect(() => {
    const checkValidity = () => {
      const currentSession = getSessionSnapshot();
      const currentValidation = getSessionValidationSnapshot();
      const currentLifetime = currentLifetimeRef.current;

      let invalidated = false;

      if (currentLifetime && !currentLifetime.retired) {
        const sessionInvalid =
          currentSession.token === null ||
          currentSession.sessionEpoch !== currentLifetime.scope.sessionEpoch ||
          !isPanelScopeCurrent(currentLifetime.scope, currentSession.sessionEpoch);

        const validationInvalid =
          currentValidation !== currentLifetime.validation ||
          currentValidation.status !== 'verified' ||
          currentValidation.sessionEpoch !== currentLifetime.scope.sessionEpoch;

        if (sessionInvalid || validationInvalid) {
          invalidated = true;
          currentLifetime.retired = true;
          currentLifetimeRef.current = null;
        }
      }

      if (confirmationRef.current) {
        const conf = confirmationRef.current;
        if (invalidated || conf.retired || !isActorValid(conf)) {
          conf.retired = true;
          confirmationRef.current = null;
          setConfirmation(null);
        }
      }

      if (activeActorRef.current) {
        const act = activeActorRef.current;
        if (invalidated || act.retired || !isActorValid(act)) {
          act.retired = true;
          activeActorRef.current = null;
          if (activeControllerRef.current) {
            const ctrl = activeControllerRef.current;
            activeControllerRef.current = null;
            ctrl.dispose();
            setSnapshot(null);
          }
        }
      }

      setTick((t) => t + 1);
    };

    const unregSession = subscribeSession(checkValidity);
    const unregValidation = subscribeSessionValidation(checkValidity);
    const unregChannel = subscribePanelChannel(checkValidity);

    return () => {
      unregSession();
      unregValidation();
      unregChannel();
    };
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    if (wasCleanedUpRef.current) {
      wasCleanedUpRef.current = false;
      if (!props.disabled && currentLifetimeRef.current === null) {
        setTick((t) => t + 1);
      }
    }
    return () => {
      isMountedRef.current = false;
      wasCleanedUpRef.current = true;
      retireAllCurrentAndActive();
    };
  }, []);

  const boundLifetime = renderLifetime;
  const capturedIsCurrentOwner = props.isCurrentOwner;

  const handleOpenConfirmation = (operation: BatchOperation, testChoice?: 'default' | 'chosen') => {
    if (!boundLifetime || boundLifetime.retired) return;
    if (boundLifetime !== currentLifetimeRef.current) return;
    if (props.disabled) return;
    if (!isOwnerCurrent) return;

    if (confirmationRef.current !== null && !confirmationRef.current.retired) return;
    if (activeControllerRef.current !== null && activeControllerRef.current.getSnapshot().running) return;

    if (boundLifetime.filenames.length === 0) return;
    if (operation === 'test' && testChoice !== 'default' && testModel.trim() === '') return;
    if (operation === 'preview' && boundLifetime.mode !== 'geminicli') return;

    const session = getSessionSnapshot();
    const validationSnap = getSessionValidationSnapshot();
    if (
      session.token === null ||
      session.sessionEpoch !== boundLifetime.scope.sessionEpoch ||
      !isPanelScopeCurrent(boundLifetime.scope, session.sessionEpoch) ||
      validationSnap !== boundLifetime.validation ||
      validationSnap.status !== 'verified' ||
      validationSnap.sessionEpoch !== boundLifetime.scope.sessionEpoch
    ) {
      return;
    }

    try {
      if (!props.isCurrentOwner()) return;
    } catch {
      return;
    }

    const resolvedChoice: 'default' | 'chosen' | undefined =
      operation === 'test' ? (testChoice ?? (testModel.trim() !== '' ? 'chosen' : 'default')) : undefined;

    confirmationIdCounterRef.current += 1;
    const actor: ConfirmationActor = {
      id: confirmationIdCounterRef.current,
      lifetime: boundLifetime,
      operation,
      testChoice: resolvedChoice,
      filenames: Object.freeze([...boundLifetime.filenames]),
      mode: boundLifetime.mode,
      testModel: operation === 'test' && resolvedChoice !== 'default' ? testModel.trim() : '',
      scope: Object.freeze({
        mode: boundLifetime.scope.mode,
        channelEpoch: boundLifetime.scope.channelEpoch,
        sessionEpoch: boundLifetime.scope.sessionEpoch,
      }),
      validation: boundLifetime.validation,
      ownerRevision: boundLifetime.ownerRevision,
      isCurrentOwner: props.isCurrentOwner,
      onRefresh: props.onRefresh,
      consumed: false,
      retired: false,
      refreshFired: false,
    };

    confirmationRef.current = actor;
    setConfirmation(actor);
  };

  const handleCancel = (actorToCancel: ConfirmationActor) => {
    if (actorToCancel.retired || actorToCancel.consumed) return;
    actorToCancel.retired = true;
    if (confirmationRef.current === actorToCancel) {
      confirmationRef.current = null;
    }
    setConfirmation((curr) => (curr === actorToCancel ? null : curr));
  };

  const handleAttemptSettled = (actor: ConfirmationActor, controller: CredentialBatchController) => {
    if (actor.refreshFired) return;
    if (activeActorRef.current !== actor || actor.retired) return;
    if (!isActorValid(actor)) return;

    const snap = controller.getSnapshot();
    const hasCompleted = snap.items.some((it) => it.phase === 'completed');
    if (!hasCompleted) return;

    actor.refreshFired = true;

    if (typeof actor.onRefresh === 'function') {
      try {
        const res = actor.onRefresh();
        if (res && typeof (res as Promise<void>).catch === 'function') {
          (res as Promise<void>).catch(() => {});
        }
      } catch {
        // Contain thrown callback errors without exposing raw text
      }
    }

    const hasPendingWriteback = snap.items.some((it) => {
      if (it.receipt?.publicDetails?.has_pending_writeback === true) return true;
      if (it.receipt?.updates?.some((u) => u.status === 'pending')) return true;
      return false;
    });

    if (actor.mode === 'antigravity' && actor.operation === 'quota' && hasPendingWriteback) {
      clearDelayedRefreshTimer();
      const timerId = setTimeout(() => {
        if (!isMountedRef.current) return;
        if (delayedRefreshTimerRef.current?.actor !== actor) return;
        delayedRefreshTimerRef.current = null;
        if (actor.retired || !isActorValid(actor)) return;
        if (typeof actor.onRefresh === 'function') {
          try {
            const res = actor.onRefresh();
            if (res && typeof (res as Promise<void>).catch === 'function') {
              (res as Promise<void>).catch(() => {});
            }
          } catch {
            // Contain thrown callback errors without exposing raw text
          }
        }
      }, 30000);
      delayedRefreshTimerRef.current = { timer: timerId, actor };
    }
  };

  const createWorkersForAttempt = (actor: ConfirmationActor): BatchWorkers => {
    const api = createCredentialApi(actor.mode, actor.scope);
    const advanced = actor.mode === 'geminicli' ? createAdvancedCredentialApi(actor.mode, actor.scope) : null;

    const verifyProjectWorker: BatchFileWorker = async (filename: string, signal: AbortSignal) => {
      if (!isActorValid(actor)) {
        throw new DOMException('作用域或会话已失效。', 'AbortError');
      }
      return api.manual(filename, 'verify-project', undefined, signal);
    };

    const testWorker: BatchFileWorker = async (filename: string, signal: AbortSignal) => {
      if (!isActorValid(actor)) {
        throw new DOMException('作用域或会话已失效。', 'AbortError');
      }
      const modelParam = actor.testChoice === 'default' ? undefined : (actor.testModel || undefined);
      return api.manual(filename, 'test', modelParam, signal);
    };

    const quotaWorker: BatchQuotaWorker = async (names: readonly string[], signal: AbortSignal) => {
      if (!isActorValid(actor)) {
        throw new DOMException('作用域或会话已失效。', 'AbortError');
      }
      return api.quotaBatch([...names], signal);
    };

    const previewWorker: BatchFileWorker | undefined =
      actor.mode === 'geminicli' && advanced
        ? async (filename: string, signal: AbortSignal) => {
            if (!isActorValid(actor)) {
              throw new DOMException('作用域或会话已失效。', 'AbortError');
            }
            return advanced.configurePreview(filename, signal);
          }
        : undefined;

    return {
      'verify-project': verifyProjectWorker,
      test: testWorker,
      quota: quotaWorker,
      ...(previewWorker ? { preview: previewWorker } : {}),
    };
  };

  const startAttempt = (actor: ConfirmationActor) => {
    setLocalErrorMessage(null);
    clearDelayedRefreshTimer();

    if (!isActorValid(actor)) {
      actor.retired = true;
      return;
    }

    if (activeControllerRef.current?.getSnapshot().running) {
      return;
    }
    const prevActor = activeActorRef.current;
    if (prevActor && prevActor !== actor) {
      prevActor.retired = true;
    }
    if (activeControllerRef.current) {
      const prevCtrl = activeControllerRef.current;
      activeControllerRef.current = null;
      prevCtrl.dispose();
    }

    activeActorRef.current = actor;

    let workers: BatchWorkers;
    try {
      workers = createWorkersForAttempt(actor);
    } catch {
      actor.retired = true;
      if (activeActorRef.current === actor) {
        activeActorRef.current = null;
      }
      setLocalErrorMessage('批量控制器初始化失败');
      return;
    }

    const controller = createCredentialBatch({
      scope: actor.scope,
      isCurrentOwner: () => isActorValid(actor),
      workers,
    });

    activeControllerRef.current = controller;
    setSnapshot(controller.getSnapshot());

    controller.subscribe(() => {
      if (activeActorRef.current === actor && isActorValid(actor)) {
        setSnapshot(controller.getSnapshot());
      }
    });

    let startPromise: Promise<void>;
    try {
      startPromise = controller.start(actor.operation, actor.filenames);
    } catch (err) {
      startPromise = Promise.reject(err);
    }

    startPromise
      .then(() => {
        if (activeActorRef.current === actor && isActorValid(actor)) {
          handleAttemptSettled(actor, controller);
        }
      })
      .catch(() => {
        if (activeActorRef.current === actor && isActorValid(actor)) {
          setLocalErrorMessage('批量操作执行失败，请重新检查状态');
          handleAttemptSettled(actor, controller);
        }
      });
  };

  const handleConfirm = (actorToConfirm: ConfirmationActor) => {
    if (!boundLifetime || boundLifetime.retired) return;
    if (boundLifetime !== currentLifetimeRef.current) return;
    if (actorToConfirm.retired || actorToConfirm.consumed) return;
    if (actorToConfirm.lifetime !== boundLifetime) return;

    actorToConfirm.consumed = true;
    if (confirmationRef.current === actorToConfirm) {
      confirmationRef.current = null;
    }
    setConfirmation((curr) => (curr === actorToConfirm ? null : curr));

    if (!isActorValid(actorToConfirm)) {
      actorToConfirm.retired = true;
      return;
    }

    startAttempt(actorToConfirm);
  };

  const boundActor = activeActorRef.current;
  const boundController = activeControllerRef.current;

  const handleStop = () => {
    if (!boundLifetime || boundLifetime.retired) return;
    if (boundLifetime !== currentLifetimeRef.current) return;
    if (!boundActor || boundActor.retired) return;
    if (boundActor !== activeActorRef.current) return;
    if (!boundController || boundController !== activeControllerRef.current) return;
    if (!boundController.getSnapshot().running) return;
    if (!isActorValid(boundActor)) return;

    boundController.stop();
  };

  const isRunning = Boolean(activeSnapshot?.running);
  const isBusy = activeConfirmation !== null || isRunning;

  const batchSummary = useMemo(() => {
    if (!activeSnapshot || activeSnapshot.items.length === 0) return null;

    const total = activeSnapshot.items.length;
    let completedCount = 0;
    let notStartedCount = 0;
    let runningCount = 0;
    let queuedCount = 0;
    let successCount = 0;
    let failureCount = 0;
    let unknownCount = 0;
    let pendingWritebacksCount = 0;

    const affectedCooldownCreds = new Set<string>();
    const allClearedModels = new Set<string>();
    const allAddedCooldownModels = new Set<string>();

    const opusStats: Record<string, { supported: number; unavailable: number; unknown: number }> = {};

    for (const item of activeSnapshot.items) {
      if (item.phase === 'completed') {
        completedCount++;
        if (item.receipt) {
          if (item.receipt.outcome === 'success') successCount++;
          else if (item.receipt.outcome === 'failure') failureCount++;
          else unknownCount++;
        }
      } else if (item.phase === 'not-started') {
        notStartedCount++;
      } else if (item.phase === 'running') {
        runningCount++;
      } else if (item.phase === 'queued') {
        queuedCount++;
      }

      if (item.receipt) {

        const hasPending =
          item.receipt.publicDetails?.has_pending_writeback === true ||
          item.receipt.updates.some((u) => u.status === 'pending');
        if (hasPending) {
          pendingWritebacksCount++;
        }

        const details = item.receipt.publicDetails;
        if (details) {
          let hasCooldownChange = false;
          if (details.cleared && details.cleared.length > 0) {
            hasCooldownChange = true;
            for (const m of details.cleared) allClearedModels.add(m);
          }
          if (details.added_cooldown && details.added_cooldown.length > 0) {
            hasCooldownChange = true;
            for (const m of details.added_cooldown) allAddedCooldownModels.add(m);
          }
          if (hasCooldownChange) {
            affectedCooldownCreds.add(item.filename);
          }

          if (details.model_access_families) {
            for (const [family, info] of Object.entries(details.model_access_families)) {
              if (!info) continue;
              if (!opusStats[family]) {
                opusStats[family] = { supported: 0, unavailable: 0, unknown: 0 };
              }
              const st = info.effective_status ?? info.state;
              if (st === 'supported') opusStats[family].supported++;
              else if (st === 'unavailable') opusStats[family].unavailable++;
              else opusStats[family].unknown++;
            }
          }
        }
      }
    }

    return {
      total,
      completedCount,
      notStartedCount,
      runningCount,
      queuedCount,
      successCount,
      failureCount,
      unknownCount,
      pendingWritebacksCount,
      affectedCooldownCredsCount: affectedCooldownCreds.size,
      clearedModels: Array.from(allClearedModels),
      addedCooldownModels: Array.from(allAddedCooldownModels),
      opusStats,
      hasOpusStats: Object.keys(opusStats).length > 0,
      hasCooldownData: affectedCooldownCreds.size > 0 || allClearedModels.size > 0 || allAddedCooldownModels.size > 0,
    };
  }, [activeSnapshot]);

  return (
    <section
      className="space-y-3 rounded-lg border border-border bg-card p-3 text-card-foreground shadow-sm"
      aria-label="批量操作面板"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold">批量操作</h3>
          <p className="text-xs text-muted-foreground">
            已选凭证：<span className="font-medium text-foreground">{uniqueFilenames.length}</span> 项
          </p>
        </div>
        {localErrorMessage && (
          <p className="text-xs text-destructive" role="alert">
            {localErrorMessage}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center">
          <label htmlFor="batch-test-model-input" className="text-xs font-medium text-muted-foreground whitespace-nowrap">
            测试模型：
          </label>
          <Input
            id="batch-test-model-input"
            type="text"
            placeholder="输入测试模型（如 gemini-2.5-flash）"
            value={testModel}
            onChange={(e) => setTestModel(e.target.value)}
            disabled={isBusy || !isOwnerCurrent || uniqueFilenames.length === 0}
            className="h-8 max-w-xs text-xs"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleOpenConfirmation('verify-project')}
            disabled={isBusy || !isOwnerCurrent || uniqueFilenames.length === 0}
          >
            批量项目检验
          </Button>

          {props.mode === 'geminicli' && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleOpenConfirmation('test', 'default')}
              disabled={isBusy || !isOwnerCurrent || uniqueFilenames.length === 0}
            >
              默认消息测试
            </Button>
          )}

          <Button
            variant="outline"
            size="sm"
            onClick={() => handleOpenConfirmation('test', 'chosen')}
            disabled={isBusy || !isOwnerCurrent || uniqueFilenames.length === 0 || testModel.trim() === ''}
          >
            批量模型测试
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={() => handleOpenConfirmation('quota')}
            disabled={isBusy || !isOwnerCurrent || uniqueFilenames.length === 0}
          >
            批量额度刷新
          </Button>

          {props.mode === 'geminicli' && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleOpenConfirmation('preview')}
              disabled={isBusy || !isOwnerCurrent || uniqueFilenames.length === 0}
            >
              批量预览配置
            </Button>
          )}

          <Button
            variant="destructive"
            size="sm"
            onClick={handleStop}
            disabled={!activeSnapshot?.running || activeSnapshot?.stopped}
          >
            停止
          </Button>
        </div>
      </div>

      {activeSnapshot !== null && activeSnapshot.items.length > 0 && (
        <div className="space-y-3 pt-2">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              执行进度 ({activeSnapshot.items.filter((i) => i.phase === 'completed').length} / {activeSnapshot.items.length})
            </h4>
            {activeSnapshot.stopped && <Badge variant="warning">已停止后续任务</Badge>}
          </div>

          {activeSnapshot.stopped && (
            <p className="text-xs text-muted-foreground">
              已停止后续任务；已执行的操作不会被撤销，正在进行中的请求将等待上游响应结算。
            </p>
          )}

          {activeSnapshot.stopReason && (
            <div className="rounded-md border border-amber-500/20 bg-amber-500/10 p-2 text-xs font-medium text-amber-700 dark:text-amber-400">
              停止原因：{activeSnapshot.stopReason}
            </div>
          )}

          {batchSummary && (
            <div className="rounded-lg border border-border bg-muted/20 p-3 text-xs space-y-2">
              <div className="font-semibold text-foreground">批处理统计摘要</div>
              <div className="flex flex-wrap items-center gap-3 text-muted-foreground">
                <span>总计: <span className="font-medium text-foreground">{batchSummary.total}</span></span>
                <span>已完成: <span className="font-medium text-foreground">{batchSummary.completedCount}</span></span>
                {batchSummary.notStartedCount > 0 && (
                  <span>未开始: <span className="font-medium text-foreground">{batchSummary.notStartedCount}</span></span>
                )}
                {batchSummary.successCount > 0 && (
                  <span>成功: <span className="font-medium text-success">{batchSummary.successCount}</span></span>
                )}
                {batchSummary.failureCount > 0 && (
                  <span>失败: <span className="font-medium text-destructive">{batchSummary.failureCount}</span></span>
                )}
                {batchSummary.unknownCount > 0 && (
                  <span>未知: <span className="font-medium text-warning">{batchSummary.unknownCount}</span></span>
                )}
                {batchSummary.pendingWritebacksCount > 0 && (
                  <span>待确认写回: <span className="font-medium text-warning">{batchSummary.pendingWritebacksCount}</span></span>
                )}
              </div>

              {batchSummary.hasCooldownData && (
                <div className="space-y-1 pt-1 border-t border-border/50">
                  <div className="text-muted-foreground">
                    冷却限制变更（受影响凭证: <span className="font-medium text-foreground">{batchSummary.affectedCooldownCredsCount}</span> 项）
                  </div>
                  {batchSummary.clearedModels.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-muted-foreground">已清除冷却:</span>
                      {batchSummary.clearedModels.map((m) => (
                        <Badge key={m} variant="secondary">{m}</Badge>
                      ))}
                    </div>
                  )}
                  {batchSummary.addedCooldownModels.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-muted-foreground">新增冷却:</span>
                      {batchSummary.addedCooldownModels.map((m) => (
                        <Badge key={m} variant="destructive">{m}</Badge>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {batchSummary.hasOpusStats && (
                <div className="space-y-1 pt-1 border-t border-border/50">
                  <div className="text-muted-foreground">Opus 权限汇总：</div>
                  <div className="flex flex-wrap items-center gap-3">
                    {Object.entries(batchSummary.opusStats).map(([family, stats]) => (
                      <div key={family} className="flex items-center gap-1 text-muted-foreground">
                        <span className="font-mono text-foreground">{family}:</span>
                        <span className="text-success font-medium">支持 {stats.supported}</span>
                        <span>/</span>
                        <span className="text-destructive font-medium">不可用 {stats.unavailable}</span>
                        {stats.unknown > 0 && (
                          <>
                            <span>/</span>
                            <span className="text-muted-foreground font-medium">未知 {stats.unknown}</span>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="divide-y divide-border rounded-lg border border-border bg-card">
            {activeSnapshot.items.map((item) => (
              <div key={item.filename} className="p-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono font-medium text-foreground">{item.filename}</span>
                  <div>
                    {item.phase === 'queued' && <Badge variant="secondary">排队中</Badge>}
                    {item.phase === 'running' && <Badge variant="info">执行中</Badge>}
                    {item.phase === 'not-started' && <Badge variant="outline">未开始</Badge>}
                    {item.phase === 'completed' && <Badge variant="default">已完成</Badge>}
                  </div>
                </div>

                {item.receipt && (
                  <div className="mt-2 space-y-1 rounded bg-muted/40 p-2 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        variant={
                          item.receipt.outcome === 'success'
                            ? 'success'
                            : item.receipt.outcome === 'failure'
                            ? 'destructive'
                            : 'warning'
                        }
                      >
                        {item.receipt.outcome === 'success'
                          ? '操作成功'
                          : item.receipt.outcome === 'failure'
                          ? '操作失败'
                          : '结果未知'}
                      </Badge>

                      <span>
                        {typeof item.receipt.httpStatus === 'number'
                          ? `HTTP ${item.receipt.httpStatus}`
                          : 'HTTP: 未知'}
                      </span>

                      <span>
                        {typeof item.receipt.upstreamStatus === 'number'
                          ? `上游 HTTP ${item.receipt.upstreamStatus}`
                          : '上游 HTTP: 未知'}
                      </span>

                      <Badge
                        variant={
                          item.receipt.verifiedReply === true
                            ? 'success'
                            : item.receipt.verifiedReply === false
                            ? 'destructive'
                            : 'outline'
                        }
                      >
                        {item.receipt.verifiedReply === true
                          ? '固定回复校验：通过'
                          : item.receipt.verifiedReply === false
                          ? '固定回复校验：未通过'
                          : '固定回复校验：未知'}
                      </Badge>
                    </div>

                    {(item.receipt.publicDetails?.safe_failure_reason || item.receipt.publicDetails?.failure_reason) && (
                      <div className="font-medium text-destructive pt-1">
                        失败原因：{item.receipt.publicDetails.safe_failure_reason || item.receipt.publicDetails.failure_reason}
                      </div>
                    )}

                    {item.receipt.publicDetails?.error_code && (
                      <div className="text-muted-foreground pt-0.5">
                        错误标识：<span className="font-mono text-foreground">{item.receipt.publicDetails.error_code}</span>
                        {SAFE_ERROR_CODE_LABELS[item.receipt.publicDetails.error_code as keyof typeof SAFE_ERROR_CODE_LABELS]
                          ? ` (${SAFE_ERROR_CODE_LABELS[item.receipt.publicDetails.error_code as keyof typeof SAFE_ERROR_CODE_LABELS]})`
                          : ''}
                      </div>
                    )}

                    {(item.receipt.publicDetails?.project_id !== undefined ||
                      item.receipt.publicDetails?.subscription_tier !== undefined ||
                      typeof item.receipt.publicDetails?.credit_amount === 'number') && (
                      <div className="flex flex-wrap items-center gap-3 pt-1 text-muted-foreground">
                        {item.receipt.publicDetails.project_id && (
                          <span>
                            项目 ID: <span className="font-mono text-foreground">{item.receipt.publicDetails.project_id}</span>
                          </span>
                        )}
                        {item.receipt.publicDetails.subscription_tier && (
                          <span>
                            订阅等级: <span className="font-medium text-foreground">{item.receipt.publicDetails.subscription_tier}</span>
                          </span>
                        )}
                        {typeof item.receipt.publicDetails.credit_amount === 'number' && (
                          <span>
                            积分余额: <span className="font-medium text-foreground">{item.receipt.publicDetails.credit_amount}</span>
                          </span>
                        )}
                      </div>
                    )}

                    {(item.receipt.publicDetails?.setting_id !== undefined ||
                      item.receipt.publicDetails?.binding_id !== undefined ||
                      item.receipt.publicDetails?.step !== undefined) && (
                      <div className="flex flex-wrap items-center gap-3 pt-1 text-muted-foreground">
                        {item.receipt.publicDetails.setting_id && (
                          <span>
                            Setting ID: <span className="font-mono text-foreground">{item.receipt.publicDetails.setting_id}</span>
                          </span>
                        )}
                        {item.receipt.publicDetails.binding_id && (
                          <span>
                            Binding ID: <span className="font-mono text-foreground">{item.receipt.publicDetails.binding_id}</span>
                          </span>
                        )}
                        {item.receipt.publicDetails.step && (
                          <span>
                            失败步骤:{' '}
                            <span className="font-medium text-destructive">
                              {item.receipt.publicDetails.step === 'create_setting'
                                ? '创建配置（create_setting）'
                                : '创建绑定（create_binding）'}
                            </span>
                          </span>
                        )}
                      </div>
                    )}

                    {item.receipt.publicDetails?.cleared && item.receipt.publicDetails.cleared.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5 pt-1">
                        <span className="text-muted-foreground">已清除冷却：</span>
                        {item.receipt.publicDetails.cleared.map((m) => (
                          <Badge key={m} variant="secondary">
                            {m}
                          </Badge>
                        ))}
                      </div>
                    )}

                    {item.receipt.publicDetails?.added_cooldown && item.receipt.publicDetails.added_cooldown.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5 pt-1">
                        <span className="text-muted-foreground">新增冷却：</span>
                        {item.receipt.publicDetails.added_cooldown.map((m) => (
                          <Badge key={m} variant="destructive">
                            {m}
                          </Badge>
                        ))}
                      </div>
                    )}

                    {item.receipt.publicDetails?.skipped_no_quota && item.receipt.publicDetails.skipped_no_quota.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5 pt-1">
                        <span className="text-muted-foreground">跳过 (无额度)：</span>
                        {item.receipt.publicDetails.skipped_no_quota.map((m) => (
                          <Badge key={m} variant="outline">
                            {m}
                          </Badge>
                        ))}
                      </div>
                    )}

                    {item.receipt.publicDetails?.skipped_unknown && item.receipt.publicDetails.skipped_unknown.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5 pt-1">
                        <span className="text-muted-foreground">跳过 (状态未知)：</span>
                        {item.receipt.publicDetails.skipped_unknown.map((m) => (
                          <Badge key={m} variant="outline">
                            {m}
                          </Badge>
                        ))}
                      </div>
                    )}

                    {item.receipt.publicDetails?.model_access_families &&
                      Object.keys(item.receipt.publicDetails.model_access_families).length > 0 && (
                        <div className="flex flex-wrap items-center gap-2 pt-1">
                          <span className="text-muted-foreground">Opus 访问权限：</span>
                          {Object.entries(item.receipt.publicDetails.model_access_families).map(([family, info]) => {
                            if (!info) return null;
                            const st = info.effective_status ?? info.state;
                            return (
                              <Badge
                                key={family}
                                variant={
                                  st === 'supported' ? 'success' : st === 'unavailable' ? 'destructive' : 'outline'
                                }
                              >
                                {family}: {st === 'supported' ? '支持' : st === 'unavailable' ? '不可用' : '未知'}
                              </Badge>
                            );
                          })}
                        </div>
                      )}

                    <div className="flex flex-wrap items-center gap-1.5 pt-1">
                      <span className="text-muted-foreground">写回状态：</span>
                      {item.receipt.updates.length > 0 ? (
                        item.receipt.updates.map((update, idx) => (
                          <Badge
                            key={`${update.name}-${idx}`}
                            variant={
                              update.status === 'applied'
                                ? 'success'
                                : update.status === 'failed'
                                ? 'destructive'
                                : update.status === 'pending'
                                ? 'warning'
                                : update.status === 'skipped'
                                ? 'secondary'
                                : 'outline'
                            }
                          >
                            {update.name}:{' '}
                            {update.status === 'applied'
                              ? '已更新'
                              : update.status === 'failed'
                              ? '更新失败'
                              : update.status === 'pending'
                              ? '待确认'
                              : update.status === 'skipped'
                              ? '未应用'
                              : '状态未知'}
                            {update.reason
                              ? ` (${SAFE_WRITEBACK_REASON_LABELS[update.reason] ?? update.reason})`
                              : ''}
                          </Badge>
                        ))
                      ) : (
                        <span className="text-muted-foreground">未提供写回状态</span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <AlertDialog
        open={activeConfirmation !== null}
        onOpenChange={(open) => {
          if (!open && activeConfirmation) {
            handleCancel(activeConfirmation);
          }
        }}
      >
        <AlertDialogContent
          className="max-w-md rounded-lg p-4"
          onCloseAutoFocus={(e) => {
            if (
              !isMountedRef.current ||
              props.disabled ||
              !boundLifetime ||
              boundLifetime.retired ||
              boundLifetime !== currentLifetimeRef.current ||
              !isOwnerCurrent
            ) {
              e.preventDefault();
              return;
            }

            const currentSession = getSessionSnapshot();
            if (
              currentSession.token === null ||
              currentSession.sessionEpoch !== boundLifetime.scope.sessionEpoch ||
              !isPanelScopeCurrent(boundLifetime.scope, currentSession.sessionEpoch)
            ) {
              e.preventDefault();
              return;
            }

            const currentValidation = getSessionValidationSnapshot();
            if (
              currentValidation !== boundLifetime.validation ||
              currentValidation.status !== 'verified' ||
              currentValidation.sessionEpoch !== boundLifetime.scope.sessionEpoch
            ) {
              e.preventDefault();
              return;
            }

            try {
              if (!capturedIsCurrentOwner()) {
                e.preventDefault();
                return;
              }
            } catch {
              e.preventDefault();
              return;
            }
          }}
        >
          <AlertDialogHeader className="space-y-1">
            <AlertDialogTitle className="text-base font-semibold">确认批量操作</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-xs text-muted-foreground">
                <p>
                  渠道模式：
                  <span className="font-medium text-foreground">
                    {activeConfirmation?.mode === 'antigravity' ? 'Antigravity' : 'Gemini CLI'}
                  </span>
                </p>
                <p>
                  已选凭证：
                  <span className="font-medium text-foreground">
                    {activeConfirmation?.filenames.length} 项
                  </span>
                </p>
                <p>
                  操作类型：
                  <span className="font-medium text-foreground">
                    {activeConfirmation?.operation === 'verify-project'
                      ? '项目检验'
                      : activeConfirmation?.operation === 'test'
                      ? activeConfirmation.testChoice === 'default'
                        ? '默认消息测试（省略模型）'
                        : `模型测试（${activeConfirmation.testModel}）`
                      : activeConfirmation?.operation === 'quota'
                      ? '额度刷新'
                      : '预览配置'}
                  </span>
                </p>
                <p className="rounded bg-muted p-2 text-foreground">
                  {activeConfirmation?.operation === 'test'
                    ? activeConfirmation.testChoice === 'default'
                      ? '测试将不指定模型发起默认消息测试，并可能触发后端 Preview 探测流程，请确认。'
                      : `测试可能向上游发起实际模型请求（模型: ${activeConfirmation.testModel}），请确认。`
                    : `${
                        activeConfirmation?.operation === 'verify-project'
                          ? '项目检验'
                          : activeConfirmation?.operation === 'quota'
                          ? '额度刷新'
                          : '预览配置'
                      }将联系上游或更新凭证状态，请确认。`}
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="mt-2 gap-2">
            <AlertDialogCancel
              className="h-8 px-3 text-xs"
              onClick={(e) => {
                e.preventDefault();
                if (activeConfirmation) handleCancel(activeConfirmation);
              }}
            >
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              className="h-8 px-3 text-xs"
              onClick={(e) => {
                e.preventDefault();
                if (activeConfirmation) handleConfirm(activeConfirmation);
              }}
            >
              确认执行
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
