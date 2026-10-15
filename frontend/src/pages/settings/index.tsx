import { useState, useRef, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { getServiceBase } from '@/api/client';
import {
  getSessionSnapshot,
  getSessionValidationSnapshot,
  registerSessionCleanup,
  subscribeSessionValidation,
} from '@/auth/session';
import { useSettings } from './hooks';
import { fixtureMode, getStorageState, switchStorageEngine } from './api';
import { editable, fields, same, toDraft } from './types';
import type { Draft } from './types';
import type { StoragePreview, StorageState, StorageSwitchResult } from './tools';
import { NativeSettingsTools } from './components/NativeSettingsTools';
import type { MigrationIntent } from './components/NativeSettingsTools';
import { ManagementToken } from './components/ManagementToken';
import { SavedPasswordsDialog } from './components/SavedPasswordsDialog';
import { ConfigField } from './components/ConfigField';
import { UnsavedChangesGuard } from './components/UnsavedChangesGuard';
import { createMigrationIntentGate } from './migrationIntent';
import type { MigrationIntentTicket } from './migrationIntent';

type CopiedIntent = {
  targetEngine: 'sqlite' | 'mysql';
  serverName: string;
  preview: StoragePreview | null;
  currentEngine?: string;
  epoch: number;
  generation: number;
  ticket: MigrationIntentTicket;
};

export type MigrationEvidence = {
  targetEngine: 'sqlite' | 'mysql';
  serverName: string;
  result: StorageSwitchResult;
  statusText: string;
};

let carriedMigrationEvidence: MigrationEvidence | undefined;

export default function SettingsPage() {
  const s = useSettings();
  const values = s.form.watch();
  const original = toDraft(s.baseline);
  const changes = fields.filter(
    (f) => values[f.key] !== undefined && !same(values[f.key], original[f.key])
  );
  const legacy = new URL(getServiceBase());
  legacy.hash = 'config';

  const mountedRef = useRef(true);
  const validationGenerationRef = useRef(0);
  const migrationBusyRef = useRef(false);
  const migrationControllerRef = useRef<AbortController | null>(null);
  const migrationAttemptRef = useRef(0);
  const readbackControllerRef = useRef<AbortController | null>(null);
  const migrationGateRef = useRef(createMigrationIntentGate());

  const [migrationModal, setMigrationModal] = useState<CopiedIntent | null>(null);
  const [migrationBusy, setMigrationBusy] = useState(false);
  const [, setMigrationStatus] = useState(carriedMigrationEvidence?.statusText ?? '');
  const [migrationEvidence, setMigrationEvidence] = useState<MigrationEvidence | undefined>(
    carriedMigrationEvidence
  );

  const [storageObservation, setStorageObservation] = useState<StorageState | null>(null);
  const [storageObservationStatus, setStorageObservationStatus] = useState<string>('');
  const [readbackLoading, setReadbackLoading] = useState(false);

  const checkVerifiedOwner = useCallback(
    (epoch: number, generation: number): boolean => {
      if (!mountedRef.current) return false;
      if (!s.auth.authenticated) return false;
      if (validationGenerationRef.current !== generation) return false;
      const valSnap = getSessionValidationSnapshot();
      const snap = getSessionSnapshot();
      return (
        valSnap.status === 'verified' &&
        valSnap.sessionEpoch === epoch &&
        snap.sessionEpoch === epoch &&
        snap.token !== null
      );
    },
    [s.auth.authenticated]
  );

  // Synchronous session, validation, and unmount cleanup
  useEffect(() => {
    mountedRef.current = true;

    const handleInvalidate = () => {
      validationGenerationRef.current++;
      migrationAttemptRef.current++;
      if (migrationControllerRef.current) {
        migrationControllerRef.current.abort();
        migrationControllerRef.current = null;
      }
      if (readbackControllerRef.current) {
        readbackControllerRef.current.abort();
        readbackControllerRef.current = null;
      }
      migrationBusyRef.current = false;
      setMigrationBusy(false);
      setReadbackLoading(false);
      migrationGateRef.current.clear();
      setMigrationModal(null);
    };

    const unregValidation = subscribeSessionValidation(() => {
      if (!mountedRef.current) return;
      const valSnap = getSessionValidationSnapshot();
      const snap = getSessionSnapshot();
      const isNowVerified =
        valSnap.status === 'verified' &&
        valSnap.sessionEpoch === snap.sessionEpoch &&
        snap.token !== null;
      if (!isNowVerified) {
        handleInvalidate();
      }
    });

    const unregCleanup = registerSessionCleanup(() => {
      if (!mountedRef.current) return;
      handleInvalidate();
    });

    return () => {
      mountedRef.current = false;
      unregValidation();
      unregCleanup();
      if (migrationControllerRef.current) {
        migrationControllerRef.current.abort();
        migrationControllerRef.current = null;
      }
      if (readbackControllerRef.current) {
        readbackControllerRef.current.abort();
        readbackControllerRef.current = null;
      }
      migrationBusyRef.current = false;
      migrationGateRef.current.clear();
      setMigrationModal(null);
    };
  }, []);

  useEffect(() => {
    if (!s.auth.authenticated) {
      validationGenerationRef.current++;
      migrationAttemptRef.current++;
      if (migrationControllerRef.current) {
        migrationControllerRef.current.abort();
        migrationControllerRef.current = null;
      }
      if (readbackControllerRef.current) {
        readbackControllerRef.current.abort();
        readbackControllerRef.current = null;
      }
      migrationBusyRef.current = false;
      setMigrationBusy(false);
      setReadbackLoading(false);
      migrationGateRef.current.clear();
      setMigrationModal(null);
    }
  }, [s.auth.authenticated, s.auth.sessionEpoch]);

  // Draft patching from NativeSettingsTools
  const handleDraftPatch = useCallback(
    (patch: Draft) => {
      const capturedEpoch = s.auth.sessionEpoch;
      const capturedGeneration = validationGenerationRef.current;
      if (!checkVerifiedOwner(capturedEpoch, capturedGeneration)) return;
      if (!s.snapshot || !patch || typeof patch !== 'object') return;

      for (const field of fields) {
        if (patch[field.key] !== undefined && editable(field, s.snapshot)) {
          s.form.setValue(field.key, patch[field.key], {
            shouldDirty: true,
            shouldTouch: true,
            shouldValidate: true,
          });
        }
      }
    },
    [s.snapshot, s.form, s.auth.sessionEpoch, checkVerifiedOwner]
  );

  // Migration intent request from NativeSettingsTools
  const handleRequestMigration = useCallback(
    (intent: MigrationIntent) => {
      const capturedEpoch = s.auth.sessionEpoch;
      const capturedGeneration = validationGenerationRef.current;
      if (!checkVerifiedOwner(capturedEpoch, capturedGeneration)) return;
      if (migrationBusyRef.current || s.busy) return;

      const ticket = migrationGateRef.current.issue();
      const copied: CopiedIntent = {
        targetEngine: intent.targetEngine,
        serverName: intent.serverName ?? '',
        preview: intent.preview
          ? {
              ...(intent.preview.sourceEngine ? { sourceEngine: intent.preview.sourceEngine } : {}),
              data: { ...intent.preview.data },
            }
          : null,
        currentEngine: intent.currentEngine,
        epoch: capturedEpoch,
        generation: capturedGeneration,
        ticket,
      };
      setMigrationModal(copied);
    },
    [s.auth.sessionEpoch, checkVerifiedOwner, s.busy]
  );

  // Explicit confirmation of migration intent
  const handleConfirmMigration = useCallback(
    async (targetModal?: CopiedIntent) => {
      const modal = targetModal ?? migrationModal;
      if (!modal || migrationBusyRef.current) return;

      if (modal.targetEngine === 'mysql' && !modal.serverName.trim()) {
        return;
      }

      const resolvedServerName =
        modal.targetEngine === 'sqlite' ? modal.serverName : modal.serverName.trim();

      if (!checkVerifiedOwner(modal.epoch, modal.generation)) {
        return;
      }

      if (!migrationGateRef.current.consume(modal.ticket)) {
        return;
      }

      setMigrationModal((current) => (current === modal ? null : current));

      migrationBusyRef.current = true;
      setMigrationBusy(true);

      if (migrationControllerRef.current) {
        migrationControllerRef.current.abort();
        migrationControllerRef.current = null;
      }
      const controller = new AbortController();
      migrationControllerRef.current = controller;
      const currentAttempt = ++migrationAttemptRef.current;

      const initialText = '正在切换存储引擎，结果确认中…';
      setMigrationStatus(initialText);
      const uncertainEvidence: MigrationEvidence = {
        targetEngine: modal.targetEngine,
        serverName: resolvedServerName,
        result: { kind: 'unknown' },
        statusText: initialText,
      };
      setMigrationEvidence(uncertainEvidence);
      carriedMigrationEvidence = uncertainEvidence;

      try {
        const result = await switchStorageEngine(
          modal.targetEngine,
          resolvedServerName,
          controller.signal
        );

        if (
          !mountedRef.current ||
          controller.signal.aborted ||
          migrationAttemptRef.current !== currentAttempt ||
          !checkVerifiedOwner(modal.epoch, modal.generation)
        ) {
          return;
        }

        const text = {
          acknowledged: '存储引擎切换已成功确认。',
          partial: '存储引擎已切换，但数据迁移存在部分错误。',
          rejected: '存储引擎切换请求已被服务器拒绝。',
          unknown: '存储引擎切换结果未知，未获服务器最终确认。',
        }[result.kind];

        setMigrationStatus(text);
        const finalEvidence: MigrationEvidence = {
          targetEngine: modal.targetEngine,
          serverName: resolvedServerName,
          result,
          statusText: text,
        };
        setMigrationEvidence(finalEvidence);
        carriedMigrationEvidence = finalEvidence;
      } catch {
        if (
          !mountedRef.current ||
          controller.signal.aborted ||
          migrationAttemptRef.current !== currentAttempt ||
          !checkVerifiedOwner(modal.epoch, modal.generation)
        ) {
          return;
        }

        const text = '存储引擎切换请求异常，结果未知。请重新读取状态对照。';
        setMigrationStatus(text);
        const errEvidence: MigrationEvidence = {
          targetEngine: modal.targetEngine,
          serverName: resolvedServerName,
          result: { kind: 'unknown' },
          statusText: text,
        };
        setMigrationEvidence(errEvidence);
        carriedMigrationEvidence = errEvidence;
      } finally {
        if (
          mountedRef.current &&
          migrationAttemptRef.current === currentAttempt &&
          checkVerifiedOwner(modal.epoch, modal.generation)
        ) {
          migrationBusyRef.current = false;
          setMigrationBusy(false);
          migrationControllerRef.current = null;
        }
      }
    },
    [migrationModal, checkVerifiedOwner]
  );

  const handleCancelMigration = useCallback(
    (targetModal?: CopiedIntent | null) => {
      const modal = targetModal ?? migrationModal;
      if (!modal) return;
      migrationGateRef.current.cancel(modal.ticket);
      setMigrationModal((current) => (current === modal ? null : current));
    },
    [migrationModal]
  );

  // Explicit storage state readback
  const handleReadbackStorageState = useCallback(async () => {
    const capturedEpoch = s.auth.sessionEpoch;
    const capturedGeneration = validationGenerationRef.current;
    if (!checkVerifiedOwner(capturedEpoch, capturedGeneration) || readbackLoading) return;

    if (readbackControllerRef.current) {
      readbackControllerRef.current.abort();
      readbackControllerRef.current = null;
    }
    const controller = new AbortController();
    readbackControllerRef.current = controller;

    setReadbackLoading(true);
    setStorageObservationStatus('正在读取存储当前观察值…');
    try {
      const state = await getStorageState(controller.signal);
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        !checkVerifiedOwner(capturedEpoch, capturedGeneration)
      ) {
        return;
      }
      setStorageObservation(state);
      setStorageObservationStatus('已读取当前存储引擎观察值（独立观察，非写入确认）。');
    } catch {
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        !checkVerifiedOwner(capturedEpoch, capturedGeneration)
      ) {
        return;
      }
      setStorageObservationStatus('读取存储状态失败。');
    } finally {
      if (mountedRef.current && checkVerifiedOwner(capturedEpoch, capturedGeneration)) {
        setReadbackLoading(false);
        readbackControllerRef.current = null;
      }
    }
  }, [s.auth.sessionEpoch, checkVerifiedOwner, readbackLoading]);

  return (
    <div id="settings-content" tabIndex={-1} className="mx-auto max-w-6xl space-y-6">
      {fixtureMode && (
        <p role="status" className="rounded-lg border border-border bg-info-bg p-3 text-sm text-info">
          合成预览：本页所有操作仅影响内存示例，不访问后台。
        </p>
      )}
      <header>
        <h1 className="text-2xl font-semibold text-foreground">设置</h1>
        <p className="text-sm text-muted-foreground">
          Antigravity 与共享配置。只提交已修改且未被环境锁定的字段。
        </p>
      </header>

      <div className="flex flex-wrap gap-3">
        <Button
          id="settings-read-config"
          variant="outline"
          disabled={s.busy || !s.auth.authenticated}
          onClick={() => void s.refresh()}
        >
          重新读取并对照
        </Button>
        {s.observed && (
          <Button variant="outline" disabled={s.busy} onClick={s.acceptObservation}>
            放弃草稿并采用观察值
          </Button>
        )}
      </div>

      <p className="text-[13px] leading-5 text-muted-foreground">
        非敏感草稿只保留在当前标签页内存。切换新版页面可保留修改；刷新、关闭浏览器或前往旧页面会丢失草稿，请先处理未保存修改。
      </p>

      <p
        role="status"
        aria-live="polite"
        className={s.needsRead ? 'text-sm text-warning' : 'text-sm text-info'}
      >
        {s.busy ? '正在处理…' : s.status}
      </p>

      <UnsavedChangesGuard />

      <p className="rounded-lg border border-warning/25 bg-warning-bg p-3 text-[13px] leading-5 text-warning">
        监听地址、端口、凭证目录等运行配置保存后可能需要重启服务才生效；保存确认不代表运行进程已切换。本页不会自动重启。
      </p>

      {!s.auth.authenticated && (
        <p role="alert" className="text-sm text-warning">
          请重新登录。非敏感草稿仅保存在内存，秘密输入已清除。
        </p>
      )}

      <form
        noValidate
        onSubmit={s.form.handleSubmit(s.save, (errors) => {
          const first = fields.find((field) => errors[field.key]);
          if (first) {
            s.form.setFocus(first.key);
            document.getElementById(first.key)?.scrollIntoView?.({ block: 'center' });
          }
        })}
        className="space-y-6"
      >
        {[...new Set(fields.map((f) => f.section))].map((section) => (
          <Card key={section}>
            <CardHeader>
              <CardTitle>{section}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              {fields
                .filter((f) => f.section === section)
                .map((field) => (
                  <ConfigField
                    key={field.key}
                    field={field}
                    form={s.form}
                    snapshot={s.snapshot}
                    disabled={s.busy || !s.auth.authenticated}
                  />
                ))}
            </CardContent>
          </Card>
        ))}

        <Card>
          <CardHeader>
            <CardTitle>修改对照（{changes.length}）</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-[13px] leading-5 text-muted-foreground">
              读取仅反映当前观察值，不保证事务、原子性或没有其他写入。密码与可能含秘密的网络字段均隐藏值。
            </p>
            <div className="overflow-x-auto rounded-xl bg-background ring-1 ring-border">
              <table className="w-full text-left text-sm">
                <thead className="bg-secondary text-[13px] text-muted-foreground [&_th]:font-medium">
                  <tr>
                    <th>字段</th>
                    <th>原基线</th>
                    <th>草稿</th>
                    <th>最近提交</th>
                    <th>当前观察</th>
                  </tr>
                </thead>
                <tbody>
                  {changes.map((f) => {
                    const redact =
                      f.kind === 'secret' || f.section === '网络' || f.key === 'keepalive_url';
                    const show = (value: unknown) =>
                      value === undefined ? '未提供' : redact ? '[已隐藏]' : JSON.stringify(value);
                    return (
                      <tr
                        className="border-t border-border text-foreground hover:bg-secondary/60"
                        key={f.key}
                      >
                        <th className="py-2 font-medium">{f.label}</th>
                        <td>{show(s.baseline[f.key])}</td>
                        <td>{show(values[f.key])}</td>
                        <td>{show(s.sent?.[f.key])}</td>
                        <td>{show(s.observed?.[f.key])}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Button
              type="submit"
              disabled={
                s.busy || !s.auth.authenticated || !s.snapshot || s.needsRead || !changes.length
              }
            >
              保存已修改字段
            </Button>
          </CardContent>
        </Card>
      </form>

      <Card>
        <CardHeader>
          <CardTitle>已保存密码</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-[13px] leading-5 text-muted-foreground">
            在明确确认后查看已保存的密码明文。
          </p>
          <SavedPasswordsDialog disabled={s.busy || !s.auth.authenticated} />
        </CardContent>
      </Card>

      <ManagementToken
        status={s.snapshot?.token}
        onUpdate={(token) =>
          s.setSnapshot((previous) => (previous ? { ...previous, token } : previous))
        }
      />

      <NativeSettingsTools
        snapshot={s.snapshot}
        disabled={s.busy || !s.auth.authenticated}
        onDraftPatch={handleDraftPatch}
        onRequestMigration={handleRequestMigration}
      />

      <Card>
        <CardHeader>
          <CardTitle>存储与模型路由</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-foreground">
            当前存储引擎配置观察：<strong className="font-semibold">{s.engine}</strong>
          </p>

          <p className="text-[13px] leading-5 text-muted-foreground">
            切换存储可能迁移或覆盖数据、改变凭证可见性。可通过原生设置工具请求切换并在弹窗中明确确认。独立读取仅反映当前观察值，不代表先前写入确认。
          </p>

          {migrationEvidence && (
            <div className="rounded-md border border-border bg-secondary/30 p-3 space-y-2 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-foreground">
                  最近存储切换提交记录（目标：{migrationEvidence.targetEngine === 'sqlite' ? 'SQLite' : 'MySQL'}
                  {migrationEvidence.serverName ? ` / ${migrationEvidence.serverName}` : ''}）
                </span>
                <span
                  className={
                    migrationEvidence.result.kind === 'acknowledged'
                      ? 'text-success font-medium text-xs'
                      : migrationEvidence.result.kind === 'partial'
                      ? 'text-warning font-medium text-xs'
                      : migrationEvidence.result.kind === 'rejected'
                      ? 'text-destructive font-medium text-xs'
                      : 'text-muted-foreground font-medium text-xs'
                  }
                >
                  {{
                    acknowledged: '服务已确认切换 (acknowledged)',
                    partial: '部分迁移/存在错误 (partial)',
                    rejected: '切换请求已被拒绝 (rejected)',
                    unknown: '结果未知/未确认 (unknown)',
                  }[migrationEvidence.result.kind]}
                </span>
              </div>
              <p className="text-[13px] text-muted-foreground">{migrationEvidence.statusText}</p>
              {migrationEvidence.result.migration && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs pt-1">
                  <div className="bg-background/80 p-2 rounded border border-border">
                    <span className="text-muted-foreground block">Gemini CLI 凭证</span>
                    <span className="font-medium text-foreground">
                      迁移: {migrationEvidence.result.migration.gcliCredentials.migrated ?? '未知'} /{' '}
                      {migrationEvidence.result.migration.gcliCredentials.total ?? '未知'}
                      {migrationEvidence.result.migration.gcliCredentials.errorCount !== undefined && (
                        <span className="text-muted-foreground ml-1">
                          （错误: {migrationEvidence.result.migration.gcliCredentials.errorCount}）
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="bg-background/80 p-2 rounded border border-border">
                    <span className="text-muted-foreground block">Antigravity 凭证</span>
                    <span className="font-medium text-foreground">
                      迁移: {migrationEvidence.result.migration.antigravityCredentials.migrated ?? '未知'} /{' '}
                      {migrationEvidence.result.migration.antigravityCredentials.total ?? '未知'}
                      {migrationEvidence.result.migration.antigravityCredentials.errorCount !== undefined && (
                        <span className="text-muted-foreground ml-1">
                          （错误: {migrationEvidence.result.migration.antigravityCredentials.errorCount}）
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="bg-background/80 p-2 rounded border border-border">
                    <span className="text-muted-foreground block">配置项</span>
                    <span className="font-medium text-foreground">
                      迁移: {migrationEvidence.result.migration.config.migrated ?? '未知'} /{' '}
                      {migrationEvidence.result.migration.config.total ?? '未知'}
                      {migrationEvidence.result.migration.config.errorCount !== undefined && (
                        <span className="text-muted-foreground ml-1">
                          （错误: {migrationEvidence.result.migration.config.errorCount}）
                        </span>
                      )}
                    </span>
                  </div>
                  {migrationEvidence.result.migration.totalMigrated !== undefined && (
                    <div className="sm:col-span-3 text-xs text-muted-foreground">
                      总迁移项计数:{' '}
                      <span className="font-medium text-foreground">
                        {migrationEvidence.result.migration.totalMigrated}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="space-y-2 pt-1 border-t border-border">
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={readbackLoading || !s.auth.authenticated}
                onClick={() => void handleReadbackStorageState()}
              >
                {readbackLoading ? '正在读取…' : '独立读取当前存储观察值'}
              </Button>
              {storageObservationStatus && (
                <span className="text-[13px] text-muted-foreground">{storageObservationStatus}</span>
              )}
            </div>
            {storageObservation && (
              <div className="rounded-md border border-border bg-background p-2.5 text-[13px] space-y-1">
                <span className="text-muted-foreground block font-medium">
                  当前独立观察值（非先前写入确认）：
                </span>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-foreground">
                  <span>
                    当前引擎: <strong className="font-semibold">{storageObservation.currentEngine ?? '未知'}</strong>
                  </span>
                  <span>
                    服务器: <strong className="font-semibold">{storageObservation.serverName || '无'}</strong>
                  </span>
                  <span>
                    MySQL 可用性:{' '}
                    <strong className="font-semibold">
                      {storageObservation.mysqlAvailable === undefined
                        ? '未知'
                        : storageObservation.mysqlAvailable
                        ? '可用'
                        : '不可用'}
                    </strong>
                  </span>
                  <span>
                    MySQL 配置状态:{' '}
                    <strong className="font-semibold">
                      {storageObservation.mysqlConfigured === undefined
                        ? '未知'
                        : storageObservation.mysqlConfigured
                        ? '已配置'
                        : '未配置'}
                    </strong>
                  </span>
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-wrap gap-4 text-sm pt-1">
            {fixtureMode ? (
              <span className="text-muted-foreground">合成预览中不打开真实存储入口。</span>
            ) : (
              <a
                className="rounded-sm text-primary underline decoration-primary/40 underline-offset-4 hover:text-primary-hover"
                href={legacy.href}
              >
                旧配置页：存储预览与切换
              </a>
            )}
            <a
              className="rounded-sm text-primary underline decoration-primary/40 underline-offset-4 hover:text-primary-hover"
              href="#/model-routing"
            >
              模型路由编辑器
            </a>
          </div>
        </CardContent>
      </Card>

      {migrationModal && (
        <AlertDialog
          open={
            !!migrationModal &&
            s.auth.authenticated &&
            migrationModal.epoch === s.auth.sessionEpoch
          }
          onOpenChange={(open) => {
            if (!open) handleCancelMigration(migrationModal);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>确认切换存储引擎</AlertDialogTitle>
              <AlertDialogDescription>
                切换存储可能迁移或覆盖数据、改变凭证可见性。请在弹窗中仔细检查目标配置及迁移预览后再明确确认切换。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="space-y-3 text-sm text-foreground">
              <span className="block font-medium text-warning text-[13px]">
                警告：切换存储引擎将迁移或覆盖目标数据库中的数据，并改变凭证与配置的可见性。此操作不可自动撤销。
              </span>
              <div className="rounded-md border border-border bg-secondary/40 p-3 space-y-1 text-[13px]">
                <div>
                  <span className="text-muted-foreground">目标存储引擎：</span>
                  <span className="font-semibold text-foreground">
                    {migrationModal.targetEngine === 'sqlite' ? 'SQLite' : 'MySQL'}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">服务器名称 (serverName)：</span>
                  <span className="font-mono text-foreground">
                    {migrationModal.targetEngine === 'mysql'
                      ? migrationModal.serverName.trim() || '（未填写 - 不可提交）'
                      : migrationModal.serverName || '（默认空字符串）'}
                  </span>
                  {migrationModal.targetEngine === 'mysql' && !migrationModal.serverName.trim() && (
                    <span className="text-destructive block text-xs mt-0.5">
                      MySQL 目标必须填写非空白服务器名称。
                    </span>
                  )}
                </div>
                <div>
                  <span className="text-muted-foreground">源存储引擎：</span>
                  <span className="font-medium text-foreground">
                    {migrationModal.preview?.sourceEngine ?? migrationModal.currentEngine ?? '未知'}
                  </span>
                </div>
              </div>

              <div className="rounded-md border border-border p-3 space-y-1.5 text-[13px]">
                <span className="font-medium text-foreground block">数据迁移预览（快照）：</span>
                {migrationModal.preview?.data ? (
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <span className="text-muted-foreground">Gemini CLI 凭证：</span>
                      <span className="font-medium text-foreground ml-1">
                        {migrationModal.preview.data.gcliCredentials !== undefined
                          ? migrationModal.preview.data.gcliCredentials
                          : '未知'}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Antigravity 凭证：</span>
                      <span className="font-medium text-foreground ml-1">
                        {migrationModal.preview.data.antigravityCredentials !== undefined
                          ? migrationModal.preview.data.antigravityCredentials
                          : '未知'}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">配置项：</span>
                      <span className="font-medium text-foreground ml-1">
                        {migrationModal.preview.data.config !== undefined
                          ? migrationModal.preview.data.config
                          : '未知'}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">总计项：</span>
                      <span className="font-medium text-foreground ml-1">
                        {migrationModal.preview.data.total !== undefined
                          ? migrationModal.preview.data.total
                          : '未知'}
                      </span>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    迁移预览：未知（未获取或未提供迁移预览计数）
                  </p>
                )}
              </div>
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={() => handleCancelMigration(migrationModal)}>取消</AlertDialogCancel>
              <AlertDialogAction
                disabled={
                  migrationBusy ||
                  (migrationModal.targetEngine === 'mysql' && !migrationModal.serverName.trim())
                }
                onClick={() => void handleConfirmMigration(migrationModal)}
              >
                {migrationBusy ? '正在切换…' : '明确确认并切换'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
