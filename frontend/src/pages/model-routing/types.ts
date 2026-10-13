/** The draft is the full JSON table, including rows this UI cannot edit. */
export type RoutingChannel = 'antigravity' | 'geminicli';
export type RouteValue = unknown;
export type Issue = {
  channel: string | null;
  row: number | null;
  field: string | null;
  reason: string;
  related_rows: number[];
};
export type ChannelValidation = { valid: boolean; issues: Issue[] };
export type Snapshot = {
  routes: RouteValue[];
  supportedChannels: string[];
  capabilities: string[];
  policyDigest: string;
  validation: Record<RoutingChannel, ChannelValidation>;
  issues: Issue[];
  valid: boolean;
};
export const routingChannels: readonly RoutingChannel[] = ['antigravity', 'geminicli'];
export const routingCapability = 'model.routing.aliases';
export const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Copy JSON without selecting fields or converting historical field values. */
export function copy<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => copy(item)) as T;
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)])) as T;
  return value;
}
/** JSON object key order is irrelevant; route array order is significant. */
export function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => equal(value, b[index]));
  }
  if (!object(a) || !object(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
}
export function display(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '未设置';
  try { return JSON.stringify(value) ?? '未设置'; } catch { return '无法显示的值'; }
}
export function rowChannel(value: unknown): RoutingChannel | null {
  return object(value) && (value.channel === 'antigravity' || value.channel === 'geminicli') ? value.channel : null;
}
const rowIndex = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
/** All indexes are global. An issue channel must never filter related rows. */
export function affectedRows(issue: Issue): number[] {
  return [...new Set([issue.row, ...issue.related_rows].filter(rowIndex))];
}
const reasonText: Record<string, string> = {
  INVALID_STRUCTURE: '缺少必填字段或配置结构无效',
  UNKNOWN_FIELD: '包含当前服务不支持的字段，请检查该行',
  INVALID_FIELD_TYPE: '字段类型无效，请明确编辑该字段',
  UNSUPPORTED_CHANNEL: '当前服务不支持此渠道',
  INVALID_NAME: '模型名称不能为空，也不能包含空白、控制字符或路径符号',
  RESERVED_SUFFIX: '公开名称使用了保留后缀',
  DUPLICATE_PUBLIC_NAME: '同一渠道的公开名称重复，请检查关联行',
  AMBIGUOUS_TARGET_NAME: '上游名称存在歧义',
  UNSTABLE_TARGET_DISPATCH: '上游名称不能稳定映射到同一模型',
  INVALID_IDENTITY_ROUTE: '同名路由不能保持现有模型行为',
  PROTECTED_ENTRY_CAPTURE: '路由会改变受保护模型入口，请检查关联行',
  AMBIGUOUS_COMPATIBILITY: '当前服务无法确认路由与模型规则兼容',
};
export function issueText(issue: Issue): string {
  return Object.hasOwn(reasonText, issue.reason) ? reasonText[issue.reason] : '配置未通过服务端校验，请检查对应字段或关联行';
}
export function fieldInvalid(issues: readonly Issue[], index: number, field: string): boolean {
  return issues.some(issue => affectedRows(issue).includes(index) && (issue.field === null || issue.field === field));
}
function normalizeIssue(raw: unknown): Issue | null {
  if (!object(raw) || typeof raw.reason !== 'string') return null;
  return {
    channel: typeof raw.channel === 'string' ? raw.channel : null,
    row: rowIndex(raw.row) ? raw.row : null,
    field: typeof raw.field === 'string' ? raw.field : null,
    reason: Object.hasOwn(reasonText, raw.reason) ? raw.reason : 'UNKNOWN_REASON',
    related_rows: Array.isArray(raw.related_rows) ? [...new Set(raw.related_rows.filter(rowIndex))].sort((a, b) => a - b) : [],
  };
}
/** Read known diagnostic containers only. Never retain free-form messages. */
export function collectIssues(raw: unknown): Issue[] {
  const candidates: unknown[] = [];
  const append = (value: unknown) => { if (Array.isArray(value)) candidates.push(...value); };
  if (Array.isArray(raw)) append(raw);
  else if (object(raw)) {
    append(raw.issues);
    if (object(raw.error)) append(raw.error.issues);
    if (object(raw.validation)) for (const value of Object.values(raw.validation)) if (object(value)) append(value.issues);
  }
  const issues: Issue[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const issue = normalizeIssue(candidate);
    if (!issue) continue;
    const identity = JSON.stringify(issue);
    if (!seen.has(identity)) { seen.add(identity); issues.push(issue); }
  }
  return issues;
}