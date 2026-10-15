import { useState, useEffect, useRef, useCallback } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { getServiceBase } from '@/api/client';
import { useAuth } from '@/auth';
import {
  getSessionSnapshot,
  getSessionValidationSnapshot,
  registerSessionCleanup,
  subscribeSessionValidation,
} from '@/auth/session';
import { getStorageState, getSystemStatus, previewStorageMigration } from '../api';
import { endpointPresetDraft, keepaliveServiceUrl } from '../tools';
import type { StoragePreview, StorageState, SystemStatus, Smart429Status, RedisStatus } from '../tools';
import { editable, fields } from '../types';
import type { Draft, EmbedPolicySource, Snapshot } from '../types';
import { loadNodeInfo } from '../../overview/nodeInfo';
import type { NodeOverviewData } from '../../overview/nodeInfo';

export type MigrationIntent = {
  targetEngine: 'sqlite' | 'mysql';
  serverName: string;
  preview: StoragePreview | null;
  currentEngine?: string;
};

export type NativeSettingsToolsProps = {
  snapshot?: Snapshot;
  disabled?: boolean;
  onDraftPatch?: (patch: Draft) => void;
  onRequestMigration?: (intent: MigrationIntent) => void;
};

function formatCount(val: number | undefined | null): string {
  if (val === undefined || val === null || !Number.isFinite(val)) {
    return '未知';
  }
  return String(val);
}

function formatSmartBlockedReason(reason: Smart429Status['blockedReason']): string {
  if (reason === null) return '未报告阻断原因';
  if (reason === 'multi_instance_unsupported') return '多实例环境下不受支持';
  if (reason === 'health_storage_capability_missing') return '健康存储能力缺失';
  if (reason === 'health_storage_unavailable') return '健康存储不可用';
  if (reason === 'unknown') return '受阻（原因未知）';
  return '未知';
}

function formatRedisDiagnostic(diagnostic: RedisStatus['diagnostic']): string {
  if (diagnostic === 'redis_unavailable') return 'Redis 不可用或未设置';
  if (diagnostic === 'unknown') return '状态未知';
  return '未提供诊断';
}

function formatEmbedSource(source?: EmbedPolicySource): string {
  if (source === 'environment') return '环境变量 (environment)';
  if (source === 'storage') return '存储配置 (storage)';
  if (source === 'default') return '默认配置 (default)';
  return '未知';
}

function formatEmbedValidity(
  valid: boolean | 'unknown' | undefined,
  mode: unknown
): string {
  if (valid === true) {
    if (mode === 'disabled') {
      return '有效（已配置禁用）';
    }
    return '有效';
  }
  if (valid === false) {
    return '策略无效（已阻断/Fail-closed）';
  }
  return '未知';
}

function formatEmbedLocked(locked: boolean | 'unknown' | undefined): string {
  if (locked === true) return '已锁定';
  if (locked === false) return '未锁定';
  return '未报告';
}

