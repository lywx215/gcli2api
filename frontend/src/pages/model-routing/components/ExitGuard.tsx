import { useEffect, useRef, useState } from 'react';
import { registerSessionCleanup, useAuth } from '@/auth';
import { registerRouteGuard } from '@/app/routes';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';

type Pending = { title: string; description: string; run(): void; epoch: number };
export function navigateFromRouting(href: string) { window.location.assign(href); }
export function usableFocus(element: HTMLElement | null): element is HTMLElement {
  if (!element?.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]') || element.matches(':disabled, [aria-disabled="true"]')) return false;
  for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  }
  return true;
}
export function useRoutingExitGuard(protect: boolean, discard: () => void) {
  const auth = useAuth();
  const [pending, setPending] = useState<Pending | null>(null);
  const latest = useRef({ protect, discard, auth }); latest.current = { protect, discard, auth };
  const allowExit = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  function ask(title: string, description: string, run: () => void, trigger?: HTMLElement | null) {
    returnFocus.current = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setPending({ title, description, run, epoch: latest.current.auth.sessionEpoch });
  }
  const exitDescription = '两个渠道的草稿、尚未确认的提交和读回对照将从本页清除。已发送的保存操作可能已经生效；离开或取消请求不会撤销服务器操作。';
  function askExit(run: () => void, trigger?: HTMLElement | null) {
    ask('离开模型路由页面？', exitDescription, () => {
      allowExit.current = true; latest.current.discard(); run();
    }, trigger);
  }
  useEffect(() => registerSessionCleanup(() => {
    allowExit.current = false; returnFocus.current = null; setPending(null);
  }), []);
  useEffect(() => { allowExit.current = false; setPending(null); }, [auth.sessionEpoch, auth.authenticated]);
  useEffect(() => {
    if (!auth.authenticated) return;
    return registerRouteGuard(attempt => {
      if (allowExit.current || !latest.current.protect || !latest.current.auth.authenticated || attempt.from === attempt.to) return true;
      ask('离开模型路由页面？', exitDescription, () => {
        // A shared retry can become obsolete while the dialog is open. Hash
        // navigation needs no beforeunload bypass; retain the draft on a no-op.
        attempt.retry();
        if (window.location.href === new URL(attempt.href, window.location.href).href) latest.current.discard();
      }, returnFocus.current);
      return false;
    });
  }, [auth.authenticated, auth.sessionEpoch]);
  useEffect(() => {
    if (!protect || !auth.authenticated) return;
    allowExit.current = false;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (allowExit.current || !latest.current.protect) return;
      event.preventDefault(); event.returnValue = '';
    };
    const handleClick = (event: MouseEvent) => {
      if (allowExit.current || !latest.current.protect || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target : null;
      const logout = target?.closest<HTMLElement>('[data-panel-action="logout"]');
      if (logout) {
        event.preventDefault(); event.stopPropagation(); askExit(() => latest.current.auth.logout(), logout); return;
      }
      const anchor = target?.closest<HTMLAnchorElement>('a[href]');
      if (!anchor || (anchor.target && anchor.target !== '_self') || anchor.hasAttribute('download')) return;
      const next = new URL(anchor.href, window.location.href), current = new URL(window.location.href);
      if (!['http:', 'https:'].includes(next.protocol) || next.href === current.href || next.hash === '#main-content') return;
      returnFocus.current = anchor;
      // Hash navigation is handled by the common route guard, including back/forward.
      if (next.origin === current.origin && next.pathname === current.pathname && next.search === current.search) return;
      event.preventDefault(); askExit(() => navigateFromRouting(next.href), anchor);
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', handleClick, true);
    return () => { window.removeEventListener('beforeunload', beforeUnload); document.removeEventListener('click', handleClick, true); };
  }, [protect, auth.authenticated]);
  const dialog = <AlertDialog open={pending !== null && auth.authenticated && pending.epoch === auth.sessionEpoch} onOpenChange={open => { if (!open) setPending(null); }}>
    <AlertDialogContent className="rounded-lg bg-popover text-popover-foreground" onCloseAutoFocus={event => {
      event.preventDefault();
      if (!latest.current.auth.authenticated) return;
      for (const candidate of [returnFocus.current, document.getElementById('routing-read'), document.getElementById('routing-content'), document.getElementById('main-content')]) {
        if (!usableFocus(candidate)) continue;
        candidate.focus(); if (document.activeElement === candidate) break;
      }
    }}>
      <AlertDialogHeader><AlertDialogTitle className="text-lg leading-6">{pending?.title}</AlertDialogTitle><AlertDialogDescription className="text-xs leading-5">{pending?.description}</AlertDialogDescription></AlertDialogHeader>
      <AlertDialogFooter><AlertDialogCancel>取消，保留草稿</AlertDialogCancel><AlertDialogAction onClick={() => {
        const action = pending; setPending(null);
        if (!action || action.epoch !== latest.current.auth.sessionEpoch || !latest.current.auth.authenticated) return;
        action.run();
      }}>确认并继续</AlertDialogAction></AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
  return { ask, dialog };
}
