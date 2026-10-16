import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestOptions } from '@/api/client';
import { AuthProvider } from '@/auth';
import { setSessionToken } from '@/auth/session';
import SettingsPage from '../index';
import { clearCarriedDraft } from '../hooks';

const { requestJsonMock } = vi.hoisted(() => ({
  requestJsonMock: vi.fn(),
}));

vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>();
  return {
    ...actual,
    requestJson: requestJsonMock,
  };
});

vi.mock('../components/ManagementToken', () => ({
  ManagementToken: () => null,
}));

describe('Settings form integration', () => {
  beforeEach(() => {
    requestJsonMock.mockReset();
    requestJsonMock.mockImplementation(async (path: string, options?: RequestOptions) => {
      if (path === 'config/get') {
        if (options?.query?.include_secrets === false) {
          return {
            config: {
              host: 'localhost',
              port: 7861,
              debug_mode: false,
              retry_429_max_retries: 0,
            },
            capabilities: [],
            env_locked: [],
            security: {},
            secret_fields: {
              api_password: { configured: false },
              panel_password: { configured: false },
              password: { configured: false },
            },
          };
        }
        if (options?.query?.include_secrets === true) {
          return {
            success: true,
            config: {
              api_password: 'synthetic-api-canary',
              panel_password: 'synthetic-panel-canary',
              password: 'synthetic-general-canary',
            },
          };
        }
        throw new Error(`Unexpected config/get query: ${JSON.stringify(options?.query)}`);
      }

      if (path === 'config/storage-engine') {
        return { current_engine: 'synthetic' };
      }

      if (path === 'config/save') {
        if (options?.method === 'POST') {
          const body = options.body as { config?: Record<string, unknown> } | undefined;
          return {
            success: true,
            saved_config: body?.config ?? {},
          };
        }
        throw new Error(`Unexpected config/save method: ${options?.method}`);
      }

      throw new Error(`Unexpected requestJson call to: ${path}`);
    });

    setSessionToken('synthetic-token', false);
  });

  afterEach(async () => {
    cleanup();
    clearCarriedDraft();
    setSessionToken(null);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('renders actual service URLs and submits a boolean edit when untouched numeric values are loaded', async () => {
    render(
      <AuthProvider>
        <SettingsPage />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.getByLabelText('端口')).toHaveValue(7861));
    expect(screen.getByRole('link', { name: '旧配置页：存储预览与切换' }).getAttribute('href')).toMatch(/\/#config$/);
    expect(screen.getByRole('link', { name: '模型路由编辑器' }).getAttribute('href')).toBe('#/model-routing');

    fireEvent.click(screen.getByLabelText('调试模式'));
    fireEvent.click(screen.getByRole('button', { name: '保存已修改字段' }));

    await waitFor(() =>
      expect(requestJsonMock).toHaveBeenCalledWith(
        'config/save',
        expect.objectContaining({
          method: 'POST',
          body: { config: { debug_mode: true } },
        })
      )
    );
  });

  it('reveals saved passwords via explicit confirmation and clears canary secrets upon closing without save', async () => {
    render(
      <AuthProvider>
        <SettingsPage />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.getByLabelText('端口')).toHaveValue(7861));

    const trigger = screen.getByRole('button', { name: '查看已保存密码' });
    expect(trigger).toBeInTheDocument();
    expect(trigger.closest('form')).toBeNull();

    fireEvent.click(trigger);
    expect(await screen.findByRole('button', { name: '确认查看' })).toBeInTheDocument();

    const secretGetsBeforeConfirm = requestJsonMock.mock.calls.filter((args: unknown[]) => {
      const path = args[0] as string;
      const opts = args[1] as RequestOptions | undefined;
      return path === 'config/get' && opts?.query?.include_secrets === true;
    });
    expect(secretGetsBeforeConfirm).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: '确认查看' }));

    await waitFor(() => expect(screen.getByDisplayValue('synthetic-api-canary')).toBeInTheDocument());
    expect(screen.getByDisplayValue('synthetic-panel-canary')).toBeInTheDocument();
    expect(screen.getByDisplayValue('synthetic-general-canary')).toBeInTheDocument();

    const secretGetsAfterConfirm = requestJsonMock.mock.calls.filter((args: unknown[]) => {
      const path = args[0] as string;
      const opts = args[1] as RequestOptions | undefined;
      return path === 'config/get' && opts?.query?.include_secrets === true;
    });
    expect(secretGetsAfterConfirm).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: '关闭' }));

    await waitFor(() => {
      expect(screen.queryByDisplayValue('synthetic-api-canary')).not.toBeInTheDocument();
    });
    expect(screen.queryByDisplayValue('synthetic-panel-canary')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('synthetic-general-canary')).not.toBeInTheDocument();

    const saveCalls = requestJsonMock.mock.calls.filter((args: unknown[]) => args[0] === 'config/save');
    expect(saveCalls).toHaveLength(0);
  });

  it('renders backend embed policy diagnostics when status appears, while missing or invalid status never looks valid', async () => {
    // 1. With backend status present (environment, valid: true, locked: true)
    requestJsonMock.mockImplementation(async (path: string, options?: RequestOptions) => {
      if (path === 'config/get' && options?.query?.include_secrets === false) {
        return {
          config: {
            host: 'localhost',
            port: 7861,
            debug_mode: false,
            retry_429_max_retries: 0,
            gcli_embed_mode: 'exact',
          },
          capabilities: [],
          env_locked: [],
          security: {
            embed_policy: {
              source: 'environment',
              valid: true,
              locked: true,
            },
          },
          secret_fields: {
            api_password: { configured: false },
            panel_password: { configured: false },
            password: { configured: false },
          },
        };
      }
      if (path === 'config/storage-engine') {
        return { current_engine: 'synthetic' };
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    const { unmount } = render(
      <AuthProvider>
        <SettingsPage />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.getByLabelText('端口')).toHaveValue(7861));
    expect(screen.getByText('环境变量 (environment)')).toBeInTheDocument();
    expect(screen.getByText('有效')).toBeInTheDocument();
    expect(screen.getByText('已锁定')).toBeInTheDocument();
    expect(screen.queryByText(/已进入 Fail-closed 阻断状态/)).not.toBeInTheDocument();
    unmount();
    cleanup();
    clearCarriedDraft();

    // 2. With invalid backend status (storage, valid: false, locked: false)
    requestJsonMock.mockImplementation(async (path: string, options?: RequestOptions) => {
      if (path === 'config/get' && options?.query?.include_secrets === false) {
        return {
          config: {
            host: 'localhost',
            port: 7861,
            debug_mode: false,
            retry_429_max_retries: 0,
            gcli_embed_mode: 'disabled',
          },
          capabilities: [],
          env_locked: [],
          security: {
            embed_policy: {
              source: 'storage',
              valid: false,
              locked: false,
            },
          },
          secret_fields: {
            api_password: { configured: false },
            panel_password: { configured: false },
            password: { configured: false },
          },
        };
      }
      if (path === 'config/storage-engine') {
        return { current_engine: 'synthetic' };
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    render(
      <AuthProvider>
        <SettingsPage />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.getByLabelText('端口')).toHaveValue(7861));
    expect(screen.getByText('存储配置 (storage)')).toBeInTheDocument();
    expect(screen.getByText('策略无效（已阻断/Fail-closed）')).toBeInTheDocument();
    expect(screen.getByText('未锁定')).toBeInTheDocument();
    expect(screen.getByText(/已进入 Fail-closed 阻断状态/)).toBeInTheDocument();
    expect(screen.queryByText(/^有效$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^有效（已配置禁用）$/)).not.toBeInTheDocument();
  });

  it('changing draft embed mode cannot rewrite effective embed policy source or validity', async () => {
    requestJsonMock.mockImplementation(async (path: string, options?: RequestOptions) => {
      if (path === 'config/get' && options?.query?.include_secrets === false) {
        return {
          config: {
            host: 'localhost',
            port: 7861,
            debug_mode: false,
            retry_429_max_retries: 0,
            gcli_embed_mode: 'any_https',
          },
          capabilities: [],
          env_locked: [],
          security: {
            embed_policy: {
              source: 'environment',
              valid: true,
              locked: true,
            },
          },
          secret_fields: {
            api_password: { configured: false },
            panel_password: { configured: false },
            password: { configured: false },
          },
        };
      }
      if (path === 'config/storage-engine') {
        return { current_engine: 'synthetic' };
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    render(
      <AuthProvider>
        <SettingsPage />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.getByLabelText('端口')).toHaveValue(7861));

    // Confirm initial diagnostics
    expect(screen.getByText('环境变量 (environment)')).toBeInTheDocument();
    expect(screen.getByText('有效')).toBeInTheDocument();
    expect(screen.getByText('已锁定')).toBeInTheDocument();

    // Change draft mode
    const embedModeSelect = screen.getByLabelText('嵌入策略');
    fireEvent.change(embedModeSelect, { target: { value: 'disabled' } });
    expect(embedModeSelect).toHaveValue('disabled');

    // Effective diagnostics MUST remain unchanged from backend snapshot
    expect(screen.getByText('环境变量 (environment)')).toBeInTheDocument();
    expect(screen.getByText('有效')).toBeInTheDocument();
    expect(screen.getByText('已锁定')).toBeInTheDocument();
    expect(screen.queryByText('有效（已配置禁用）')).not.toBeInTheDocument();
  });
});
