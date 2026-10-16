import * as React from 'react';
import type { ReactElement } from 'react';
import {
  isPanelMode,
  isPanelScopeCurrent,
  subscribePanelChannel,
  type PanelMode,
  type PanelScope,
} from '@/domain/panel';
import {
  getSessionSnapshot,
  getSessionValidationSnapshot,
  subscribeSession,
  subscribeSessionValidation,
  type SessionValidationSnapshot,
} from '@/auth/session';
import { createCredentialApi } from './api';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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

export type FilesDialogTarget =
  | Readonly<{ kind: 'single'; filename: string }>
  | Readonly<{ kind: 'selection'; filenames: readonly string[] }>
  | Readonly<{ kind: 'channel' }>;

export interface FilesDialogProps {
  readonly mode: PanelMode;
  readonly scope: Readonly<PanelScope>;
  readonly validation: Readonly<SessionValidationSnapshot>;
  readonly ownerRevision: object;
  readonly isCurrentOwner: () => boolean;
  readonly disabled?: boolean;
  readonly open: boolean;
  readonly target: FilesDialogTarget;
  readonly onClose: () => void;
}

interface ActorInstance {
  readonly id: number;
  readonly mode: PanelMode;
  readonly scope: PanelScope;
  readonly validation: SessionValidationSnapshot;
  readonly ownerRevision: object;
  readonly target: FilesDialogTarget;
  readonly onClose: () => void;
  readonly isCurrentOwner: () => boolean;
  readonly controller: AbortController;
  readonly activeUrls: Set<string>;
  readonly cleanupTimers: Set<ReturnType<typeof setTimeout>>;
  retired: boolean;
  confirmationConsumed: boolean;
  readBusy: boolean;
  downloadBusy: boolean;
}

let nextActorId = 1;
const revisionIds = new WeakMap<object, number>();
let nextRevisionId = 1;

function getOwnerRevisionId(obj: object): number {
  let id = revisionIds.get(obj);
  if (id === undefined) {
    id = nextRevisionId++;
    revisionIds.set(obj, id);
  }
  return id;
}

const validationIds = new WeakMap<object, number>();
let nextValidationId = 1;

function getValidationIdentity(obj: object): number {
  let id = validationIds.get(obj);
  if (id === undefined) {
    id = nextValidationId++;
    validationIds.set(obj, id);
  }
  return id;
}

function getTargetKey(target: FilesDialogTarget): string {
  if (target.kind === 'single') {
    return `single:${target.filename}`;
  }
  if (target.kind === 'selection') {
    return `selection:${target.filenames.join('\u0000')}`;
  }
  if (target.kind === 'channel') {
    return 'channel';
  }
  return 'unknown';
}

function isSingleTargetValid(filename: unknown): filename is string {
  return typeof filename === 'string' && filename.trim().length > 0;
}

function isSelectionTargetValid(filenames: unknown): filenames is readonly string[] {
  if (!Array.isArray(filenames)) return false;
  if (filenames.length === 0 || filenames.length > 100) return false;
  const seen = new Set<string>();
  for (const item of filenames) {
    if (typeof item !== 'string' || item.trim().length === 0) return false;
    if (seen.has(item)) return false;
    seen.add(item);
  }
  return true;
}

function sanitizeDownloadFilename(filename: string): string {
  const parts = filename.split(/[/\\]/);
  const base = parts[parts.length - 1]?.trim() || 'credential.json';
  if (base === '.' || base === '..') return 'credential.json';
  return base;
}

function retireActor(actor: ActorInstance): void {
  if (actor.retired) return;
  actor.retired = true;
  try {
    actor.controller.abort();
  } catch {
    // isolate abort exception
  }
  for (const timer of Array.from(actor.cleanupTimers)) {
    clearTimeout(timer);
  }
  actor.cleanupTimers.clear();
  for (const url of Array.from(actor.activeUrls)) {
    try {
      if (typeof window !== 'undefined' && window.URL && typeof window.URL.revokeObjectURL === 'function') {
        window.URL.revokeObjectURL(url);
      }
    } catch {
      // isolate revocation exception
    }
  }
  actor.activeUrls.clear();
}

function isActorValid(actor: ActorInstance): boolean {
  if (actor.retired) return false;
  if (!isPanelMode(actor.mode)) return false;
  if (actor.mode !== actor.scope.mode) return false;

  const currentSession = getSessionSnapshot();
  if (currentSession.token === null) return false;
  if (currentSession.sessionEpoch !== actor.scope.sessionEpoch) return false;

  if (!isPanelScopeCurrent(actor.scope, currentSession.sessionEpoch)) return false;

  const currentValidation = getSessionValidationSnapshot();
  if (currentValidation !== actor.validation) return false;
  if (actor.validation.status !== 'verified') return false;
  if (actor.validation.sessionEpoch !== actor.scope.sessionEpoch) return false;

  try {
    if (!actor.isCurrentOwner()) return false;
  } catch {
    return false;
  }

  return true;
}

