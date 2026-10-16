import { ApiError, requestJson } from '@/api/client';
import { readSafeConfig } from '@/api/config';
import { getSessionSnapshot, getSessionValidationSnapshot } from '@/auth/session';
import { fields, nonSensitive, same, secretKeys } from './types';
import type { Config, EmbedPolicySource, EmbedPolicyStatus, Snapshot, TokenStatus } from './types';
import type {
  RedisPools,
  RedisStatus,
  Smart429Status,
  StorageCounts,
  StorageMigration,
  StorageMigrationFamily,
  StoragePreview,
  StorageServer,
  StorageState,
  StorageSwitchResult,
  SystemStatus,
} from './tools';


const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) && v.every(i => typeof i === 'string') ? v : []);

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal) return;
  if (typeof signal.throwIfAborted === 'function') {
    signal.throwIfAborted();
  } else if (signal.aborted) {
    throw signal.reason ?? (typeof DOMException !== 'undefined' ? new DOMException('The operation was aborted', 'AbortError') : new Error('The operation was aborted'));
  }
}

export class SemanticError extends Error {}

export function parseEmbedPolicy(raw: unknown): EmbedPolicyStatus | undefined {
  if (!object(raw)) return undefined;
  const hasSecurity = Object.prototype.hasOwnProperty.call(raw, 'security');
  const inSecurity = 'security' in raw;
  if (!hasSecurity) {
    if (inSecurity) {
      const inheritedSec: unknown = (raw as Record<string, unknown>).security;
      if (object(inheritedSec) && 'embed_policy' in inheritedSec) {
        return { source: 'unknown', valid: 'unknown', locked: 'unknown' };
      }
    }
    return undefined;
  }
  const security = (raw as Record<string, unknown>).security;
  if (!object(security)) return undefined;
  const hasEp = Object.prototype.hasOwnProperty.call(security, 'embed_policy');
  const inEp = 'embed_policy' in security;
  if (!hasEp) {
    if (inEp) {
      return { source: 'unknown', valid: 'unknown', locked: 'unknown' };
    }
    return undefined;
  }
  const ep = (security as Record<string, unknown>).embed_policy;
  if (!object(ep)) {
    return { source: 'unknown', valid: 'unknown', locked: 'unknown' };
  }
  const hasOwnField = (k: string) => Object.prototype.hasOwnProperty.call(ep, k);

  const rawSource = hasOwnField('source') ? (ep as Record<string, unknown>).source : undefined;
  const source: EmbedPolicySource =
    rawSource === 'environment' || rawSource === 'storage' || rawSource === 'default'
      ? rawSource
      : 'unknown';

  const rawValid = hasOwnField('valid') ? (ep as Record<string, unknown>).valid : undefined;
  const valid: boolean | 'unknown' = typeof rawValid === 'boolean' ? rawValid : 'unknown';

  const rawLocked = hasOwnField('locked') ? (ep as Record<string, unknown>).locked : undefined;
  const locked: boolean | 'unknown' = typeof rawLocked === 'boolean' ? rawLocked : 'unknown';

  return { source, valid, locked };
}

export function readSnapshot(raw: unknown): Snapshot {
  if (!object(raw) || !object(raw.config) || raw.success === false || raw.error || !Array.isArray(raw.env_locked) || !raw.env_locked.every(key => typeof key === 'string')) {
    throw new SemanticError('配置响应无效');
  }
  const config: Config = {};
  for (const f of fields) {
    if (f.kind === 'secret') continue;
    const v = raw.config[f.key];
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || (Array.isArray(v) && v.every(i => typeof i === 'number' || typeof i === 'string'))) {
      config[f.key] = v as Config[string];
    }
  }
  const security = object(raw.security) ? raw.security : {};
  const value = security.node_management_token;
  const token = object(value) && typeof value.configured === 'boolean' && typeof value.locked === 'boolean'
    ? {
        configured: value.configured,
        locked: value.locked,
        ...(typeof value.source === 'string' ? { source: value.source } : {}),
      }
    : undefined;
  const embedPolicy = parseEmbedPolicy(raw);
  return {
    config,
    envLocked: strings(raw.env_locked),
    capabilities: strings(raw.capabilities),
    token,
    ...(embedPolicy !== undefined ? { embedPolicy } : {}),
  };
}

