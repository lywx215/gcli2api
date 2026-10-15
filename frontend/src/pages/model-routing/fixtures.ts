/** Synthetic DEV transport. It never imports the client or calls a network. */
import { copy, object, rowChannel, routingChannels } from './types';
import type { Issue, RouteValue, RoutingChannel } from './types';

const initialRoutes: RouteValue[] = [
  { channel: 'antigravity', public_name: 'team-sonnet', upstream_name: 'claude-sonnet-4-6', enabled: true },
  { channel: 'geminicli', public_name: 'legacy-cli-model', upstream_name: 'gemini-3-flash-preview', enabled: false },
  { channel: 'antigravity', public_name: 'team-opus', upstream_name: 'claude-opus-4-6-thinking', enabled: true },
  { channel: 'antigravity', public_name: 'team-flash', upstream_name: 'gemini-3-flash', enabled: false },
];
let routes = copy(initialRoutes);
export function resetModelRoutingFixture(next: readonly RouteValue[] = initialRoutes): void { routes = copy([...next]); }
const suffixes = ['-maxthinking', '-nothinking', '-minimal', '-medium', '-search', '-think', '-high', '-max', '-low'];
const validName = (value: string) => value.length > 0 && value !== '.' && value !== '..' && !/[\s\p{C}/\\:*?\[\]#%]/u.test(value);
function issue(channel: RoutingChannel | null, row: number | null, field: string | null, reason: string, related_rows: number[] = []): Issue {
  return { channel, row, field, reason, related_rows };
}
function validate(value: unknown): Issue[] {
  if (!object(value)) return [issue(null, null, null, 'INVALID_STRUCTURE')];
  const issues: Issue[] = [];
  if (Object.keys(value).some(key => key !== 'routes')) issues.push(issue(null, null, null, 'UNKNOWN_FIELD'));
  if (!Array.isArray(value.routes)) return [...issues, issue(null, null, 'routes', 'INVALID_STRUCTURE')];
  const names = new Map<string, number>();
  value.routes.forEach((raw, index) => {
    if (!object(raw)) { issues.push(issue(null, index, null, 'INVALID_STRUCTURE')); return; }
    const channel = rowChannel(raw);
    if (!channel) {
      issues.push(issue(null, index, 'channel', !Object.hasOwn(raw, 'channel') ? 'INVALID_STRUCTURE' : typeof raw.channel !== 'string' ? 'INVALID_FIELD_TYPE' : 'UNSUPPORTED_CHANNEL'));
      return;
    }
    if (Object.keys(raw).some(key => !['channel', 'public_name', 'upstream_name', 'enabled'].includes(key))) issues.push(issue(channel, index, null, 'UNKNOWN_FIELD'));
    for (const field of ['public_name', 'upstream_name', 'enabled']) {
      if (!Object.hasOwn(raw, field)) issues.push(issue(channel, index, field, 'INVALID_STRUCTURE'));
      else if (typeof raw[field] !== (field === 'enabled' ? 'boolean' : 'string')) issues.push(issue(channel, index, field, 'INVALID_FIELD_TYPE'));
      else if (field !== 'enabled' && !validName(raw[field] as string)) issues.push(issue(channel, index, field, 'INVALID_NAME'));
    }
    if (typeof raw.public_name === 'string') {
      if (channel === 'geminicli' && suffixes.some(suffix => (raw.public_name as string).endsWith(suffix))) issues.push(issue(channel, index, 'public_name', 'RESERVED_SUFFIX'));
      const key = JSON.stringify([channel, raw.public_name]);
      const previous = names.get(key);
      if (previous !== undefined) issues.push(issue(channel, index, 'public_name', 'DUPLICATE_PUBLIC_NAME', [previous]));
      else names.set(key, index);
    }
  });
  return issues;
}
function snapshot() {
  const issues = validate({ routes });
  return {
    routes: copy(routes), supported_channels: [...routingChannels],
    capabilities: ['model.routing.aliases', 'model.identity.public'], policy_digest: 'synthetic-routing-policy-1',
    validation: Object.fromEntries(routingChannels.map(channel => {
      const channelIssues = issues.filter(value => value.channel === null || value.channel === channel);
      return [channel, { valid: channelIssues.length === 0, issues: channelIssues }];
    })),
  };
}
const wireIssues = (issues: Issue[]) => issues.map(value => ({ ...value, message: 'Invalid model routing configuration.' }));
export function fixtureModelRoutingRequest(url: URL, init: RequestInit): Response {
  init.signal?.throwIfAborted();
  if (!url.pathname.endsWith('/config/model-routing')) return Response.json({ error: 'synthetic_fixture_not_matched' }, { status: 404 });
  const method = (init.method ?? 'GET').toUpperCase();
  if (method === 'GET') {
    if (validate({ routes }).some(value => value.channel === null)) {
      return Response.json({ error: { code: 'MODEL_ROUTING_UNAVAILABLE', message: 'Model routing configuration is unavailable.' } }, { status: 503 });
    }
    return Response.json(snapshot());
  }
  if (method !== 'PUT') return Response.json({ error: 'synthetic_method_not_allowed' }, { status: 405 });
  let value: unknown;
  try { value = typeof init.body === 'string' ? JSON.parse(init.body) : null; } catch { value = null; }
  const issues = validate(value);
  if (issues.length) return Response.json({ error: { code: 'MODEL_ROUTING_VALIDATION_FAILED', message: 'Invalid model routing configuration.', issues: wireIssues(issues) } }, { status: 400 });
  routes = copy((value as { routes: RouteValue[] }).routes);
  return Response.json(snapshot());
}