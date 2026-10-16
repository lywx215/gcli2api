import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  FilesDialog,
  type FilesDialogProps,
} from './FilesDialog';
import {
  __commitPanelChannel,
  capturePanelScope,
  getPanelChannelSnapshot,
} from '@/domain/panel';
import {
  __setSessionValidationStatus,
  getSessionSnapshot,
  getSessionValidationSnapshot,
  setSessionToken,
  type SessionValidationSnapshot,
} from '@/auth/session';

function getReactClickHandler(element: HTMLElement): (() => void) | undefined {
  const propKey = Object.keys(element).find((key) => key.startsWith('__reactProps$'));
  if (propKey) {
    const props = (element as unknown as Record<string, { onClick?: () => void }>)[propKey];
    if (typeof props?.onClick === 'function') {
      return props.onClick;
    }
  }
  return undefined;
}

beforeEach(() => {
  setSessionToken('synthetic-test-token');
  window.URL.createObjectURL = vi.fn((_blob: Blob) => 'blob:synthetic-test-url');
  window.URL.revokeObjectURL = vi.fn();
  Object.assign(navigator, {
    clipboard: {
      writeText: vi.fn().mockResolvedValue(undefined),
    },
  });
});

afterEach(() => {
  cleanup();
  __commitPanelChannel('antigravity');
});

const respond = (body: unknown, status = 200, headers?: Record<string, string>) =>
  vi.mocked(fetch).mockResolvedValueOnce(Response.json(body, { status, headers }));

function createDefaultProps(overrides?: Partial<FilesDialogProps>): FilesDialogProps {
  const session = getSessionSnapshot();
  const mode = overrides?.mode ?? 'antigravity';
  const baseScope = capturePanelScope(session.sessionEpoch);
  const scope = overrides?.scope ?? {
    ...baseScope,
    mode,
  };
  const validation = overrides?.validation ?? getSessionValidationSnapshot();
  return {
    mode,
    scope,
    validation,
    ownerRevision: {},
    isCurrentOwner: () => true,
    open: true,
    target: { kind: 'single', filename: 'cred-1.json' },
    onClose: vi.fn(),
    ...overrides,
  };
}

