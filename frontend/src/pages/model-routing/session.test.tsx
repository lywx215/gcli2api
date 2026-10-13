import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/auth';
import { getSessionSnapshot, setSessionToken } from '@/auth/session';
import { useModelRouting } from './hooks';

const rows = [{ channel: 'antigravity', public_name: 'session-public', upstream_name: 'session-target', enabled: true }];
const envelope = () => ({ routes: rows, supported_channels: ['geminicli', 'antigravity'], capabilities: ['model.routing.aliases', 'model.identity.public'], policy_digest: 'session-fixture', validation: { antigravity: { valid: true, issues: [] }, geminicli: { valid: true, issues: [] } } });
const wrapper = ({ children }: { children: React.ReactNode }) => <AuthProvider>{children}</AuthProvider>;
beforeEach(() => setSessionToken('synthetic-session-client'));

it('panel401 uses the real shared client to clear old drafts and abort tracking without replay after login', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json(envelope())).mockResolvedValueOnce(Response.json({ detail: '密码错误' }, { status: 401 })).mockResolvedValueOnce(Response.json(envelope()));
  vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(useModelRouting, { wrapper });
  await waitFor(() => expect(result.current.ready).toBe(true));
  act(() => result.current.changeRow(0, { public_name: 'old-session-draft' }));
  await act(async () => { await result.current.save(); });
  expect(getSessionSnapshot().token).toBeNull(); expect(result.current.rows).toEqual([]); expect(result.current.sent).toBeNull(); expect(result.current.protect).toBe(false);
  act(() => setSessionToken('synthetic-new-session'));
  await waitFor(() => expect(result.current.ready).toBe(true));
  expect(result.current.rows).toEqual(rows);
  expect(fetch.mock.calls.filter(([, init]) => init.method === 'PUT')).toHaveLength(1);
  expect(fetch.mock.calls.every(([url]) => new URL(url).pathname === '/config/model-routing')).toBe(true);
});

it('business401 preserves the shared session and rejected draft; it is not an authentication proof', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json(envelope())).mockResolvedValueOnce(Response.json({ error: { code: 'BUSINESS_REJECTION' }, detail: '密码错误' }, { status: 401 }));
  vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(useModelRouting, { wrapper });
  await waitFor(() => expect(result.current.ready).toBe(true));
  act(() => result.current.changeRow(0, { upstream_name: 'rejected-draft' }));
  await act(async () => { await result.current.save(); });
  expect(getSessionSnapshot().token).toBe('synthetic-session-client'); expect(result.current.rows[0]).toMatchObject({ upstream_name: 'rejected-draft' });
  expect(result.current.unknown).toBe(false); expect(result.current.dirty).toBe(true); expect(fetch).toHaveBeenCalledTimes(2);
});
