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
import { createCredentialApi } from './api';
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

interface ConfirmationActor {
  readonly id: number;
  readonly operation: BatchOperation;
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
  const confirmationRef = useRef<ConfirmationActor | null>(null);
  const activeActorRef = useRef<ConfirmationActor | null>(null);
  const activeControllerRef = useRef<CredentialBatchController | null>(null);
  const confirmationIdCounterRef = useRef<number>(0);

  const prevOwnerRevisionRef = useRef<object>(props.ownerRevision);
  const prevFilenamesRef = useRef<readonly string[]>(props.filenames);
  const prevScopeRef = useRef<PanelScope>(props.scope);
  const prevValidationRef = useRef<SessionValidationSnapshot>(props.validation);
  const prevDisabledRef = useRef<boolean | undefined>(props.disabled);
  const prevModeRef = useRef<PanelMode>(props.mode);

  const uniqueFilenames = useMemo(() => dedupeFilenames(props.filenames), [props.filenames]);

  const isOwnerCurrent = useMemo(() => {
    if (props.disabled) return false;
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
  }, [props.disabled, props.mode, props.scope, props.validation, props.isCurrentOwner]);

  const isAttemptCurrent = (actor: ConfirmationActor): boolean => {
    if (!isMountedRef.current) return false;
    if (actor.retired) return false;
    if (props.disabled) return false;
    if (props.ownerRevision !== actor.ownerRevision) return false;
    if (!areFilenamesEqual(props.filenames, actor.filenames)) return false;
    if (props.mode !== actor.mode) return false;

    const currentSession = getSessionSnapshot();
    if (currentSession.token === null) return false;
    if (currentSession.sessionEpoch !== actor.scope.sessionEpoch) return false;
    if (!isPanelScopeCurrent(actor.scope, currentSession.sessionEpoch)) return false;

    const currentValidation = getSessionValidationSnapshot();
    if (currentValidation !== actor.validation) return false;
    if (currentValidation.status !== 'verified') return false;
    if (currentValidation.sessionEpoch !== actor.scope.sessionEpoch) return false;

    try {
      if (!actor.isCurrentOwner() || !props.isCurrentOwner()) return false;
    } catch {
      return false;
    }

    return true;
  };

