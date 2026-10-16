import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { getConfig, readSnapshot } from './api';
import { secretKeys } from './types';

function createSafeResponse(overrides: {
  config?: Record<string, unknown>;
  capabilities?: string[];
  env_locked?: string[];
  security?: Record<string, unknown>;
  secret_fields?: Record<string, { configured: boolean }>;
} = {}) {
  return {
    config: {
      host: '127.0.0.1',
      port: 7861,
      credentials_dir: 'synthetic-credentials',
      debug_mode: false,
      retry_429_max_retries: 0,
      retry_429_interval: 0.1,
      auto_ban_enabled: false,
      auto_ban_error_codes: [],
      gcli_embed_mode: 'disabled',
      gcli_embed_allowed_origins: [],
      compatibility_mode_enabled: false,
      return_thoughts_to_frontend: true,
      antigravity_stream2nostream: true,
      antigravity_switch_credential_enabled: false,
      antigravity_flash_non_stream_mode: 'inherit',
      antigravity_native_timeout_seconds: 480,
      routing_mode: 'normal',
      keepalive_url: '',
      keepalive_interval: 60,
      ...overrides.config,
    },
    capabilities: overrides.capabilities ?? [
      'antigravity.flash.non_stream_transport',
      'antigravity.native.timeout',
    ],
    env_locked: overrides.env_locked ?? ['host'],
    security: overrides.security ?? {
      node_management_token: { configured: true, locked: false, source: 'storage' },
    },
    secret_fields: overrides.secret_fields ?? {
      api_password: { configured: true },
      panel_password: { configured: false },
      password: { configured: false },
    },
  };
}

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

