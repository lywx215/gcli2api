import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/auth/AuthProvider';
import { getSessionSnapshot, getSessionValidationSnapshot, setSessionToken } from '@/auth/session';
import { __commitPanelChannel, __invalidatePanelChannel, getPanelChannelSnapshot } from '@/domain/panel';
import { discardExitChanges, hasSecretExitChanges } from '../exitProtection';
import type { TokenStatus } from '../types';
import { ManagementToken } from './ManagementToken';

const apiMocks = vi.hoisted(() => ({
  managementToken: vi.fn(),
  writeFailure: vi.fn((err: unknown) => (err instanceof Error && err.message === 'rejected' ? 'rejected' : 'unknown')),
}));

vi.mock('../api', () => ({
  ...apiMocks,
}));

let writeTextMock: ReturnType<typeof vi.fn>;

function renderToken(uiProps: { status?: TokenStatus; onUpdate?: (status: TokenStatus) => void } = {}) {
  const onUpdate = uiProps.onUpdate ?? vi.fn();
  const utils = render(
    <AuthProvider>
      <ManagementToken status={uiProps.status} onUpdate={onUpdate} />
    </AuthProvider>
  );
  return { ...utils, onUpdate };
}

beforeEach(() => {
  if (getPanelChannelSnapshot().mode !== 'antigravity') {
    __commitPanelChannel('antigravity');
  }
  setSessionToken('synth-auth-token-invented');
  expect(getPanelChannelSnapshot().mode).toBe('antigravity');
  expect(getSessionSnapshot().token).toBe('synth-auth-token-invented');
  expect(getSessionValidationSnapshot().status).toBe('verified');
  writeTextMock = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: {
      writeText: writeTextMock,
    },
    configurable: true,
    writable: true,
  });
  apiMocks.managementToken.mockReset();
  apiMocks.writeFailure.mockClear();
  discardExitChanges('all');
});