  const retireCurrentAndActive = () => {
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
      activeControllerRef.current.dispose();
      activeControllerRef.current = null;
      setSnapshot(null);
    }
  };

  useEffect(() => {
    const ownerChanged = props.ownerRevision !== prevOwnerRevisionRef.current;
    const filenamesChanged = !areFilenamesEqual(props.filenames, prevFilenamesRef.current);
    const modeChanged = props.mode !== prevModeRef.current;
    const scopeChanged =
      props.scope !== prevScopeRef.current &&
      (props.scope.mode !== prevScopeRef.current?.mode ||
        props.scope.channelEpoch !== prevScopeRef.current?.channelEpoch ||
        props.scope.sessionEpoch !== prevScopeRef.current?.sessionEpoch);
    const validationChanged =
      props.validation !== prevValidationRef.current || props.validation.status !== 'verified';
    const disabledChanged = props.disabled === true && prevDisabledRef.current !== true;

    prevOwnerRevisionRef.current = props.ownerRevision;
    prevFilenamesRef.current = props.filenames;
    prevModeRef.current = props.mode;
    prevScopeRef.current = props.scope;
    prevValidationRef.current = props.validation;
    prevDisabledRef.current = props.disabled;

    if (ownerChanged || filenamesChanged || modeChanged || scopeChanged || validationChanged || disabledChanged) {
      retireCurrentAndActive();
    }
  });

  useEffect(() => {
    const checkValidity = () => {
      setTick((t) => t + 1);

      const activeActor = activeActorRef.current;
      const currentConfirmation = confirmationRef.current;

      if (currentConfirmation && !currentConfirmation.retired && !currentConfirmation.consumed) {
        if (!isAttemptCurrent(currentConfirmation)) {
          currentConfirmation.retired = true;
          confirmationRef.current = null;
          setConfirmation(null);
        }
      }

      if (activeActor && !activeActor.retired) {
        if (!isAttemptCurrent(activeActor)) {
          activeActor.retired = true;
          activeActorRef.current = null;
          if (activeControllerRef.current) {
            activeControllerRef.current.dispose();
            activeControllerRef.current = null;
            setSnapshot(null);
          }
        }
      }
    };

    const unregSession = subscribeSession(checkValidity);
    const unregValidation = subscribeSessionValidation(checkValidity);
    const unregChannel = subscribePanelChannel(checkValidity);

    return () => {
      unregSession();
      unregValidation();
      unregChannel();
    };
  }, [props.disabled, props.ownerRevision, props.filenames, props.isCurrentOwner, props.mode, props.scope, props.validation]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      retireCurrentAndActive();
    };
  }, []);

  const handleOpenConfirmation = (operation: BatchOperation) => {
    if (isBusy || !isOwnerCurrent || props.disabled) return;
    if (uniqueFilenames.length === 0) return;
    if (operation === 'test' && testModel.trim() === '') return;
    if (operation === 'preview' && props.mode !== 'geminicli') return;

    const session = getSessionSnapshot();
    const validationSnap = getSessionValidationSnapshot();
    if (
      session.token === null ||
      !isPanelScopeCurrent(props.scope, session.sessionEpoch) ||
      validationSnap !== props.validation ||
      validationSnap.status !== 'verified'
    ) {
      return;
    }
    try {
      if (!props.isCurrentOwner()) return;
    } catch {
      return;
    }

    confirmationIdCounterRef.current++;
    const actor: ConfirmationActor = {
      id: confirmationIdCounterRef.current,
      operation,
      filenames: Object.freeze([...uniqueFilenames]),
      mode: props.mode,
      testModel: operation === 'test' ? testModel.trim() : '',
      scope: Object.freeze({
        mode: props.scope.mode,
        channelEpoch: props.scope.channelEpoch,
        sessionEpoch: props.scope.sessionEpoch,
      }),
      validation: props.validation,
      ownerRevision: props.ownerRevision,
      isCurrentOwner: props.isCurrentOwner,
      onRefresh: props.onRefresh,
      consumed: false,
      retired: false,
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
    if (!isAttemptCurrent(actor)) return;

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
  };

  const createWorkersForAttempt = (actor: ConfirmationActor): BatchWorkers => {
    const api = createCredentialApi(actor.mode, actor.scope);
    const advanced = actor.mode === 'geminicli' ? createAdvancedCredentialApi(actor.mode, actor.scope) : null;

    const verifyProjectWorker: BatchFileWorker = async (filename: string, signal: AbortSignal) => {
      if (!isAttemptCurrent(actor)) {
        throw new DOMException('作用域或会话已失效。', 'AbortError');
      }
      return api.manual(filename, 'verify-project', undefined, signal);
    };

    const testWorker: BatchFileWorker = async (filename: string, signal: AbortSignal) => {
      if (!isAttemptCurrent(actor)) {
        throw new DOMException('作用域或会话已失效。', 'AbortError');
      }
      return api.manual(filename, 'test', actor.testModel, signal);
    };

    const quotaWorker: BatchQuotaWorker = async (names: readonly string[], signal: AbortSignal) => {
      if (!isAttemptCurrent(actor)) {
        throw new DOMException('作用域或会话已失效。', 'AbortError');
      }
      return api.quotaBatch([...names], signal);
    };

    const previewWorker: BatchFileWorker | undefined =
      actor.mode === 'geminicli' && advanced
        ? async (filename: string, signal: AbortSignal) => {
            if (!isAttemptCurrent(actor)) {
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

    if (activeControllerRef.current?.getSnapshot().running) {
      return;
    }
    if (activeControllerRef.current) {
      activeControllerRef.current.dispose();
      activeControllerRef.current = null;
    }

    activeActorRef.current = actor;

    let workers: BatchWorkers;
    try {
      workers = createWorkersForAttempt(actor);
    } catch {
      actor.retired = true;
      setLocalErrorMessage('批量控制器初始化失败');
      return;
    }

    const controller = createCredentialBatch({
      scope: actor.scope,
      isCurrentOwner: () => isAttemptCurrent(actor),
      workers,
    });

    activeControllerRef.current = controller;
    setSnapshot(controller.getSnapshot());

    controller.subscribe(() => {
      if (activeActorRef.current === actor && !actor.retired) {
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
        handleAttemptSettled(actor, controller);
      })
      .catch(() => {
        setLocalErrorMessage('批量操作执行失败，请重新检查状态');
        handleAttemptSettled(actor, controller);
      });
  };

  const handleConfirm = (actorToConfirm: ConfirmationActor) => {
    if (actorToConfirm.retired || actorToConfirm.consumed) return;
    actorToConfirm.consumed = true;
    if (confirmationRef.current === actorToConfirm) {
      confirmationRef.current = null;
    }
    setConfirmation((curr) => (curr === actorToConfirm ? null : curr));

    if (!isAttemptCurrent(actorToConfirm)) {
      actorToConfirm.retired = true;
      return;
    }

    startAttempt(actorToConfirm);
  };

  const handleStop = () => {
    if (!activeControllerRef.current) return;
    activeControllerRef.current.stop();
  };

  const isRunning = Boolean(snapshot?.running);
  const isBusy = confirmation !== null || isRunning;

  return (
    <section
      className="space-y-4 rounded-xl border border-border bg-card p-4 text-card-foreground shadow-sm"
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

          <Button
            variant="outline"
            size="sm"
            onClick={() => handleOpenConfirmation('test')}
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
            disabled={!snapshot?.running || snapshot?.stopped}
          >
            停止
          </Button>
        </div>
      </div>

      {snapshot !== null && snapshot.items.length > 0 && (
        <div className="space-y-3 pt-2">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              执行进度 ({snapshot.items.filter((i) => i.phase === 'completed').length} / {snapshot.items.length})
            </h4>
            {snapshot.stopped && <Badge variant="warning">已停止后续任务</Badge>}
          </div>

          {snapshot.stopped && (
            <p className="text-xs text-muted-foreground">
              已停止后续任务；已执行的操作不会被撤销，正在进行中的请求将等待上游响应结算。
            </p>
          )}

          <div className="divide-y divide-border rounded-lg border border-border bg-card">
            {snapshot.items.map((item) => (
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
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open && confirmation) {
            handleCancel(confirmation);
          }
        }}
      >
        <AlertDialogContent
          onCloseAutoFocus={(e) => {
            if (!isMountedRef.current || !isOwnerCurrent) {
              e.preventDefault();
            }
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>确认批量操作</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-xs text-muted-foreground">
                <p>
                  渠道模式：
                  <span className="font-medium text-foreground">
                    {confirmation?.mode === 'antigravity' ? 'Antigravity' : 'Gemini CLI'}
                  </span>
                </p>
                <p>
                  已选凭证：
                  <span className="font-medium text-foreground">
                    {confirmation?.filenames.length} 项
                  </span>
                </p>
                <p>
                  操作类型：
                  <span className="font-medium text-foreground">
                    {confirmation?.operation === 'verify-project'
                      ? '项目检验'
                      : confirmation?.operation === 'test'
                      ? `模型测试（${confirmation.testModel}）`
                      : confirmation?.operation === 'quota'
                      ? '额度刷新'
                      : '预览配置'}
                  </span>
                </p>
                <p className="rounded bg-muted p-2 text-foreground">
                  {confirmation?.operation === 'test'
                    ? `测试可能向上游发起实际模型请求（模型: ${confirmation.testModel}），请确认。`
                    : `${
                        confirmation?.operation === 'verify-project'
                          ? '项目检验'
                          : confirmation?.operation === 'quota'
                          ? '额度刷新'
                          : '预览配置'
                      }将联系上游或更新凭证状态，请确认。`}
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={(e) => {
                e.preventDefault();
                if (confirmation) handleCancel(confirmation);
              }}
            >
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (confirmation) handleConfirm(confirmation);
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
