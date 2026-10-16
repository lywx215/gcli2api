import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as clientModule from '@/api/client';
import { ApiError } from '@/api/client';
import {
  getStorageState,
  getSystemStatus,
  previewStorageMigration,
  SemanticError,
  switchStorageEngine,
  writeFailure,
} from './api';

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

function directObjectResponse(data: unknown, status = 200, headers: Record<string, string> = {}) {
  const bodyText = JSON.stringify(data);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers({
      'Content-Type': 'application/json',
      ...headers,
    }),
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(bodyText),
    clone: function () {
      return this;
    },
  } as unknown as Response;
}

describe('storage and system settings api client contract', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    document.head.innerHTML = '<meta name="gcli-service-base" content="/nested/service/">';
    vi.stubEnv('VITE_UI_FIXTURES', 'false');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe('transport, prefixing, and request options', () => {
    it('issues exact GET config/storage-engine with nested prefix, no query, no body, no scope/mode', async () => {
      const requestJsonSpy = vi.spyOn(clientModule, 'requestJson');
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ success: true, current_engine: 'sqlite' })
      );

      const state = await getStorageState();

      expect(requestJsonSpy).toHaveBeenCalledTimes(1);
      const [calledPath, calledOptions] = requestJsonSpy.mock.calls[0];
      expect(calledPath).toBe('config/storage-engine');
      expect(calledOptions?.method).toBe('GET');
      expect(calledOptions?.query).toBeUndefined();
      expect(calledOptions?.body).toBeUndefined();
      expect(calledOptions?.scope).toBeUndefined();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [requestUrl, requestInit] = fetchMock.mock.calls[0];
      const parsed = new URL(
        typeof requestUrl === 'string' ? requestUrl : requestUrl.toString(),
        'http://localhost:3000'
      );
      expect(parsed.pathname).toBe('/nested/service/config/storage-engine');
      expect(parsed.search).toBe('');
      expect(parsed.searchParams.toString()).toBe('');
      expect((requestInit?.method ?? 'GET').toUpperCase()).toBe('GET');
      expect(requestInit?.body).toBeUndefined();
      expect(state.currentEngine).toBe('sqlite');
    });

    it('issues exact GET config/system-status with nested prefix, no query, no body, no scope/mode', async () => {
      const requestJsonSpy = vi.spyOn(clientModule, 'requestJson');
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ success: true, redis: {}, smart_429: {} })
      );

      const status = await getSystemStatus();

      expect(requestJsonSpy).toHaveBeenCalledTimes(1);
      const [calledPath, calledOptions] = requestJsonSpy.mock.calls[0];
      expect(calledPath).toBe('config/system-status');
      expect(calledOptions?.method).toBe('GET');
      expect(calledOptions?.query).toBeUndefined();
      expect(calledOptions?.body).toBeUndefined();
      expect(calledOptions?.scope).toBeUndefined();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [requestUrl, requestInit] = fetchMock.mock.calls[0];
      const parsed = new URL(
        typeof requestUrl === 'string' ? requestUrl : requestUrl.toString(),
        'http://localhost:3000'
      );
      expect(parsed.pathname).toBe('/nested/service/config/system-status');
      expect(parsed.search).toBe('');
      expect(parsed.searchParams.toString()).toBe('');
      expect((requestInit?.method ?? 'GET').toUpperCase()).toBe('GET');
      expect(requestInit?.body).toBeUndefined();
      expect(status.redis).toBeDefined();
      expect(status.smart429).toBeDefined();
    });

    it('issues exact POST config/storage-engine/preview with JSON {}, no query, no scope/mode', async () => {
      const requestJsonSpy = vi.spyOn(clientModule, 'requestJson');
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ success: true, data: { gcli_credentials: 2 } })
      );

      const preview = await previewStorageMigration();

      expect(requestJsonSpy).toHaveBeenCalledTimes(1);
      const [calledPath, calledOptions] = requestJsonSpy.mock.calls[0];
      expect(calledPath).toBe('config/storage-engine/preview');
      expect(calledOptions?.method).toBe('POST');
      expect(calledOptions?.body).toEqual({});
      expect(calledOptions?.query).toBeUndefined();
      expect(calledOptions?.scope).toBeUndefined();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [requestUrl, requestInit] = fetchMock.mock.calls[0];
      const parsed = new URL(
        typeof requestUrl === 'string' ? requestUrl : requestUrl.toString(),
        'http://localhost:3000'
      );
      expect(parsed.pathname).toBe('/nested/service/config/storage-engine/preview');
      expect(parsed.search).toBe('');
      expect(parsed.searchParams.toString()).toBe('');
      expect(requestInit?.method).toBe('POST');
      expect(JSON.parse(requestInit?.body as string)).toEqual({});
      expect(preview.data.gcliCredentials).toBe(2);
    });

    it('issues exact POST config/storage-engine/switch with exact body including explicit empty server_name for sqlite', async () => {
      const requestJsonSpy = vi.spyOn(clientModule, 'requestJson');
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ success: true, engine: 'sqlite', migration: null })
      );

      const result = await switchStorageEngine('sqlite', '');

      expect(requestJsonSpy).toHaveBeenCalledTimes(1);
      const [calledPath, calledOptions] = requestJsonSpy.mock.calls[0];
      expect(calledPath).toBe('config/storage-engine/switch');
      expect(calledOptions?.method).toBe('POST');
      expect(calledOptions?.body).toEqual({
        target_engine: 'sqlite',
        server_name: '',
        migrate_data: true,
      });
      expect(calledOptions?.query).toBeUndefined();
      expect(calledOptions?.scope).toBeUndefined();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [requestUrl, requestInit] = fetchMock.mock.calls[0];
      const parsed = new URL(
        typeof requestUrl === 'string' ? requestUrl : requestUrl.toString(),
        'http://localhost:3000'
      );
      expect(parsed.pathname).toBe('/nested/service/config/storage-engine/switch');
      expect(parsed.search).toBe('');
      expect(parsed.searchParams.toString()).toBe('');
      expect(requestInit?.method).toBe('POST');
      expect(JSON.parse(requestInit?.body as string)).toEqual({
        target_engine: 'sqlite',
        server_name: '',
        migrate_data: true,
      });
      expect(result.kind).toBe('acknowledged');
    });

    it('issues exact POST config/storage-engine/switch with target mysql and provided server_name', async () => {
      const requestJsonSpy = vi.spyOn(clientModule, 'requestJson');
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ success: true, engine: 'mysql', migration: null })
      );

      const result = await switchStorageEngine('mysql', 'cluster-mysql-01');

      expect(requestJsonSpy).toHaveBeenCalledTimes(1);
      expect(requestJsonSpy.mock.calls[0][1]?.body).toEqual({
        target_engine: 'mysql',
        server_name: 'cluster-mysql-01',
        migrate_data: true,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [requestUrl, requestInit] = fetchMock.mock.calls[0];
      const parsed = new URL(
        typeof requestUrl === 'string' ? requestUrl : requestUrl.toString(),
        'http://localhost:3000'
      );
      expect(parsed.pathname).toBe('/nested/service/config/storage-engine/switch');
      expect(JSON.parse(requestInit?.body as string)).toEqual({
        target_engine: 'mysql',
        server_name: 'cluster-mysql-01',
        migrate_data: true,
      });
      expect(result.kind).toBe('acknowledged');
    });

    it('sends exactly one request and performs no automatic preview, switch, or retry', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ success: true, current_engine: 'sqlite' })
      );
      await getStorageState();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ success: true, data: { total: 0 } })
      );
      await previewStorageMigration();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ success: true, engine: 'sqlite', migration: null })
      );
      await switchStorageEngine('sqlite', '');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ success: true, redis: {}, smart_429: {} })
      );
      await getSystemStatus();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('cancellation and signal propagation', () => {
    it('rejects immediately on already-aborted signal without sending fetch for read endpoints', async () => {
      const controller = new AbortController();
      controller.abort(new DOMException('Caller aborted before execution', 'AbortError'));

      await expect(getStorageState(controller.signal)).rejects.toThrow();
      await expect(previewStorageMigration(controller.signal)).rejects.toThrow();
      await expect(getSystemStatus(controller.signal)).rejects.toThrow();

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('propagates caller abort for switchStorageEngine without converting to successful/unknown and sends zero fetch', async () => {
      const controller = new AbortController();
      controller.abort(new DOMException('Caller canceled switch', 'AbortError'));

      let caught: unknown;
      try {
        await switchStorageEngine('sqlite', '', controller.signal);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      expect(caught).toEqual(controller.signal.reason);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('forwards caller signal on in-flight switchStorageEngine and propagates abort rather than converting to unknown', async () => {
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

      const promise = switchStorageEngine('mysql', 'srv', controller.signal);
      controller.abort();

      let caught: unknown;
      try {
        await promise;
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('forwards caller signal on in-flight read endpoints and cancels transport', async () => {
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

      const promise = getStorageState(controller.signal);
      controller.abort();

      await expect(promise).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('storage state projection and hygiene', () => {
    it('preserves distinct mysqlAvailable/mysqlConfigured false, empty serverName, and valid empty servers list', async () => {
      const raw = {
        success: true,
        current_engine: 'sqlite',
        mysql_available: false,
        mysql_configured: false,
        server_name: '',
        servers: [],
      };
      fetchMock.mockResolvedValueOnce(jsonResponse(raw));

      const state = await getStorageState();
      expect(state.currentEngine).toBe('sqlite');
      expect(state.mysqlAvailable).toBe(false);
      expect(state.mysqlConfigured).toBe(false);
      expect(state.serverName).toBe('');
      expect(state.servers).toEqual([]);
    });

    it('projects typed name/status rows freshly and discards server URL and unknown secrets', async () => {
      const raw = {
        success: true,
        current_engine: 'mysql',
        mysql_available: true,
        mysql_configured: true,
        server_name: 'prod-mysql',
        servers: [
          {
            name: 'primary',
            status: 'online',
            url: 'mysql://admin:secret_password@db.example.internal:3306/prod',
            internal_token: 'CANARY_RAW_SECRET_TOKEN_999',
            canary_field: 'LEAK_CANARY',
          },
          {
            name: 'replica-1',
            status: 'standby',
            url: 'mysql://readonly:secret_pw2@replica.internal:3306/prod',
          },
          {
            name: 'unregistered',
          },
        ],
      };
      fetchMock.mockResolvedValueOnce(jsonResponse(raw));

      const state = await getStorageState();
      expect(state.servers).toEqual([
        { name: 'primary', status: 'online' },
        { name: 'replica-1', status: 'standby' },
        { name: 'unregistered' },
      ]);

      const serialized = JSON.stringify(state);
      expect(serialized).not.toContain('mysql://');
      expect(serialized).not.toContain('secret_password');
      expect(serialized).not.toContain('CANARY_RAW_SECRET_TOKEN_999');
      expect(serialized).not.toContain('LEAK_CANARY');
    });

    it('keeps malformed server lists unknown (undefined)', async () => {
      const malformedCases = [
        { success: true, servers: 'not-an-array' },
        { success: true, servers: [{ url: 'mysql://localhost:3306' }] },
        { success: true, servers: [{ name: 12345 }] },
        { success: true, servers: [{ name: 'srv1' }, 'string-instead-of-object'] },
        { success: true, servers: [{ name: 'srv1' }, null] },
      ];

      for (const payload of malformedCases) {
        fetchMock.mockResolvedValueOnce(jsonResponse(payload));
        const state = await getStorageState();
        expect(state.servers).toBeUndefined();
      }
    });

    it('throws safe SemanticError on invalid top envelope or success:false without leaking canaries', async () => {
      const canarySecret = 'CANARY_RAW_STORAGE_BACKEND_CRASH_INFO';
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ success: false, error: canarySecret }, 200)
      );

      let caught: unknown;
      try {
        await getStorageState();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(SemanticError);
      expect((caught as Error).message).toBe('存储状态响应无效');
      expect((caught as Error).message).not.toContain(canarySecret);
    });

    it('throws safe SemanticError on null or primitive responses', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(null));
      await expect(getStorageState()).rejects.toThrow('存储状态响应无效');

      fetchMock.mockResolvedValueOnce(jsonResponse('plain string'));
      await expect(getStorageState()).rejects.toThrow('存储状态响应无效');
    });
  });

  describe('preview storage migration projection', () => {
    it('preserves zero counters and valid siblings while keeping sourceEngine', async () => {
      const raw = {
        success: true,
        source_engine: 'sqlite',
        data: {
          gcli_credentials: 0,
          antigravity_credentials: 12,
          config: 0,
          total: 12,
        },
      };
      fetchMock.mockResolvedValueOnce(jsonResponse(raw));

      const preview = await previewStorageMigration();
      expect(preview.sourceEngine).toBe('sqlite');
      expect(preview.data.gcliCredentials).toBe(0);
      expect(preview.data.antigravityCredentials).toBe(12);
      expect(preview.data.config).toBe(0);
      expect(preview.data.total).toBe(12);
    });

    it('treats missing, negative, fractional, string, boolean, NaN, and Infinity counters as unknown', async () => {
      const raw = {
        success: true,
        data: {
          gcli_credentials: -1,
          antigravity_credentials: 4.8,
          config: '10',
          total: true,
          extra_counter1: NaN,
          extra_counter2: Infinity,
          extra_counter3: false,
          extra_counter4: null,
        },
      };
      fetchMock.mockResolvedValueOnce(jsonResponse(raw));

      const preview = await previewStorageMigration();
      expect(preview.data.gcliCredentials).toBeUndefined();
      expect(preview.data.antigravityCredentials).toBeUndefined();
      expect(preview.data.config).toBeUndefined();
      expect(preview.data.total).toBeUndefined();
    });

    it('ensures count invalidity in one field cannot erase valid sibling counts', async () => {
      const raw = {
        success: true,
        data: {
          gcli_credentials: 25,
          antigravity_credentials: -99,
          config: 'invalid',
          total: 25,
        },
      };
      fetchMock.mockResolvedValueOnce(jsonResponse(raw));

      const preview = await previewStorageMigration();
      expect(preview.data.gcliCredentials).toBe(25);
      expect(preview.data.antigravityCredentials).toBeUndefined();
      expect(preview.data.config).toBeUndefined();
      expect(preview.data.total).toBe(25);
    });

    it('throws safe SemanticError on invalid top envelope, missing data object, or error payload without leaking canaries', async () => {
      const previewCanary = 'CANARY_PREVIEW_REJECTED_SQLITE_LOCKED';
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ success: false, error: previewCanary })
      );

      let caught: unknown;
      try {
        await previewStorageMigration();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(SemanticError);
      expect((caught as Error).message).toBe('存储迁移预览响应无效');
      expect((caught as Error).message).not.toContain(previewCanary);

      fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: null }));
      await expect(previewStorageMigration()).rejects.toThrow('存储迁移预览响应无效');

      fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: 'not-an-object' }));
      await expect(previewStorageMigration()).rejects.toThrow('存储迁移预览响应无效');
    });
  });

  describe('mutation isolation with direct raw response', () => {
    it('isolates getStorageState DTO from raw and prevents container mutations from altering raw or other results', async () => {
      const raw = {
        success: true,
        current_engine: 'sqlite',
        mysql_available: false,
        mysql_configured: false,
        server_name: '',
        servers: [
          { name: 'srv1', status: 'online', url: 'mysql://user:pass@127.0.0.1:3306/db' },
        ],
      };
      fetchMock.mockResolvedValueOnce(directObjectResponse(raw));

      const result1 = await getStorageState();
      expect(result1.servers).toEqual([{ name: 'srv1', status: 'online' }]);

      // Mutating raw after retrieval must not alter already returned DTO
      raw.servers.push({ name: 'srv2', status: 'offline', url: 'mysql://replica:3306' });
      raw.current_engine = 'mysql';
      expect(result1.currentEngine).toBe('sqlite');
      expect(result1.servers).toHaveLength(1);

      // Mutating returned nested containers must not alter raw
      result1.servers![0].name = 'tampered-name';
      expect(raw.servers[0].name).toBe('srv1');

      // Frozen raw object must also be accepted cleanly
      const frozenRaw = Object.freeze({
        success: true,
        current_engine: 'mysql',
        mysql_available: true,
        mysql_configured: true,
        server_name: 'prod',
        servers: Object.freeze([
          Object.freeze({ name: 'frozen-srv', status: 'ready' }),
        ]),
      });
      fetchMock.mockResolvedValueOnce(directObjectResponse(frozenRaw));

      const result2 = await getStorageState();
      expect(result2.currentEngine).toBe('mysql');
      expect(result2.servers).toEqual([{ name: 'frozen-srv', status: 'ready' }]);
    });

    it('isolates previewStorageMigration data container from raw', async () => {
      const rawData = {
        gcli_credentials: 10,
        antigravity_credentials: 20,
        config: 5,
        total: 35,
      };
      const raw = {
        success: true,
        source_engine: 'sqlite',
        data: rawData,
      };
      fetchMock.mockResolvedValueOnce(directObjectResponse(raw));

      const preview = await previewStorageMigration();
      expect(preview.data.gcliCredentials).toBe(10);

      // Mutating raw cannot alter DTO
      rawData.gcli_credentials = 999;
      expect(preview.data.gcliCredentials).toBe(10);

      // Mutating DTO cannot alter raw
      preview.data.gcliCredentials = 123;
      expect(rawData.gcli_credentials).toBe(999);
    });

    it('isolates getSystemStatus redis pools and smart429 containers from raw', async () => {
      const rawPools = {
        geminicli_avail: 3,
        geminicli_preview: 2,
        antigravity_avail: 1,
      };
      const raw = {
        success: true,
        redis: {
          enabled: true,
          server_name: 'redis-main',
          pools: rawPools,
        },
        smart_429: {
          enabled: true,
        },
      };
      fetchMock.mockResolvedValueOnce(directObjectResponse(raw));

      const status = await getSystemStatus();
      expect(status.redis.pools).toEqual({
        geminicliAvail: 3,
        geminicliPreview: 2,
        antigravityAvail: 1,
      });

      // Mutating raw pools must not alter status
      rawPools.geminicli_avail = 999;
      expect(status.redis.pools?.geminicliAvail).toBe(3);

      // Mutating status pools must not alter raw pools
      status.redis.pools!.geminicliAvail = 42;
      expect(rawPools.geminicli_avail).toBe(999);
    });

    it('isolates switchStorageEngine migration containers from raw', async () => {
      const rawFam = { total: 5, migrated: 5, errors: [] };
      const raw = {
        success: true,
        engine: 'mysql',
        migration: {
          gcli_credentials: { ...rawFam },
          antigravity_credentials: { ...rawFam },
          config: { ...rawFam },
        },
      };
      fetchMock.mockResolvedValueOnce(directObjectResponse(raw));

      const switchResult = await switchStorageEngine('mysql', 'srv');
      expect(switchResult.kind).toBe('acknowledged');
      expect(switchResult.migration?.gcliCredentials.total).toBe(5);

      // Mutating raw migration after call must not affect DTO
      raw.migration.gcli_credentials.total = 1000;
      expect(switchResult.migration?.gcliCredentials.total).toBe(5);

      // Mutating returned DTO must not alter raw
      switchResult.migration!.gcliCredentials.total = 777;
      expect(raw.migration.gcli_credentials.total).toBe(1000);
    });
  });

  describe('switch storage engine decision rules', () => {
    it('acknowledges matched engine with explicit null migration', async () => {
      const raw = { success: true, engine: 'mysql', migration: null };
      fetchMock.mockResolvedValueOnce(jsonResponse(raw));

      const result = await switchStorageEngine('mysql', 'srv1');
      expect(result).toEqual({
        kind: 'acknowledged',
        engine: 'mysql',
        migration: null,
      });
    });

    it('returns unknown on mismatched engine with explicit null migration', async () => {
      const raw = { success: true, engine: 'sqlite', migration: null };
      fetchMock.mockResolvedValueOnce(jsonResponse(raw));

      const result = await switchStorageEngine('mysql', 'srv1');
      expect(result).toEqual({
        kind: 'unknown',
        engine: 'sqlite',
        migration: null,
      });
    });

    it('returns unknown on mismatched engine even with complete migration totals', async () => {
      const raw = {
        success: true,
        engine: 'sqlite',
        migration: {
          gcli_credentials: { total: 10, migrated: 10, errors: [] },
          antigravity_credentials: { total: 5, migrated: 5, errors: [] },
          config: { total: 2, migrated: 2, errors: [] },
        },
      };
      fetchMock.mockResolvedValueOnce(jsonResponse(raw));

      const result = await switchStorageEngine('mysql', 'srv1');
      expect(result.kind).toBe('unknown');
      expect(result.engine).toBe('sqlite');
      expect(result.migration).toBeDefined();
    });

    it('acknowledges complete internally consistent family totals/migrated with zero errors and omitted totalMigrated', async () => {
      const raw = {
        success: true,
        engine: 'mysql',
        migration: {
          gcli_credentials: { total: 10, migrated: 10, errors: [] },
          antigravity_credentials: { total: 5, migrated: 5, errors: [] },
          config: { total: 2, migrated: 2, errors: [] },
        },
      };
      fetchMock.mockResolvedValueOnce(jsonResponse(raw));

      const result = await switchStorageEngine('mysql', 'srv1');
      expect(result).toEqual({
        kind: 'acknowledged',
        engine: 'mysql',
        migration: {
          gcliCredentials: { total: 10, migrated: 10, errorCount: 0 },
          antigravityCredentials: { total: 5, migrated: 5, errorCount: 0 },
          config: { total: 2, migrated: 2, errorCount: 0 },
        },
      });
      expect(result.migration?.totalMigrated).toBeUndefined();
    });

    it('acknowledges complete internally consistent totals when valid matching total_migrated is present', async () => {
      const raw = {
        success: true,
        engine: 'sqlite',
        migration: {
          gcli_credentials: { total: 4, migrated: 4, errors: [] },
          antigravity_credentials: { total: 3, migrated: 3, errors: [] },
          config: { total: 1, migrated: 1, errors: [] },
          total_migrated: 8,
        },
      };
      fetchMock.mockResolvedValueOnce(jsonResponse(raw));

      const result = await switchStorageEngine('sqlite', '');
      expect(result.kind).toBe('acknowledged');
      expect(result.engine).toBe('sqlite');
      expect(result.migration?.totalMigrated).toBe(8);
    });

    it('returns partial when positive errors exist even if migrated equals total', async () => {
      const raw = {
        success: true,
        engine: 'sqlite',
        migration: {
          gcli_credentials: { total: 10, migrated: 10, errors: ['duplicate key ignored'] },
          antigravity_credentials: { total: 5, migrated: 5, errors: [] },
          config: { total: 2, migrated: 2, errors: [] },
        },
      };
      fetchMock.mockResolvedValueOnce(jsonResponse(raw));

      const result = await switchStorageEngine('sqlite', '');
      expect(result.kind).toBe('partial');
      expect(result.migration?.gcliCredentials.errorCount).toBe(1);
    });

    it('returns partial when fewer migrated items than total exist with zero errors', async () => {
      const raw = {
        success: true,
        engine: 'sqlite',
        migration: {
          gcli_credentials: { total: 10, migrated: 9, errors: [] },
          antigravity_credentials: { total: 5, migrated: 5, errors: [] },
          config: { total: 2, migrated: 2, errors: [] },
        },
      };
      fetchMock.mockResolvedValueOnce(jsonResponse(raw));

      const result = await switchStorageEngine('sqlite', '');
      expect(result.kind).toBe('partial');
      expect(result.migration?.gcliCredentials.migrated).toBe(9);
    });

    it('returns unknown when migration object or migration families are missing or incomplete', async () => {
      const cases = [
        { success: true, engine: 'sqlite', migration: {} },
        {
          success: true,
          engine: 'sqlite',
          migration: {
            gcli_credentials: { total: 5, migrated: 5, errors: [] },
          },
        },
        {
          success: true,
          engine: 'sqlite',
          migration: {
            gcli_credentials: { total: 5, migrated: 5, errors: [] },
            antigravity_credentials: { total: 5, migrated: 5, errors: [] },
            config: { total: 5, migrated: 5 }, // missing errors array
          },
        },
        { success: true, engine: 'sqlite', migration: 'invalid-string' },
      ];

      for (const raw of cases) {
        fetchMock.mockResolvedValueOnce(jsonResponse(raw));
        const result = await switchStorageEngine('sqlite', '');
        expect(result.kind).toBe('unknown');
      }
    });

    it('returns unknown independently when an over-migrated family is present (migrated > total)', async () => {
      const raw = {
        success: true,
        engine: 'sqlite',
        migration: {
          gcli_credentials: { total: 10, migrated: 11, errors: [] },
          antigravity_credentials: { total: 5, migrated: 5, errors: [] },
          config: { total: 2, migrated: 2, errors: [] },
        },
      };
      fetchMock.mockResolvedValueOnce(jsonResponse(raw));

      const result = await switchStorageEngine('sqlite', '');
      expect(result.kind).toBe('unknown');
    });

    it('returns unknown independently when present total_migrated contradicts sum of migrated items', async () => {
      const raw = {
        success: true,
        engine: 'mysql',
        migration: {
          gcli_credentials: { total: 10, migrated: 10, errors: [] },
          antigravity_credentials: { total: 5, migrated: 5, errors: [] },
          config: { total: 2, migrated: 2, errors: [] },
          total_migrated: 18, // Sum is 17
        },
      };
      fetchMock.mockResolvedValueOnce(jsonResponse(raw));

      const result = await switchStorageEngine('mysql', 'srv1');
      expect(result.kind).toBe('unknown');
    });

    it('validates zero counters and suppresses raw filename/error/message canaries', async () => {
      const raw = {
        success: true,
        engine: 'sqlite',
        migration: {
          gcli_credentials: {
            total: 0,
            migrated: 0,
            errors: [
              'CANARY_RAW_ERROR_MESSAGE_CREDENTIALS_FAILED_AT_FILE_01',
              'CANARY_SECRET_PATH_LEAK_ETC_PASSWD',
            ],
          },
          antigravity_credentials: { total: 0, migrated: 0, errors: [] },
          config: { total: 0, migrated: 0, errors: [] },
        },
      };
      fetchMock.mockResolvedValueOnce(jsonResponse(raw));

      const result = await switchStorageEngine('sqlite', '');
      expect(result.kind).toBe('partial');
      expect(result.migration?.gcliCredentials).toEqual({
        total: 0,
        migrated: 0,
        errorCount: 2,
      });

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('CANARY_RAW_ERROR_MESSAGE_CREDENTIALS_FAILED_AT_FILE_01');
      expect(serialized).not.toContain('CANARY_SECRET_PATH_LEAK_ETC_PASSWD');
    });

    it('records malformed error-member handling as boundary without asserting invented rejection', async () => {
      const raw = {
        success: true,
        engine: 'sqlite',
        migration: {
          gcli_credentials: {
            total: 5,
            migrated: 4,
            errors: [123, null, { canary_object: true }, true],
          },
          antigravity_credentials: { total: 3, migrated: 3, errors: [] },
          config: { total: 1, migrated: 1, errors: [] },
        },
      };
      fetchMock.mockResolvedValueOnce(jsonResponse(raw));

      const result = await switchStorageEngine('sqlite', '');
      // parseMigrationFamily counts rawFam.errors.length without inspecting member types
      expect(result.kind).toBe('partial');
      expect(result.migration?.gcliCredentials.errorCount).toBe(4);
    });

    it('returns rejected when semantic false or error is returned in top envelope', async () => {
      const rawCases = [
        { success: false, error: 'CANARY_STORAGE_SWITCH_FORBIDDEN' },
        { success: false },
        { error: 'Engine switch rejected by target database lock' },
      ];

      for (const raw of rawCases) {
        fetchMock.mockResolvedValueOnce(jsonResponse(raw));
        const result = await switchStorageEngine('sqlite', '');
        expect(result.kind).toBe('rejected');
      }
    });

    it('throws safe SemanticError when top envelope is not an object', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(null));
      await expect(switchStorageEngine('sqlite', '')).rejects.toThrow('存储切换响应无效');

      fetchMock.mockResolvedValueOnce(jsonResponse('primitive response'));
      await expect(switchStorageEngine('sqlite', '')).rejects.toThrow('存储切换响应无效');
    });
  });

  describe('system status projection', () => {
    it('preserves genuine Redis/SMART false, zero, fractional memory/retry interval and explicit blockedReason:null', async () => {
      const raw = {
        success: true,
        redis: {
          enabled: false,
          server_name: '',
          memory_used_mb: 28.5,
          total_keys: 0,
          pools: {
            geminicli_avail: 0,
            geminicli_preview: 0,
            antigravity_avail: 0,
          },
        },
        smart_429: {
          enabled: false,
          requested_enabled: false,
          max_attempts: 0,
          retry_base_interval: 0.125,
          policy_epoch: 0,
          single_instance_only: false,
          blocked_reason: null,
        },
      };
      fetchMock.mockResolvedValueOnce(jsonResponse(raw));

      const status = await getSystemStatus();
      expect(status.redis.enabled).toBe(false);
      expect(status.redis.serverName).toBe('');
      expect(status.redis.memoryUsedMb).toBe(28.5);
      expect(status.redis.totalKeys).toBe(0);
      expect(status.redis.pools).toEqual({
        geminicliAvail: 0,
        geminicliPreview: 0,
        antigravityAvail: 0,
      });

      expect(status.smart429.enabled).toBe(false);
      expect(status.smart429.requestedEnabled).toBe(false);
      expect(status.smart429.maxAttempts).toBe(0);
      expect(status.smart429.retryBaseInterval).toBe(0.125);
      expect(status.smart429.policyEpoch).toBe(0);
      expect(status.smart429.singleInstanceOnly).toBe(false);
      expect(status.smart429.blockedReason).toBeNull();
    });

    it('keeps missing status values unknown', async () => {
      const raw = {
        success: true,
        redis: {},
        smart_429: {},
      };
      fetchMock.mockResolvedValueOnce(jsonResponse(raw));

      const status = await getSystemStatus();
      expect(status.redis.enabled).toBeUndefined();
      expect(status.redis.serverName).toBeUndefined();
      expect(status.redis.memoryUsedMb).toBeUndefined();
      expect(status.redis.pools).toBeUndefined();
      expect(status.redis.totalKeys).toBeUndefined();
      expect(status.redis.diagnostic).toBeUndefined();

      expect(status.smart429.enabled).toBeUndefined();
      expect(status.smart429.requestedEnabled).toBeUndefined();
      expect(status.smart429.maxAttempts).toBeUndefined();
      expect(status.smart429.retryBaseInterval).toBeUndefined();
      expect(status.smart429.policyEpoch).toBeUndefined();
      expect(status.smart429.singleInstanceOnly).toBeUndefined();
      expect(status.smart429.blockedReason).toBeUndefined();
    });

    it('ensures count invalidity does not erase valid sibling pool counts', async () => {
      const raw = {
        success: true,
        redis: {
          pools: {
            geminicli_avail: -1,
            geminicli_preview: 'invalid-string',
            antigravity_avail: 15,
          },
        },
        smart_429: {
          max_attempts: -5,
          policy_epoch: 3,
        },
      };
      fetchMock.mockResolvedValueOnce(jsonResponse(raw));

      const status = await getSystemStatus();
      expect(status.redis.pools?.geminicliAvail).toBeUndefined();
      expect(status.redis.pools?.geminicliPreview).toBeUndefined();
      expect(status.redis.pools?.antigravityAvail).toBe(15);
      expect(status.smart429.maxAttempts).toBeUndefined();
      expect(status.smart429.policyEpoch).toBe(3);
    });

    it('survives known SMART blocked reason enums', async () => {
      const knownReasons = [
        'multi_instance_unsupported',
        'health_storage_capability_missing',
        'health_storage_unavailable',
      ] as const;

      for (const reason of knownReasons) {
        fetchMock.mockResolvedValueOnce(
          jsonResponse({
            success: true,
            redis: {},
            smart_429: { blocked_reason: reason },
          })
        );
        const status = await getSystemStatus();
        expect(status.smart429.blockedReason).toBe(reason);
      }
    });

    it('collapses health_storage_unavailable:<canary> to safe base and maps arbitrary strings to unknown', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          redis: {},
          smart_429: {
            blocked_reason: 'health_storage_unavailable:CANARY_DATABASE_CONNECTION_LEAK_999',
          },
        })
      );
      const status1 = await getSystemStatus();
      expect(status1.smart429.blockedReason).toBe('health_storage_unavailable');

      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          redis: {},
          smart_429: {
            blocked_reason: 'arbitrary_unapproved_reason_string_canary',
          },
        })
      );
      const status2 = await getSystemStatus();
      expect(status2.smart429.blockedReason).toBe('unknown');
    });

    it('maps exact Redis error or fixed note evidence to redis_unavailable, arbitrary note to unknown, and does not fabricate diagnostics', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          redis: { error: 'CANARY_RAW_REDIS_SOCKET_TIMEOUT' },
          smart_429: {},
        })
      );
      const statusError = await getSystemStatus();
      expect(statusError.redis.diagnostic).toBe('redis_unavailable');

      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          redis: { note: 'REDIS_URL 未设置或连接失败' },
          smart_429: {},
        })
      );
      const statusFixedNote = await getSystemStatus();
      expect(statusFixedNote.redis.diagnostic).toBe('redis_unavailable');

      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          redis: { note: 'CANARY_CUSTOM_INTERNAL_DIAGNOSTIC_NOTE' },
          smart_429: {},
        })
      );
      const statusArbitraryNote = await getSystemStatus();
      expect(statusArbitraryNote.redis.diagnostic).toBe('unknown');

      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          redis: { note: '', error: null },
          smart_429: {},
        })
      );
      const statusEmpty = await getSystemStatus();
      expect(statusEmpty.redis.diagnostic).toBeUndefined();
    });

    it('excludes raw note/error/status extra fields from returned data', async () => {
      const raw = {
        success: true,
        redis: {
          enabled: true,
          note: 'REDIS_URL 未设置或连接失败',
          error: 'CANARY_RAW_ERROR_MESSAGE',
          internal_redis_secret: 'CANARY_SECRET_REDIS_PW',
        },
        smart_429: {
          enabled: true,
          internal_smart_meta: 'CANARY_SMART_LEAK',
        },
      };
      fetchMock.mockResolvedValueOnce(jsonResponse(raw));

      const status = await getSystemStatus();
      expect(status.redis).not.toHaveProperty('note');
      expect(status.redis).not.toHaveProperty('error');
      expect(status.redis).not.toHaveProperty('internal_redis_secret');
      expect(status.smart429).not.toHaveProperty('internal_smart_meta');

      const serialized = JSON.stringify(status);
      expect(serialized).not.toContain('CANARY_RAW_ERROR_MESSAGE');
      expect(serialized).not.toContain('CANARY_SECRET_REDIS_PW');
      expect(serialized).not.toContain('CANARY_SMART_LEAK');
    });

    it('throws safe SemanticError on invalid top or nested envelopes without leaking canaries', async () => {
      const systemCanary = 'CANARY_RAW_SYSTEM_STATUS_EXCEPTION';
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ success: false, error: systemCanary })
      );

      let caught: unknown;
      try {
        await getSystemStatus();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(SemanticError);
      expect((caught as Error).message).toBe('系统状态响应无效');
      expect((caught as Error).message).not.toContain(systemCanary);

      fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, redis: null, smart_429: {} }));
      await expect(getSystemStatus()).rejects.toThrow('系统状态响应无效');

      fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, redis: {}, smart_429: null }));
      await expect(getSystemStatus()).rejects.toThrow('系统状态响应无效');
    });
  });

  describe('HTTP failures and writeFailure agreement', () => {
    it('returns rejected for real HTTP 400 switch and agrees with writeFailure', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ detail: 'Invalid target storage engine configuration' }, 400)
      );

      const result = await switchStorageEngine('mysql', 'invalid-srv');
      expect(result.kind).toBe('rejected');

      const testError = new ApiError(400, { detail: 'Bad request' });
      expect(writeFailure(testError)).toBe('rejected');
    });

    it('returns unknown for real HTTP 500 switch and agrees with writeFailure', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ detail: 'CANARY_INTERNAL_DATABASE_DEADLOCK' }, 500)
      );

      const result = await switchStorageEngine('mysql', 'srv1');
      expect(result.kind).toBe('unknown');

      const testError = new ApiError(500, { detail: 'Internal error' });
      expect(writeFailure(testError)).toBe('unknown');
    });

    it('returns unknown for network failure on switch and agrees with writeFailure', async () => {
      fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

      const result = await switchStorageEngine('sqlite', '');
      expect(result.kind).toBe('unknown');

      expect(writeFailure(new TypeError('Failed to fetch'))).toBe('unknown');
      expect(writeFailure(new Error('Arbitrary failure'))).toBe('unknown');
    });

    it('retains ApiError provenance on read adapters and agrees with writeFailure', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ detail: 'storage read unavailable' }, 500)
      );

      let caught: unknown;
      try {
        await getStorageState();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ApiError);
      if (caught instanceof ApiError) {
        expect(caught.status).toBe(500);
        expect(caught.payload).toEqual({ detail: 'storage read unavailable' });
        expect(writeFailure(caught)).toBe('unknown');
      }

      fetchMock.mockResolvedValueOnce(
        jsonResponse({ detail: 'preview unauthorized' }, 401)
      );

      let caughtPreview: unknown;
      try {
        await previewStorageMigration();
      } catch (err) {
        caughtPreview = err;
      }
      expect(caughtPreview).toBeInstanceOf(ApiError);
      if (caughtPreview instanceof ApiError) {
        expect(caughtPreview.status).toBe(401);
        expect(writeFailure(caughtPreview)).toBe('rejected');
      }

      fetchMock.mockRejectedValueOnce(new TypeError('Network disconnected'));
      let caughtSystem: unknown;
      try {
        await getSystemStatus();
      } catch (err) {
        caughtSystem = err;
      }
      expect(caughtSystem).toBeInstanceOf(TypeError);
      expect(writeFailure(caughtSystem)).toBe('unknown');
    });
  });

  describe('local fixture mode fallback (DEV + VITE_UI_FIXTURES=true)', () => {
    beforeEach(() => {
      vi.stubEnv('VITE_UI_FIXTURES', 'true');
    });

    it('rejects unsupported read operations with ApiError(501) and zero fetch calls', async () => {
      let errState: unknown;
      try {
        await getStorageState();
      } catch (e) {
        errState = e;
      }
      expect(errState).toBeInstanceOf(ApiError);
      expect((errState as ApiError).status).toBe(501);

      let errPreview: unknown;
      try {
        await previewStorageMigration();
      } catch (e) {
        errPreview = e;
      }
      expect(errPreview).toBeInstanceOf(ApiError);
      expect((errPreview as ApiError).status).toBe(501);

      let errSystem: unknown;
      try {
        await getSystemStatus();
      } catch (e) {
        errSystem = e;
      }
      expect(errSystem).toBeInstanceOf(ApiError);
      expect((errSystem as ApiError).status).toBe(501);

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns unknown for switchStorageEngine under existing writeFailure semantics and zero fetch calls', async () => {
      const result = await switchStorageEngine('sqlite', '');
      expect(result).toEqual({ kind: 'unknown' });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