afterEach(() => {
  cleanup();
  discardExitChanges('all');
  if (getPanelChannelSnapshot().mode !== 'antigravity') {
    __commitPanelChannel('antigravity');
  }
  setSessionToken(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ManagementToken component regressions', () => {
  describe('Case 1: Token generation & RNG failure handling', () => {
    it('generates 64-char hex token from 32-byte deterministic RNG, sets dirty, and never auto-saves', async () => {
      const mathSpy = vi.spyOn(Math, 'random');
      vi.spyOn(crypto, 'getRandomValues').mockImplementation((arr: ArrayBufferView) => {
        (arr as Uint8Array).fill(0xab);
        return arr;
      });

      renderToken({ status: { configured: false, locked: false } });
      const generateBtn = screen.getByRole('button', { name: '生成 Token' });
      expect(generateBtn).not.toBeDisabled();
      expect(hasSecretExitChanges()).toBe(false);

      fireEvent.click(generateBtn);

      const tokenInput = screen.getByLabelText('新 Token（独立保存）');
      const expectedHex = 'ab'.repeat(32);
      expect(tokenInput).toHaveValue(expectedHex);
      expect(expectedHex).toHaveLength(64);
      expect(hasSecretExitChanges()).toBe(true);

      expect(apiMocks.managementToken).not.toHaveBeenCalled();
      expect(mathSpy).not.toHaveBeenCalled();
    });

    it('preserves current draft and displays safe explanation when RNG throws or is absent, with no Math.random fallback', async () => {
      const mathSpy = vi.spyOn(Math, 'random');
      renderToken({ status: { configured: false, locked: false } });

      const tokenInput = screen.getByLabelText('新 Token（独立保存）');
      fireEvent.change(tokenInput, { target: { value: 'existing-secret-draft-value-preserved' } });
      expect(tokenInput).toHaveValue('existing-secret-draft-value-preserved');

      vi.spyOn(crypto, 'getRandomValues').mockImplementation(() => {
        throw new Error('RNG fault');
      });

      fireEvent.click(screen.getByRole('button', { name: '生成 Token' }));

      expect(tokenInput).toHaveValue('existing-secret-draft-value-preserved');
      expect(screen.getByText('安全随机数生成失败，未能生成 Token。')).toBeInTheDocument();
      expect(mathSpy).not.toHaveBeenCalled();

      // Test absent crypto
      vi.stubGlobal('crypto', undefined);
      fireEvent.click(screen.getByRole('button', { name: '生成 Token' }));

      expect(tokenInput).toHaveValue('existing-secret-draft-value-preserved');
      expect(screen.getByText('安全随机数生成器不可用，未能生成 Token。')).toBeInTheDocument();
      expect(mathSpy).not.toHaveBeenCalled();
    });
  });

  describe('Case 2: Copy happy path, gate enforcement & manual fallback', () => {
    it('obeys missing-status/auth/locked/pending gates and requires non-empty draft to copy', async () => {
      // 1. Missing status
      const { unmount } = renderToken({ status: undefined });
      expect(screen.getByRole('button', { name: '生成 Token' })).toBeDisabled();
      expect(screen.getByRole('button', { name: '复制 Token' })).toBeDisabled();
      expect(screen.getByRole('button', { name: '保存 Token' })).toBeDisabled();
      unmount();

      // 2. Locked status
      const { unmount: unmountLocked } = renderToken({ status: { configured: true, locked: true } });
      expect(screen.getByRole('button', { name: '生成 Token' })).toBeDisabled();
      expect(screen.getByRole('button', { name: '复制 Token' })).toBeDisabled();
      unmountLocked();

      // 3. Unauthenticated session
      act(() => { setSessionToken(null); });
      const { unmount: unmountUnauth } = renderToken({ status: { configured: true, locked: false } });
      expect(screen.getByRole('button', { name: '生成 Token' })).toBeDisabled();
      expect(screen.getByRole('button', { name: '复制 Token' })).toBeDisabled();
      unmountUnauth();

      // 4. Authenticated with empty token draft
      act(() => { setSessionToken('synth-auth-token-invented'); });
      renderToken({ status: { configured: true, locked: false } });
      expect(screen.getByRole('button', { name: '生成 Token' })).not.toBeDisabled();
      expect(screen.getByRole('button', { name: '复制 Token' })).toBeDisabled();
    });

    it('copies nonempty draft to clipboard, and provides selectable readonly fallback without fetching saved token when clipboard fails', async () => {
      renderToken({ status: { configured: true, locked: false } });
      const tokenInput = screen.getByLabelText('新 Token（独立保存）');
      const draft = 'synth-copy-test-token-draft-value-32chars';
      fireEvent.change(tokenInput, { target: { value: draft } });

      const copyBtn = screen.getByRole('button', { name: '复制 Token' });
      expect(copyBtn).not.toBeDisabled();

      // Successful copy
      fireEvent.click(copyBtn);
      await waitFor(() => {
        expect(writeTextMock).toHaveBeenCalledWith(draft);
      });
      expect(screen.getByText('Token 已复制到剪贴板。')).toBeInTheDocument();
      expect(screen.queryByLabelText('手动复制 Token（剪贴板不可用）')).not.toBeInTheDocument();

      // Rejected copy provides selectable readonly fallback containing current draft
      writeTextMock.mockRejectedValueOnce(new Error('Clipboard denied'));
      fireEvent.click(copyBtn);

      await waitFor(() => {
        expect(screen.getByLabelText('手动复制 Token（剪贴板不可用）')).toBeInTheDocument();
      });
      const fallbackInput = screen.getByLabelText('手动复制 Token（剪贴板不可用）');
      expect(fallbackInput).toHaveAttribute('readonly');
      expect(fallbackInput).toHaveValue(draft);
      expect(screen.getByText('剪贴板不可用或被拒绝，请手动复制下方 Token。')).toBeInTheDocument();
      expect(apiMocks.managementToken).not.toHaveBeenCalled();

      // Check selectable on focus/click
      const selectSpy = vi.spyOn(fallbackInput as HTMLInputElement, 'select');
      fireEvent.focus(fallbackInput);
      expect(selectSpy).toHaveBeenCalled();
    });
  });

  describe('Case 3: Fencing & lifecycle invalidation', () => {
    it('drops in-flight copy completion when channel changes or session invalidates', async () => {
      let resolveClipboard: () => void = () => {};
      writeTextMock.mockImplementationOnce(() => new Promise<void>(resolve => {
        resolveClipboard = resolve;
      }));

      renderToken({ status: { configured: true, locked: false } });
      const tokenInput = screen.getByLabelText('新 Token（独立保存）');
      fireEvent.change(tokenInput, { target: { value: 'fencing-test-token-draft-value-1234' } });

      fireEvent.click(screen.getByRole('button', { name: '复制 Token' }));

      const snapshotBefore = getPanelChannelSnapshot();
      expect(snapshotBefore.mode).toBe('antigravity');

      // Channel epoch changes while writeText in-flight
      act(() => {
        __commitPanelChannel('geminicli');
      });

      const snapshotAfter = getPanelChannelSnapshot();
      expect(snapshotAfter.mode).toBe('geminicli');
      expect(snapshotAfter.channelEpoch).toBe(snapshotBefore.channelEpoch + 1);

      // Now clipboard promise resolves
      await act(async () => {
        resolveClipboard();
      });

      // Completion notice must have been dropped due to channel fence, draft discarded
      expect(screen.queryByText('Token 已复制到剪贴板。')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('手动复制 Token（剪贴板不可用）')).not.toBeInTheDocument();
      expect(tokenInput).toHaveValue('');
      expect(hasSecretExitChanges()).toBe(false);
    });

    it('invalidates active copy notice and fallback upon edit, generate, discard, and channel switch', async () => {
      writeTextMock.mockRejectedValue(new Error('Unavailable'));
      renderToken({ status: { configured: true, locked: false } });

      const tokenInput = screen.getByLabelText('新 Token（独立保存）');
      fireEvent.change(tokenInput, { target: { value: 'draft-token-for-invalidation-suite' } });
      fireEvent.click(screen.getByRole('button', { name: '复制 Token' }));

      await waitFor(() => {
        expect(screen.getByLabelText('手动复制 Token（剪贴板不可用）')).toBeInTheDocument();
      });

      // 1. Edit invalidates fallback
      fireEvent.change(tokenInput, { target: { value: 'draft-token-edited-manually-now' } });
      expect(screen.queryByLabelText('手动复制 Token（剪贴板不可用）')).not.toBeInTheDocument();
      expect(screen.queryByText('剪贴板不可用或被拒绝，请手动复制下方 Token。')).not.toBeInTheDocument();

      // Re-trigger fallback
      fireEvent.click(screen.getByRole('button', { name: '复制 Token' }));
      await waitFor(() => {
        expect(screen.getByLabelText('手动复制 Token（剪贴板不可用）')).toBeInTheDocument();
      });

      // 2. Generate invalidates fallback
      vi.spyOn(crypto, 'getRandomValues').mockImplementation((arr: ArrayBufferView) => {
        (arr as Uint8Array).fill(0xee);
        return arr;
      });
      fireEvent.click(screen.getByRole('button', { name: '生成 Token' }));
      expect(screen.queryByLabelText('手动复制 Token（剪贴板不可用）')).not.toBeInTheDocument();

      // Re-trigger fallback
      fireEvent.click(screen.getByRole('button', { name: '复制 Token' }));
      await waitFor(() => {
        expect(screen.getByLabelText('手动复制 Token（剪贴板不可用）')).toBeInTheDocument();
      });

      // 3. Discard invalidates fallback
      fireEvent.click(screen.getByRole('button', { name: '放弃 Token 输入' }));
      expect(screen.queryByLabelText('手动复制 Token（剪贴板不可用）')).not.toBeInTheDocument();
      expect(tokenInput).toHaveValue('');

      // 4. Channel switch invalidates fallback
      fireEvent.change(tokenInput, { target: { value: 'new-draft-before-channel-switch' } });
      fireEvent.click(screen.getByRole('button', { name: '复制 Token' }));
      await waitFor(() => {
        expect(screen.getByLabelText('手动复制 Token（剪贴板不可用）')).toBeInTheDocument();
      });

      const snapBefore = getPanelChannelSnapshot();
      expect(snapBefore.mode).toBe('antigravity');

      act(() => {
        __commitPanelChannel('geminicli');
      });

      const snapAfter = getPanelChannelSnapshot();
      expect(snapAfter.mode).toBe('geminicli');
      expect(snapAfter.channelEpoch).toBe(snapBefore.channelEpoch + 1);

      expect(screen.queryByLabelText('手动复制 Token（剪贴板不可用）')).not.toBeInTheDocument();
      expect(screen.queryByText('剪贴板不可用或被拒绝，请手动复制下方 Token。')).not.toBeInTheDocument();
      expect(tokenInput).toHaveValue('');
      expect(hasSecretExitChanges()).toBe(false);
    });

    it('leaves draft and fallback intact when same-mode __commitPanelChannel is a no-op, but clears them on same-mode __invalidatePanelChannel', async () => {
      writeTextMock.mockRejectedValue(new Error('Unavailable'));
      renderToken({ status: { configured: true, locked: false } });

      const tokenInput = screen.getByLabelText('新 Token（独立保存）');
      fireEvent.change(tokenInput, { target: { value: 'draft-token-for-same-mode-test' } });
      fireEvent.click(screen.getByRole('button', { name: '复制 Token' }));

      await waitFor(() => {
        expect(screen.getByLabelText('手动复制 Token（剪贴板不可用）')).toBeInTheDocument();
      });
      expect(hasSecretExitChanges()).toBe(true);

      const snap0 = getPanelChannelSnapshot();
      expect(snap0.mode).toBe('antigravity');

      // Same-mode __commitPanelChannel is a strict no-op
      act(() => {
        __commitPanelChannel('antigravity');
      });

      const snap1 = getPanelChannelSnapshot();
      expect(snap1.mode).toBe('antigravity');
      expect(snap1.channelEpoch).toBe(snap0.channelEpoch);
      expect(screen.getByLabelText('手动复制 Token（剪贴板不可用）')).toBeInTheDocument();
      expect(tokenInput).toHaveValue('draft-token-for-same-mode-test');
      expect(hasSecretExitChanges()).toBe(true);

      // Now trigger same-mode __invalidatePanelChannel
      act(() => {
        __invalidatePanelChannel();
      });

      const snap2 = getPanelChannelSnapshot();
      expect(snap2.mode).toBe('antigravity');
      expect(snap2.channelEpoch).toBe(snap1.channelEpoch + 1);

      expect(screen.queryByLabelText('手动复制 Token（剪贴板不可用）')).not.toBeInTheDocument();
      expect(screen.queryByText('剪贴板不可用或被拒绝，请手动复制下方 Token。')).not.toBeInTheDocument();
      expect(tokenInput).toHaveValue('');
      expect(hasSecretExitChanges()).toBe(false);
    });

    it('clears local delete confirmation and aria-invalid error marker on channel invalidation', async () => {
      renderToken({ status: { configured: true, locked: false } });

      const tokenInput = screen.getByLabelText('新 Token（独立保存）');
      // Trigger invalid length error
      fireEvent.change(tokenInput, { target: { value: 'short' } });
      fireEvent.click(screen.getByRole('button', { name: '保存 Token' }));
      expect(tokenInput).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByRole('alert')).toHaveTextContent('请输入 32–512 字符的新 Token');

      // Open DELETE confirmation
      fireEvent.click(screen.getByRole('button', { name: '清除 Token' }));
      expect(screen.getByRole('button', { name: '确认清除' })).toBeInTheDocument();

      const snapBefore = getPanelChannelSnapshot();
      expect(snapBefore.mode).toBe('antigravity');

      act(() => {
        __commitPanelChannel('geminicli');
      });

      const snapAfter = getPanelChannelSnapshot();
      expect(snapAfter.mode).toBe('geminicli');
      expect(snapAfter.channelEpoch).toBe(snapBefore.channelEpoch + 1);

      // Confirmation alert, invalid marker, and draft are removed
      expect(screen.queryByRole('button', { name: '确认清除' })).not.toBeInTheDocument();
      expect(tokenInput).toHaveAttribute('aria-invalid', 'false');
      expect(screen.queryByText(/请输入 32–512 字符的新 Token/)).not.toBeInTheDocument();
      expect(tokenInput).toHaveValue('');
      expect(hasSecretExitChanges()).toBe(false);
    });

    it('advances channelEpoch on ABA transition (AG -> GCLI -> AG) and prevents resurrecting old draft, copy completion, or API response', async () => {
      let resolveClipboard: () => void = () => {};
      writeTextMock.mockImplementationOnce(() => new Promise<void>(resolve => {
        resolveClipboard = resolve;
      }));
      let resolveApi: (status: TokenStatus) => void = () => {};
      apiMocks.managementToken.mockImplementationOnce(() => new Promise<TokenStatus>(resolve => {
        resolveApi = resolve;
      }));

      const onUpdate = vi.fn();
      renderToken({ status: { configured: false, locked: false }, onUpdate });

      const tokenInput = screen.getByLabelText('新 Token（独立保存）');
      const abaToken = 'd'.repeat(32);
      fireEvent.change(tokenInput, { target: { value: abaToken } });
      expect(hasSecretExitChanges()).toBe(true);

      // Start copy and save in flight
      fireEvent.click(screen.getByRole('button', { name: '复制 Token' }));
      fireEvent.click(screen.getByRole('button', { name: '保存 Token' }));

      const snap0 = getPanelChannelSnapshot();
      expect(snap0.mode).toBe('antigravity');

      // Step A: switch to geminicli
      act(() => {
        __commitPanelChannel('geminicli');
      });
      const snap1 = getPanelChannelSnapshot();
      expect(snap1.mode).toBe('geminicli');
      expect(snap1.channelEpoch).toBe(snap0.channelEpoch + 1);
      expect(tokenInput).toHaveValue('');
      expect(hasSecretExitChanges()).toBe(false);

      // Step B: switch back to antigravity (ABA)
      act(() => {
        __commitPanelChannel('antigravity');
      });
      const snap2 = getPanelChannelSnapshot();
      expect(snap2.mode).toBe('antigravity');
      expect(snap2.channelEpoch).toBe(snap1.channelEpoch + 1);

      // Resolve delayed copy and API calls now that mode is back to antigravity
      await act(async () => {
        resolveClipboard();
        resolveApi({ configured: true, locked: false });
      });

      // Neither clipboard success nor API confirmation can resurrect old state
      expect(screen.queryByText('Token 已复制到剪贴板。')).not.toBeInTheDocument();
      expect(screen.queryByText('独立 Token 操作已确认。')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('手动复制 Token（剪贴板不可用）')).not.toBeInTheDocument();
      expect(onUpdate).not.toHaveBeenCalled();
      expect(tokenInput).toHaveValue('');
      expect(hasSecretExitChanges()).toBe(false);
    });
  });

  describe('Case 4: Preservation of existing save validation, onUpdate, discard, clear confirmation & ARIA contracts', () => {
    it('enforces 32-512 length validation with alert role and aria-invalid on save', async () => {
      renderToken({ status: { configured: true, locked: false } });
      const tokenInput = screen.getByLabelText('新 Token（独立保存）');

      fireEvent.change(tokenInput, { target: { value: 'short-token' } });
      fireEvent.click(screen.getByRole('button', { name: '保存 Token' }));

      expect(tokenInput).toHaveAttribute('aria-invalid', 'true');
      expect(tokenInput).toHaveAttribute('aria-describedby', 'management-token-error');
      const errorMsg = screen.getByRole('alert');
      expect(errorMsg).toHaveTextContent('请输入 32–512 字符的新 Token，不含首尾空白或掩码占位符。');
      expect(apiMocks.managementToken).not.toHaveBeenCalled();
    });

    it('submits valid token to PUT API, triggers onUpdate, clears draft and exit dirty', async () => {
      const nextStatus = { configured: true, locked: false };
      apiMocks.managementToken.mockResolvedValueOnce(nextStatus);
      const onUpdate = vi.fn();
      renderToken({ status: { configured: false, locked: false }, onUpdate });

      const tokenInput = screen.getByLabelText('新 Token（独立保存）');
      const validToken = 'c'.repeat(32);
      fireEvent.change(tokenInput, { target: { value: validToken } });
      expect(hasSecretExitChanges()).toBe(true);

      fireEvent.click(screen.getByRole('button', { name: '保存 Token' }));

      await waitFor(() => {
        expect(apiMocks.managementToken).toHaveBeenCalledWith('PUT', validToken);
      });
      expect(onUpdate).toHaveBeenCalledWith(nextStatus);
      expect(tokenInput).toHaveValue('');
      expect(hasSecretExitChanges()).toBe(false);
      expect(screen.getByText('独立 Token 操作已确认。')).toBeInTheDocument();
    });

    it('handles discard input and external secret discard signal cleanly', async () => {
      renderToken({ status: { configured: true, locked: false } });
      const tokenInput = screen.getByLabelText('新 Token（独立保存）');

      fireEvent.change(tokenInput, { target: { value: 'token-to-discard-1234567890123456' } });
      expect(hasSecretExitChanges()).toBe(true);

      fireEvent.click(screen.getByRole('button', { name: '放弃 Token 输入' }));
      expect(tokenInput).toHaveValue('');
      expect(hasSecretExitChanges()).toBe(false);

      // External discard
      fireEvent.change(tokenInput, { target: { value: 'another-token-to-discard-remotely' } });
      expect(hasSecretExitChanges()).toBe(true);
      act(() => {
        discardExitChanges('secrets');
      });
      expect(tokenInput).toHaveValue('');
      expect(hasSecretExitChanges()).toBe(false);
    });

    it('requires explicit confirmation before issuing DELETE and respects cancel', async () => {
      apiMocks.managementToken.mockResolvedValueOnce({ configured: false, locked: false });
      const onUpdate = vi.fn();
      renderToken({ status: { configured: true, locked: false }, onUpdate });

      const clearBtn = screen.getByRole('button', { name: '清除 Token' });
      expect(clearBtn).not.toBeDisabled();

      // Open confirm
      fireEvent.click(clearBtn);
      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent('清除将关闭 Management API，依赖此 Token 的连接会失效。');

      // Cancel
      fireEvent.click(screen.getByRole('button', { name: '取消' }));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(apiMocks.managementToken).not.toHaveBeenCalled();

      // Confirm deletion
      fireEvent.click(clearBtn);
      fireEvent.click(screen.getByRole('button', { name: '确认清除' }));

      await waitFor(() => {
        expect(apiMocks.managementToken).toHaveBeenCalledWith('DELETE', '');
      });
      expect(onUpdate).toHaveBeenCalledWith({ configured: false, locked: false });
    });
  });
});
