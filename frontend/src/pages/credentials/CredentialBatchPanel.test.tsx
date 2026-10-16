import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CredentialBatchPanel } from './CredentialBatchPanel';
import {
  __commitPanelChannel,
  __invalidatePanelChannel,
  capturePanelScope,
  type PanelMode,
  type PanelScope,
} from '@/domain/panel';
import {
  __setSessionValidationStatus,
  getSessionSnapshot,
  getSessionValidationSnapshot,
  setSessionToken,
  type SessionValidationSnapshot,
} from '@/auth/session';

interface TestContext {
  readonly mode: PanelMode;
  readonly scope: PanelScope;
  readonly validation: SessionValidationSnapshot;
  readonly ownerRevision: object;
  readonly isCurrentOwner: () => boolean;
  readonly setOwnerActive: (active: boolean) => void;
}

function setupTestContext(mode: PanelMode = 'antigravity'): TestContext {
  __commitPanelChannel(mode);
  setSessionToken('synthetic-test-token', false);
  const session = getSessionSnapshot();
  const scope = capturePanelScope(session.sessionEpoch);
  const validation = getSessionValidationSnapshot();
  let ownerActive = true;
  return {
    mode,
    scope,
    validation,
    ownerRevision: { id: `rev-${Math.random()}` },
    isCurrentOwner: () => ownerActive,
    setOwnerActive: (active: boolean) => {
      ownerActive = active;
    },
  };
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createSyntheticResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

beforeEach(() => {
  setSessionToken(null);
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
  setSessionToken(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('CredentialBatchPanel Regression Group A', () => {
  it('mount/open/cancel 0, explicit confirm 1, exact filenames/mode/trimmed chosen model', async () => {
    const ctx = setupTestContext('antigravity');
    const mockFetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const url = new URL(urlStr);
      if (url.pathname.startsWith('/creds/test/')) {
        return createSyntheticResponse({
          success: true,
          status_code: 200,
          verified_reply: true,
          state_update: { test: { status: 'applied' } },
        });
      }
      return createSyntheticResponse({}, 404);
    });
    vi.stubGlobal('fetch', mockFetch);

    render(
      <CredentialBatchPanel
        mode={ctx.mode}
        scope={ctx.scope}
        validation={ctx.validation}
        ownerRevision={ctx.ownerRevision}
        isCurrentOwner={ctx.isCurrentOwner}
        filenames={['cred-alpha.json', 'cred-beta.json']}
      />
    );

    const modelInput = screen.getByLabelText('测试模型：');
    fireEvent.change(modelInput, { target: { value: '   gemini-2.5-flash   ' } });

    // Open confirmation
    const testBtn = screen.getByRole('button', { name: '批量模型测试' });
    fireEvent.click(testBtn);

    expect(screen.getByText('确认批量操作')).toBeInTheDocument();
    expect(screen.getByText(/gemini-2.5-flash/)).toBeInTheDocument();

    // Cancel: 0 requests
    const cancelBtn = screen.getByRole('button', { name: '取消' });
    fireEvent.click(cancelBtn);

    await waitFor(() => {
      expect(screen.queryByText('确认批量操作')).toBeNull();
    });
    expect(mockFetch).toHaveBeenCalledTimes(0);

    // Reopen and confirm
    fireEvent.click(testBtn);
    expect(screen.getByText('确认批量操作')).toBeInTheDocument();

    const confirmBtn = screen.getByRole('button', { name: '确认执行' });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(screen.getByText('执行进度 (2 / 2)')).toBeInTheDocument();
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);

    const firstCallUrl = new URL(mockFetch.mock.calls[0][0].toString());
    const secondCallUrl = new URL(mockFetch.mock.calls[1][0].toString());

    expect(firstCallUrl.pathname).toBe('/creds/test/cred-alpha.json');
    expect(firstCallUrl.searchParams.get('mode')).toBe('antigravity');
    expect(firstCallUrl.searchParams.get('model')).toBe('gemini-2.5-flash');

    expect(secondCallUrl.pathname).toBe('/creds/test/cred-beta.json');
    expect(secondCallUrl.searchParams.get('mode')).toBe('antigravity');
    expect(secondCallUrl.searchParams.get('model')).toBe('gemini-2.5-flash');
  });

  it('frozen queued model after draft/rerender', async () => {
    const ctx = setupTestContext('antigravity');
    const deferredItem1 = createDeferred<Response>();

    const mockFetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const url = new URL(urlStr);
      if (url.pathname.includes('c1.json')) {
        return deferredItem1.promise;
      }
      return createSyntheticResponse({
        success: true,
        status_code: 200,
        verified_reply: true,
        state_update: { test: { status: 'applied' } },
      });
    });
    vi.stubGlobal('fetch', mockFetch);

    const { rerender } = render(
      <CredentialBatchPanel
        mode={ctx.mode}
        scope={ctx.scope}
        validation={ctx.validation}
        ownerRevision={ctx.ownerRevision}
        isCurrentOwner={ctx.isCurrentOwner}
        filenames={['c1.json', 'c2.json']}
      />
    );

    const modelInput = screen.getByLabelText('测试模型：');
    fireEvent.change(modelInput, { target: { value: 'initial-model' } });

    fireEvent.click(screen.getByRole('button', { name: '批量模型测试' }));
    fireEvent.click(screen.getByRole('button', { name: '确认执行' }));

    // While c1 is in-flight, tamper with draft input and trigger rerender
    fireEvent.change(screen.getByLabelText('测试模型：'), { target: { value: 'tampered-draft-model' } });
    rerender(
      <CredentialBatchPanel
        mode={ctx.mode}
        scope={ctx.scope}
        validation={ctx.validation}
        ownerRevision={ctx.ownerRevision}
        isCurrentOwner={ctx.isCurrentOwner}
        filenames={['c1.json', 'c2.json']}
      />
    );

    // Resolve c1
    deferredItem1.resolve(
      createSyntheticResponse({
        success: true,
        status_code: 200,
        verified_reply: true,
        state_update: { test: { status: 'applied' } },
      })
    );

    await waitFor(() => {
      expect(screen.getByText('执行进度 (2 / 2)')).toBeInTheDocument();
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const secondCallUrl = new URL(mockFetch.mock.calls[1][0].toString());
    expect(secondCallUrl.searchParams.get('model')).toBe('initial-model');
    expect(secondCallUrl.searchParams.get('model')).not.toBe('tampered-draft-model');
  });

  it('verify/test and quota exercise real max2 concurrency and quota chunks<=10 (bounded deferred work, sufficient items to leave a pending chunk)', async () => {
    const ctx = setupTestContext('antigravity');

    // Test Quota with 25 items -> chunks of [10, 10, 5]
    const filenames = Array.from({ length: 25 }, (_, i) => `quota-${i}.json`);
    const deferredChunk0 = createDeferred<Response>();
    const deferredChunk1 = createDeferred<Response>();
    const deferredChunk2 = createDeferred<Response>();

    const mockFetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const url = new URL(urlStr);
      if (url.pathname === '/creds/batch-refresh-cooldown') {
        const body = JSON.parse(init?.body as string) as { filenames: string[] };
        if (body.filenames[0] === 'quota-0.json') {
          return deferredChunk0.promise;
        }
        if (body.filenames[0] === 'quota-10.json') {
          return deferredChunk1.promise;
        }
        if (body.filenames[0] === 'quota-20.json') {
          return deferredChunk2.promise;
        }
      }
      return createSyntheticResponse({}, 404);
    });
    vi.stubGlobal('fetch', mockFetch);

    render(
      <CredentialBatchPanel
        mode={ctx.mode}
        scope={ctx.scope}
        validation={ctx.validation}
        ownerRevision={ctx.ownerRevision}
        isCurrentOwner={ctx.isCurrentOwner}
        filenames={filenames}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '批量额度刷新' }));
    fireEvent.click(screen.getByRole('button', { name: '确认执行' }));

    // With max2 concurrency, chunk 0 and chunk 1 are dispatched; chunk 2 remains pending
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    const chunk0Body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string) as { filenames: string[] };
    const chunk1Body = JSON.parse(mockFetch.mock.calls[1][1]?.body as string) as { filenames: string[] };
    expect(chunk0Body.filenames).toHaveLength(10);
    expect(chunk1Body.filenames).toHaveLength(10);

    // Resolve chunk 0 -> chunk 2 should now be dispatched
    deferredChunk0.resolve(
      createSyntheticResponse({
        success: true,
        results: chunk0Body.filenames.map((name) => ({
          filename: name,
          success: true,
          status_code: 200,
          state_update: { quota: { status: 'applied' } },
        })),
      })
    );

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    const chunk2Body = JSON.parse(mockFetch.mock.calls[2][1]?.body as string) as { filenames: string[] };
    expect(chunk2Body.filenames).toHaveLength(5);

    // Resolve chunk 1 and chunk 2
    deferredChunk1.resolve(
      createSyntheticResponse({
        success: true,
        results: chunk1Body.filenames.map((name) => ({
          filename: name,
          success: true,
          status_code: 200,
          state_update: { quota: { status: 'applied' } },
        })),
      })
    );
    deferredChunk2.resolve(
      createSyntheticResponse({
        success: true,
        results: chunk2Body.filenames.map((name) => ({
          filename: name,
          success: true,
          status_code: 200,
          state_update: { quota: { status: 'applied' } },
        })),
      })
    );

    await waitFor(() => {
      expect(screen.getByText('执行进度 (25 / 25)')).toBeInTheDocument();
    });
  });

  it('Stop leaves in-flight work and prevents pending requests with correct phases', async () => {
    const ctx = setupTestContext('antigravity');
    const deferredV0 = createDeferred<Response>();
    const deferredV1 = createDeferred<Response>();

    const mockFetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const url = new URL(urlStr);
      if (url.pathname.includes('v0.json')) return deferredV0.promise;
      if (url.pathname.includes('v1.json')) return deferredV1.promise;
      return createSyntheticResponse({
        success: true,
        status_code: 200,
        verified_reply: true,
        state_update: { project: { status: 'applied' } },
      });
    });
    vi.stubGlobal('fetch', mockFetch);

    render(
      <CredentialBatchPanel
        mode={ctx.mode}
        scope={ctx.scope}
        validation={ctx.validation}
        ownerRevision={ctx.ownerRevision}
        isCurrentOwner={ctx.isCurrentOwner}
        filenames={['v0.json', 'v1.json', 'v2.json', 'v3.json']}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '批量项目检验' }));
    fireEvent.click(screen.getByRole('button', { name: '确认执行' }));

    // v0 and v1 are running
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    const stopBtn = screen.getByRole('button', { name: '停止' });
    expect(stopBtn).toBeEnabled();
    fireEvent.click(stopBtn);

    // After stop, pending items v2 and v3 transition to 'not-started'
    expect(screen.getByText('已停止后续任务；已执行的操作不会被撤销，正在进行中的请求将等待上游响应结算。')).toBeInTheDocument();
    expect(screen.getAllByText('未开始')).toHaveLength(2);

    // Resolve running in-flight items
    deferredV0.resolve(
      createSyntheticResponse({
        success: true,
        status_code: 200,
        verified_reply: true,
        state_update: { project: { status: 'applied' } },
      })
    );
    deferredV1.resolve(
      createSyntheticResponse({
        success: true,
        status_code: 200,
        verified_reply: true,
        state_update: { project: { status: 'applied' } },
      })
    );

    await waitFor(() => {
      expect(screen.getAllByText('已完成')).toHaveLength(2);
    });

    // Pending v2 and v3 were prevented and never requested
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText('未开始')).toHaveLength(2);
  });

  it('safe success/failure/unknown receipts and canary exclusion', async () => {
    const ctx = setupTestContext('antigravity');

    const mockFetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const url = new URL(urlStr);
      if (url.pathname.includes('safe-1.json')) {
        return createSyntheticResponse({
          success: true,
          status_code: 200,
          upstream_status: 200,
          verified_reply: true,
          state_update: { test: { status: 'applied' } },
          canary_secret: 'TOP_SECRET_CANARY_VALUE_123',
          raw_error_message: 'INTERNAL_EXCEPTION_TRACE',
        });
      }
      if (url.pathname.includes('safe-2.json')) {
        return createSyntheticResponse(
          {
            success: false,
            status_code: 502,
            upstream_status: 503,
            state_update: { test: { status: 'failed' } },
            canary_secret: 'TOP_SECRET_CANARY_VALUE_123',
          },
          502
        );
      }
      if (url.pathname.includes('safe-3.json')) {
        return createSyntheticResponse({
          success: true,
          status_code: 200,
          verified_reply: false,
          state_update: { test: { status: 'pending' } },
          canary_secret: 'TOP_SECRET_CANARY_VALUE_123',
        });
      }
      return createSyntheticResponse({}, 404);
    });
    vi.stubGlobal('fetch', mockFetch);

    render(
      <CredentialBatchPanel
        mode={ctx.mode}
        scope={ctx.scope}
        validation={ctx.validation}
        ownerRevision={ctx.ownerRevision}
        isCurrentOwner={ctx.isCurrentOwner}
        filenames={['safe-1.json', 'safe-2.json', 'safe-3.json']}
      />
    );

    fireEvent.change(screen.getByLabelText('测试模型：'), { target: { value: 'gemini-1.5-flash' } });
    fireEvent.click(screen.getByRole('button', { name: '批量模型测试' }));
    fireEvent.click(screen.getByRole('button', { name: '确认执行' }));

    await waitFor(() => {
      expect(screen.getByText('执行进度 (3 / 3)')).toBeInTheDocument();
    });

    expect(screen.getByText('操作成功')).toBeInTheDocument();
    expect(screen.getByText('操作失败')).toBeInTheDocument();
    expect(screen.getByText('结果未知')).toBeInTheDocument();

    expect(screen.getByText('HTTP 502')).toBeInTheDocument();
    expect(screen.getByText('上游 HTTP 503')).toBeInTheDocument();

    expect(screen.getByText('固定回复校验：通过')).toBeInTheDocument();
    expect(screen.getByText('固定回复校验：未通过')).toBeInTheDocument();

    expect(screen.getByText('test: 已更新')).toBeInTheDocument();
    expect(screen.getByText('test: 更新失败')).toBeInTheDocument();
    expect(screen.getByText('test: 待确认')).toBeInTheDocument();

    // Canary exclusion
    expect(document.body.textContent).not.toContain('TOP_SECRET_CANARY_VALUE_123');
    expect(document.body.textContent).not.toContain('INTERNAL_EXCEPTION_TRACE');
  });

  it('GCLI Preview exact configure-preview POST and AG no Preview control/zero Preview transport', async () => {
    // 1. GCLI mode has Preview control
    const gcliCtx = setupTestContext('geminicli');
    const mockFetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const url = new URL(urlStr);
      if (url.pathname === '/creds/configure-preview/preview-item.json') {
        expect(url.searchParams.get('mode')).toBe('geminicli');
        expect(init?.method).toBe('POST');
        expect(init?.body).toBeUndefined();
        return createSyntheticResponse({
          success: true,
          preview: true,
          filename: 'preview-item.json',
          state_update: { preview: { status: 'applied' } },
        });
      }
      return createSyntheticResponse({}, 404);
    });
    vi.stubGlobal('fetch', mockFetch);

    const { unmount } = render(
      <CredentialBatchPanel
        mode={gcliCtx.mode}
        scope={gcliCtx.scope}
        validation={gcliCtx.validation}
        ownerRevision={gcliCtx.ownerRevision}
        isCurrentOwner={gcliCtx.isCurrentOwner}
        filenames={['preview-item.json']}
      />
    );

    const previewBtn = screen.getByRole('button', { name: '批量预览配置' });
    expect(previewBtn).toBeInTheDocument();

    fireEvent.click(previewBtn);
    expect(screen.getByText('确认批量操作')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认执行' }));

    await waitFor(() => {
      expect(screen.getByText('执行进度 (1 / 1)')).toBeInTheDocument();
    });

    expect(screen.getByText('preview: 已更新')).toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    unmount();

    // 2. AG mode does NOT have Preview control
    const agCtx = setupTestContext('antigravity');
    render(
      <CredentialBatchPanel
        mode={agCtx.mode}
        scope={agCtx.scope}
        validation={agCtx.validation}
        ownerRevision={agCtx.ownerRevision}
        isCurrentOwner={agCtx.isCurrentOwner}
        filenames={['preview-item.json']}
      />
    );

    expect(screen.queryByRole('button', { name: '批量预览配置' })).toBeNull();
  });
});

