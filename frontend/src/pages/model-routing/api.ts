import { ApiError, requestJson } from '@/api/client';
import { collectIssues, copy, equal, object, routingChannels } from './types';
import type { Issue, RouteValue, Snapshot } from './types';

const path = 'config/model-routing';
export class RoutingReadError extends Error {
  constructor(public recoveryAllowed = false, public issues: Issue[] = [], public status?: number) {
    super(recoveryAllowed ? '已保存的路由配置无法读取，可使用空白草稿恢复。' : '无法读取模型路由，请重试。');
    this.name = 'RoutingReadError';
  }
}
/** Recovery is allowed only for the exact dedicated backend unavailable code. */
export function canRecover(error: unknown): boolean {
  return error instanceof RoutingReadError ? error.recoveryAllowed
    : error instanceof ApiError && error.status === 503 && object(error.payload)
      && object(error.payload.error) && error.payload.error.code === 'MODEL_ROUTING_UNAVAILABLE';
}
function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}
function issueArray(value: unknown): value is Issue[] {
  return Array.isArray(value) && value.every(item => object(item)
    && (item.channel === null || typeof item.channel === 'string')
    && (item.row === null || typeof item.row === 'number' && Number.isSafeInteger(item.row) && item.row >= 0)
    && (item.field === null || typeof item.field === 'string')
    && typeof item.reason === 'string' && item.reason.length > 0
    && Array.isArray(item.related_rows) && item.related_rows.every(index => typeof index === 'number' && Number.isSafeInteger(index) && index >= 0));
}
export function readSnapshot(raw: unknown): Snapshot {
  if (!object(raw) || !Array.isArray(raw.routes) || !stringArray(raw.supported_channels)
    || !stringArray(raw.capabilities) || typeof raw.policy_digest !== 'string' || !raw.policy_digest
    || !object(raw.validation)) throw new RoutingReadError(false, collectIssues(raw));
  if ((raw.issues !== undefined && !issueArray(raw.issues))
    || (object(raw.error) && raw.error.issues !== undefined && !issueArray(raw.error.issues))) {
    throw new RoutingReadError(false, collectIssues(raw));
  }
  const validation = {} as Snapshot['validation'];
  for (const channel of routingChannels) {
    const value = raw.validation[channel];
    if (!object(value) || typeof value.valid !== 'boolean' || !issueArray(value.issues)) {
      throw new RoutingReadError(false, collectIssues(raw));
    }
    validation[channel] = { valid: value.valid, issues: collectIssues(value) };
  }
  const issues = collectIssues(raw);
  return {
    routes: copy(raw.routes), supportedChannels: [...raw.supported_channels], capabilities: [...raw.capabilities],
    policyDigest: raw.policy_digest, validation, issues,
    valid: routingChannels.every(channel => validation[channel].valid) && issues.length === 0 && !raw.error && raw.success !== false,
  };
}
function aborted(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (object(error) && error.name === 'AbortError');
}
export async function getRouting(signal: AbortSignal): Promise<Snapshot> {
  try { return readSnapshot(await requestJson<unknown>(path, { signal })); }
  catch (error) {
    if (aborted(error, signal) || error instanceof RoutingReadError) throw error;
    throw new RoutingReadError(canRecover(error), error instanceof ApiError ? collectIssues(error.payload) : [], error instanceof ApiError ? error.status : undefined);
  }
}
export type SaveResult =
  | { kind: 'acknowledged'; snapshot: Snapshot; issues: Issue[] }
  | { kind: 'rejected' | 'unknown'; snapshot?: Snapshot; issues: Issue[] };
export function readSave(raw: unknown, sent: readonly RouteValue[]): SaveResult {
  try {
    const snapshot = readSnapshot(raw);
    return snapshot.valid && equal(snapshot.routes, sent)
      ? { kind: 'acknowledged', snapshot, issues: [] }
      : { kind: 'unknown', snapshot, issues: snapshot.issues };
  } catch { return { kind: 'unknown', issues: collectIssues(raw) }; }
}
export async function putRouting(routes: readonly RouteValue[], signal: AbortSignal): Promise<SaveResult> {
  // Capture the complete table before awaiting so later draft edits cannot change this attempt.
  const sent = copy(routes);
  try { return readSave(await requestJson<unknown>(path, { method: 'PUT', body: { routes: sent }, signal }), sent); }
  catch (error) {
    if (aborted(error, signal)) throw error;
    return {
      kind: error instanceof ApiError && error.status >= 400 && error.status < 500 ? 'rejected' : 'unknown',
      issues: error instanceof ApiError ? collectIssues(error.payload) : [],
    };
  }
}