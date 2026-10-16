import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { registerSessionCleanup, useAuth } from '@/auth';
import { getSessionSnapshot, getSessionValidationSnapshot } from '@/auth/session';
import {
  getAcceptedPanelRouteSnapshot,
  navigatePanel,
  registerRouteGuard,
  routeFromHash,
  type AcceptedPanelRouteSnapshot,
  type RouteId,
  type RouteNavigation,
} from '@/app/routes';
import { type PanelMode } from '@/domain/panel';
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
import {
  discardExitChanges,
  hasExitChanges,
  hasSecretExitChanges,
  hasUnconfirmedSubmission,
  leavesDocument,
  navigateFromSettings,
  subscribeExitChanges,
} from '../exitProtection';

function canRestoreFocus(element: HTMLElement | null): element is HTMLElement {
  if (
    !element?.isConnected ||
    element.closest('[hidden], [inert], [aria-hidden="true"]') ||
    element.matches(':disabled, [aria-disabled="true"]')
  ) {
    return false;
  }
  for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
      return false;
    }
  }
  return true;
}

function parseDestinationRouteAndMode(hash: string): { route: RouteId; mode?: PanelMode } {
  const route = routeFromHash(hash);
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const queryIndex = raw.indexOf('?');
  const pathPart = queryIndex === -1 ? raw : raw.slice(0, queryIndex);
  const cleaned = pathPart.replace(/^\/+/, '').replace(/\/+$/, '');
  if (cleaned === 'manage') return { route, mode: 'geminicli' };
  if (cleaned === 'antigravity-manage') return { route, mode: 'antigravity' };
  if (queryIndex !== -1) {
    const params = new URLSearchParams(raw.slice(queryIndex + 1));
    if (params.has('channel')) {
      const values = params.getAll('channel');
      const mode: PanelMode = values.length === 1 && values[0] === 'geminicli' ? 'geminicli' : 'antigravity';
      return { route, mode };
    }
  }
  return { route };
}

function isCurrentSessionVerified(expectedEpoch: number, authenticated: boolean): boolean {
  if (!authenticated) return false;
  try {
    const session = getSessionSnapshot();
    const validation = getSessionValidationSnapshot();
    return (
      session.token !== null &&
      session.sessionEpoch === expectedEpoch &&
      validation.sessionEpoch === expectedEpoch &&
      validation.status === 'verified'
    );
  } catch {
    return false;
  }
}

type PendingNavigation = {
  id: number;
  lifetime: number;
  href: string;
  anchor: HTMLAnchorElement | null;
  epoch: number;
  full: boolean;
  attempt?: RouteNavigation;
  originatingSnapshot: AcceptedPanelRouteSnapshot;
};