describe('FilesDialog - Component & API Integration', () => {
  it('mount/open sends 0 requests across both antigravity and geminicli channels', () => {
    // Antigravity channel
    const agProps = createDefaultProps({ mode: 'antigravity' });
    const { unmount } = render(<FilesDialog {...agProps} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
    unmount();

    // Geminicli channel
    __commitPanelChannel('geminicli');
    const gcliProps = createDefaultProps({
      mode: 'geminicli',
      scope: capturePanelScope(getSessionSnapshot().sessionEpoch),
    });
    render(<FilesDialog {...gcliProps} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('cancel in confirmation dialog sends 0 requests', () => {
    const props = createDefaultProps({
      target: { kind: 'single', filename: 'cred-cancel.json' },
    });
    render(<FilesDialog {...props} />);

    // Click view full JSON to open confirmation
    fireEvent.click(screen.getByRole('button', { name: '查看完整 JSON' }));
    expect(screen.getByText('查看完整凭证内容确认')).toBeInTheDocument();

    // Click Cancel
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.queryByText('查看完整凭证内容确认')).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('confirm sends exactly 1 readContent request, formats nested JSON, and excludes server envelope', async () => {
    const canaryNested = {
      client_id: 'synthetic-client-id',
      secret_value: 'synthetic-secret-token-123',
      nested: {
        refresh_token: 'synthetic-refresh-token',
        scopes: ['read', 'write'],
      },
    };
    const envelope = {
      filename: 'cred-1.json',
      content: canaryNested,
      user_email: 'canary@example.invalid',
      backend_type: 'oauth',
      status: { disabled: false },
      extra_unwanted_envelope: 'drop-me',
    };
    respond(envelope);

    const props = createDefaultProps({
      target: { kind: 'single', filename: 'cred-1.json' },
    });
    render(<FilesDialog {...props} />);

    // Click view full JSON and confirm
    fireEvent.click(screen.getByRole('button', { name: '查看完整 JSON' }));
    fireEvent.click(screen.getByRole('button', { name: '确认查看' }));

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.pathname).toBe('/creds/detail/cred-1.json');
    expect(parsed.searchParams.get('mode')).toBe('antigravity');
    expect(init?.method).toBe('GET');

    // Wait for Textarea to display formatted content
    await waitFor(() => {
      expect(screen.getByRole('textbox')).toBeInTheDocument();
    });

    const textarea = screen.getByRole('textbox');
    expect(textarea).toHaveValue(JSON.stringify(canaryNested, null, 2));

    // Excludes server envelope fields
    expect(textarea.textContent).not.toContain('canary@example.invalid');
    expect(textarea.textContent).not.toContain('extra_unwanted_envelope');
    expect(textarea.textContent).not.toContain('backend_type');

    // Compact geminicli check for mode parameter
    __commitPanelChannel('geminicli');
    respond({ filename: 'gcli-1.json', content: { gcli_key: 'canary-gcli' } });
    const gcliProps = createDefaultProps({
      mode: 'geminicli',
      scope: capturePanelScope(getSessionSnapshot().sessionEpoch),
      target: { kind: 'single', filename: 'gcli-1.json' },
    });
    render(<FilesDialog {...gcliProps} />);
    fireEvent.click(screen.getByRole('button', { name: '查看完整 JSON' }));
    fireEvent.click(screen.getByRole('button', { name: '确认查看' }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(2);
    });
    const [gcliUrl] = vi.mocked(fetch).mock.calls[1];
    expect(new URL(String(gcliUrl)).searchParams.get('mode')).toBe('geminicli');
  });

  it('explicit clipboard copy succeeds, and falls back gracefully on rejection or unavailable clipboard', async () => {
    const content = { apiKey: 'synthetic-api-key' };
    respond({ filename: 'cred-copy.json', content });

    const props = createDefaultProps({
      target: { kind: 'single', filename: 'cred-copy.json' },
    });
    const { rerender } = render(<FilesDialog {...props} />);

    fireEvent.click(screen.getByRole('button', { name: '查看完整 JSON' }));
    fireEvent.click(screen.getByRole('button', { name: '确认查看' }));

    await waitFor(() => {
      expect(screen.getByRole('textbox')).toBeInTheDocument();
    });

    // 1. Success case
    vi.mocked(navigator.clipboard.writeText).mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByRole('button', { name: '复制 JSON' }));
    await waitFor(() => {
      expect(screen.getByText('已复制到剪贴板')).toBeInTheDocument();
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(JSON.stringify(content, null, 2));

    // 2. Rejection case
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('Clipboard write rejected'));
    fireEvent.click(screen.getByRole('button', { name: '复制 JSON' }));
    await waitFor(() => {
      expect(screen.getByText('复制失败，请手动选择复制')).toBeInTheDocument();
    });
    expect(screen.getByRole('textbox')).toHaveValue(JSON.stringify(content, null, 2));

    // 3. Unavailable clipboard fallback
    const originalClipboard = navigator.clipboard;
    try {
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true, writable: true });
      rerender(<FilesDialog {...props} />);
      fireEvent.click(screen.getByRole('button', { name: '复制 JSON' }));
      await waitFor(() => {
        expect(screen.getByText('剪贴板不可用，请手动选择复制')).toBeInTheDocument();
      });
      expect(screen.getByRole('textbox')).toHaveValue(JSON.stringify(content, null, 2));
    } finally {
      Object.defineProperty(navigator, 'clipboard', { value: originalClipboard, configurable: true, writable: true });
    }
  });

  it('downloads single, selection, and channel targets with exact endpoint, method, body, and mode', async () => {
    // 1. Single target download (antigravity)
    vi.mocked(fetch).mockResolvedValueOnce(new Response(new Blob(['cred-single-data'])));
    const singleProps = createDefaultProps({
      target: { kind: 'single', filename: 'single-cred.json' },
    });
    const { unmount: unmount1 } = render(<FilesDialog {...singleProps} />);
    fireEvent.click(screen.getByRole('button', { name: '下载 JSON 文件' }));
    await waitFor(() => {
      expect(screen.getByText('下载已开始')).toBeInTheDocument();
    });
    const [url1, init1] = vi.mocked(fetch).mock.calls[0];
    expect(new URL(String(url1)).pathname).toBe('/creds/download/single-cred.json');
    expect(new URL(String(url1)).searchParams.get('mode')).toBe('antigravity');
    expect(init1?.method).toBe('GET');
    unmount1();

    // 2. Selection target download (antigravity)
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(new Blob(['zip-bytes']), {
        headers: { 'X-Selected-Count': '2', 'X-Missing-Count': '0' },
      })
    );
    const selProps = createDefaultProps({
      target: { kind: 'selection', filenames: ['a.json', 'b.json'] },
    });
    const { unmount: unmount2 } = render(<FilesDialog {...selProps} />);
    fireEvent.click(screen.getByRole('button', { name: '下载所选 ZIP' }));
    await waitFor(() => {
      expect(screen.getByText(/下载已开始/)).toBeInTheDocument();
    });
    const [url2, init2] = vi.mocked(fetch).mock.calls[1];
    expect(new URL(String(url2)).pathname).toBe('/creds/download-selected');
    expect(new URL(String(url2)).searchParams.get('mode')).toBe('antigravity');
    expect(init2?.method).toBe('POST');
    expect(JSON.parse(String(init2?.body))).toEqual({ filenames: ['a.json', 'b.json'] });
    unmount2();

    // 3. Channel target download (geminicli)
    __commitPanelChannel('geminicli');
    vi.mocked(fetch).mockResolvedValueOnce(new Response(new Blob(['all-zip-bytes'])));
    const chanProps = createDefaultProps({
      mode: 'geminicli',
      scope: capturePanelScope(getSessionSnapshot().sessionEpoch),
      target: { kind: 'channel' },
    });
    render(<FilesDialog {...chanProps} />);
    fireEvent.click(screen.getByRole('button', { name: '下载全部 ZIP' }));
    await waitFor(() => {
      expect(screen.getByText('下载已开始')).toBeInTheDocument();
    });
    const [url3, init3] = vi.mocked(fetch).mock.calls[2];
    expect(new URL(String(url3)).pathname).toBe('/creds/download-all');
    expect(new URL(String(url3)).searchParams.get('mode')).toBe('geminicli');
    expect(init3?.method).toBe('GET');
  });

  it('handles partial and unknown counts independently and revokes Blob URLs', async () => {
    // 1. Partial counts
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(new Blob(['zip-bytes']), {
        headers: { 'X-Selected-Count': '3', 'X-Missing-Count': '1' },
      })
    );
    const selProps = createDefaultProps({
      target: { kind: 'selection', filenames: ['1.json', '2.json', '3.json', '4.json'] },
    });
    const { unmount } = render(<FilesDialog {...selProps} />);
    fireEvent.click(screen.getByRole('button', { name: '下载所选 ZIP' }));

    await waitFor(() => {
      expect(screen.getByText(/已选 3 项，缺失 1 项/)).toBeInTheDocument();
    });
    expect(window.URL.createObjectURL).toHaveBeenCalled();
    await waitFor(() => {
      expect(window.URL.revokeObjectURL).toHaveBeenCalled();
    });
    unmount();

    // 2. Missing headers -> unknown counts (never fabricate zero)
    vi.mocked(fetch).mockResolvedValueOnce(new Response(new Blob(['zip-bytes'])));
    const selPropsUnknown = createDefaultProps({
      target: { kind: 'selection', filenames: ['1.json'] },
    });
    render(<FilesDialog {...selPropsUnknown} />);
    fireEvent.click(screen.getByRole('button', { name: '下载所选 ZIP' }));

    await waitFor(() => {
      expect(screen.getByText(/已选 未知 项，缺失 未知 项/)).toBeInTheDocument();
    });
    expect(window.URL.revokeObjectURL).toHaveBeenCalled();
  });

  it('rejects invalid or oversize selection with 0 requests sent', () => {
    // Empty selection
    const emptyProps = createDefaultProps({
      target: { kind: 'selection', filenames: [] },
    });
    const { rerender } = render(<FilesDialog {...emptyProps} />);
    expect(screen.getByText('未选择任何凭证文件。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下载所选 ZIP' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '下载所选 ZIP' }));
    expect(fetch).not.toHaveBeenCalled();

    // Oversize selection (>100)
    const oversizeNames = Array.from({ length: 101 }, (_, i) => `cred-${i}.json`);
    const oversizeProps = createDefaultProps({
      target: { kind: 'selection', filenames: oversizeNames },
    });
    rerender(<FilesDialog {...oversizeProps} />);
    expect(screen.getByText(/超过 100 项上限/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下载所选 ZIP' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '下载所选 ZIP' }));
    expect(fetch).not.toHaveBeenCalled();

    // Duplicate names
    const dupProps = createDefaultProps({
      target: { kind: 'selection', filenames: ['dup.json', 'dup.json'] },
    });
    rerender(<FilesDialog {...dupProps} />);
    expect(screen.getByText(/包含重复项或无效文件名/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下载所选 ZIP' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '下载所选 ZIP' }));
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('FilesDialog - Session, Validation & Lifetime Retraction', () => {
  it('closing and reopening clears plaintext JSON and requires fresh confirmation', async () => {
    respond({ filename: 'cred-reopen.json', content: { token: 'synthetic-jwt' } });
    const props = createDefaultProps({
      target: { kind: 'single', filename: 'cred-reopen.json' },
    });
    const { rerender } = render(<FilesDialog {...props} />);

    // View full JSON
    fireEvent.click(screen.getByRole('button', { name: '查看完整 JSON' }));
    fireEvent.click(screen.getByRole('button', { name: '确认查看' }));

    await waitFor(() => {
      expect(screen.getByRole('textbox')).toBeInTheDocument();
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    // Close dialog
    rerender(<FilesDialog {...props} open={false} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // Reopen dialog
    rerender(<FilesDialog {...props} open={true} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // Plaintext is cleared; chooser is presented; zero additional requests sent
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '查看完整 JSON' })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('target or revision replacement immediately clears plaintext and retires state', async () => {
    respond({ filename: 'cred-a.json', content: { secret: 'secret-a' } });
    const ownerA = {};
    const propsA = createDefaultProps({
      ownerRevision: ownerA,
      target: { kind: 'single', filename: 'cred-a.json' },
    });
    const { rerender } = render(<FilesDialog {...propsA} />);

    fireEvent.click(screen.getByRole('button', { name: '查看完整 JSON' }));
    fireEvent.click(screen.getByRole('button', { name: '确认查看' }));

    await waitFor(() => {
      expect(screen.getByRole('textbox')).toBeInTheDocument();
    });

    // Replace target while keeping ownerRevision
    const propsB = createDefaultProps({
      ownerRevision: ownerA,
      target: { kind: 'single', filename: 'cred-b.json' },
    });
    rerender(<FilesDialog {...propsB} />);

    // Plaintext is cleared immediately and new filename is shown in chooser
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('文件：cred-b.json')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '查看完整 JSON' })).toBeInTheDocument();
  });

  it('handles same-session validation transition from unavailable to verified', () => {
    const session = getSessionSnapshot();
    const scope = capturePanelScope(session.sessionEpoch);

    // 1. Validation is unavailable
    __setSessionValidationStatus(session.sessionEpoch, 'unavailable');
    const unavailableSnapshot = getSessionValidationSnapshot();

    const propsUnavailable = createDefaultProps({
      scope,
      validation: unavailableSnapshot,
    });
    const { rerender } = render(<FilesDialog {...propsUnavailable} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // 2. Validation becomes verified with exact object identity
    __setSessionValidationStatus(session.sessionEpoch, 'verified');
    const verifiedSnapshot = getSessionValidationSnapshot();

    const propsVerified = createDefaultProps({
      scope,
      validation: verifiedSnapshot,
    });
    rerender(<FilesDialog {...propsVerified} />);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '查看完整 JSON' })).toBeInTheDocument();
  });

  it('channel ABA transition invalidates old scope and fails closed', () => {
    const session = getSessionSnapshot();
    const originalScope = capturePanelScope(session.sessionEpoch);
    const initialChannelEpoch = originalScope.channelEpoch;

    const props = createDefaultProps({
      mode: 'antigravity',
      scope: originalScope,
    });
    const { rerender } = render(<FilesDialog {...props} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // Channel ABA: antigravity -> geminicli -> antigravity
    __commitPanelChannel('geminicli');
    __commitPanelChannel('antigravity');

    const currentChannel = getPanelChannelSnapshot();
    expect(currentChannel.mode).toBe('antigravity');
    expect(currentChannel.channelEpoch).toBeGreaterThan(initialChannelEpoch);

    // Original scope with initialChannelEpoch is now stale
    rerender(<FilesDialog {...props} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('held old confirm/cancel/download handlers are completely inert after retirement', () => {
    const ownerA = {};
    const onCloseA = vi.fn();
    const propsA = createDefaultProps({
      ownerRevision: ownerA,
      target: { kind: 'single', filename: 'held-a.json' },
      onClose: onCloseA,
    });
    const { rerender } = render(<FilesDialog {...propsA} />);

    // Capture download control and handler before opening confirmation
    const oldDownloadBtn = screen.getByRole('button', { name: '下载 JSON 文件' });
    const oldDownloadHandler = getReactClickHandler(oldDownloadBtn);

    // Open confirmation for owner A
    fireEvent.click(screen.getByRole('button', { name: '查看完整 JSON' }));
    const oldConfirmBtn = screen.getByRole('button', { name: '确认查看' });
    const oldCancelBtn = screen.getByRole('button', { name: '取消' });
    const oldConfirmHandler = getReactClickHandler(oldConfirmBtn);
    const oldCancelHandler = getReactClickHandler(oldCancelBtn);

    // Rerender with owner B
    const ownerB = {};
    const onCloseB = vi.fn();
    const propsB = createDefaultProps({
      ownerRevision: ownerB,
      target: { kind: 'single', filename: 'held-b.json' },
      onClose: onCloseB,
    });
    rerender(<FilesDialog {...propsB} />);

    // Fire clicks on owner A's held controls and invoke real held handlers
    fireEvent.click(oldConfirmBtn);
    oldConfirmHandler?.();
    expect(fetch).not.toHaveBeenCalled();

    fireEvent.click(oldCancelBtn);
    oldCancelHandler?.();
    expect(fetch).not.toHaveBeenCalled();
    expect(onCloseA).not.toHaveBeenCalled();
    expect(onCloseB).not.toHaveBeenCalled();

    fireEvent.click(oldDownloadBtn);
    oldDownloadHandler?.();
    expect(fetch).not.toHaveBeenCalled();

    // Owner B's fresh handlers still work cleanly
    respond({ filename: 'held-b.json', content: { key: 'secret-b' } });
    fireEvent.click(screen.getByRole('button', { name: '查看完整 JSON' }));
    fireEvent.click(screen.getByRole('button', { name: '确认查看' }));
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(new URL(String(url)).pathname).toBe('/creds/detail/held-b.json');
  });

  it('ignored-abort read completions and old finally are inert while a new valid owner still works', async () => {
    let resolveA: ((value: Response) => void) | undefined;
    const pendingA = new Promise<Response>((resolve) => {
      resolveA = resolve;
    });
    vi.mocked(fetch).mockImplementationOnce(() => pendingA);

    const ownerA = {};
    const propsA = createDefaultProps({
      ownerRevision: ownerA,
      target: { kind: 'single', filename: 'pending-a.json' },
    });
    const { rerender } = render(<FilesDialog {...propsA} />);

    fireEvent.click(screen.getByRole('button', { name: '查看完整 JSON' }));
    fireEvent.click(screen.getByRole('button', { name: '确认查看' }));
    expect(fetch).toHaveBeenCalledTimes(1);

    // Replace owner while fetch A is pending
    const ownerB = {};
    const propsB = createDefaultProps({
      ownerRevision: ownerB,
      target: { kind: 'single', filename: 'fresh-b.json' },
    });
    rerender(<FilesDialog {...propsB} />);

    // Resolve owner A's ignored abort
    resolveA!(Response.json({
      filename: 'pending-a.json',
      content: { canary: 'leak-from-a' },
    }));

    await new Promise((r) => setTimeout(r, 20));

    // Owner A's content was never rendered
    expect(screen.queryByText(/leak-from-a/)).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();

    // Owner B can perform read normally
    respond({
      filename: 'fresh-b.json',
      content: { canary: 'legit-from-b' },
    });
    fireEvent.click(screen.getByRole('button', { name: '查看完整 JSON' }));
    fireEvent.click(screen.getByRole('button', { name: '确认查看' }));

    await waitFor(() => {
      expect(screen.getByRole('textbox')).toHaveValue(
        JSON.stringify({ canary: 'legit-from-b' }, null, 2)
      );
    });
    expect(screen.queryByText(/leak-from-a/)).not.toBeInTheDocument();
  });

  it('dynamic isCurrentOwner check fails closed when ownership is false or throws', () => {
    let isOwner = true;
    const isCurrentOwner = () => isOwner;

    const props = createDefaultProps({ isCurrentOwner });
    const { rerender } = render(<FilesDialog {...props} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // Ownership returns false
    isOwner = false;
    rerender(<FilesDialog {...props} isCurrentOwner={isCurrentOwner} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // Ownership throws
    const throwingOwner = () => {
      throw new Error('Ownership error');
    };
    rerender(<FilesDialog {...props} isCurrentOwner={throwingOwner} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('validation replacement in single batch retires actor, clears plaintext/confirmation/copy, requires fresh confirmation, and preserves stable identity on callback rerender', async () => {
    respond({ filename: 'cred-val.json', content: { secret: 'secret-val-1' } });
    const session = getSessionSnapshot();
    const scope = capturePanelScope(session.sessionEpoch);
    const val1 = getSessionValidationSnapshot();
    const ownerRevision = {};
    const props = createDefaultProps({
      ownerRevision,
      scope,
      validation: val1,
      target: { kind: 'single', filename: 'cred-val.json' },
    });
    const { rerender } = render(<FilesDialog {...props} />);

    // 1. Read synthetic JSON under verified actor
    fireEvent.click(screen.getByRole('button', { name: '查看完整 JSON' }));
    fireEvent.click(screen.getByRole('button', { name: '确认查看' }));

    await waitFor(() => {
      expect(screen.getByRole('textbox')).toBeInTheDocument();
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    // Trigger copy so copyStatus is populated
    fireEvent.click(screen.getByRole('button', { name: '复制 JSON' }));
    await waitFor(() => {
      expect(screen.getByText('已复制到剪贴板')).toBeInTheDocument();
    });

    // 2. In ONE React act batch set same session epoch unavailable then verified, rerender with exact new snapshot
    // keeping SAME scope values, ownerRevision, target and open=true. No intermediate null commit assumption.
    let val2: SessionValidationSnapshot;
    act(() => {
      __setSessionValidationStatus(session.sessionEpoch, 'unavailable');
      __setSessionValidationStatus(session.sessionEpoch, 'verified');
      val2 = getSessionValidationSnapshot();
      rerender(
        <FilesDialog
          {...props}
          validation={val2}
        />
      );
    });

    // 3. Assert old plaintext/confirmation/copy status gone, no automatic request
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByText('查看完整凭证内容确认')).not.toBeInTheDocument();
    expect(screen.queryByText('已复制到剪贴板')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '查看完整 JSON' })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);

    // 4. Same-props/callback-only rerender must retain current authorization/state without request or remount
    const dummyOnClose = vi.fn();
    rerender(
      <FilesDialog
        {...props}
        validation={val2!}
        onClose={dummyOnClose}
      />
    );
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '查看完整 JSON' })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);

    // 5. Fresh confirmation sends exactly 1 new request and works
    respond({ filename: 'cred-val.json', content: { secret: 'secret-val-2' } });
    fireEvent.click(screen.getByRole('button', { name: '查看完整 JSON' }));
    expect(screen.getByText('查看完整凭证内容确认')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认查看' }));

    await waitFor(() => {
      expect(screen.getByRole('textbox')).toBeInTheDocument();
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('textbox')).toHaveValue(
      JSON.stringify({ secret: 'secret-val-2' }, null, 2)
    );

    // 6. Callback-only rerender while plaintext is visible preserves state and plaintext without request
    rerender(
      <FilesDialog
        {...props}
        validation={val2!}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByRole('textbox')).toHaveValue(
      JSON.stringify({ secret: 'secret-val-2' }, null, 2)
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('holds pending download across validation replacement with ignored abort; signal aborted and old result inert', async () => {
    let capturedSignalA: AbortSignal | undefined;
    let resolveDownloadA: ((res: Response) => void) | undefined;
    const pendingA = new Promise<Response>((resolve) => {
      resolveDownloadA = resolve;
    });
    vi.mocked(fetch).mockImplementationOnce((_url, init) => {
      capturedSignalA = init?.signal as AbortSignal | undefined;
      return pendingA;
    });

    const session = getSessionSnapshot();
    const scope = capturePanelScope(session.sessionEpoch);
    const val1 = getSessionValidationSnapshot();
    const ownerRevision = {};
    const props = createDefaultProps({
      ownerRevision,
      scope,
      validation: val1,
      target: { kind: 'single', filename: 'download-val.json' },
    });
    const { rerender } = render(<FilesDialog {...props} />);

    // Start download under actor 1
    fireEvent.click(screen.getByRole('button', { name: '下载 JSON 文件' }));
    expect(screen.getByText('正在准备下载...')).toBeInTheDocument();
    expect(capturedSignalA).toBeDefined();
    expect(capturedSignalA?.aborted).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);

    // Validation replacement in one batch (unavailable -> verified)
    let val2: SessionValidationSnapshot;
    act(() => {
      __setSessionValidationStatus(session.sessionEpoch, 'unavailable');
      __setSessionValidationStatus(session.sessionEpoch, 'verified');
      val2 = getSessionValidationSnapshot();
      rerender(
        <FilesDialog
          {...props}
          validation={val2}
        />
      );
    });

    // Assert old signal was aborted
    expect(capturedSignalA?.aborted).toBe(true);

    // Reset createObjectURL calls to verify old result doesn't create/click any URL
    vi.mocked(window.URL.createObjectURL).mockClear();

    // Old transport resolves (ignoring abort)
    resolveDownloadA!(new Response(new Blob(['old-payload-bytes'])));
    await new Promise((r) => setTimeout(r, 20));

    // Old result created no Blob URL, cannot set fresh status or busy
    expect(window.URL.createObjectURL).not.toHaveBeenCalled();
    expect(screen.queryByText('下载已开始')).not.toBeInTheDocument();
    expect(screen.queryByText('正在准备下载...')).not.toBeInTheDocument();

    // Fresh explicit download works and URL is revoked
    vi.mocked(fetch).mockResolvedValueOnce(new Response(new Blob(['fresh-payload-bytes'])));
    fireEvent.click(screen.getByRole('button', { name: '下载 JSON 文件' }));

    await waitFor(() => {
      expect(screen.getByText('下载已开始')).toBeInTheDocument();
    });
    expect(window.URL.createObjectURL).toHaveBeenCalled();
    await waitFor(() => {
      expect(window.URL.revokeObjectURL).toHaveBeenCalled();
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
