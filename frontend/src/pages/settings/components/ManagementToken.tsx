import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { registerSessionCleanup, useAuth } from '@/auth';
import { getPanelChannelSnapshot, registerChannelCleanup } from '@/domain/panel';
import { managementToken, writeFailure } from '../api';
import type { TokenStatus } from '../types';
import { registerExitDiscard, setExitDirty } from '../exitProtection';

function formatTokenSource(source?: string): string {
  if (source === 'environment') return '环境变量';
  if (source === 'storage') return '页面存储';
  if (source === 'none') return '未配置来源/无';
  return '来源未知';
}

export function ManagementToken({ status, onUpdate }: { status?: TokenStatus; onUpdate: (status: TokenStatus) => void }) {
  const auth = useAuth();
  const [token, setToken] = useState('');
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [fallback, setFallback] = useState(false);
  const [invalid, setInvalid] = useState(false);

  const epoch = useRef(auth.sessionEpoch);
  epoch.current = auth.sessionEpoch;
  const version = useRef(0);
  const draftRev = useRef(0);
  const copyOpId = useRef(0);
  const mounted = useRef(true);
  const input = useRef<HTMLInputElement>(null);

  function discardInput() {
    draftRev.current++;
    copyOpId.current++;
    setToken('');
    setInvalid(false);
    setConfirm(false);
    setFallback(false);
    setMessage('');
    setExitDirty('management-token', false);
  }

  useEffect(() => {
    mounted.current = true;
    const unregister = registerSessionCleanup(() => {
      ++version.current;
      discardInput();
      setPending(false);
      setMessage('会话已变更，秘密输入已清除。');
    });
    const unregisterDiscard = registerExitDiscard(() => {
      ++version.current;
      discardInput();
      setPending(false);
    });
    const unregisterChannel = registerChannelCleanup(() => {
      ++version.current;
      discardInput();
      setPending(false);
    });
    return () => {
      mounted.current = false;
      draftRev.current++;
      copyOpId.current++;
      ++version.current;
      setExitDirty('management-token', false);
      unregister();
      unregisterDiscard();
      unregisterChannel();
    };
  }, []);

  useEffect(() => {
    if (!auth.authenticated || status?.locked) {
      ++version.current;
      discardInput();
      setPending(false);
    } else {
      setExitDirty('management-token', token.length > 0);
    }
  }, [token, auth.authenticated, status?.locked]);

  const disabled = !auth.authenticated || !status || status.locked || pending;

  function generateToken() {
    if (disabled) return;
    draftRev.current++;
    copyOpId.current++;
    setFallback(false);
    setMessage(prev => (prev === 'Token 已复制到剪贴板。' || prev.startsWith('剪贴板不可用') ? '' : prev));
    try {
      const cryptoObj = typeof crypto !== 'undefined' ? crypto : undefined;
      if (!cryptoObj || typeof cryptoObj.getRandomValues !== 'function') {
        setMessage('安全随机数生成器不可用，未能生成 Token。');
        return;
      }
      const bytes = new Uint8Array(32);
      cryptoObj.getRandomValues(bytes);
      const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
      setToken(hex);
      setInvalid(false);
    } catch {
      setMessage('安全随机数生成失败，未能生成 Token。');
    }
  }

  async function copyToken() {
    if (disabled || !token) return;

    const capturedSessionEpoch = epoch.current;
    const capturedChannelEpoch = getPanelChannelSnapshot().channelEpoch;
    const capturedValidationStatus = auth.validationStatus;
    const capturedRev = ++draftRev.current;
    const capturedToken = token;
    const currentCopyId = ++copyOpId.current;

    setFallback(false);
    setMessage(prev => (prev === 'Token 已复制到剪贴板。' || prev.startsWith('剪贴板不可用') ? '' : prev));

    let success = false;
    try {
      const nav = typeof navigator !== 'undefined' ? navigator : undefined;
      if (!nav?.clipboard || typeof nav.clipboard.writeText !== 'function') {
        throw new Error('Clipboard unavailable');
      }
      await nav.clipboard.writeText(capturedToken);
      success = true;
    } catch {
      success = false;
    }

    if (!mounted.current) return;
    if (currentCopyId !== copyOpId.current) return;
    if (capturedRev !== draftRev.current || token !== capturedToken) return;
    if (capturedSessionEpoch !== epoch.current) return;
    if (capturedChannelEpoch !== getPanelChannelSnapshot().channelEpoch) return;
    if (capturedValidationStatus !== auth.validationStatus) return;
    if (!auth.authenticated || status?.locked || pending) return;

    if (success) {
      setFallback(false);
      setMessage('Token 已复制到剪贴板。');
    } else {
      setFallback(true);
      setMessage('剪贴板不可用或被拒绝，请手动复制下方 Token。');
    }
  }

  async function act(action: 'PUT' | 'DELETE') {
    if (disabled) return;
    if (action === 'PUT' && (token.length < 32 || token.length > 512 || token.trim() !== token || /^\*+$/.test(token))) {
      setInvalid(true);
      setMessage('请输入 32–512 字符的新 Token，不含首尾空白或掩码占位符。');
      input.current?.focus();
      return;
    }
    draftRev.current++;
    copyOpId.current++;
    setFallback(false);
    const e = epoch.current, n = ++version.current;
    setPending(true);
    setConfirm(false);
    try {
      const next = await managementToken(action, token);
      if (e !== epoch.current || n !== version.current) return;
      onUpdate(next);
      discardInput();
      setMessage('独立 Token 操作已确认。');
    } catch (error) {
      if (e === epoch.current && n === version.current) {
        setMessage(writeFailure(error) === 'unknown' ? '结果未知，请重新读取状态；不会自动重试。' : '操作被拒绝。');
      }
    } finally {
      if (e === epoch.current && n === version.current) setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader className="p-3 pb-1.5">
        <CardTitle className="text-base font-semibold">Management Token</CardTitle>
      </CardHeader>
      <CardContent className="p-3 pt-0 space-y-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={!status || status.locked ? 'warning' : status.configured ? 'success' : 'info'} className="h-5 text-xs py-0">
            {!status ? '状态未知' : status.configured ? '已配置' : '未配置（Management API 关闭）'}
            {status?.locked ? ' · 环境变量锁定' : ''}
          </Badge>
          <Badge variant="outline" className="h-5 text-xs py-0">
            <span className="text-muted-foreground mr-1">来源：</span>
            <span>{formatTokenSource(status?.source)}</span>
          </Badge>
        </div>
        <label htmlFor="management-token" className="text-xs md:text-[13px] font-medium text-foreground block">
          新 Token（独立保存）
        </label>
        <Input
          className="h-8 text-base md:text-[13px] aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive"
          ref={input}
          id="management-token"
          type="password"
          autoComplete="new-password"
          value={token}
          aria-invalid={invalid}
          aria-describedby={invalid ? 'management-token-error' : 'management-token-help'}
          onChange={event => {
            draftRev.current++;
            copyOpId.current++;
            setToken(event.target.value);
            setInvalid(false);
            setFallback(false);
            setMessage(prev => (prev === 'Token 已复制到剪贴板。' || prev.startsWith('剪贴板不可用') ? '' : prev));
          }}
          disabled={disabled}
        />
        <p id="management-token-help" className="text-[12px] leading-tight text-muted-foreground">
          未提交输入只留在当前页面；环境锁定、会话变化或离开本页会清除。
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" className="h-8 text-xs" disabled={disabled || !token} onClick={() => void act('PUT')}>
            保存 Token
          </Button>
          <Button type="button" variant="outline" size="sm" className="h-8 text-xs" disabled={disabled} onClick={generateToken}>
            生成 Token
          </Button>
          <Button type="button" variant="outline" size="sm" className="h-8 text-xs" disabled={disabled || !token} onClick={() => void copyToken()}>
            复制 Token
          </Button>
          <Button type="button" variant="outline" size="sm" className="h-8 text-xs" disabled={pending || !token} onClick={discardInput}>
            放弃 Token 输入
          </Button>
          <Button type="button" variant="destructive" size="sm" className="h-8 text-xs" disabled={disabled || !status?.configured} onClick={() => setConfirm(true)}>
            清除 Token
          </Button>
        </div>
        {confirm && (
          <div role="alert" className="space-y-1.5 rounded-md border border-destructive/30 bg-destructive-bg p-2 text-xs text-destructive">
            <p>清除将关闭 Management API，依赖此 Token 的连接会失效。</p>
            <div className="flex gap-2">
              <Button variant="destructive" size="sm" className="h-7 text-xs px-2" onClick={() => void act('DELETE')}>
                确认清除
              </Button>
              <Button variant="outline" size="sm" className="h-7 text-xs px-2" onClick={() => setConfirm(false)}>
                取消
              </Button>
            </div>
          </div>
        )}
        {fallback && (
          <div className="space-y-1">
            <label htmlFor="management-token-fallback" className="text-xs font-medium text-foreground block">
              手动复制 Token（剪贴板不可用）
            </label>
            <Input
              id="management-token-fallback"
              className="h-8 text-base md:text-xs font-mono"
              readOnly
              value={token}
              onFocus={event => event.currentTarget.select()}
              onClick={event => event.currentTarget.select()}
              aria-label="手动复制 Token"
            />
          </div>
        )}
        {message && (
          <p
            id={invalid ? 'management-token-error' : undefined}
            role={invalid ? 'alert' : 'status'}
            className={invalid ? 'text-[12px] leading-tight text-destructive' : 'text-xs text-info'}
          >
            {message}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