describe('CredentialBatchPanel Regression Group B', () => {
  it('duplicate and cancelled retained confirm handlers inert', async () => {
    const ctx = setupTestContext('antigravity');
    const mockFetch = vi.fn().mockImplementation(async () => {
      return createSyntheticResponse({
        success: true,
        status_code: 200,
        verified_reply: true,
        state_update: { project: { status: 'applied' } },
      });
    });
    vi.stubGlobal('fetch', mockFetch);

    const { unmount } = render(
      <CredentialBatchPanel
        mode={ctx.mode}
        scope={ctx.scope}
        validation={ctx.validation}
        ownerRevision={ctx.ownerRevision}
        isCurrentOwner={ctx.isCurrentOwner}
        filenames={['f1.json']}
      />
    );

    // Duplicate confirm
    fireEvent.click(screen.getByRole('button', { name: '批量项目检验' }));
    const confirmBtn = screen.getByRole('button', { name: '确认执行' });
    fireEvent.click(confirmBtn);
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(screen.getByText('执行进度 (1 / 1)')).toBeInTheDocument();
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    unmount();

    // Cancelled confirm handler
    render(
      <CredentialBatchPanel
        mode={ctx.mode}
        scope={ctx.scope}
        validation={ctx.validation}
        ownerRevision={ctx.ownerRevision}
        isCurrentOwner={ctx.isCurrentOwner}
        filenames={['f2.json']}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '批量项目检验' }));
    const retainedConfirm = screen.getByRole('button', { name: '确认执行' });
    const cancelBtn = screen.getByRole('button', { name: '取消' });
    fireEvent.click(cancelBtn);

    // Retained confirm clicked after cancel
    fireEvent.click(retainedConfirm);
    expect(mockFetch).toHaveBeenCalledTimes(1); // Still 1 from previous unmounted test
  });

  it('same-Scope revoke/reverify and channel ABA retire dialog/controller', async () => {
    const ctx = setupTestContext('antigravity');
    const deferredFetch = createDeferred<Response>();
    const mockFetch = vi.fn().mockReturnValue(deferredFetch.promise);
    vi.stubGlobal('fetch', mockFetch);

    render(
      <CredentialBatchPanel
        mode={ctx.mode}
        scope={ctx.scope}
        validation={ctx.validation}
        ownerRevision={ctx.ownerRevision}
        isCurrentOwner={ctx.isCurrentOwner}
        filenames={['f1.json']}
      />
    );

    // Part 1: Revoke/reverify retires open dialog
    fireEvent.click(screen.getByRole('button', { name: '批量项目检验' }));
    expect(screen.getByText('确认批量操作')).toBeInTheDocument();

    act(() => {
      __setSessionValidationStatus(ctx.scope.sessionEpoch, 'unavailable');
      __setSessionValidationStatus(ctx.scope.sessionEpoch, 'verified');
    });

    await waitFor(() => {
      expect(screen.queryByText('确认批量操作')).toBeNull();
    });

    // Part 2: Channel ABA while batch is running
    // Setup fresh valid context for start
    const ctx2 = setupTestContext('antigravity');
    cleanup();
    render(
      <CredentialBatchPanel
        mode={ctx2.mode}
        scope={ctx2.scope}
        validation={ctx2.validation}
        ownerRevision={ctx2.ownerRevision}
        isCurrentOwner={ctx2.isCurrentOwner}
        filenames={['f1.json']}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '批量项目检验' }));
    fireEvent.click(screen.getByRole('button', { name: '确认执行' }));

    await waitFor(() => {
      expect(screen.getByText('执行进度 (0 / 1)')).toBeInTheDocument();
    });

    // Invalidate channel (ABA)
    act(() => {
      __invalidatePanelChannel();
    });

    await waitFor(() => {
      expect(screen.queryByText(/执行进度/)).toBeNull();
    });
  });

  it('ignored-abort late completion cannot publish/focus/refresh new owner', async () => {
    const ctx = setupTestContext('antigravity');
    const deferredFetch = createDeferred<Response>();
    const mockFetch = vi.fn().mockReturnValue(deferredFetch.promise);
    vi.stubGlobal('fetch', mockFetch);

    const onRefresh = vi.fn();

    render(
      <CredentialBatchPanel
        mode={ctx.mode}
        scope={ctx.scope}
        validation={ctx.validation}
        ownerRevision={ctx.ownerRevision}
        isCurrentOwner={ctx.isCurrentOwner}
        filenames={['f1.json']}
        onRefresh={onRefresh}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '批量项目检验' }));
    fireEvent.click(screen.getByRole('button', { name: '确认执行' }));

    await waitFor(() => {
      expect(screen.getByText('执行进度 (0 / 1)')).toBeInTheDocument();
    });

    // Invalidate session
    act(() => {
      setSessionToken(null);
    });

    await waitFor(() => {
      expect(screen.queryByText(/执行进度/)).toBeNull();
    });

    // Late completion of ignored abort
    deferredFetch.resolve(
      createSyntheticResponse({
        success: true,
        status_code: 200,
        verified_reply: true,
        state_update: { project: { status: 'applied' } },
      })
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(onRefresh).not.toHaveBeenCalled();
    expect(screen.queryByText(/执行进度/)).toBeNull();
  });

  it('new valid owner/selection attempt still works', async () => {
    const ctx1 = setupTestContext('antigravity');
    const mockFetch = vi.fn().mockImplementation(async () => {
      return createSyntheticResponse({
        success: true,
        status_code: 200,
        verified_reply: true,
        state_update: { project: { status: 'applied' } },
      });
    });
    vi.stubGlobal('fetch', mockFetch);

    const { rerender } = render(
      <CredentialBatchPanel
        mode={ctx1.mode}
        scope={ctx1.scope}
        validation={ctx1.validation}
        ownerRevision={ctx1.ownerRevision}
        isCurrentOwner={ctx1.isCurrentOwner}
        filenames={['old.json']}
      />
    );

    // Invalidate ctx1
    act(() => {
      setSessionToken(null);
    });

    // Create ctx2
    const ctx2 = setupTestContext('antigravity');
    rerender(
      <CredentialBatchPanel
        mode={ctx2.mode}
        scope={ctx2.scope}
        validation={ctx2.validation}
        ownerRevision={ctx2.ownerRevision}
        isCurrentOwner={ctx2.isCurrentOwner}
        filenames={['new.json']}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '批量项目检验' }));
    fireEvent.click(screen.getByRole('button', { name: '确认执行' }));

    await waitFor(() => {
      expect(screen.getByText('执行进度 (1 / 1)')).toBeInTheDocument();
    });
    expect(screen.getByText('new.json')).toBeInTheDocument();
  });

  it('Equivalent rerenders preserve running attempt/model', async () => {
    const ctx = setupTestContext('antigravity');
    const deferredFetch = createDeferred<Response>();
    const mockFetch = vi.fn().mockReturnValue(deferredFetch.promise);
    vi.stubGlobal('fetch', mockFetch);

    const { rerender } = render(
      <CredentialBatchPanel
        mode={ctx.mode}
        scope={ctx.scope}
        validation={ctx.validation}
        ownerRevision={ctx.ownerRevision}
        isCurrentOwner={ctx.isCurrentOwner}
        filenames={['c1.json']}
      />
    );

    fireEvent.change(screen.getByLabelText('测试模型：'), { target: { value: 'stable-model' } });
    fireEvent.click(screen.getByRole('button', { name: '批量模型测试' }));
    fireEvent.click(screen.getByRole('button', { name: '确认执行' }));

    await waitFor(() => {
      expect(screen.getByText('执行进度 (0 / 1)')).toBeInTheDocument();
    });

    // Rerender with fresh array reference having identical filenames and new callback references
    rerender(
      <CredentialBatchPanel
        mode={ctx.mode}
        scope={ctx.scope}
        validation={ctx.validation}
        ownerRevision={ctx.ownerRevision}
        isCurrentOwner={() => true}
        filenames={['c1.json']}
        onRefresh={() => {}}
      />
    );

    // Attempt is preserved and still running
    expect(screen.getByText('执行进度 (0 / 1)')).toBeInTheDocument();

    deferredFetch.resolve(
      createSyntheticResponse({
        success: true,
        status_code: 200,
        verified_reply: true,
        state_update: { test: { status: 'applied' } },
      })
    );

    await waitFor(() => {
      expect(screen.getByText('执行进度 (1 / 1)')).toBeInTheDocument();
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const callUrl = new URL(mockFetch.mock.calls[0][0].toString());
    expect(callUrl.searchParams.get('model')).toBe('stable-model');
  });

  it('Current settlement refresh at most 1, stale 0', async () => {
    const ctx = setupTestContext('antigravity');
    const mockFetch = vi.fn().mockImplementation(async () => {
      return createSyntheticResponse({
        success: true,
        status_code: 200,
        verified_reply: true,
        state_update: { project: { status: 'applied' } },
      });
    });
    vi.stubGlobal('fetch', mockFetch);

    const onRefresh = vi.fn();

    render(
      <CredentialBatchPanel
        mode={ctx.mode}
        scope={ctx.scope}
        validation={ctx.validation}
        ownerRevision={ctx.ownerRevision}
        isCurrentOwner={ctx.isCurrentOwner}
        filenames={['c1.json']}
        onRefresh={onRefresh}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '批量项目检验' }));
    fireEvent.click(screen.getByRole('button', { name: '确认执行' }));

    await waitFor(() => {
      expect(screen.getByText('执行进度 (1 / 1)')).toBeInTheDocument();
    });

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