export const fixtureMode = import.meta.env.DEV && import.meta.env.VITE_UI_FIXTURES === 'true';

export async function getConfig(signal?: AbortSignal): Promise<Snapshot> {
  if (fixtureMode || (import.meta.env.DEV && import.meta.env.VITE_UI_FIXTURES === 'true')) {
    throwIfAborted(signal);
    const { snapshot } = await import('./fixtures');
    throwIfAborted(signal);
    const snap = snapshot();
    const config: Config = {};
    for (const [key, value] of Object.entries(snap.config)) {
      if (!secretKeys.includes(key)) {
        config[key] = value;
      }
    }
    return {
      config,
      envLocked: Array.isArray(snap.envLocked) ? [...snap.envLocked] : [],
      capabilities: Array.isArray(snap.capabilities) ? [...snap.capabilities] : [],
      token: snap.token
        ? {
            configured: snap.token.configured,
            locked: snap.token.locked,
            ...(typeof snap.token.source === 'string' ? { source: snap.token.source } : {}),
          }
        : undefined,
      embedPolicy: snap.embedPolicy
        ? {
            source:
              snap.embedPolicy.source === 'environment' ||
              snap.embedPolicy.source === 'storage' ||
              snap.embedPolicy.source === 'default'
                ? snap.embedPolicy.source
                : 'unknown',
            valid: typeof snap.embedPolicy.valid === 'boolean' ? snap.embedPolicy.valid : 'unknown',
            locked: typeof snap.embedPolicy.locked === 'boolean' ? snap.embedPolicy.locked : 'unknown',
          }
        : undefined,
    };
  }
  return readSnapshot(await readSafeConfig(signal));
}
export type SaveResult={kind:'acknowledged'|'partial'|'unknown'|'rejected'; acknowledged:string[]};
export function readSave(raw:unknown,sent:Config):SaveResult {
  if(!object(raw))return {kind:'unknown',acknowledged:[]};
  if(raw.success===false||raw.error)return {kind:'rejected',acknowledged:[]};
  const saved=object(raw.saved_config)?raw.saved_config:{};
  const keys=Object.keys(sent).filter(key=>same(saved[key],sent[key]));
  return {kind:keys.length===Object.keys(sent).length?'acknowledged':keys.length?'partial':'unknown',acknowledged:keys};
}
export async function saveConfig(patch:Config) {if(fixtureMode)return readSave((await import('./fixtures')).save(patch),patch);return readSave(await requestJson('config/save',{method:'POST',body:{config:patch}}),patch);}
export function writeFailure(error:unknown):'rejected'|'unknown' {
  return error instanceof ApiError && error.status>=400 && error.status<500 ? 'rejected':'unknown';
}
export async function readEngine(signal?:AbortSignal):Promise<string> {
  if(fixtureMode)return 'synthetic (仅预览)';
  const raw=await requestJson<unknown>('config/storage-engine',{signal});
  if(!object(raw)||typeof raw.current_engine!=='string')throw new SemanticError('存储状态未知');
  return raw.current_engine;
}
export async function managementToken(action:'PUT'|'DELETE',token?:string):Promise<TokenStatus> {
  if(fixtureMode)return (await import('./fixtures')).setToken(action);
  const raw=await requestJson<unknown>('config/management-token',{method:action,...(action==='PUT'?{body:{token}}:{})});
  if(!object(raw)||raw.success===false||raw.error||!object(raw.status)||typeof raw.status.configured!=='boolean'||typeof raw.status.locked!=='boolean')throw new SemanticError('操作结果需重新读取确认');
  return raw.status as TokenStatus;
}
export const safePatch=nonSensitive;

function toCounter(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined;
}

function toNonNegativeNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function parseMigrationFamily(rawFam: unknown): { family: StorageMigrationFamily; complete: boolean } {
  if (!object(rawFam)) {
    return { family: {}, complete: false };
  }
  const family: StorageMigrationFamily = {};
  const total = toCounter(rawFam.total);
  if (total !== undefined) family.total = total;
  const migrated = toCounter(rawFam.migrated);
  if (migrated !== undefined) family.migrated = migrated;
  if (Array.isArray(rawFam.errors)) {
    family.errorCount = rawFam.errors.length;
  }
  const complete = total !== undefined && migrated !== undefined && family.errorCount !== undefined;
  return { family, complete };
}