export function NativeSettingsTools({
  snapshot,
  disabled = false,
  onDraftPatch,
  onRequestMigration,
}: NativeSettingsToolsProps) {
  const { authenticated, validationStatus, sessionEpoch } = useAuth();

  const mountedRef = useRef(true);
  const attemptRef = useRef(0);
  const readControllerRef = useRef<AbortController | null>(null);
  const previewAbortRef = useRef<AbortController | null>(null);
  const previewAttemptRef = useRef(0);
  const validationGenerationRef = useRef(0);
  const lastVerifiedRef = useRef(false);
  const initialVerifiedRef = useRef<boolean | null>(null);

  const [, setRenderTick] = useState(0);

  const isLiveVerified = useCallback((): boolean => {
    if (!authenticated || validationStatus !== 'verified') {
      return false;
    }
    const valSnap = getSessionValidationSnapshot();
    const currentSnap = getSessionSnapshot();
    return (
      valSnap.status === 'verified' &&
      valSnap.sessionEpoch === sessionEpoch &&
      currentSnap.sessionEpoch === sessionEpoch &&
      currentSnap.token !== null
    );
  }, [authenticated, validationStatus, sessionEpoch]);

  const isVerified = isLiveVerified();

  if (initialVerifiedRef.current === null) {
    initialVerifiedRef.current = isVerified;
    lastVerifiedRef.current = isVerified;
    validationGenerationRef.current = isVerified ? 1 : 0;
  }

  const currentEpoch = sessionEpoch;
  const currentGeneration = validationGenerationRef.current;

  const checkCapturedOwnership = useCallback(
    (capturedEpoch: number, capturedGeneration: number): boolean => {
      if (!mountedRef.current) {
        return false;
      }
      if (validationGenerationRef.current !== capturedGeneration) {
        return false;
      }
      const valSnap = getSessionValidationSnapshot();
      const currentSnap = getSessionSnapshot();
      return (
        valSnap.status === 'verified' &&
        valSnap.sessionEpoch === capturedEpoch &&
        currentSnap.sessionEpoch === capturedEpoch &&
        currentSnap.token !== null
      );
    },
    []
  );

  // Storage state
  const [storageState, setStorageState] = useState<StorageState | null>(null);
  const [storageLoading, setStorageLoading] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);

  // System status
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [systemLoading, setSystemLoading] = useState(false);
  const [systemError, setSystemError] = useState<string | null>(null);

  // Node info
  const [nodeInfo, setNodeInfo] = useState<NodeOverviewData | null>(null);
  const [nodeLoading, setNodeLoading] = useState(false);
  const [nodeError, setNodeError] = useState<string | null>(null);

  // Preview state (explicit only)
  const [previewData, setPreviewData] = useState<StoragePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Migration form state
  const [targetEngine, setTargetEngine] = useState<'sqlite' | 'mysql'>('mysql');
  const [serverName, setServerName] = useState<string>('');

  // Keepalive URL helper state
  const [keepaliveInput, setKeepaliveInput] = useState<string>('');

  const invalidateSessionState = useCallback(() => {
    validationGenerationRef.current++;
    attemptRef.current++;
    previewAttemptRef.current++;

    if (readControllerRef.current) {
      readControllerRef.current.abort();
      readControllerRef.current = null;
    }
    if (previewAbortRef.current) {
      previewAbortRef.current.abort();
      previewAbortRef.current = null;
    }

    setStorageState(null);
    setStorageLoading(false);
    setStorageError(null);

    setSystemStatus(null);
    setSystemLoading(false);
    setSystemError(null);

    setNodeInfo(null);
    setNodeLoading(false);
    setNodeError(null);

    setPreviewData(null);
    setPreviewLoading(false);
    setPreviewError(null);

    setTargetEngine('mysql');
    setServerName('');
    setKeepaliveInput('');
  }, []);

  // Session & validation subscriptions
  useEffect(() => {
    mountedRef.current = true;

    const unregValidation = subscribeSessionValidation(() => {
      if (!mountedRef.current) return;
      const valSnap = getSessionValidationSnapshot();
      const snap = getSessionSnapshot();
      const isNowVerified =
        valSnap.status === 'verified' &&
        valSnap.sessionEpoch === snap.sessionEpoch &&
        snap.token !== null;

      if (isNowVerified) {
        if (!lastVerifiedRef.current) {
          lastVerifiedRef.current = true;
          validationGenerationRef.current++;
          setRenderTick((t) => t + 1);
        }
      } else {
        if (lastVerifiedRef.current) {
          lastVerifiedRef.current = false;
          invalidateSessionState();
        }
      }
    });

    const unregCleanup = registerSessionCleanup(() => {
      if (!mountedRef.current) return;
      lastVerifiedRef.current = false;
      invalidateSessionState();
    });

    return () => {
      mountedRef.current = false;
      unregValidation();
      unregCleanup();
      if (readControllerRef.current) {
        readControllerRef.current.abort();
        readControllerRef.current = null;
      }
      if (previewAbortRef.current) {
        previewAbortRef.current.abort();
        previewAbortRef.current = null;
      }
    };
  }, [invalidateSessionState]);

  // Guarded serverName initial value from storage state if not yet set
  useEffect(() => {
    const capturedEpoch = currentEpoch;
    const capturedGeneration = currentGeneration;
    if (!checkCapturedOwnership(capturedEpoch, capturedGeneration)) {
      return;
    }
    if (storageState?.serverName && !serverName) {
      setServerName(storageState.serverName);
    }
  }, [checkCapturedOwnership, currentEpoch, currentGeneration, storageState?.serverName, serverName]);

  // Guarded keepalive default initialization from snapshot or current service base
  useEffect(() => {
    const capturedEpoch = currentEpoch;
    const capturedGeneration = currentGeneration;
    if (!checkCapturedOwnership(capturedEpoch, capturedGeneration)) {
      return;
    }
    if (snapshot?.config?.keepalive_url !== undefined && snapshot.config.keepalive_url !== '') {
      setKeepaliveInput(String(snapshot.config.keepalive_url));
    } else {
      try {
        const base = getServiceBase();
        const defaultUrl = keepaliveServiceUrl(base);
        setKeepaliveInput(defaultUrl);
      } catch {
        setKeepaliveInput('');
      }
    }
  }, [checkCapturedOwnership, currentEpoch, currentGeneration, snapshot]);

  // Read state/system/node data with captured attempt/owner/generation guards
  const loadData = useCallback(async () => {
    const capturedEpoch = currentEpoch;
    const capturedGeneration = currentGeneration;

    if (!checkCapturedOwnership(capturedEpoch, capturedGeneration)) {
      return;
    }

    if (readControllerRef.current) {
      readControllerRef.current.abort();
      readControllerRef.current = null;
    }
    const controller = new AbortController();
    readControllerRef.current = controller;

    const currentAttempt = ++attemptRef.current;

    const isReadCurrent = () =>
      mountedRef.current &&
      attemptRef.current === currentAttempt &&
      validationGenerationRef.current === capturedGeneration &&
      getSessionSnapshot().sessionEpoch === capturedEpoch &&
      getSessionSnapshot().token !== null &&
      getSessionValidationSnapshot().sessionEpoch === capturedEpoch &&
      getSessionValidationSnapshot().status === 'verified';

    setStorageLoading(true);
    setStorageError(null);
    setSystemLoading(true);
    setSystemError(null);
    setNodeLoading(true);
    setNodeError(null);

    // 1. Storage State
    void (async () => {
      try {
        const state = await getStorageState(controller.signal);
        if (isReadCurrent() && !controller.signal.aborted) {
          setStorageState(state);
        }
      } catch {
        if (isReadCurrent() && !controller.signal.aborted) {
          setStorageError('读取存储状态失败');
        }
      } finally {
        if (isReadCurrent()) {
          setStorageLoading(false);
        }
      }
    })();

    // 2. System Status
    void (async () => {
      try {
        const sys = await getSystemStatus(controller.signal);
        if (isReadCurrent() && !controller.signal.aborted) {
          setSystemStatus(sys);
        }
      } catch {
        if (isReadCurrent() && !controller.signal.aborted) {
          setSystemError('读取系统状态失败');
        }
      } finally {
        if (isReadCurrent()) {
          setSystemLoading(false);
        }
      }
    })();

    // 3. Node Info
    void (async () => {
      try {
        const info = await loadNodeInfo(controller.signal);
        if (isReadCurrent() && !controller.signal.aborted) {
          setNodeInfo(info);
        }
      } catch {
        if (isReadCurrent() && !controller.signal.aborted) {
          setNodeError('读取节点信息失败');
        }
      } finally {
        if (isReadCurrent()) {
          setNodeLoading(false);
        }
      }
    })();
  }, [checkCapturedOwnership, currentEpoch, currentGeneration]);

  // Trigger read once on authenticated entry and session switch
  useEffect(() => {
    if (isVerified) {
      void loadData();
    } else {
      if (readControllerRef.current) {
        readControllerRef.current.abort();
        readControllerRef.current = null;
      }
      if (previewAbortRef.current) {
        previewAbortRef.current.abort();
        previewAbortRef.current = null;
      }
      setStorageState(null);
      setStorageLoading(false);
      setStorageError(null);
      setSystemStatus(null);
      setSystemLoading(false);
      setSystemError(null);
      setNodeInfo(null);
      setNodeLoading(false);
      setNodeError(null);
      setPreviewData(null);
      setPreviewLoading(false);
      setPreviewError(null);
      setTargetEngine('mysql');
      setServerName('');
      setKeepaliveInput('');
    }
  }, [isVerified, sessionEpoch, loadData]);

  // Explicit storage migration preview
  const handleFetchPreview = useCallback(async () => {
    const capturedEpoch = currentEpoch;
    const capturedGeneration = currentGeneration;

    if (disabled || !checkCapturedOwnership(capturedEpoch, capturedGeneration)) return;

    if (previewAbortRef.current) {
      previewAbortRef.current.abort();
      previewAbortRef.current = null;
    }
    const controller = new AbortController();
    previewAbortRef.current = controller;

    const currentAttempt = ++previewAttemptRef.current;

    setPreviewLoading(true);
    setPreviewError(null);

    const isPreviewCurrent = () =>
      mountedRef.current &&
      previewAttemptRef.current === currentAttempt &&
      validationGenerationRef.current === capturedGeneration &&
      getSessionSnapshot().sessionEpoch === capturedEpoch &&
      getSessionSnapshot().token !== null &&
      getSessionValidationSnapshot().sessionEpoch === capturedEpoch &&
      getSessionValidationSnapshot().status === 'verified';

    try {
      const preview = await previewStorageMigration(controller.signal);
      if (isPreviewCurrent() && !controller.signal.aborted) {
        setPreviewData(preview);
      }
    } catch {
      if (isPreviewCurrent() && !controller.signal.aborted) {
        setPreviewError('获取存储迁移预览失败');
      }
    } finally {
      if (isPreviewCurrent()) {
        setPreviewLoading(false);
      }
    }
  }, [disabled, checkCapturedOwnership, currentEpoch, currentGeneration]);

  // Draft preset tools
  const draftToolsDisabled = disabled || !isVerified || !snapshot || !onDraftPatch;
  const keepaliveField = fields.find((f) => f.key === 'keepalive_url');
  const isKeepaliveLocked = snapshot && keepaliveField ? !editable(keepaliveField, snapshot) : true;

  const handleApplyMirrorPresets = useCallback(() => {
    const capturedEpoch = currentEpoch;
    const capturedGeneration = currentGeneration;
    if (draftToolsDisabled || !checkCapturedOwnership(capturedEpoch, capturedGeneration) || !snapshot || !onDraftPatch) return;
    const patch = endpointPresetDraft('mirror', snapshot);
    onDraftPatch(patch);
  }, [draftToolsDisabled, checkCapturedOwnership, currentEpoch, currentGeneration, snapshot, onDraftPatch]);

  const handleApplyOfficialPresets = useCallback(() => {
    const capturedEpoch = currentEpoch;
    const capturedGeneration = currentGeneration;
    if (draftToolsDisabled || !checkCapturedOwnership(capturedEpoch, capturedGeneration) || !snapshot || !onDraftPatch) return;
    const patch = endpointPresetDraft('official', snapshot);
    onDraftPatch(patch);
  }, [draftToolsDisabled, checkCapturedOwnership, currentEpoch, currentGeneration, snapshot, onDraftPatch]);

  const handleApplyKeepaliveInput = useCallback(() => {
    const capturedEpoch = currentEpoch;
    const capturedGeneration = currentGeneration;
    if (
      draftToolsDisabled ||
      isKeepaliveLocked ||
      !checkCapturedOwnership(capturedEpoch, capturedGeneration) ||
      !keepaliveInput.trim() ||
      !onDraftPatch
    ) return;
    onDraftPatch({ keepalive_url: keepaliveInput.trim() });
  }, [draftToolsDisabled, isKeepaliveLocked, checkCapturedOwnership, currentEpoch, currentGeneration, keepaliveInput, onDraftPatch]);

  const handleFillServiceBaseKeepalive = useCallback(() => {
    const capturedEpoch = currentEpoch;
    const capturedGeneration = currentGeneration;
    if (
      draftToolsDisabled ||
      isKeepaliveLocked ||
      !checkCapturedOwnership(capturedEpoch, capturedGeneration) ||
      !onDraftPatch
    ) return;
    try {
      const base = getServiceBase();
      const serviceUrl = keepaliveServiceUrl(base);
      setKeepaliveInput(serviceUrl);
      onDraftPatch({ keepalive_url: serviceUrl });
    } catch {
      // Ignore if service base cannot be parsed
    }
  }, [draftToolsDisabled, isKeepaliveLocked, checkCapturedOwnership, currentEpoch, currentGeneration, onDraftPatch]);

  // Migration intent handling
  const isMigrationIntentDisabled =
    disabled ||
    !isVerified ||
    !onRequestMigration ||
    (targetEngine === 'mysql' && !serverName.trim());

  const handleRequestMigration = useCallback(() => {
    const capturedEpoch = currentEpoch;
    const capturedGeneration = currentGeneration;
    if (
      isMigrationIntentDisabled ||
      !checkCapturedOwnership(capturedEpoch, capturedGeneration) ||
      !onRequestMigration
    ) return;
    onRequestMigration({
      targetEngine,
      serverName: targetEngine === 'sqlite' ? serverName : serverName.trim(),
      preview: previewData,
      ...(storageState?.currentEngine !== undefined ? { currentEngine: storageState.currentEngine } : {}),
    });
  }, [
    isMigrationIntentDisabled,
    checkCapturedOwnership,
    currentEpoch,
    currentGeneration,
    onRequestMigration,
    targetEngine,
    serverName,
    previewData,
    storageState?.currentEngine,
  ]);

  const isAnyLoading = storageLoading || systemLoading || nodeLoading;

  return (
    <div className="space-y-6">
      {/* Top Header / Actions Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">原生设置与运行诊断工具</h2>
          <p className="text-[13px] text-muted-foreground">
            存储引擎诊断与切换、Redis 及 SMART 429 系统状态、节点端点观察及端点预设草稿工具。
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void loadData()}
          disabled={disabled || !isVerified || isAnyLoading}
        >
          {isAnyLoading ? '正在刷新…' : '刷新所有状态'}
        </Button>
      </div>

      {!isVerified && (
        <p role="status" className="rounded-lg border border-warning/30 bg-warning-bg p-3 text-[13px] text-warning">
          未登录或面板会话已失效。请登录后查看运行状态与使用工具。
        </p>
      )}

      {/* 1. Storage Engine & Migration Section */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">存储引擎与迁移（SQLite / MySQL）</CardTitle>
          <CardDescription className="text-[13px]">
            查看当前存储引擎与 MySQL 可用性。切换存储引擎需经页面确认，本组件不执行实际写入或配置保存。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {storageError && (
            <p role="alert" className="text-[13px] text-destructive">
              存储状态读取失败：{storageError}
            </p>
          )}

          {/* Current storage info */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
            <div className="rounded-md border border-border p-2.5 bg-background">
              <span className="text-[13px] text-muted-foreground block">当前存储引擎</span>
              <span className="font-medium text-foreground">
                {storageState?.currentEngine ?? (storageLoading ? '读取中…' : '未知')}
              </span>
              {storageState?.currentEngine &&
                storageState.currentEngine !== 'sqlite' &&
                storageState.currentEngine !== 'mysql' && (
                  <span className="text-[13px] text-muted-foreground block mt-0.5">
                    （当前其他后端不承诺支持在线切换）
                  </span>
                )}
            </div>
            <div className="rounded-md border border-border p-2.5 bg-background">
              <span className="text-[13px] text-muted-foreground block">MySQL 可用性 (mysqlAvailable)</span>
              <span className="font-medium text-foreground">
                {storageState
                  ? storageState.mysqlAvailable === undefined
                    ? '未知'
                    : storageState.mysqlAvailable
                      ? '可用'
                      : '不可用'
                  : storageLoading
                    ? '读取中…'
                    : '未知'}
              </span>
            </div>
            <div className="rounded-md border border-border p-2.5 bg-background">
              <span className="text-[13px] text-muted-foreground block">MySQL 配置状态 (mysqlConfigured)</span>
              <span className="font-medium text-foreground">
                {storageState
                  ? storageState.mysqlConfigured === undefined
                    ? '未知'
                    : storageState.mysqlConfigured
                      ? '已配置'
                      : '未配置'
                  : storageLoading
                    ? '读取中…'
                    : '未知'}
              </span>
            </div>
          </div>

          {/* Storage Servers Choices */}
          <div className="space-y-1.5">
            <span className="text-sm font-medium text-foreground">已发现的服务器列表（点击填入）：</span>
            {storageState?.servers && storageState.servers.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {storageState.servers.map((srv) => (
                  <Button
                    key={srv.name}
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={disabled || !isVerified}
                    onClick={() => {
                      if (checkCapturedOwnership(currentEpoch, currentGeneration)) {
                        setServerName(srv.name);
                      }
                    }}
                  >
                    <span>{srv.name}</span>
                    {srv.status && (
                      <span className="ml-1 text-[13px] text-muted-foreground">({srv.status})</span>
                    )}
                  </Button>
                ))}
              </div>
            ) : (
              <p className="text-[13px] text-muted-foreground">未返回已配置服务器元数据</p>
            )}
          </div>

          {/* Target Engine & Server Name Form */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
            <div className="space-y-1">
              <span className="text-sm font-medium text-foreground">目标存储引擎</span>
              <div className="flex items-center gap-4 text-sm h-10">
                <label className="flex items-center gap-1.5 cursor-pointer text-sm">
                  <input
                    type="radio"
                    name="nativeTargetEngine"
                    value="sqlite"
                    checked={targetEngine === 'sqlite'}
                    onChange={() => {
                      if (checkCapturedOwnership(currentEpoch, currentGeneration)) {
                        setTargetEngine('sqlite');
                      }
                    }}
                    disabled={disabled || !isVerified}
                  />
                  <span>SQLite</span>
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer text-sm">
                  <input
                    type="radio"
                    name="nativeTargetEngine"
                    value="mysql"
                    checked={targetEngine === 'mysql'}
                    onChange={() => {
                      if (checkCapturedOwnership(currentEpoch, currentGeneration)) {
                        setTargetEngine('mysql');
                      }
                    }}
                    disabled={disabled || !isVerified}
                  />
                  <span>MySQL</span>
                </label>
              </div>
            </div>

            <div className="space-y-1">
              <label htmlFor="native-storage-server-name" className="text-sm font-medium text-foreground">
                服务器名称 (serverName)
              </label>
              <Input
                id="native-storage-server-name"
                value={serverName}
                onChange={(e) => {
                  if (checkCapturedOwnership(currentEpoch, currentGeneration)) {
                    setServerName(e.target.value);
                  }
                }}
                placeholder={targetEngine === 'mysql' ? 'MySQL 服务器名称（必填）' : 'SQLite 无需服务器名称（可为空）'}
                disabled={disabled || !isVerified}
              />
            </div>
          </div>

          {/* Storage Preview (Explicit only) */}
          <div className="rounded-md border border-border p-3 bg-background space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-foreground">数据迁移预览</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void handleFetchPreview()}
                disabled={disabled || previewLoading || !isVerified}
              >
                {previewLoading ? '获取中…' : '获取迁移预览'}
              </Button>
            </div>
            {previewError && (
              <p role="alert" className="text-[13px] text-destructive">
                预览获取失败：{previewError}
              </p>
            )}
            {previewData ? (
              <div className="space-y-2 text-sm">
                <div className="text-[13px] text-muted-foreground">
                  源引擎：<span className="text-foreground font-medium">{previewData.sourceEngine ?? '未知'}</span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <div className="bg-secondary/40 p-2 rounded">
                    <span className="text-muted-foreground block text-[13px]">Gemini CLI 凭证</span>
                    <span className="font-medium text-foreground text-sm">
                      {formatCount(previewData.data?.gcliCredentials)}
                    </span>
                  </div>
                  <div className="bg-secondary/40 p-2 rounded">
                    <span className="text-muted-foreground block text-[13px]">Antigravity 凭证</span>
                    <span className="font-medium text-foreground text-sm">
                      {formatCount(previewData.data?.antigravityCredentials)}
                    </span>
                  </div>
                  <div className="bg-secondary/40 p-2 rounded">
                    <span className="text-muted-foreground block text-[13px]">配置项</span>
                    <span className="font-medium text-foreground text-sm">
                      {formatCount(previewData.data?.config)}
                    </span>
                  </div>
                  <div className="bg-secondary/40 p-2 rounded">
                    <span className="text-muted-foreground block text-[13px]">总计项</span>
                    <span className="font-medium text-foreground text-sm">
                      {formatCount(previewData.data?.total)}
                    </span>
                  </div>
                </div>
              </div>
            ) : !previewError && !previewLoading ? (
              <p className="text-[13px] text-muted-foreground">暂无迁移预览数据（仅在显式点击上方按钮时发起查询）</p>
            ) : null}
          </div>

          {/* Migration Intent Request Button */}
          <div className="space-y-1.5 pt-1">
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={handleRequestMigration}
              disabled={isMigrationIntentDisabled}
            >
              请求切换存储引擎
            </Button>
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              注：本操作仅请求页面确认切换存储引擎，不执行实际数据库写入、配置保存或进程重启。
              {targetEngine === 'mysql' && !serverName.trim() && (
                <span className="text-destructive ml-1">（MySQL 目标必须填写非空白服务器名称）</span>
              )}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* 2. Redis & SMART 429 Status Section */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">系统状态与缓存（Redis / SMART 429）</CardTitle>
          <CardDescription className="text-[13px]">
            共享节点 Redis 缓存连接诊断与 SMART 429 保护策略观察。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {systemError && (
            <p role="alert" className="text-[13px] text-destructive">
              系统状态读取失败：{systemError}
            </p>
          )}

          {/* Redis Sub-section */}
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-foreground">Redis 状态</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2.5 text-sm">
              <div className="rounded-md border border-border p-2.5 bg-background">
                <span className="text-[13px] text-muted-foreground block">启用状态</span>
                <span className="font-medium text-foreground">
                  {systemStatus?.redis?.enabled === undefined
                    ? systemLoading
                      ? '读取中…'
                      : '未知'
                    : systemStatus.redis.enabled
                      ? '已启用'
                      : '未启用'}
                </span>
              </div>
              <div className="rounded-md border border-border p-2.5 bg-background">
                <span className="text-[13px] text-muted-foreground block">服务器名称</span>
                <span className="font-medium text-foreground">
                  {systemStatus?.redis?.serverName ?? (systemLoading ? '读取中…' : '未知')}
                </span>
              </div>
              <div className="rounded-md border border-border p-2.5 bg-background">
                <span className="text-[13px] text-muted-foreground block">内存使用</span>
                <span className="font-medium text-foreground">
                  {systemStatus?.redis?.memoryUsedMb !== undefined
                    ? `${systemStatus.redis.memoryUsedMb} MB`
                    : systemLoading
                      ? '读取中…'
                      : '未知'}
                </span>
              </div>
              <div className="rounded-md border border-border p-2.5 bg-background">
                <span className="text-[13px] text-muted-foreground block">总键数</span>
                <span className="font-medium text-foreground">
                  {formatCount(systemStatus?.redis?.totalKeys)}
                </span>
              </div>
              <div className="rounded-md border border-border p-2.5 bg-background">
                <span className="text-[13px] text-muted-foreground block">GCLI 可用池</span>
                <span className="font-medium text-foreground">
                  {formatCount(systemStatus?.redis?.pools?.geminicliAvail)}
                </span>
              </div>
              <div className="rounded-md border border-border p-2.5 bg-background">
                <span className="text-[13px] text-muted-foreground block">GCLI 预览池</span>
                <span className="font-medium text-foreground">
                  {formatCount(systemStatus?.redis?.pools?.geminicliPreview)}
                </span>
              </div>
              <div className="rounded-md border border-border p-2.5 bg-background">
                <span className="text-[13px] text-muted-foreground block">Antigravity 可用池</span>
                <span className="font-medium text-foreground">
                  {formatCount(systemStatus?.redis?.pools?.antigravityAvail)}
                </span>
              </div>
              <div className="rounded-md border border-border p-2.5 bg-background sm:col-span-2">
                <span className="text-[13px] text-muted-foreground block">诊断结论</span>
                <span className="font-medium text-foreground">
                  {systemStatus?.redis?.diagnostic
                    ? formatRedisDiagnostic(systemStatus.redis.diagnostic)
                    : systemLoading
                      ? '读取中…'
                      : '未提供诊断'}
                </span>
              </div>
            </div>
          </div>

          {/* SMART 429 Sub-section */}
          <div className="space-y-2 pt-2 border-t border-border">
            <h3 className="text-sm font-semibold text-foreground">SMART 429 保护状态</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2.5 text-sm">
              <div className="rounded-md border border-border p-2.5 bg-background">
                <span className="text-[13px] text-muted-foreground block">运行启用状态</span>
                <span className="font-medium text-foreground">
                  {systemStatus?.smart429?.enabled === undefined
                    ? systemLoading
                      ? '读取中…'
                      : '未知'
                    : systemStatus.smart429.enabled
                      ? '已启用'
                      : '未启用'}
                </span>
              </div>
              <div className="rounded-md border border-border p-2.5 bg-background">
                <span className="text-[13px] text-muted-foreground block">配置请求状态</span>
                <span className="font-medium text-foreground">
                  {systemStatus?.smart429?.requestedEnabled === undefined
                    ? systemLoading
                      ? '读取中…'
                      : '未知'
                    : systemStatus.smart429.requestedEnabled
                      ? '已请求启用'
                      : '未请求启用'}
                </span>
              </div>
              <div className="rounded-md border border-border p-2.5 bg-background">
                <span className="text-[13px] text-muted-foreground block">最大尝试次数</span>
                <span className="font-medium text-foreground">
                  {formatCount(systemStatus?.smart429?.maxAttempts)}
                </span>
              </div>
              <div className="rounded-md border border-border p-2.5 bg-background">
                <span className="text-[13px] text-muted-foreground block">重试基准间隔</span>
                <span className="font-medium text-foreground">
                  {systemStatus?.smart429?.retryBaseInterval !== undefined
                    ? `${systemStatus.smart429.retryBaseInterval}s`
                    : systemLoading
                      ? '读取中…'
                      : '未知'}
                </span>
              </div>
              <div className="rounded-md border border-border p-2.5 bg-background">
                <span className="text-[13px] text-muted-foreground block">实例模式</span>
                <span className="font-medium text-foreground">
                  {systemStatus?.smart429?.singleInstanceOnly === undefined
                    ? systemLoading
                      ? '读取中…'
                      : '未知'
                    : systemStatus.smart429.singleInstanceOnly
                      ? '单实例'
                      : '多实例'}
                </span>
              </div>
              <div className="rounded-md border border-border p-2.5 bg-background">
                <span className="text-[13px] text-muted-foreground block">策略版本</span>
                <span className="font-medium text-foreground">
                  {formatCount(systemStatus?.smart429?.policyEpoch)}
                </span>
              </div>
              <div className="rounded-md border border-border p-2.5 bg-background sm:col-span-3">
                <span className="text-[13px] text-muted-foreground block">受阻原因诊断</span>
                <span className="font-medium text-foreground">
                  {formatSmartBlockedReason(systemStatus?.smart429?.blockedReason)}
                </span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 3. Embed Policy Security Diagnostics Section */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">嵌入策略安全诊断</CardTitle>
          <CardDescription className="text-[13px]">
            当前有效控制台嵌入策略只读诊断，由服务安全策略直接上报，不随表单草稿改变。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-sm">
            <div className="rounded-md border border-border p-2.5 bg-background">
              <span className="text-[13px] text-muted-foreground block">策略来源 (source)</span>
              <span className="font-medium text-foreground">
                {formatEmbedSource(snapshot?.embedPolicy?.source)}
              </span>
            </div>
            <div className="rounded-md border border-border p-2.5 bg-background">
              <span className="text-[13px] text-muted-foreground block">策略有效性 (valid)</span>
              <span className="font-medium text-foreground">
                {formatEmbedValidity(snapshot?.embedPolicy?.valid, snapshot?.config?.gcli_embed_mode)}
              </span>
            </div>
            <div className="rounded-md border border-border p-2.5 bg-background">
              <span className="text-[13px] text-muted-foreground block">锁定状态 (locked)</span>
              <span className="font-medium text-foreground">
                {formatEmbedLocked(snapshot?.embedPolicy?.locked)}
              </span>
            </div>
          </div>
          {snapshot?.embedPolicy?.valid === false && (
            <p role="alert" className="text-[13px] text-destructive">
              注意：嵌入策略校验未通过，已进入 Fail-closed 阻断状态（禁止 iframe 嵌入）。
            </p>
          )}
        </CardContent>
      </Card>

      {/* 4. Node Info & Code Assist Observation Card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">节点与代码助手观察</CardTitle>
          <CardDescription className="text-[13px]">
            当前节点版本观察与 Code Assist 端点，仅供展示，不根据版本推断功能支持。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {nodeError && (
            <p role="alert" className="text-[13px] text-destructive">
              节点信息读取失败：{nodeError}
            </p>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            <div className="rounded-md border border-border p-3 bg-background space-y-1">
              <span className="text-[13px] text-muted-foreground block font-medium">节点版本</span>
              {nodeInfo?.version ? (
                nodeInfo.version.issue ? (
                  <span className="text-[13px] text-muted-foreground">{nodeInfo.version.issue}</span>
                ) : nodeInfo.version.value ? (
                  <div className="space-y-1">
                    <span className="font-semibold text-foreground text-sm block">
                      {nodeInfo.version.value.display_version || nodeInfo.version.value.version || '未知版本'}
                    </span>
                    {nodeInfo.version.value.full_hash && (
                      <span className="text-[13px] text-muted-foreground block font-mono">
                        Hash: {nodeInfo.version.value.full_hash.slice(0, 8)}
                      </span>
                    )}
                    {nodeInfo.version.value.commit_date && (
                      <span className="text-[13px] text-muted-foreground block">
                        提交日期: {nodeInfo.version.value.commit_date}
                      </span>
                    )}
                  </div>
                ) : (
                  <span className="text-[13px] text-muted-foreground">版本信息不可用</span>
                )
              ) : (
                <span className="text-[13px] text-muted-foreground">{nodeLoading ? '读取中…' : '版本信息不可用'}</span>
              )}
            </div>

            <div className="rounded-md border border-border p-3 bg-background space-y-1">
              <span className="text-[13px] text-muted-foreground block font-medium">Code Assist 观察端点</span>
              {nodeInfo?.codeAssistEndpoint ? (
                nodeInfo.codeAssistEndpoint.issue ? (
                  <span className="text-[13px] text-muted-foreground">{nodeInfo.codeAssistEndpoint.issue}</span>
                ) : nodeInfo.codeAssistEndpoint.value ? (
                  <span className="font-mono text-sm text-foreground break-all block">
                    {nodeInfo.codeAssistEndpoint.value}
                  </span>
                ) : (
                  <span className="text-[13px] text-muted-foreground">代码助手端点不可用</span>
                )
              ) : (
                <span className="text-[13px] text-muted-foreground">{nodeLoading ? '读取中…' : '代码助手端点不可用'}</span>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 4. Draft Tools Section (Endpoint Presets & Keepalive URL Helper) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">端点预设与辅助工具（草稿）</CardTitle>
          <CardDescription className="text-[13px]">
            快捷应用端点预设或填充保活 URL 到当前页面草稿中。不会自动保存，受环境变量锁定控制。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!snapshot && (
            <p className="text-[13px] text-muted-foreground">
              当前无配置快照（未加载或未认证），草稿辅助工具已禁用。
            </p>
          )}

          {/* Preset Buttons */}
          <div className="space-y-2">
            <span className="text-sm font-medium text-foreground block">端点快捷预设</span>
            <div className="flex flex-wrap gap-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleApplyMirrorPresets}
                disabled={draftToolsDisabled}
              >
                应用镜像端点预设 (Mirror)
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleApplyOfficialPresets}
                disabled={draftToolsDisabled}
              >
                应用官方端点预设 (Official)
              </Button>
            </div>
            <p className="text-[13px] text-muted-foreground">
              仅将未被环境锁定的端点地址填入表单草稿，不包含敏感凭据，亦不自动发起网络保存。
            </p>
          </div>

          {/* Keepalive URL Helper */}
          <div className="space-y-2 pt-2 border-t border-border">
            <label htmlFor="native-keepalive-url-input" className="text-sm font-medium text-foreground block">
              保活 URL 辅助填充
            </label>
            <div className="flex flex-col sm:flex-row gap-2">
              <Input
                id="native-keepalive-url-input"
                value={keepaliveInput}
                onChange={(e) => {
                  if (checkCapturedOwnership(currentEpoch, currentGeneration)) {
                    setKeepaliveInput(e.target.value);
                  }
                }}
                placeholder="例如：https://example.com/prefix/"
                disabled={draftToolsDisabled || isKeepaliveLocked}
                className="font-mono"
              />
              <div className="flex flex-wrap gap-2 shrink-0">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleFillServiceBaseKeepalive}
                  disabled={draftToolsDisabled || isKeepaliveLocked}
                >
                  填入当前服务根
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={handleApplyKeepaliveInput}
                  disabled={draftToolsDisabled || isKeepaliveLocked || !keepaliveInput.trim()}
                >
                  应用到草稿
                </Button>
              </div>
            </div>
            {isKeepaliveLocked && snapshot && (
              <p className="text-[13px] text-warning">
                保活 URL 已被环境变量锁定，无法通过界面修改草稿。
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default NativeSettingsTools;
