import { describe, expect, it } from 'vitest';
import { endpointPresetDraft, keepaliveServiceUrl } from './tools';
import { buildPatch, fields, toDraft } from './types';
import type { Config, Draft, Snapshot } from './types';

const EXPECTED_MIRROR_PRESET: Record<string, string> = {
  code_assist_endpoint: 'https://gcli-api.sukaka.top/cloudcode-pa',
  oauth_proxy_url: 'https://gcli-api.sukaka.top/oauth2',
  googleapis_proxy_url: 'https://gcli-api.sukaka.top/googleapis',
  resource_manager_api_url: 'https://gcli-api.sukaka.top/cloudresourcemanager',
  service_usage_api_url: 'https://gcli-api.sukaka.top/serviceusage',
  antigravity_api_url: 'https://gcli-api.sukaka.top/daily-cloudcode-pa',
};

const EXPECTED_OFFICIAL_PRESET: Record<string, string> = {
  code_assist_endpoint: 'https://cloudcode-pa.googleapis.com',
  oauth_proxy_url: 'https://oauth2.googleapis.com',
  googleapis_proxy_url: 'https://www.googleapis.com',
  resource_manager_api_url: 'https://cloudresourcemanager.googleapis.com',
  service_usage_api_url: 'https://serviceusage.googleapis.com',
  antigravity_api_url: 'https://daily-cloudcode-pa.googleapis.com',
};

const PRESET_KEYS = [
  'code_assist_endpoint',
  'oauth_proxy_url',
  'googleapis_proxy_url',
  'resource_manager_api_url',
  'service_usage_api_url',
  'antigravity_api_url',
] as const;