export function UnsavedChangesGuard() {
  const { authenticated, sessionEpoch } = useAuth();
  const dirty = useSyncExternalStore(subscribeExitChanges, hasExitChanges);
  const secrets = useSyncExternalStore(subscribeExitChanges, hasSecretExitChanges);
  const unconfirmed = useSyncExternalStore(subscribeExitChanges, hasUnconfirmedSubmission);

  const [pending, setPending] = useState<PendingNavigation | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  const confirmationSeq = useRef(0);
  const setupLifetimeSeq = useRef(0);
  const activeLifetimeRef = useRef(0);
  const claimedConfirmations = useRef<Set<number>>(new Set());
  const currentPendingRef = useRef<PendingNavigation | null>(null);
  const approvedDepartureRef = useRef<{
    route: RouteId;
    mode?: PanelMode;
    epoch: number;
    lifetime: number;
  } | null>(null);

  useEffect(() => {
    const lifetime = ++setupLifetimeSeq.current;
    activeLifetimeRef.current = lifetime;
    return () => {
      activeLifetimeRef.current = 0;
      if (currentPendingRef.current) {
        claimedConfirmations.current.add(currentPendingRef.current.id);
        currentPendingRef.current = null;
      }
      approvedDepartureRef.current = null;
    };
  }, []);

  useEffect(() => {
    return registerSessionCleanup(() => {
      returnFocus.current = null;
      if (currentPendingRef.current) {
        claimedConfirmations.current.add(currentPendingRef.current.id);
        currentPendingRef.current = null;
      }
      approvedDepartureRef.current = null;
      setPending(null);
    });
  }, []);

  useEffect(() => {
    if (currentPendingRef.current) {
      claimedConfirmations.current.add(currentPendingRef.current.id);
      currentPendingRef.current = null;
    }
    approvedDepartureRef.current = null;
    setPending(null);
  }, [sessionEpoch, authenticated]);

  const handleCancel = () => {
    if (currentPendingRef.current) {
      claimedConfirmations.current.add(currentPendingRef.current.id);
      currentPendingRef.current = null;
    }
    approvedDepartureRef.current = null;
    setPending(null);
  };

  useEffect(() => {
    if (!authenticated) return;
    return registerRouteGuard((attempt: RouteNavigation) => {
      if (!authenticated || !isCurrentSessionVerified(sessionEpoch, authenticated)) {
        if (currentPendingRef.current) {
          claimedConfirmations.current.add(currentPendingRef.current.id);
          currentPendingRef.current = null;
        }
        approvedDepartureRef.current = null;
        setPending(null);
        return true;
      }
      if (!hasSecretExitChanges()) return true;

      if (approvedDepartureRef.current) {
        const approved = approvedDepartureRef.current;
        approvedDepartureRef.current = null;
        if (
          approved.route === attempt.to &&
          (approved.mode === undefined || approved.mode === attempt.toMode) &&
          approved.epoch === sessionEpoch &&
          approved.lifetime === activeLifetimeRef.current
        ) {
          return true;
        }
      }

      const isSettingsDeparture =
        attempt.from === 'settings' &&
        (attempt.to !== 'settings' || attempt.fromMode !== attempt.toMode);
      if (!isSettingsDeparture) return true;

      returnFocus.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;

      const id = ++confirmationSeq.current;
      const originatingSnapshot = getAcceptedPanelRouteSnapshot();
      const nextPending: PendingNavigation = {
        id,
        lifetime: activeLifetimeRef.current,
        href: attempt.href,
        anchor: null,
        epoch: sessionEpoch,
        full: false,
        attempt,
        originatingSnapshot,
      };

      if (currentPendingRef.current) {
        claimedConfirmations.current.add(currentPendingRef.current.id);
      }
      currentPendingRef.current = nextPending;
      setPending(nextPending);
      return false;
    });
  }, [authenticated, sessionEpoch]);

  useEffect(() => {
    if (!dirty || !authenticated) return;
    const handleClick = (event: MouseEvent) => {
      const anchor =
        event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
      if (!anchor || !hasExitChanges()) return;

      if (!authenticated || !isCurrentSessionVerified(sessionEpoch, authenticated)) {
        if (currentPendingRef.current) {
          claimedConfirmations.current.add(currentPendingRef.current.id);
          currentPendingRef.current = null;
        }
        approvedDepartureRef.current = null;
        setPending(null);
        return;
      }

      const full = leavesDocument(anchor, event);
      const destination = new URL(anchor.href, location.href);
      const internal =
        !event.defaultPrevented &&
        event.button === 0 &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        !event.altKey &&
        (!anchor.target || anchor.target === '_self') &&
        !anchor.hasAttribute('download') &&
        destination.origin === location.origin &&
        destination.pathname === location.pathname &&
        destination.search === location.search &&
        destination.hash !== location.hash &&
        destination.hash.startsWith('#/');

      if (!full && !(internal && hasSecretExitChanges())) return;

      if (internal && !full) {
        const { route: targetRoute, mode: targetMode } = parseDestinationRouteAndMode(destination.hash);
        const currentSnapshot = getAcceptedPanelRouteSnapshot();
        const isSettingsDeparture =
          targetRoute !== 'settings' ||
          (targetMode !== undefined && targetMode !== currentSnapshot.mode);
        if (!isSettingsDeparture) {
          return;
        }
      }

      event.preventDefault();
      returnFocus.current = anchor;

      const id = ++confirmationSeq.current;
      const originatingSnapshot = getAcceptedPanelRouteSnapshot();
      const nextPending: PendingNavigation = {
        id,
        lifetime: activeLifetimeRef.current,
        href: anchor.href,
        anchor,
        epoch: sessionEpoch,
        full,
        originatingSnapshot,
      };

      if (currentPendingRef.current) {
        claimedConfirmations.current.add(currentPendingRef.current.id);
      }
      currentPendingRef.current = nextPending;
      setPending(nextPending);
    };

    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [dirty, authenticated, sessionEpoch]);

  return (
    <>
      {secrets && (
        <p className="text-xs leading-4 text-warning">
          未提交的密码、Token 或敏感地址输入不会跨页面保留；离开设置页会清除这些输入。
        </p>
      )}
      {unconfirmed && (
        <p role="status" className="text-xs leading-4 text-warning">
          存在尚未确认的配置提交。普通读回不会解除提醒；可明确采用观察值或放弃草稿结束跟踪，不会自动重试。
        </p>
      )}
      <AlertDialog
        open={
          !!pending &&
          authenticated &&
          pending.epoch === sessionEpoch &&
          pending.lifetime === activeLifetimeRef.current
        }
        onOpenChange={open => {
          if (!open) handleCancel();
        }}
      >
        <AlertDialogContent
          className="p-4 max-w-md"
          onCloseAutoFocus={event => {
            event.preventDefault();
            if (!authenticated) return;
            // A mobile Sheet may have already unmounted the original navigation link.
            const candidates = [
              returnFocus.current,
              document.getElementById('settings-read-config'),
              document.getElementById('settings-content'),
              document.getElementById('main-content'),
            ];
            for (const candidate of candidates) {
              if (!canRestoreFocus(candidate)) continue;
              candidate.focus();
              if (document.activeElement === candidate) break;
            }
          }}
        >
          <AlertDialogHeader className="space-y-1">
            <AlertDialogTitle className="text-base font-semibold">
              {pending?.full ? '离开设置页面？' : '清除秘密输入后切换页面？'}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-xs text-muted-foreground">
              {pending?.full
                ? '存在未保存的修改或尚未确认的提交。继续离开会放弃本页草稿和未提交的秘密输入；不会撤销已发送到服务器的操作。'
                : '未提交的密码、Token 和敏感地址输入将被清除。非敏感草稿继续保留在内存中；不会提交或撤销服务器操作。'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="pt-2 gap-2">
            <AlertDialogCancel className="h-8 text-xs" onClick={handleCancel}>继续编辑</AlertDialogCancel>
            <AlertDialogAction
              className="h-8 text-xs"
              onClick={() => {
                if (
                  !pending ||
                  !currentPendingRef.current ||
                  pending.id !== currentPendingRef.current.id
                ) {
                  return;
                }
                if (claimedConfirmations.current.has(pending.id)) return;
                claimedConfirmations.current.add(pending.id);
                currentPendingRef.current = null;

                const currentLifetime = activeLifetimeRef.current;
                if (currentLifetime === 0 || currentLifetime !== pending.lifetime) {
                  setPending(null);
                  return;
                }

                if (!isCurrentSessionVerified(pending.epoch, authenticated)) {
                  setPending(null);
                  return;
                }

                const currentSnap = getAcceptedPanelRouteSnapshot();
                if (
                  currentSnap.navigationEpoch !== pending.originatingSnapshot.navigationEpoch ||
                  currentSnap.route !== pending.originatingSnapshot.route ||
                  currentSnap.mode !== pending.originatingSnapshot.mode
                ) {
                  setPending(null);
                  return;
                }

                if (pending.full) {
                  setPending(null);
                  discardExitChanges('all');
                  navigateFromSettings(pending.href);
                  return;
                }

                if (pending.attempt) {
                  const attempt = pending.attempt;
                  setPending(null);
                  const snapBefore = getAcceptedPanelRouteSnapshot();
                  attempt.retry();
                  const snapAfter = getAcceptedPanelRouteSnapshot();

                  const navigationAccepted =
                    snapAfter.navigationEpoch > snapBefore.navigationEpoch &&
                    snapAfter.route === attempt.to &&
                    (attempt.toMode === undefined || snapAfter.mode === attempt.toMode);

                  if (
                    navigationAccepted &&
                    activeLifetimeRef.current === currentLifetime &&
                    isCurrentSessionVerified(pending.epoch, authenticated)
                  ) {
                    discardExitChanges('secrets');
                  }
                  return;
                }

                const dest = new URL(pending.href, window.location.href);
                const { route: targetRoute, mode: targetMode } = parseDestinationRouteAndMode(dest.hash);
                const snapBeforeAnchor = getAcceptedPanelRouteSnapshot();
                const isDeparture =
                  targetRoute !== 'settings' ||
                  (targetMode !== undefined && targetMode !== snapBeforeAnchor.mode);

                if (!isDeparture) {
                  setPending(null);
                  return;
                }

                setPending(null);
                approvedDepartureRef.current = {
                  route: targetRoute,
                  mode: targetMode,
                  epoch: pending.epoch,
                  lifetime: pending.lifetime,
                };

                let navigationAccepted = false;
                try {
                  const snapBefore = getAcceptedPanelRouteSnapshot();
                  navigatePanel(targetRoute, targetMode);
                  const snapAfter = getAcceptedPanelRouteSnapshot();

                  navigationAccepted =
                    snapAfter.navigationEpoch > snapBefore.navigationEpoch &&
                    snapAfter.route === targetRoute &&
                    (targetMode === undefined || snapAfter.mode === targetMode);
                } finally {
                  approvedDepartureRef.current = null;
                }

                if (
                  navigationAccepted &&
                  activeLifetimeRef.current === currentLifetime &&
                  isCurrentSessionVerified(pending.epoch, authenticated)
                ) {
                  discardExitChanges('secrets');
                }
              }}
            >
              {pending?.full ? '放弃并离开' : '清除秘密输入并切换'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
