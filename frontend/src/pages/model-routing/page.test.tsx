import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from '@/auth';
import { getSessionSnapshot, setSessionToken } from '@/auth/session';
import type { Issue, Snapshot } from './types';
import { copy, equal } from './types';
import { useModelRouting } from './hooks';
import ModelRoutingPage from './index';

type Attempt = { from: string; to: string; href: string; retry(): void };
const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), recovery: vi.fn(), guard: null as null | ((attempt: Attempt) => boolean) }));
vi.mock('./api', () => ({ getRouting: mocks.get, putRouting: mocks.put, canRecover: mocks.recovery }));
vi.mock('@/app/routes', () => ({ registerRouteGuard: (guard: (attempt: Attempt) => boolean) => {
  mocks.guard = guard;
  return () => { if (mocks.guard === guard) mocks.guard = null; };
} }));

const initial = [
  { channel: 'geminicli', public_name: 'public-cli', upstream_name: 'target-cli', enabled: false, future: { nested: [1, false] } },
  { channel: 'antigravity', public_name: 'public-ag', upstream_name: 'target-ag', enabled: true },
];
function snapshot(routes: unknown[] = initial, issues: Issue[] = []): Snapshot {
  return { routes: copy(routes), issues, supportedChannels: ['geminicli', 'antigravity'], capabilities: ['model.routing.aliases', 'model.identity.public'], policyDigest: 'test-policy', valid: issues.length === 0,
    validation: { antigravity: { valid: !issues.length, issues }, geminicli: { valid: !issues.length, issues } } };
}
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const wrapper = ({ children }: { children: React.ReactNode }) => <AuthProvider>{children}</AuthProvider>;
function Layout() {
  const auth = useAuth();
  return <><button data-panel-action="logout" onClick={auth.logout}>任意退出文案</button><a href="#/logs">导航到日志</a><a href="/model-routing">旧页面</a><a href="#main-content">跳至内容</a><main id="main-content" tabIndex={-1}><ModelRoutingPage /></main></>;
}
async function mount() {
  const view = render(<Layout />, { wrapper });
  await screen.findByText('已读取两个渠道的完整路由表。');
  return view;
}
function field(label: string) { return screen.getAllByLabelText(label)[0]; }
function change(label: string, value: string) { fireEvent.change(field(label), { target: { value } }); }
function selectChannel(name: string) { fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0, ctrlKey: false }); }
function warns() { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }
async function confirm() { fireEvent.click(await screen.findByRole('button', { name: '确认并继续' })); }
beforeEach(() => {
  mocks.get.mockReset(); mocks.put.mockReset(); mocks.recovery.mockReset(); mocks.guard = null;
  mocks.get.mockResolvedValue(snapshot()); mocks.put.mockImplementation(async (rows: unknown[]) => ({ kind: 'acknowledged', snapshot: snapshot(rows), issues: [] }));
  mocks.recovery.mockReturnValue(false);
  setSessionToken('synthetic-routing-session');
  window.history.replaceState(null, '', '/ui/#/model-routing');
  // jsdom has no Tailwind stylesheet. Use the real visible-layout branch explicitly.
  document.head.insertAdjacentHTML('beforeend', '<style>[data-layout="mobile"]{display:none}</style>');
});

