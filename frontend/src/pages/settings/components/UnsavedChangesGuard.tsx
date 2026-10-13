import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { registerSessionCleanup, useAuth } from '@/auth';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { discardExitChanges, hasExitChanges, hasSecretExitChanges, hasUnconfirmedSubmission, leavesDocument, navigateFromSettings, subscribeExitChanges } from '../exitProtection';

function canRestoreFocus(element: HTMLElement | null): element is HTMLElement {
  if(!element?.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]') || element.matches(':disabled, [aria-disabled="true"]'))return false;
  for(let ancestor:HTMLElement|null=element;ancestor;ancestor=ancestor.parentElement){
    const style=getComputedStyle(ancestor);
    if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse')return false;
  }
  return true;
}

export function UnsavedChangesGuard() {
  const { authenticated, sessionEpoch } = useAuth();
  const dirty = useSyncExternalStore(subscribeExitChanges, hasExitChanges);
  const secrets = useSyncExternalStore(subscribeExitChanges, hasSecretExitChanges);
  const unconfirmed = useSyncExternalStore(subscribeExitChanges, hasUnconfirmedSubmission);
  const [pending, setPending] = useState<{ href: string; anchor: HTMLAnchorElement; epoch: number; full: boolean } | null>(null);
  const returnFocus = useRef<HTMLAnchorElement | null>(null);
  useEffect(() => registerSessionCleanup(() => { returnFocus.current=null;setPending(null); }), []);
  useEffect(() => { setPending(null); }, [sessionEpoch, authenticated]);
  useEffect(() => {
    if (!dirty || !authenticated) return;
    const handleClick = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
      if (!anchor || !hasExitChanges()) return;
      const full = leavesDocument(anchor, event);
      const destination = new URL(anchor.href, location.href);
      const internal = !event.defaultPrevented && event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && (!anchor.target || anchor.target === '_self') && !anchor.hasAttribute('download') &&
        destination.origin === location.origin && destination.pathname === location.pathname && destination.search === location.search && destination.hash !== location.hash && destination.hash.startsWith('#/');
      if (!full && !(internal && hasSecretExitChanges())) return;
      event.preventDefault();
      returnFocus.current=anchor;
      setPending({ href: anchor.href, anchor, epoch: sessionEpoch, full });
    };
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [dirty, authenticated, sessionEpoch]);
  return <>{secrets && <p className="text-[13px] leading-5 text-warning">未提交的密码、Token 或敏感地址输入不会跨页面保留；离开设置页会清除这些输入。</p>}{unconfirmed && <p role="status" className="text-[13px] leading-5 text-warning">存在尚未确认的配置提交。普通读回不会解除提醒；可明确采用观察值或放弃草稿结束跟踪，不会自动重试。</p>}<AlertDialog open={!!pending && authenticated && pending.epoch === sessionEpoch} onOpenChange={open => { if (!open) setPending(null); }}>
    <AlertDialogContent onCloseAutoFocus={event => {
      event.preventDefault();
      if(!authenticated)return;
      // A mobile Sheet may have already unmounted the original navigation link.
      const candidates=[returnFocus.current,document.getElementById('settings-read-config'),document.getElementById('settings-content'),document.getElementById('main-content')];
      for(const candidate of candidates){
        if(!canRestoreFocus(candidate))continue;
        candidate.focus();if(document.activeElement===candidate)break;
      }
    }}>
      <AlertDialogHeader><AlertDialogTitle>{pending?.full ? '离开设置页面？' : '清除秘密输入后切换页面？'}</AlertDialogTitle><AlertDialogDescription>{pending?.full ? '存在未保存的修改或尚未确认的提交。继续离开会放弃本页草稿和未提交的秘密输入；不会撤销已发送到服务器的操作。' : '未提交的密码、Token 和敏感地址输入将被清除。非敏感草稿继续保留在内存中；不会提交或撤销服务器操作。'}</AlertDialogDescription></AlertDialogHeader>
      <AlertDialogFooter><AlertDialogCancel>继续编辑</AlertDialogCancel><AlertDialogAction onClick={() => {
        if (!pending || pending.epoch !== sessionEpoch || !authenticated) return;
        const href = pending.href;
        discardExitChanges(pending.full ? 'all' : 'secrets'); setPending(null); navigateFromSettings(href);
      }}>{pending?.full ? '放弃并离开' : '清除秘密输入并切换'}</AlertDialogAction></AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog></>;
}