describe('endpointPresetDraft', () => {
  it('returns exact literal mirror preset values for all six keys', () => {
    const syntheticSnapshot: Snapshot = { config: {}, envLocked: [], capabilities: [] };
    const draft = endpointPresetDraft('mirror', syntheticSnapshot);
    expect(draft).toEqual(EXPECTED_MIRROR_PRESET);
    expect(Object.keys(draft).sort()).toEqual([...PRESET_KEYS].sort());
  });

  it('returns exact literal official preset values for all six keys', () => {
    const syntheticSnapshot: Snapshot = { config: {}, envLocked: [], capabilities: [] };
    const draft = endpointPresetDraft('official', syntheticSnapshot);
    expect(draft).toEqual(EXPECTED_OFFICIAL_PRESET);
    expect(Object.keys(draft).sort()).toEqual([...PRESET_KEYS].sort());
  });

  it('asserts every preset key exists in fields and arbitrary config keys are excluded', () => {
    for (const key of PRESET_KEYS) {
      const field = fields.find(f => f.key === key);
      expect(field).toBeDefined();
      expect(field?.section).toBe('网络');
    }

    const syntheticSnapshot: Snapshot = {
      config: { arbitrary_unrecognized_key: 'https://example.invalid' },
      envLocked: [],
      capabilities: [],
    };
    const mirrorDraft = endpointPresetDraft('mirror', syntheticSnapshot);
    expect(mirrorDraft).toEqual(EXPECTED_MIRROR_PRESET);
    expect('arbitrary_unrecognized_key' in mirrorDraft).toBe(false);

    // Unsupported preset kind returns empty draft
    expect(endpointPresetDraft('unknown' as 'mirror', syntheticSnapshot)).toEqual({});
  });

  it('omits locked endpoints individually and collectively', () => {
    const baseSnapshot: Snapshot = { config: {}, envLocked: [], capabilities: [] };

    // Individually omitted
    for (const key of PRESET_KEYS) {
      const lockedOne: Snapshot = { ...baseSnapshot, envLocked: [key] };
      const mirrorDraft = endpointPresetDraft('mirror', lockedOne);
      expect(mirrorDraft[key]).toBeUndefined();
      expect(Object.keys(mirrorDraft)).toHaveLength(PRESET_KEYS.length - 1);
      const expectedMirrorMinusOne = { ...EXPECTED_MIRROR_PRESET };
      delete expectedMirrorMinusOne[key];
      expect(mirrorDraft).toEqual(expectedMirrorMinusOne);

      const officialDraft = endpointPresetDraft('official', lockedOne);
      expect(officialDraft[key]).toBeUndefined();
      expect(Object.keys(officialDraft)).toHaveLength(PRESET_KEYS.length - 1);
      const expectedOfficialMinusOne = { ...EXPECTED_OFFICIAL_PRESET };
      delete expectedOfficialMinusOne[key];
      expect(officialDraft).toEqual(expectedOfficialMinusOne);
    }

    // Collectively omitted
    const lockedAll: Snapshot = { ...baseSnapshot, envLocked: [...PRESET_KEYS] };
    expect(endpointPresetDraft('mirror', lockedAll)).toEqual({});
    expect(endpointPresetDraft('official', lockedAll)).toEqual({});
  });

  it('returns fresh draft objects without mutating snapshot, even when inputs are frozen', () => {
    const snapshot: Snapshot = {
      config: { host: '127.0.0.1', port: 7860 },
      envLocked: ['proxy'],
      capabilities: ['some_capability'],
    };

    const d1 = endpointPresetDraft('mirror', snapshot);
    const d2 = endpointPresetDraft('mirror', snapshot);
    expect(d1).toEqual(d2);
    expect(d1).not.toBe(d2);

    d1.code_assist_endpoint = 'https://mutated.example.invalid';
    expect(d2.code_assist_endpoint).toBe(EXPECTED_MIRROR_PRESET.code_assist_endpoint);
    expect(snapshot.config.code_assist_endpoint).toBeUndefined();

    // Calling helper alone does not save or mutate snapshot
    expect(snapshot.config).toEqual({ host: '127.0.0.1', port: 7860 });
    expect(snapshot.envLocked).toEqual(['proxy']);
    expect(snapshot.capabilities).toEqual(['some_capability']);

    // Frozen snapshot input
    const frozenSnapshot: Snapshot = {
      config: Object.freeze({ host: 'localhost' }) as Config,
      envLocked: Object.freeze(['proxy']) as unknown as string[],
      capabilities: Object.freeze(['cap1']) as unknown as string[],
    };
    expect(() => endpointPresetDraft('official', frozenSnapshot)).not.toThrow();
    expect(frozenSnapshot.config).toEqual({ host: 'localhost' });
    expect(frozenSnapshot.envLocked).toEqual(['proxy']);
    expect(frozenSnapshot.capabilities).toEqual(['cap1']);
  });

  it('gates by catalogue and editable, independent of snapshot.config key presence or endpoint capabilities', () => {
    // Empty config - preset keys are NOT in config, but helper still returns all six
    const emptyConfigSnapshot: Snapshot = { config: {}, envLocked: [], capabilities: [] };
    const draft = endpointPresetDraft('mirror', emptyConfigSnapshot);
    expect(draft).toEqual(EXPECTED_MIRROR_PRESET);

    // Capabilities list is completely empty - endpoints do not require capabilities
    const noCapSnapshot: Snapshot = { config: {}, envLocked: [], capabilities: [] };
    expect(endpointPresetDraft('official', noCapSnapshot)).toEqual(EXPECTED_OFFICIAL_PRESET);
  });

  it('merges preset into toDraft(snapshot.config), preserving unrelated draft values, and builds patch with only changed editable endpoints', () => {
    const baseline: Config = {
      host: '127.0.0.1',
      port: 7860,
      debug_mode: true,
      // code_assist_endpoint is different from mirror preset
      code_assist_endpoint: 'https://cloudcode-pa.googleapis.com',
      // oauth_proxy_url is already matching the mirror preset
      oauth_proxy_url: 'https://gcli-api.sukaka.top/oauth2',
      // googleapis_proxy_url is in baseline, but will be locked in snapshot
      googleapis_proxy_url: 'https://www.googleapis.com',
    };

    const snapshot: Snapshot = {
      config: baseline,
      envLocked: ['googleapis_proxy_url'],
      capabilities: [],
    };

    const baseDraft = toDraft(snapshot.config);
    expect(baseDraft.host).toBe('127.0.0.1');
    expect(baseDraft.port).toBe('7860');
    expect(baseDraft.debug_mode).toBe(true);
    expect(baseDraft.code_assist_endpoint).toBe('https://cloudcode-pa.googleapis.com');
    expect(baseDraft.oauth_proxy_url).toBe('https://gcli-api.sukaka.top/oauth2');
    expect(baseDraft.googleapis_proxy_url).toBe('https://www.googleapis.com');

    // Get preset draft for mirror
    const presetDraft = endpointPresetDraft('mirror', snapshot);
    // googleapis_proxy_url is locked, so not in preset draft
    expect(presetDraft.googleapis_proxy_url).toBeUndefined();

    // Merge preset into draft
    const mergedDraft: Draft = { ...baseDraft, ...presetDraft };

    // Unrelated values preserved
    expect(mergedDraft.host).toBe('127.0.0.1');
    expect(mergedDraft.port).toBe('7860');
    expect(mergedDraft.debug_mode).toBe(true);

    // Build patch from merged draft
    const patch = buildPatch(mergedDraft, baseline, snapshot);

    // Only changed editable endpoint values form the patch:
    // - code_assist_endpoint: changed (was cloudcode-pa.googleapis.com -> gcli-api.sukaka.top/cloudcode-pa) -> IN PATCH
    // - oauth_proxy_url: already matching baseline -> ABSENT
    // - googleapis_proxy_url: locked -> ABSENT
    // - resource_manager_api_url: was '' -> gcli-api.sukaka.top/cloudresourcemanager -> IN PATCH
    // - service_usage_api_url: was '' -> gcli-api.sukaka.top/serviceusage -> IN PATCH
    // - antigravity_api_url: was '' -> gcli-api.sukaka.top/daily-cloudcode-pa -> IN PATCH
    // - host, port, debug_mode: unchanged -> ABSENT
    expect(patch).toEqual({
      code_assist_endpoint: 'https://gcli-api.sukaka.top/cloudcode-pa',
      resource_manager_api_url: 'https://gcli-api.sukaka.top/cloudresourcemanager',
      service_usage_api_url: 'https://gcli-api.sukaka.top/serviceusage',
      antigravity_api_url: 'https://gcli-api.sukaka.top/daily-cloudcode-pa',
    });

    // Calling endpointPresetDraft did not mutate baseline or snapshot
    expect(snapshot.config.code_assist_endpoint).toBe('https://cloudcode-pa.googleapis.com');
  });
});