describe('model routing state', () => {
  it('preserves the other channel, full ordering, unknown fields and malformed historical values until explicitly changed', async () => {
    const historic = [...initial, { channel: 'antigravity', public_name: 7, upstream_name: null, enabled: 1, future: ['keep'] }, null];
    mocks.get.mockResolvedValueOnce(snapshot(historic));
    const { result } = renderHook(useModelRouting, { wrapper });
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.changeRow(1, { upstream_name: 'edited-target' }));
    await act(async () => { await result.current.save(); });
    expect(mocks.put).toHaveBeenCalledOnce();
    expect(mocks.put.mock.calls[0][0]).toEqual([historic[0], { ...initial[1], upstream_name: 'edited-target' }, historic[2], null]);
    expect(result.current.dirty).toBe(false);
  });
  it('unknown saves preserve sent evidence and draft; GET only observes until explicit adoption', async () => {
    const { result } = renderHook(useModelRouting, { wrapper });
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.changeRow(1, { public_name: 'local-only' }));
    mocks.put.mockResolvedValueOnce({ kind: 'unknown', issues: [] });
    await act(async () => { await result.current.save(); });
    expect(result.current.unknown).toBe(true);
    expect(equal(result.current.sent, result.current.rows)).toBe(true);
    await act(async () => { await result.current.save(); await result.current.read(); });
    expect(mocks.put).toHaveBeenCalledOnce();
    expect(result.current.unknown).toBe(true);
    expect(result.current.rows[1]).toMatchObject({ public_name: 'local-only' });
    expect(result.current.observed?.routes).toEqual(initial);
    act(() => result.current.adoptObserved());
    expect(result.current.rows).toEqual(initial); expect(result.current.protect).toBe(false); expect(result.current.sent).toBeNull();
  });
  it('explicitly ending comparison retains local edits and never replays a PUT', async () => {
    const { result } = renderHook(useModelRouting, { wrapper });
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.changeRow(1, { upstream_name: 'changed-ag' }));
    mocks.put.mockResolvedValueOnce({ kind: 'unknown', issues: [] });
    await act(async () => { await result.current.save(); await result.current.read(); });
    act(() => result.current.retainAfterComparison());
    expect(result.current.unknown).toBe(false); expect(result.current.dirty).toBe(true);
    expect(result.current.rows[1]).toMatchObject({ upstream_name: 'changed-ag' }); expect(mocks.put).toHaveBeenCalledOnce();
  });
  it('a failed GET retains unknown write evidence and both channel drafts', async () => {
    const { result } = renderHook(useModelRouting, { wrapper });
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.changeRow(1, { public_name: 'local-ag' }));
    mocks.put.mockResolvedValueOnce({ kind: 'unknown', issues: [] });
    await act(async () => { await result.current.save(); });
    const sent = copy(result.current.sent); mocks.get.mockRejectedValueOnce(new Error('synthetic read failure'));
    await act(async () => { await result.current.read(); });
    expect(result.current.unknown).toBe(true); expect(result.current.sent).toEqual(sent); expect(result.current.rows[0]).toEqual(initial[0]);
  });
  it('clears prior-session drafts, observations and pending requests; a late save cannot populate the new session', async () => {
    const pending = deferred<{ kind: string; snapshot: Snapshot; issues: Issue[] }>();
    const { result } = renderHook(useModelRouting, { wrapper });
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.changeRow(1, { public_name: 'previous-session-private' }));
    mocks.put.mockReturnValueOnce(pending.promise);
    act(() => { void result.current.save(); });
    const signal = mocks.put.mock.calls[0][1] as AbortSignal;
    act(() => setSessionToken(null));
    expect(signal.aborted).toBe(true); expect(result.current.rows).toEqual([]); expect(result.current.sent).toBeNull();
    act(() => setSessionToken('synthetic-next-session'));
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => { pending.resolve({ kind: 'acknowledged', snapshot: snapshot([{ ...initial[1], public_name: 'previous-session-private' }]), issues: [] }); });
    expect(result.current.rows).toEqual(initial); expect(result.current.unknown).toBe(false); expect(mocks.put).toHaveBeenCalledOnce();
  });
  it('isolates a late read after unmount and fetches a fresh table on remount', async () => {
    const pending = deferred<Snapshot>(); mocks.get.mockReturnValueOnce(pending.promise);
    const old = renderHook(useModelRouting, { wrapper });
    const signal = mocks.get.mock.calls[0][0] as AbortSignal; old.unmount(); expect(signal.aborted).toBe(true);
    const next = renderHook(useModelRouting, { wrapper });
    await waitFor(() => expect(next.result.current.ready).toBe(true));
    await act(async () => { pending.resolve(snapshot([{ ...initial[1], public_name: 'old-read' }])); });
    expect(next.result.current.rows).toEqual(initial);
  });
  it.each(['missing-capability', 'missing-channel'])('makes unsupported %s responses read-only', async scenario => {
    const unsupported = snapshot();
    if (scenario === 'missing-capability') unsupported.capabilities = []; else unsupported.supportedChannels = ['antigravity'];
    mocks.get.mockResolvedValueOnce(unsupported);
    const { result } = renderHook(useModelRouting, { wrapper });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.editable).toBe(false);
    act(() => { result.current.changeRow(1, { public_name: 'blocked' }); result.current.addRow(); });
    expect(result.current.rows).toEqual(initial);
    await act(async () => { await result.current.save(); }); expect(mocks.put).not.toHaveBeenCalled();
  });
});