function isLifetimeValid(props: FilesDialogProps): boolean {
  if (!props.open) return false;
  if (props.disabled) return false;
  if (!isPanelMode(props.mode)) return false;
  if (props.mode !== props.scope.mode) return false;

  const session = getSessionSnapshot();
  if (session.token === null) return false;
  if (session.sessionEpoch !== props.scope.sessionEpoch) return false;

  if (!isPanelScopeCurrent(props.scope, session.sessionEpoch)) return false;

  const validation = getSessionValidationSnapshot();
  if (validation !== props.validation) return false;
  if (props.validation.status !== 'verified') return false;
  if (props.validation.sessionEpoch !== props.scope.sessionEpoch) return false;

  try {
    if (!props.isCurrentOwner()) return false;
  } catch {
    return false;
  }

  if (!props.target || typeof props.target !== 'object' || !('kind' in props.target)) {
    return false;
  }

  return true;
}

function triggerBlobDownload(blob: Blob, filename: string, actor: ActorInstance): void {
  if (typeof window === 'undefined' || !window.URL || typeof window.URL.createObjectURL !== 'function') {
    return;
  }
  const url = window.URL.createObjectURL(blob);
  actor.activeUrls.add(url);

  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener noreferrer';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } catch {
    // isolate download click exception
  }

  const timer = setTimeout(() => {
    try {
      if (typeof window !== 'undefined' && window.URL && typeof window.URL.revokeObjectURL === 'function') {
        window.URL.revokeObjectURL(url);
      }
    } catch {
      // isolate revocation exception
    }
    actor.activeUrls.delete(url);
    actor.cleanupTimers.delete(timer);
  }, 0);
  actor.cleanupTimers.add(timer);
}