describe('keepaliveServiceUrl', () => {
  it('normalizes absolute HTTP and HTTPS root URLs, retaining root path and dropping query/hash', () => {
    expect(keepaliveServiceUrl('http://example.invalid')).toBe('http://example.invalid/');
    expect(keepaliveServiceUrl('http://example.invalid/')).toBe('http://example.invalid/');
    expect(keepaliveServiceUrl('https://example.invalid')).toBe('https://example.invalid/');
    expect(keepaliveServiceUrl('https://example.invalid/')).toBe('https://example.invalid/');

    // Dropping query and hash on root
    expect(keepaliveServiceUrl('http://example.invalid?foo=bar')).toBe('http://example.invalid/');
    expect(keepaliveServiceUrl('https://example.invalid#section')).toBe('https://example.invalid/');
    expect(keepaliveServiceUrl('https://example.invalid/?key=val#hash')).toBe('https://example.invalid/');
  });

  it('retains complete nested configured pathname prefixes while dropping query and hash', () => {
    expect(keepaliveServiceUrl('https://example.invalid/prefix')).toBe('https://example.invalid/prefix');
    expect(keepaliveServiceUrl('https://example.invalid/prefix/')).toBe('https://example.invalid/prefix/');
    expect(keepaliveServiceUrl('http://example.invalid/api/v1/keepalive')).toBe('http://example.invalid/api/v1/keepalive');
    expect(keepaliveServiceUrl('https://example.invalid/nested/path/')).toBe('https://example.invalid/nested/path/');

    // Dropping query and hash with nested paths
    expect(keepaliveServiceUrl('https://example.invalid/nested/path?session=123&mode=active')).toBe('https://example.invalid/nested/path');
    expect(keepaliveServiceUrl('https://example.invalid/nested/path/#frag')).toBe('https://example.invalid/nested/path/');
    expect(keepaliveServiceUrl('http://example.invalid/api/v1?token=abc#anchor')).toBe('http://example.invalid/api/v1');
  });

  it('throws for blank or whitespace-only inputs', () => {
    expect(() => keepaliveServiceUrl('')).toThrow('服务地址不能为空');
    expect(() => keepaliveServiceUrl('   ')).toThrow('服务地址不能为空');
    expect(() => keepaliveServiceUrl('\t\n ')).toThrow('服务地址不能为空');
  });

  it('throws for malformed URLs', () => {
    expect(() => keepaliveServiceUrl('not a url')).toThrow('服务地址格式无效');
    expect(() => keepaliveServiceUrl('http://')).toThrow('服务地址格式无效');
    expect(() => keepaliveServiceUrl('://example.invalid')).toThrow('服务地址格式无效');
  });

  it('throws for relative URLs', () => {
    expect(() => keepaliveServiceUrl('/api/v1')).toThrow('服务地址格式无效');
    expect(() => keepaliveServiceUrl('service/keepalive')).toThrow('服务地址格式无效');
    expect(() => keepaliveServiceUrl('./relative')).toThrow('服务地址格式无效');
    expect(() => keepaliveServiceUrl('../parent/path')).toThrow('服务地址格式无效');
  });

  it('throws for non-HTTP(S) protocols', () => {
    expect(() => keepaliveServiceUrl('ftp://example.invalid')).toThrow('服务地址协议必须为 HTTP 或 HTTPS');
    expect(() => keepaliveServiceUrl('ws://example.invalid')).toThrow('服务地址协议必须为 HTTP 或 HTTPS');
    expect(() => keepaliveServiceUrl('wss://example.invalid')).toThrow('服务地址协议必须为 HTTP 或 HTTPS');
    expect(() => keepaliveServiceUrl('file:///path/to/service')).toThrow('服务地址协议必须为 HTTP 或 HTTPS');
    expect(() => keepaliveServiceUrl('javascript:alert(1)')).toThrow('服务地址协议必须为 HTTP 或 HTTPS');
  });

  it('throws for URLs containing backslashes', () => {
    expect(() => keepaliveServiceUrl('https://example.invalid\\path')).toThrow('服务地址格式无效');
    expect(() => keepaliveServiceUrl('http:\\\\example.invalid')).toThrow('服务地址格式无效');
    expect(() => keepaliveServiceUrl('https://example.invalid/foo\\bar')).toThrow('服务地址格式无效');
    expect(() => keepaliveServiceUrl('\\\\example.invalid\\path')).toThrow('服务地址格式无效');
  });

  it('throws for URLs containing userinfo, including username-only and username/password', () => {
    // username-only
    expect(() => keepaliveServiceUrl('http://user@example.invalid')).toThrow('服务地址不能包含认证信息');
    expect(() => keepaliveServiceUrl('https://admin@example.invalid/prefix')).toThrow('服务地址不能包含认证信息');
    expect(() => keepaliveServiceUrl('http://user:@example.invalid')).toThrow('服务地址不能包含认证信息');

    // username and password
    expect(() => keepaliveServiceUrl('http://user:password@example.invalid')).toThrow('服务地址不能包含认证信息');
    expect(() => keepaliveServiceUrl('https://admin:secret123@example.invalid/api/v1')).toThrow('服务地址不能包含认证信息');
    expect(() => keepaliveServiceUrl('https://token:secret@example.invalid:8443/nested')).toThrow('服务地址不能包含认证信息');
  });
});