function readStorageSwitchResult(raw: unknown, targetEngine: 'sqlite' | 'mysql'): StorageSwitchResult {
  if (!object(raw)) {
    throw new SemanticError('存储切换响应无效');
  }
  if (raw.success === false || raw.error) {
    return { kind: 'rejected' };
  }
  const engine = raw.engine === 'sqlite' || raw.engine === 'mysql' ? raw.engine : undefined;

  if (raw.migration === null) {
    const kind = engine === targetEngine ? 'acknowledged' : 'unknown';
    return {
      kind,
      ...(engine !== undefined ? { engine } : {}),
      migration: null,
    };
  }

  if (!object(raw.migration)) {
    return {
      kind: 'unknown',
      ...(engine !== undefined ? { engine } : {}),
    };
  }

  const rawMigration = raw.migration;
  const gcliParsed = parseMigrationFamily(rawMigration.gcli_credentials);
  const antiParsed = parseMigrationFamily(rawMigration.antigravity_credentials);
  const cfgParsed = parseMigrationFamily(rawMigration.config);
  const totalMigrated = toCounter(rawMigration.total_migrated);

  const migration: StorageMigration = {
    gcliCredentials: gcliParsed.family,
    antigravityCredentials: antiParsed.family,
    config: cfgParsed.family,
    ...(totalMigrated !== undefined ? { totalMigrated } : {}),
  };

  if (engine !== targetEngine) {
    return { kind: 'unknown', ...(engine !== undefined ? { engine } : {}), migration };
  }

  const allComplete = gcliParsed.complete && antiParsed.complete && cfgParsed.complete;
  if (!allComplete) {
    return { kind: 'unknown', engine, migration };
  }

  const gcli = gcliParsed.family;
  const anti = antiParsed.family;
  const cfg = cfgParsed.family;

  const gcliTotal = gcli.total!;
  const gcliMigrated = gcli.migrated!;
  const gcliErrors = gcli.errorCount!;

  const antiTotal = anti.total!;
  const antiMigrated = anti.migrated!;
  const antiErrors = anti.errorCount!;

  const cfgTotal = cfg.total!;
  const cfgMigrated = cfg.migrated!;
  const cfgErrors = cfg.errorCount!;

  const sumTotal = gcliTotal + antiTotal + cfgTotal;
  const sumMigrated = gcliMigrated + antiMigrated + cfgMigrated;
  const totalErrors = gcliErrors + antiErrors + cfgErrors;

  if (gcliMigrated > gcliTotal || antiMigrated > antiTotal || cfgMigrated > cfgTotal) {
    return { kind: 'unknown', engine, migration };
  }
  if (totalMigrated !== undefined && totalMigrated !== sumMigrated) {
    return { kind: 'unknown', engine, migration };
  }

  if (totalErrors > 0 || sumMigrated < sumTotal) {
    return { kind: 'partial', engine, migration };
  }

  if (totalErrors === 0 && sumMigrated === sumTotal) {
    return { kind: 'acknowledged', engine, migration };
  }

  return { kind: 'unknown', engine, migration };
}

export async function getStorageState(signal?: AbortSignal): Promise<StorageState> {
  const raw = await requestJson<unknown>('config/storage-engine', { method: 'GET', signal });
  if (!object(raw) || raw.success === false || raw.error) {
    throw new SemanticError('存储状态响应无效');
  }
  let servers: StorageServer[] | undefined;
  if (Array.isArray(raw.servers)) {
    const valid = raw.servers.every(item => object(item) && typeof item.name === 'string');
    if (valid) {
      servers = raw.servers.map(item => ({
        name: item.name as string,
        ...(typeof item.status === 'string' ? { status: item.status } : {}),
      }));
    }
  }
  const state: StorageState = {};
  if (typeof raw.current_engine === 'string') state.currentEngine = raw.current_engine;
  if (typeof raw.mysql_available === 'boolean') state.mysqlAvailable = raw.mysql_available;
  if (typeof raw.mysql_configured === 'boolean') state.mysqlConfigured = raw.mysql_configured;
  if (typeof raw.server_name === 'string') state.serverName = raw.server_name;
  if (servers !== undefined) state.servers = servers;
  return state;
}