function FilesDialogView(props: FilesDialogProps): ReactElement {
  const actorRef = React.useRef<ActorInstance | null>(null);
  if (!actorRef.current) {
    actorRef.current = {
      id: nextActorId++,
      mode: props.mode,
      scope: props.scope,
      validation: props.validation,
      ownerRevision: props.ownerRevision,
      target: props.target,
      onClose: props.onClose,
      isCurrentOwner: props.isCurrentOwner,
      controller: new AbortController(),
      activeUrls: new Set<string>(),
      cleanupTimers: new Set<ReturnType<typeof setTimeout>>(),
      retired: false,
      confirmationConsumed: false,
      readBusy: false,
      downloadBusy: false,
    };
  }
  const actor = actorRef.current;

  React.useEffect(() => {
    return () => {
      retireActor(actor);
    };
  }, [actor]);

  const [jsonContent, setJsonContent] = React.useState<Record<string, unknown> | null>(null);
  const [showConfirmDialog, setShowConfirmDialog] = React.useState<boolean>(false);
  const [readBusy, setReadBusy] = React.useState<boolean>(false);
  const [readError, setReadError] = React.useState<string | null>(null);
  const [downloadBusy, setDownloadBusy] = React.useState<boolean>(false);
  const [downloadStatus, setDownloadStatus] = React.useState<string | null>(null);
  const [downloadError, setDownloadError] = React.useState<string | null>(null);
  const [copyStatus, setCopyStatus] = React.useState<string | null>(null);

  const handleClose = React.useCallback(() => {
    if (actor.retired || !isActorValid(actor)) return;
    actor.onClose();
  }, [actor]);

  const handleCancelConfirm = React.useCallback(() => {
    if (actor.retired || !isActorValid(actor)) return;
    setShowConfirmDialog(false);
  }, [actor]);

  const handleConfirmRead = React.useCallback(async () => {
    if (actor.retired || !isActorValid(actor)) return;
    if (actor.confirmationConsumed || actor.readBusy) return;
    if (actor.target.kind !== 'single' || !isSingleTargetValid(actor.target.filename)) return;

    actor.confirmationConsumed = true;
    actor.readBusy = true;
    setReadBusy(true);
    setShowConfirmDialog(false);
    setReadError(null);

    try {
      const apiInstance = createCredentialApi(actor.mode, actor.scope);
      const res = await apiInstance.readContent(actor.target.filename, actor.controller.signal);
      if (actor.retired || !isActorValid(actor)) return;
      setJsonContent(res.content);
    } catch (err: unknown) {
      if (actor.retired || !isActorValid(actor)) return;
      if ((err instanceof DOMException && err.name === 'AbortError') || (err as { name?: string })?.name === 'AbortError') {
        return;
      }
      setReadError('本次读取未完成。请关闭后重新打开，并再次确认查看。');
    } finally {
      if (!actor.retired && isActorValid(actor)) {
        actor.readBusy = false;
        setReadBusy(false);
      }
    }
  }, [actor]);

  const handleDownload = React.useCallback(async () => {
    if (actor.retired || !isActorValid(actor)) return;
    if (actor.downloadBusy) return;

    if (actor.target.kind === 'single' && !isSingleTargetValid(actor.target.filename)) return;
    if (actor.target.kind === 'selection' && !isSelectionTargetValid(actor.target.filenames)) return;

    actor.downloadBusy = true;
    setDownloadBusy(true);
    setDownloadError(null);
    setDownloadStatus(null);

    try {
      const apiInstance = createCredentialApi(actor.mode, actor.scope);
      if (actor.target.kind === 'single') {
        const res = await apiInstance.downloadOne(actor.target.filename, actor.controller.signal);
        if (actor.retired || !isActorValid(actor)) return;
        triggerBlobDownload(res.blob, sanitizeDownloadFilename(actor.target.filename), actor);
        setDownloadStatus('下载已开始');
      } else if (actor.target.kind === 'selection') {
        const namesCopy = [...actor.target.filenames];
        const res = await apiInstance.download(namesCopy, actor.controller.signal);
        if (actor.retired || !isActorValid(actor)) return;
        triggerBlobDownload(res.blob, `${actor.mode}-selected.zip`, actor);
        const selText = res.selected !== null ? String(res.selected) : '未知';
        const misText = res.missing !== null ? String(res.missing) : '未知';
        setDownloadStatus(`下载已开始（已选 ${selText} 项，缺失 ${misText} 项）`);
      } else if (actor.target.kind === 'channel') {
        const res = await apiInstance.downloadAll(actor.controller.signal);
        if (actor.retired || !isActorValid(actor)) return;
        triggerBlobDownload(res.blob, `${actor.mode}-all-credentials.zip`, actor);
        setDownloadStatus('下载已开始');
      }
    } catch (err: unknown) {
      if (actor.retired || !isActorValid(actor)) return;
      if ((err instanceof DOMException && err.name === 'AbortError') || (err as { name?: string })?.name === 'AbortError') {
        return;
      }
      setDownloadError('下载未完成，请稍后重试。');
    } finally {
      if (!actor.retired && isActorValid(actor)) {
        actor.downloadBusy = false;
        setDownloadBusy(false);
      }
    }
  }, [actor]);

  const handleCopy = React.useCallback(async () => {
    if (actor.retired || !isActorValid(actor)) return;
    if (!jsonContent) return;

    const formatted = JSON.stringify(jsonContent, null, 2);
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(formatted);
        if (actor.retired || !isActorValid(actor)) return;
        setCopyStatus('已复制到剪贴板');
      } else {
        setCopyStatus('剪贴板不可用，请手动选择复制');
      }
    } catch {
      if (actor.retired || !isActorValid(actor)) return;
      setCopyStatus('复制失败，请手动选择复制');
    }
  }, [actor, jsonContent]);

  let dialogTitle = '凭证操作';
  let dialogDescription = '';
  if (actor.target.kind === 'single') {
    dialogTitle = '凭证详情与下载';
    dialogDescription = `文件：${actor.target.filename}`;
  } else if (actor.target.kind === 'selection') {
    dialogTitle = '下载所选凭证';
    dialogDescription = `已选择 ${actor.target.filenames.length} 项凭证文件`;
  } else if (actor.target.kind === 'channel') {
    dialogTitle = '下载全部凭证';
    dialogDescription = `当前渠道：${actor.mode === 'antigravity' ? 'Antigravity' : 'Gemini CLI'}`;
  }

  const isSelectionValid = actor.target.kind === 'selection' && isSelectionTargetValid(actor.target.filenames);
  const isSingleValid = actor.target.kind === 'single' && isSingleTargetValid(actor.target.filename);

  return (
    <Dialog
      open={props.open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          handleClose();
        }
      }}
    >
      <DialogContent
        className="sm:max-w-xl max-h-[85vh] flex flex-col gap-4 overflow-hidden"
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{dialogTitle}</DialogTitle>
          <DialogDescription>{dialogDescription}</DialogDescription>
        </DialogHeader>

        {actor.target.kind === 'single' && (
          <div className="flex flex-col gap-4 py-2">
            {jsonContent === null ? (
              <div className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">
                  请选择操作：查看凭证完整 JSON 内容（需要显式敏感操作确认），或直接下载单文件 JSON。
                </p>
                <div className="flex flex-wrap gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!isSingleValid || readBusy || downloadBusy || actor.confirmationConsumed}
                    onClick={() => {
                      if (!actor.retired && isActorValid(actor) && !actor.confirmationConsumed) {
                        setShowConfirmDialog(true);
                      }
                    }}
                  >
                    查看完整 JSON
                  </Button>
                  <Button
                    type="button"
                    variant="default"
                    disabled={!isSingleValid || readBusy || downloadBusy}
                    onClick={handleDownload}
                  >
                    下载 JSON 文件
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">完整凭证 JSON（已排除服务端信封）：</span>
                  <div className="flex items-center gap-2">
                    {copyStatus && <span className="text-xs text-muted-foreground">{copyStatus}</span>}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleCopy}
                    >
                      复制 JSON
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={downloadBusy}
                      onClick={handleDownload}
                    >
                      下载 JSON 文件
                    </Button>
                  </div>
                </div>
                <Textarea
                  readOnly
                  value={JSON.stringify(jsonContent, null, 2)}
                  className="font-mono text-xs h-64 resize-none overflow-auto bg-muted/30 select-text"
                  aria-label="凭证 JSON 内容"
                />
              </div>
            )}

            {readBusy && <p className="text-xs text-muted-foreground">正在读取凭证内容...</p>}
            {readError && <p className="text-xs text-destructive" role="alert">{readError}</p>}
            {downloadBusy && <p className="text-xs text-muted-foreground">正在准备下载...</p>}
            {downloadStatus && <p className="text-xs text-muted-foreground">{downloadStatus}</p>}
            {downloadError && <p className="text-xs text-destructive" role="alert">{downloadError}</p>}
          </div>
        )}

        {actor.target.kind === 'selection' && (
          <div className="flex flex-col gap-4 py-2">
            {!isSelectionValid ? (
              <p className="text-xs text-destructive" role="alert">
                {actor.target.filenames.length === 0
                  ? '未选择任何凭证文件。'
                  : actor.target.filenames.length > 100
                  ? `已选数量（${actor.target.filenames.length}）超过 100 项上限，请减少选择。`
                  : '所选文件列表中包含重复项或无效文件名。'}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                可将已选择的 {actor.target.filenames.length} 项凭证打包为 ZIP 文件下载。
              </p>
            )}
            <div>
              <Button
                type="button"
                variant="default"
                disabled={!isSelectionValid || downloadBusy}
                onClick={handleDownload}
              >
                下载所选 ZIP
              </Button>
            </div>
            {downloadBusy && <p className="text-xs text-muted-foreground">正在打包下载所选凭证...</p>}
            {downloadStatus && <p className="text-xs text-muted-foreground">{downloadStatus}</p>}
            {downloadError && <p className="text-xs text-destructive" role="alert">{downloadError}</p>}
          </div>
        )}

        {actor.target.kind === 'channel' && (
          <div className="flex flex-col gap-4 py-2">
            <p className="text-sm text-muted-foreground">
              将下载当前渠道全部凭证文件并打包为 ZIP 归档。
            </p>
            <div>
              <Button
                type="button"
                variant="default"
                disabled={downloadBusy}
                onClick={handleDownload}
              >
                下载全部 ZIP
              </Button>
            </div>
            {downloadBusy && <p className="text-xs text-muted-foreground">正在打包下载全部凭证...</p>}
            {downloadStatus && <p className="text-xs text-muted-foreground">{downloadStatus}</p>}
            {downloadError && <p className="text-xs text-destructive" role="alert">{downloadError}</p>}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={handleClose}>
            关闭
          </Button>
        </DialogFooter>

        {actor.target.kind === 'single' && (
          <AlertDialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
            <AlertDialogContent onCloseAutoFocus={(e) => e.preventDefault()}>
              <AlertDialogHeader>
                <AlertDialogTitle>查看完整凭证内容确认</AlertDialogTitle>
                <AlertDialogDescription>
                  即将查看凭证「{actor.target.filename}」的完整明文内容（包含敏感密钥与配置）。请确认当前屏幕安全，避免敏感信息泄露。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel
                  disabled={readBusy}
                  onClick={handleCancelConfirm}
                >
                  取消
                </AlertDialogCancel>
                <AlertDialogAction
                  disabled={readBusy}
                  onClick={handleConfirmRead}
                >
                  确认查看
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function FilesDialog(props: FilesDialogProps): ReactElement | null {
  const [, forceUpdate] = React.useReducer((c: number) => c + 1, 0);

  React.useEffect(() => {
    const unsubSession = subscribeSession(forceUpdate);
    const unsubValidation = subscribeSessionValidation(forceUpdate);
    const unsubChannel = subscribePanelChannel(forceUpdate);
    return () => {
      unsubSession();
      unsubValidation();
      unsubChannel();
    };
  }, []);

  if (!isLifetimeValid(props)) {
    return null;
  }

  const viewKey = `${props.mode}:${props.scope.channelEpoch}:${props.scope.sessionEpoch}:${getOwnerRevisionId(props.ownerRevision)}:${getValidationIdentity(props.validation)}:${getTargetKey(props.target)}`;

  return <FilesDialogView key={viewKey} {...props} />;
}
