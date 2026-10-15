import { editable, fields } from './types';
import type { Draft, Snapshot } from './types';

export const ENDPOINT_PRESETS: Record<'mirror' | 'official', Record<string, string>> = {
  mirror: {
    code_assist_endpoint: 'https://gcli-api.sukaka.top/cloudcode-pa',
    oauth_proxy_url: 'https://gcli-api.sukaka.top/oauth2',
    googleapis_proxy_url: 'https://gcli-api.sukaka.top/googleapis',
    resource_manager_api_url: 'https://gcli-api.sukaka.top/cloudresourcemanager',
    service_usage_api_url: 'https://gcli-api.sukaka.top/serviceusage',
    antigravity_api_url: 'https://gcli-api.sukaka.top/daily-cloudcode-pa',
  },
  official: {
    code_assist_endpoint: 'https://cloudcode-pa.googleapis.com',
    oauth_proxy_url: 'https://oauth2.googleapis.com',
    googleapis_proxy_url: 'https://www.googleapis.com',
    resource_manager_api_url: 'https://cloudresourcemanager.googleapis.com',
    service_usage_api_url: 'https://serviceusage.googleapis.com',
    antigravity_api_url: 'https://daily-cloudcode-pa.googleapis.com',
  },
};

export function endpointPresetDraft(kind: 'mirror' | 'official', snapshot: Snapshot): Draft {
  const presets = ENDPOINT_PRESETS[kind];
  if (!presets || !snapshot) {
    return {};
  }
  const draft: Draft = {};
  for (const [key, value] of Object.entries(presets)) {
    const field = fields.find(f => f.key === key);
    if (field && editable(field, snapshot)) {
      draft[key] = value;
    }
  }
  return draft;
}

export function keepaliveServiceUrl(serviceBase: string): string {
  if (typeof serviceBase !== 'string' || !serviceBase.trim()) {
    throw new Error('服务地址不能为空');
  }
  if (serviceBase.includes('\\')) {
    throw new Error('服务地址格式无效');
  }
  let parsed: URL;
  try {
    parsed = new URL(serviceBase);
  } catch {
    throw new Error('服务地址格式无效');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('服务地址协议必须为 HTTP 或 HTTPS');
  }
  if (parsed.username || parsed.password) {
    throw new Error('服务地址不能包含认证信息');
  }
  if (!parsed.hostname) {
    throw new Error('服务地址必须包含有效主机名');
  }
  parsed.search = '';
  parsed.hash = '';
  return parsed.href;
}

export type StorageServer = {
  name: string;
  status?: string;
};

export type StorageState = {
  currentEngine?: string;
  mysqlAvailable?: boolean;
  mysqlConfigured?: boolean;
  serverName?: string;
  servers?: StorageServer[];
};

export type StorageCounts = {
  gcliCredentials?: number;
  antigravityCredentials?: number;
  config?: number;
  total?: number;
};

export type StoragePreview = {
  sourceEngine?: string;
  data: StorageCounts;
};

export type StorageMigrationFamily = {
  total?: number;
  migrated?: number;
  errorCount?: number;
};

export type StorageMigration = {
  gcliCredentials: StorageMigrationFamily;
  antigravityCredentials: StorageMigrationFamily;
  config: StorageMigrationFamily;
  totalMigrated?: number;
};

export type StorageSwitchResult = {
  kind: 'acknowledged' | 'partial' | 'unknown' | 'rejected';
  engine?: 'sqlite' | 'mysql';
  migration?: StorageMigration | null;
};

export type RedisPools = {
  geminicliAvail?: number;
  geminicliPreview?: number;
  antigravityAvail?: number;
};

export type RedisStatus = {
  enabled?: boolean;
  serverName?: string;
  memoryUsedMb?: number;
  pools?: RedisPools;
  totalKeys?: number;
  diagnostic?: 'redis_unavailable' | 'unknown';
};

export type Smart429Status = {
  enabled?: boolean;
  requestedEnabled?: boolean;
  maxAttempts?: number;
  retryBaseInterval?: number;
  policyEpoch?: number;
  singleInstanceOnly?: boolean;
  blockedReason?:
    | 'multi_instance_unsupported'
    | 'health_storage_capability_missing'
    | 'health_storage_unavailable'
    | 'unknown'
    | null;
};

export type SystemStatus = {
  redis: RedisStatus;
  smart429: Smart429Status;
};