export async function previewStorageMigration(signal?: AbortSignal): Promise<StoragePreview> {
  const raw = await requestJson<unknown>('config/storage-engine/preview', {
    method: 'POST',
    body: {},
    signal,
  });
  if (!object(raw) || raw.success === false || raw.error || !object(raw.data)) {
    throw new SemanticError('存储迁移预览响应无效');
  }
  const rawData = raw.data;
  const data: StorageCounts = {};
  const gcliCredentials = toCounter(rawData.gcli_credentials);
  if (gcliCredentials !== undefined) data.gcliCredentials = gcliCredentials;
  const antigravityCredentials = toCounter(rawData.antigravity_credentials);
  if (antigravityCredentials !== undefined) data.antigravityCredentials = antigravityCredentials;
  const config = toCounter(rawData.config);
  if (config !== undefined) data.config = config;
  const total = toCounter(rawData.total);
  if (total !== undefined) data.total = total;

  const preview: StoragePreview = { data };
  if (typeof raw.source_engine === 'string') {
    preview.sourceEngine = raw.source_engine;
  }
  return preview;
}

export async function switchStorageEngine(
  targetEngine: 'sqlite' | 'mysql',
  serverName: string,
  signal?: AbortSignal
): Promise<StorageSwitchResult> {
  try {
    const raw = await requestJson<unknown>('config/storage-engine/switch', {
      method: 'POST',
      body: {
        target_engine: targetEngine,
        server_name: serverName,
        migrate_data: true,
      },
      signal,
    });
    return readStorageSwitchResult(raw, targetEngine);
  } catch (error) {
    if (error instanceof SemanticError) {
      throw error;
    }
    throwIfAborted(signal);
    return { kind: writeFailure(error) };
  }
}

export async function getSystemStatus(signal?: AbortSignal): Promise<SystemStatus> {
  const raw = await requestJson<unknown>('config/system-status', { method: 'GET', signal });
  if (!object(raw) || raw.success === false || raw.error || !object(raw.redis) || !object(raw.smart_429)) {
    throw new SemanticError('系统状态响应无效');
  }
  const rawRedis = raw.redis;
  const redis: RedisStatus = {};
  if (typeof rawRedis.enabled === 'boolean') redis.enabled = rawRedis.enabled;
  if (typeof rawRedis.server_name === 'string') redis.serverName = rawRedis.server_name;
  const mem = toNonNegativeNumber(rawRedis.memory_used_mb);
  if (mem !== undefined) redis.memoryUsedMb = mem;
  if (object(rawRedis.pools)) {
    const pools: RedisPools = {};
    const gAvail = toCounter(rawRedis.pools.geminicli_avail);
    if (gAvail !== undefined) pools.geminicliAvail = gAvail;
    const gPreview = toCounter(rawRedis.pools.geminicli_preview);
    if (gPreview !== undefined) pools.geminicliPreview = gPreview;
    const aAvail = toCounter(rawRedis.pools.antigravity_avail);
    if (aAvail !== undefined) pools.antigravityAvail = aAvail;
    redis.pools = pools;
  }
  const totalKeys = toCounter(rawRedis.total_keys);
  if (totalKeys !== undefined) redis.totalKeys = totalKeys;

  const hasError = rawRedis.error !== undefined && rawRedis.error !== null && rawRedis.error !== false && rawRedis.error !== '';
  const hasNote = typeof rawRedis.note === 'string' && rawRedis.note.length > 0;
  if (hasError || (hasNote && rawRedis.note === 'REDIS_URL 未设置或连接失败')) {
    redis.diagnostic = 'redis_unavailable';
  } else if (hasNote) {
    redis.diagnostic = 'unknown';
  }

  const rawSmart = raw.smart_429;
  const smart429: Smart429Status = {};
  if (typeof rawSmart.enabled === 'boolean') smart429.enabled = rawSmart.enabled;
  if (typeof rawSmart.requested_enabled === 'boolean') smart429.requestedEnabled = rawSmart.requested_enabled;
  const maxAttempts = toCounter(rawSmart.max_attempts);
  if (maxAttempts !== undefined) smart429.maxAttempts = maxAttempts;
  const retryBase = toNonNegativeNumber(rawSmart.retry_base_interval);
  if (retryBase !== undefined) smart429.retryBaseInterval = retryBase;
  const epoch = toCounter(rawSmart.policy_epoch);
  if (epoch !== undefined) smart429.policyEpoch = epoch;
  if (typeof rawSmart.single_instance_only === 'boolean') smart429.singleInstanceOnly = rawSmart.single_instance_only;

  if (rawSmart.blocked_reason === null) {
    smart429.blockedReason = null;
  } else if (typeof rawSmart.blocked_reason === 'string') {
    if (rawSmart.blocked_reason === 'multi_instance_unsupported') {
      smart429.blockedReason = 'multi_instance_unsupported';
    } else if (rawSmart.blocked_reason === 'health_storage_capability_missing') {
      smart429.blockedReason = 'health_storage_capability_missing';
    } else if (
      rawSmart.blocked_reason === 'health_storage_unavailable' ||
      rawSmart.blocked_reason.startsWith('health_storage_unavailable:')
    ) {
      smart429.blockedReason = 'health_storage_unavailable';
    } else {
      smart429.blockedReason = 'unknown';
    }
  }

  return { redis, smart429 };
}