describe('model routing production UI', () => {
  it('associates active tabs with their panels and supports keyboard channel changes', async () => {
    await mount();
    const ag = screen.getByRole('tab', { name: 'Antigravity' });
    const agPanel = document.getElementById(ag.getAttribute('aria-controls')!);
    expect(agPanel).toHaveAttribute('role', 'tabpanel'); expect(agPanel).toHaveAttribute('aria-labelledby', ag.id);
    ag.focus(); fireEvent.keyDown(ag, { key: 'ArrowRight' });
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Gemini CLI' })).toHaveAttribute('data-state', 'active'));
    const cli = screen.getByRole('tab', { name: 'Gemini CLI' });
    expect(document.getElementById(cli.getAttribute('aria-controls')!)).toHaveAttribute('aria-labelledby', cli.id);
    expect(field('第 1 行公开名称')).toHaveValue('public-cli');
  });
  it('defaults to Antigravity and submits both channels without coercing the inactive channel', async () => {
    await mount(); expect(screen.getByRole('tab', { name: 'Antigravity' })).toHaveAttribute('data-state', 'active');
    change('第 2 行目标名称', 'ag-next');
    selectChannel('Gemini CLI');
    expect(field('第 1 行公开名称')).toHaveValue('public-cli');
    fireEvent.click(screen.getByRole('button', { name: '保存全部路由' }));
    await screen.findByText('服务已确认保存完整路由表。');
    expect(mocks.put.mock.calls[0][0]).toEqual([initial[0], { ...initial[1], upstream_name: 'ag-next' }]); expect(warns()).toBe(false);
  });
  it('renders rejected related-row errors across tabs and focuses the primary global row', async () => {
    const issue: Issue = { channel: 'geminicli', row: 0, field: 'public_name', reason: 'DUPLICATE_PUBLIC_NAME', related_rows: [1] };
    await mount(); change('第 2 行公开名称', 'duplicate');
    mocks.put.mockResolvedValueOnce({ kind: 'rejected', issues: [issue] });
    fireEvent.click(screen.getByRole('button', { name: '保存全部路由' }));
    await waitFor(() => expect(field('第 1 行公开名称')).toHaveFocus());
    expect(field('第 1 行公开名称')).toHaveAttribute('aria-invalid', 'true'); expect(field('第 1 行公开名称')).toHaveAttribute('aria-describedby');
    expect(screen.getByRole('tab', { name: 'Antigravity，1 个错误' })).toBeInTheDocument();
    selectChannel('Antigravity，1 个错误');
    expect(field('第 2 行公开名称')).toHaveValue('duplicate'); expect(field('第 2 行公开名称')).toHaveAttribute('aria-invalid', 'true'); expect(warns()).toBe(true);
  });
  it('requires explicit confirmation for an unreadable-table repair and for its full empty PUT', async () => {
    mocks.get.mockRejectedValueOnce(new Error('synthetic unavailable')); mocks.recovery.mockReturnValue(true);
    render(<Layout />, { wrapper });
    const repair = await screen.findByRole('button', { name: '用空表重新编辑修复' });
    expect(screen.getByRole('button', { name: '新增路由' })).toBeDisabled();
    fireEvent.click(repair); expect(await screen.findByRole('alertdialog')).toHaveTextContent('当前完整配置无法读取');
    fireEvent.click(screen.getByRole('button', { name: '取消，保留草稿' })); expect(screen.getByRole('button', { name: '新增路由' })).toBeDisabled();
    fireEvent.click(repair); await confirm(); expect(screen.getByRole('button', { name: '新增路由' })).toBeEnabled(); expect(warns()).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '保存全部路由' })); expect(mocks.put).not.toHaveBeenCalled();
    await confirm(); await screen.findByText('服务已确认保存完整路由表。'); expect(mocks.put.mock.calls[0][0]).toEqual([]); expect(warns()).toBe(false);
  });
  it('does not offer empty-table repair for an ordinary read failure', async () => {
    mocks.get.mockRejectedValueOnce(new Error('synthetic transport failure')); render(<Layout />, { wrapper });
    await screen.findByText('读取失败，当前草稿和提交结果仍保留。可手动重新读取。');
    expect(screen.queryByRole('button', { name: '用空表重新编辑修复' })).toBeNull();
  });
  it('revokes recovery after a later read loses the dedicated unavailable provenance', async () => {
    mocks.get.mockRejectedValueOnce(new Error('synthetic dedicated503')); mocks.recovery.mockReturnValueOnce(true).mockReturnValueOnce(true);
    render(<Layout />, { wrapper });
    await screen.findByRole('button', { name: '用空表重新编辑修复' });
    mocks.get.mockRejectedValueOnce(new Error('synthetic unrelated read failure')); mocks.recovery.mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: '重新读取并对照' }));
    await screen.findByText('读取失败，当前草稿和提交结果仍保留。可手动重新读取。');
    expect(screen.queryByRole('button', { name: '用空表重新编辑修复' })).toBeNull();
  });
  it('GET comparison and cancelled adoption preserve an unknown draft', async () => {
    await mount(); change('第 2 行公开名称', 'unconfirmed-ag'); mocks.put.mockResolvedValueOnce({ kind: 'unknown', issues: [] });
    fireEvent.click(screen.getByRole('button', { name: '保存全部路由' })); await screen.findByText(/保存结果未知；草稿和本次提交值已保留/);
    expect(screen.getByRole('button', { name: '保存全部路由' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '重新读取并对照' })); await screen.findByRole('region', { name: '读回对照' });
    expect(field('第 2 行公开名称')).toHaveValue('unconfirmed-ag'); expect(warns()).toBe(true); expect(mocks.put).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '放弃草稿并采用观察值' })); fireEvent.click(await screen.findByRole('button', { name: '取消，保留草稿' }));
    expect(field('第 2 行公开名称')).toHaveValue('unconfirmed-ag');
    fireEvent.click(screen.getByRole('button', { name: '放弃草稿并采用观察值' })); await confirm();
    expect(field('第 2 行公开名称')).toHaveValue('public-ag'); expect(warns()).toBe(false);
  });
  it('keeps the registered hash guard stable while editing and cancelling; retries a confirmed attempt once', async () => {
    await mount(); const guard = mocks.guard; const retry = vi.fn(() => window.history.replaceState(null, '', '/ui/#/logs'));
    change('第 2 行公开名称', 'draft-ag'); expect(mocks.guard).toBe(guard);
    act(() => { expect(guard?.({ from: 'model-routing', to: 'logs', href: '/ui/#/logs', retry })).toBe(false); });
    fireEvent.click(await screen.findByRole('button', { name: '取消，保留草稿' })); expect(retry).not.toHaveBeenCalled(); expect(mocks.guard).toBe(guard);
    act(() => { guard?.({ from: 'model-routing', to: 'logs', href: '/ui/#/logs', retry }); });
    await confirm(); expect(retry).toHaveBeenCalledOnce(); expect(warns()).toBe(false);
  });
  it('a stale shared hash retry keeps the draft and its exit protection active', async () => {
    await mount(); change('第 2 行公开名称', 'retained-after-stale-retry');
    const retry = vi.fn();
    act(() => { mocks.guard?.({ from: 'model-routing', to: 'logs', href: '/ui/#/logs', retry }); });
    await screen.findByRole('alertdialog');
    window.history.replaceState(null, '', '/ui/#model-routing');
    await confirm(); expect(retry).toHaveBeenCalledOnce();
    expect(field('第 2 行公开名称')).toHaveValue('retained-after-stale-retry'); expect(warns()).toBe(true);
    change('第 2 行公开名称', 'still-protected'); expect(warns()).toBe(true);
    act(() => { expect(mocks.guard?.({ from: 'model-routing', to: 'logs', href: '/ui/#/logs', retry: vi.fn() })).toBe(false); });
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
  });
  it.each(['removed', 'hidden', 'disabled'])('cancellation restores a usable fallback when the mobile link is %s', async state => {
    await mount(); change('第 2 行公开名称', 'mobile-draft');
    const link = document.createElement('a'); link.href = '#/logs'; link.textContent = 'temporary mobile link'; document.body.append(link);
    link.addEventListener('click', event => event.preventDefault());
    fireEvent.click(link, { button: 0 });
    act(() => { mocks.guard?.({ from: 'model-routing', to: 'logs', href: link.href, retry: vi.fn() }); });
    await screen.findByRole('alertdialog');
    if (state === 'removed') link.remove(); else if (state === 'hidden') link.hidden = true; else link.setAttribute('aria-disabled', 'true');
    fireEvent.click(screen.getByRole('button', { name: '取消，保留草稿' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '重新读取并对照' })).toHaveFocus());
    expect(field('第 2 行公开名称')).toHaveValue('mobile-draft');
    link.remove();
  });
  it('busy logout waits for explicit confirmation, aborts the request and ignores a late acknowledgement', async () => {
    const pending = deferred<{ kind: string; snapshot: Snapshot; issues: Issue[] }>();
    await mount(); change('第 2 行公开名称', 'pending-save'); mocks.put.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole('button', { name: '保存全部路由' })); expect(warns()).toBe(true);
    const signal = mocks.put.mock.calls[0][1] as AbortSignal;
    fireEvent.click(screen.getByRole('button', { name: '任意退出文案' }));
    await screen.findByRole('alertdialog'); expect(getSessionSnapshot().token).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '取消，保留草稿' })); expect(signal.aborted).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '任意退出文案' })); await confirm();
    expect(signal.aborted).toBe(true); expect(getSessionSnapshot().token).toBeNull(); expect(warns()).toBe(false);
    await act(async () => { pending.resolve({ kind: 'acknowledged', snapshot: snapshot([{ ...initial[1], public_name: 'pending-save' }]), issues: [] }); });
    expect(screen.queryByDisplayValue('pending-save')).toBeNull();
  });
  it('forced session change closes the portal, clears drafts, and reinstalls the guard for the next login', async () => {
    await mount(); change('第 2 行公开名称', 'old-session-draft');
    act(() => { mocks.guard?.({ from: 'model-routing', to: 'logs', href: '/ui/#/logs', retry: vi.fn() }); });
    await screen.findByRole('alertdialog'); act(() => setSessionToken(null));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull()); expect(screen.queryByDisplayValue('old-session-draft')).toBeNull();
    act(() => setSessionToken('synthetic-another-login')); await screen.findByText('已读取两个渠道的完整路由表。');
    expect(mocks.guard).not.toBeNull(); expect(field('第 2 行公开名称')).toHaveValue('public-ag'); expect(mocks.put).not.toHaveBeenCalled();
  });
  it('ignores separate-tab, modified, non-http and skip-content clicks', async () => {
    await mount(); change('第 2 行公开名称', 'remaining-draft');
    const link = screen.getByRole('link', { name: '旧页面' });
    link.addEventListener('click', event => event.preventDefault());
    fireEvent.click(link, { button: 0, ctrlKey: true }); link.setAttribute('target', '_blank'); fireEvent.click(link, { button: 0 });
    link.removeAttribute('target'); link.setAttribute('href', 'mailto:synthetic@example.invalid'); fireEvent.click(link, { button: 0 });
    fireEvent.click(screen.getByRole('link', { name: '跳至内容' })); expect(screen.queryByRole('alertdialog')).toBeNull(); expect(warns()).toBe(true);
  });
});