describe('settings api client safe read contract', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('production getConfig transport contract', () => {
    it('issues exactly one prefixed GET config/get with explicit include_secrets=false and never missing or true', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(createSafeResponse()));

      const snapshot = await getConfig();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [requestUrl, requestInit] = fetchMock.mock.calls[0];
      const parsed = new URL(typeof requestUrl === 'string' ? requestUrl : requestUrl.toString(), 'http://localhost:3000');
      expect(parsed.pathname).toMatch(/\/config\/get$/);
      expect(parsed.searchParams.has('include_secrets')).toBe(true);
      expect(parsed.searchParams.get('include_secrets')).toBe('false');
      expect(parsed.searchParams.get('include_secrets')).not.toBe('true');
      expect(parsed.searchParams.get('include_secrets')).not.toBe('');
      expect((requestInit?.method ?? 'GET').toUpperCase()).toBe('GET');
      expect(snapshot).toBeDefined();
      expect(snapshot.config.host).toBe('127.0.0.1');
    });
  });

  describe('safe Snapshot projection', () => {
    it('preserves zero, false, explicit empty arrays, field locks, capabilities and token metadata', async () => {
      const raw = createSafeResponse({
        config: {
          host: '192.168.1.1',
          port: 8080,
          debug_mode: false,
          retry_429_max_retries: 0,
          retry_429_interval: 0.05,
          auto_ban_enabled: false,
          auto_ban_error_codes: [],
          gcli_embed_mode: 'disabled',
          gcli_embed_allowed_origins: [],
          antigravity_flash_non_stream_mode: 'stream_collect',
          antigravity_native_timeout_seconds: 300,
        },
        env_locked: ['host', 'port', 'debug_mode'],
        capabilities: ['antigravity.flash.non_stream_transport', 'antigravity.native.timeout'],
        security: {
          node_management_token: { configured: true, locked: false, source: 'storage' },
        },
        secret_fields: {
          api_password: { configured: true },
          panel_password: { configured: false },
          password: { configured: true },
        },
      });
      fetchMock.mockResolvedValueOnce(jsonResponse(raw));

      const snapshot = await getConfig();
      expect(snapshot.config.debug_mode).toBe(false);
      expect(snapshot.config.retry_429_max_retries).toBe(0);
      expect(snapshot.config.auto_ban_enabled).toBe(false);
      expect(snapshot.config.auto_ban_error_codes).toEqual([]);
      expect(snapshot.config.gcli_embed_allowed_origins).toEqual([]);
      expect(snapshot.config.host).toBe('192.168.1.1');
      expect(snapshot.config.port).toBe(8080);
      expect(snapshot.config.antigravity_flash_non_stream_mode).toBe('stream_collect');
      expect(snapshot.config.antigravity_native_timeout_seconds).toBe(300);
      expect(snapshot.envLocked).toEqual(['host', 'port', 'debug_mode']);
      expect(snapshot.capabilities).toEqual(['antigravity.flash.non_stream_transport', 'antigravity.native.timeout']);
      expect(snapshot.token).toEqual({ configured: true, locked: false, source: 'storage' });

      for (const key of secretKeys) {
        expect(key in snapshot.config).toBe(false);
        expect(snapshot.config[key]).toBeUndefined();
      }
    });

    it('preserves legacy readSnapshot helper compatibility with explicitly provided raw snapshots', () => {
      const legacyRaw = {
        config: { host: 'localhost', panel_password: 'synthetic-legacy-secret', port: 7861 },
        capabilities: ['valid_cap', false],
        env_locked: ['host', 'panel_password'],
        security: { node_management_token: { configured: true, locked: true, source: 'env' } },
      };
      const result = readSnapshot(legacyRaw);
      expect(result.config.host).toBe('localhost');
      expect(result.config.port).toBe(7861);
      expect(result.config.panel_password).toBeUndefined();
      expect('panel_password' in result.config).toBe(false);
      expect(result.capabilities).toEqual([]);
      expect(result.envLocked).toEqual(['host', 'panel_password']);
      expect(result.token).toEqual({ configured: true, locked: true, source: 'env' });
    });
  });

  describe('poison config rejection before projection', () => {
    it.each(['api_password', 'panel_password', 'password'] as const)(
      'rejects a 200 response with %s in config using fixed safe ApiError(200, null)',
      async (secretKey) => {
        const poison = createSafeResponse({
          config: { [secretKey]: 'synthetic-secret-plaintext-value' },
        });
        fetchMock.mockResolvedValueOnce(jsonResponse(poison));

        let caught: unknown;
        try {
          await getConfig();
        } catch (err: unknown) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(ApiError);
        if (caught instanceof ApiError) {
          expect(caught.status).toBe(200);
          expect(caught.payload).toBeNull();
        }
      }
    );

    it('rejects empty-string secret values in config as poison transport', async () => {
      const poison = createSafeResponse({
        config: { api_password: '' },
      });
      fetchMock.mockResolvedValueOnce(jsonResponse(poison));

      let caught: unknown;
      try {
        await getConfig();
      } catch (err: unknown) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ApiError);
      if (caught instanceof ApiError) {
        expect(caught.status).toBe(200);
        expect(caught.payload).toBeNull();
      }
    });
  });

  describe('malformed safe envelope and error provenance', () => {
    it('rejects malformed capabilities array with fixed safe ApiError(200, null)', async () => {
      const malformed = {
        ...createSafeResponse(),
        capabilities: ['valid', 12345],
      };
      fetchMock.mockResolvedValueOnce(jsonResponse(malformed));

      let caught: unknown;
      try {
        await getConfig();
      } catch (err: unknown) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ApiError);
      if (caught instanceof ApiError) {
        expect(caught.status).toBe(200);
        expect(caught.payload).toBeNull();
      }
    });

    it('rejects malformed env_locked with fixed safe ApiError(200, null)', async () => {
      const malformed = {
        ...createSafeResponse(),
        env_locked: 'not-an-array',
      };
      fetchMock.mockResolvedValueOnce(jsonResponse(malformed));

      let caught: unknown;
      try {
        await getConfig();
      } catch (err: unknown) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ApiError);
      if (caught instanceof ApiError) {
        expect(caught.status).toBe(200);
        expect(caught.payload).toBeNull();
      }
    });

    it('rejects missing or incomplete secret_fields with fixed safe ApiError(200, null)', async () => {
      const malformed = {
        ...createSafeResponse(),
        secret_fields: {
          api_password: { configured: true },
        },
      };
      fetchMock.mockResolvedValueOnce(jsonResponse(malformed));

      let caught: unknown;
      try {
        await getConfig();
      } catch (err: unknown) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ApiError);
      if (caught instanceof ApiError) {
        expect(caught.status).toBe(200);
        expect(caught.payload).toBeNull();
      }
    });

    it('preserves error provenance on HTTP 500 server error', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'storage backend unavailable' }, 500));

      let caught: unknown;
      try {
        await getConfig();
      } catch (err: unknown) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ApiError);
      if (caught instanceof ApiError) {
        expect(caught.status).toBe(500);
        expect(caught.payload).toEqual({ detail: 'storage backend unavailable' });
      }
    });

    it('preserves error provenance on HTTP 401 unauthorized', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'Not authenticated' }, 401));

      let caught: unknown;
      try {
        await getConfig();
      } catch (err: unknown) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ApiError);
      if (caught instanceof ApiError) {
        expect(caught.status).toBe(401);
      }
    });

    it('preserves network error provenance', async () => {
      fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

      let caught: unknown;
      try {
        await getConfig();
      } catch (err: unknown) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(TypeError);
      if (caught instanceof TypeError) {
        expect(caught.message).toBe('Failed to fetch');
      }
    });
  });

  describe('storage and output hygiene', () => {
    it('never retains secrets or rejected payloads in localStorage, sessionStorage, or logs', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const secretCanary = 'canary-password-never-log-or-persist-999';
      const poison = createSafeResponse({
        config: { panel_password: secretCanary },
      });
      fetchMock.mockResolvedValueOnce(jsonResponse(poison));

      let caught: unknown;
      try {
        await getConfig();
      } catch (err: unknown) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ApiError);
      if (caught instanceof ApiError) {
        expect(caught.status).toBe(200);
        expect(caught.payload).toBeNull();
      }

      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i)!;
        expect(window.localStorage.getItem(key)).not.toContain(secretCanary);
      }

      for (let i = 0; i < window.sessionStorage.length; i++) {
        const key = window.sessionStorage.key(i)!;
        expect(window.sessionStorage.getItem(key)).not.toContain(secretCanary);
      }

      const allLogCalls = [...errorSpy.mock.calls, ...warnSpy.mock.calls, ...logSpy.mock.calls];
      for (const call of allLogCalls) {
        expect(JSON.stringify(call)).not.toContain(secretCanary);
      }
    });
  });

  describe('cancellation handling', () => {
    it('rejects immediately when passed an already-aborted signal without sending network fetch', async () => {
      const controller = new AbortController();
      controller.abort();

      let caught: unknown;
      try {
        await getConfig(controller.signal);
      } catch (err: unknown) {
        caught = err;
      }
      expect(caught).toBeDefined();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('cancels an in-flight delayed request when aborted', async () => {
      const controller = new AbortController();
      fetchMock.mockImplementationOnce((_url, init) => {
        return new Promise((_, reject) => {
          if (init?.signal) {
            init.signal.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted', 'AbortError'));
            });
          }
        });
      });

      const promise = getConfig(controller.signal);
      controller.abort();

      let caught: unknown;
      try {
        await promise;
      } catch (err: unknown) {
        caught = err;
      }
      expect(caught).toBeDefined();
    });
  });

  describe('local settings synthetic fixture branch', () => {
    it('stays offline with invented values, never calls fetch, projects safe fields and refuses reveal', async () => {
      vi.stubEnv('VITE_UI_FIXTURES', 'true');

      const snapshot = await getConfig();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(snapshot).toBeDefined();
      expect(snapshot.config.host).toBe('127.0.0.1');
      expect(snapshot.config.port).toBe(7861);
      expect(snapshot.envLocked).toContain('host');
      expect(snapshot.capabilities).toContain('antigravity.flash.non_stream_transport');

      for (const key of secretKeys) {
        expect(key in snapshot.config).toBe(false);
        expect(snapshot.config[key]).toBeUndefined();
      }
    });

    it('honors an already-aborted signal in fixture mode without network fallback', async () => {
      vi.stubEnv('VITE_UI_FIXTURES', 'true');
      const controller = new AbortController();
      controller.abort();

      let caught: unknown;
      try {
        await getConfig(controller.signal);
      } catch (err: unknown) {
        caught = err;
      }
      expect(caught).toBeDefined();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