export async function getSavedPasswords(signal: AbortSignal) {
  throwIfAborted(signal);
  const capturedSession = getSessionSnapshot();
  const capturedValidation = getSessionValidationSnapshot();
  if (
    capturedSession.token === null ||
    capturedValidation.status !== 'verified' ||
    capturedValidation.sessionEpoch !== capturedSession.sessionEpoch
  ) {
    throw new ApiError(401, null);
  }

  if (fixtureMode || (import.meta.env.DEV && import.meta.env.VITE_UI_FIXTURES === 'true')) {
    throw new ApiError(501, null);
  }

  throwIfAborted(signal);
  if (
    getSessionSnapshot().sessionEpoch !== capturedSession.sessionEpoch ||
    getSessionValidationSnapshot() !== capturedValidation
  ) {
    throw new ApiError(401, null);
  }

  let raw: unknown;
  try {
    raw = await requestJson<unknown>('config/get', {
      method: 'GET',
      query: { include_secrets: true },
      signal,
    });
  } catch (error) {
    throwIfAborted(signal);
    if (
      (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError') ||
      (error instanceof Error && error.name === 'AbortError')
    ) {
      throw error;
    }
    if (error instanceof ApiError) {
      throw new ApiError(error.status, null);
    }
    throw new ApiError(500, null);
  }

  throwIfAborted(signal);
  const postSession = getSessionSnapshot();
  const postValidation = getSessionValidationSnapshot();
  if (
    postSession.sessionEpoch !== capturedSession.sessionEpoch ||
    postSession.token === null ||
    postValidation !== capturedValidation ||
    postValidation.status !== 'verified' ||
    postValidation.sessionEpoch !== capturedSession.sessionEpoch
  ) {
    throw new ApiError(401, null);
  }

  if (!object(raw) || !object(raw.config) || raw.success === false || Boolean(raw.error)) {
    throw new ApiError(500, null);
  }

  const rawConfig = raw.config;
  const passwords: {
    api_password?: string;
    panel_password?: string;
    password?: string;
  } = {};

  if (Object.prototype.hasOwnProperty.call(rawConfig, 'api_password') && typeof rawConfig.api_password === 'string') {
    passwords.api_password = rawConfig.api_password;
  }
  if (Object.prototype.hasOwnProperty.call(rawConfig, 'panel_password') && typeof rawConfig.panel_password === 'string') {
    passwords.panel_password = rawConfig.panel_password;
  }
  if (Object.prototype.hasOwnProperty.call(rawConfig, 'password') && typeof rawConfig.password === 'string') {
    passwords.password = rawConfig.password;
  }

  throwIfAborted(signal);
  const finalSession = getSessionSnapshot();
  const finalValidation = getSessionValidationSnapshot();
  if (
    finalSession.sessionEpoch !== capturedSession.sessionEpoch ||
    finalSession.token === null ||
    finalValidation !== capturedValidation ||
    finalValidation.status !== 'verified' ||
    finalValidation.sessionEpoch !== capturedSession.sessionEpoch
  ) {
    throw new ApiError(401, null);
  }

  return passwords;
}


