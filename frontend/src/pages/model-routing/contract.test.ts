import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, requestJson } from '@/api/client';
import { canRecover, getRouting, putRouting, readSave, readSnapshot, RoutingReadError } from './api';
import { affectedRows, collectIssues, copy, display, equal, fieldInvalid, issueText, rowChannel } from './types';
import type { Issue, RouteValue } from './types';
import { fixtureModelRoutingRequest, resetModelRoutingFixture } from './fixtures';

vi.mock('@/api/client', () => ({
  requestJson: vi.fn(),
  ApiError: class extends Error { constructor(public status: number, public payload: unknown) { super('safe request failure'); } },
}));
const ag = (name = 'demo-alias', enabled = true) => ({ channel: 'antigravity', public_name: name, upstream_name: 'claude-sonnet-4-6', enabled });
const cli = () => ({ channel: 'geminicli', public_name: 'legacy-alias', upstream_name: 'gemini-3-flash-preview', enabled: false });
const payload = (routes: readonly RouteValue[], extra: Record<string, unknown> = {}) => ({
  routes, supported_channels: ['antigravity', 'geminicli'], capabilities: ['model.routing.aliases', 'model.identity.public'],
  policy_digest: 'synthetic-policy', validation: { antigravity: { valid: true, issues: [] }, geminicli: { valid: true, issues: [] } }, ...extra,
});
const diagnostic = (extra: Partial<Issue> = {}): Issue => ({ channel: 'antigravity', row: 2, field: 'public_name', reason: 'DUPLICATE_PUBLIC_NAME', related_rows: [0, 1], ...extra });
beforeEach(() => { vi.resetAllMocks(); resetModelRoutingFixture(); });

describe('raw model-routing table contract', () => {
  it('preserves interleaved channels, unknown fields, invalid object values and uneditable rows', () => {
    const historical = { ...ag(), public_name: { invalid: ['original', false] }, enabled: null, unknown: { nested: [0, false, null] } };
    const routes: RouteValue[] = [cli(), historical, { channel: 'future', strange: true }, null, ['invalid'], ag('last')];
    const snapshot = readSnapshot(payload(routes));
    expect(snapshot.routes).toEqual(routes);
    expect(snapshot.routes).not.toBe(routes);
    expect(snapshot.routes[1]).not.toBe(historical);
    (historical.public_name.invalid as unknown[]).push('later');
    expect(snapshot.routes[1]).toMatchObject({ public_name: { invalid: ['original', false] } });
    expect(rowChannel(snapshot.routes[0])).toBe('geminicli');
    expect(rowChannel(snapshot.routes[1])).toBe('antigravity');
    expect(rowChannel(snapshot.routes[2])).toBeNull();
    expect(display({ value: false })).toBe('{"value":false}');
  });
  it('copies own JSON keys safely and compares object keys independent of order while retaining row order', () => {
    const value = JSON.parse('{"__proto__":{"unexpected":true},"constructor":"historical","rows":[false,0,null]}');
    const cloned = copy(value);
    expect(Object.hasOwn(cloned, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(cloned)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).unexpected).toBeUndefined();
    expect(equal({ first: { x: 1, y: false }, second: [] }, { second: [], first: { y: false, x: 1 } })).toBe(true);
    expect(equal([ag(), cli()], [cli(), ag()])).toBe(false);
    expect(equal({ enabled: false }, {})).toBe(false);
  });
  it('deduplicates validation and error issues, discards free text and retains global indexes', () => {
    const first = { ...diagnostic(), message: 'synthetic backend text must not be displayed' };
    const snapshot = readSnapshot(payload([ag(), cli(), ag()], {
      validation: { antigravity: { valid: false, issues: [first] }, geminicli: { valid: false, issues: [first] } },
      error: { issues: [first] }, issues: [first],
    }));
    expect(snapshot.issues).toEqual([diagnostic()]);
    expect(snapshot.valid).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain('synthetic backend text');
    expect(affectedRows(snapshot.issues[0])).toEqual([2, 0, 1]);
    expect(fieldInvalid(snapshot.issues, 1, 'public_name')).toBe(true);
    expect(fieldInvalid(snapshot.issues, 1, 'upstream_name')).toBe(false);
    expect(fieldInvalid([diagnostic({ field: null })], 1, 'upstream_name')).toBe(true);
  });
  it('maps every known server reason to safe text and rejects prototype property names', () => {
    for (const reason of ['INVALID_STRUCTURE', 'UNKNOWN_FIELD', 'INVALID_FIELD_TYPE', 'UNSUPPORTED_CHANNEL', 'INVALID_NAME', 'RESERVED_SUFFIX', 'DUPLICATE_PUBLIC_NAME', 'AMBIGUOUS_TARGET_NAME', 'UNSTABLE_TARGET_DISPATCH', 'INVALID_IDENTITY_ROUTE', 'PROTECTED_ENTRY_CAPTURE', 'AMBIGUOUS_COMPATIBILITY']) {
      expect(typeof issueText(diagnostic({ reason }))).toBe('string');
      expect(issueText(diagnostic({ reason }))).not.toContain(reason);
    }
    for (const reason of ['__proto__', 'constructor', 'synthetic-secret']) {
      expect(issueText(diagnostic({ reason }))).toBe('配置未通过服务端校验，请检查对应字段或关联行');
      expect(collectIssues({ issues: [diagnostic({ reason })] })[0].reason).toBe('UNKNOWN_REASON');
    }
    expect(collectIssues({ issues: [{ reason: 'INVALID_NAME', row: -1, related_rows: [-2, '3', 2, 2, 4.5] }, null] })).toEqual([
      { channel: null, row: null, field: null, reason: 'INVALID_NAME', related_rows: [2] },
    ]);
  });
  it.each([{}, { routes: [] }, payload([], { validation: {} }), payload([], { capabilities: [false] }), payload([], { policy_digest: '' })])('rejects a malformed read envelope', raw => {
    expect(() => readSnapshot(raw)).toThrow(RoutingReadError);
  });
});

describe('model-routing API acknowledgement', () => {
  it('uses the shared request with a signal for reads and complete-table writes', async () => {
    const routes = [ag(), cli(), { ...ag('disabled'), enabled: false, historical: { retain: true } }];
    const signal = new AbortController().signal;
    vi.mocked(requestJson).mockResolvedValue(payload(routes));
    expect((await getRouting(signal)).routes).toEqual(routes);
    expect(requestJson).toHaveBeenNthCalledWith(1, 'config/model-routing', { signal });
    const result = await putRouting(routes, signal);
    expect(result.kind).toBe('acknowledged');
    expect(requestJson).toHaveBeenNthCalledWith(2, 'config/model-routing', { method: 'PUT', body: { routes }, signal });
  });
  it('captures the attempt before later draft changes, without changing object values or unknown fields', async () => {
    const historical = { ...ag(), public_name: { original: true } };
    const routes = [historical, cli(), { channel: 'future', fields: [false, 0] }];
    let resolve!: (value: unknown) => void;
    vi.mocked(requestJson).mockImplementation(() => new Promise(value => { resolve = value; }));
    const saving = putRouting(routes, new AbortController().signal);
    const body = vi.mocked(requestJson).mock.calls[0][1]?.body as { routes: unknown[] };
    const sent = copy(body.routes);
    historical.public_name = { original: false };
    routes.reverse();
    expect(body.routes).toEqual(sent);
    resolve(payload(sent));
    expect((await saving).kind).toBe('acknowledged');
  });
  it('accepts authoritative equal JSON with reordered object keys', () => {
    const sent = [ag()];
    const acknowledged = [{ enabled: true, upstream_name: 'claude-sonnet-4-6', public_name: 'demo-alias', channel: 'antigravity' }];
    expect(readSave(payload(acknowledged), sent).kind).toBe('acknowledged');
  });
  it('does not confirm arbitrary 2xx, partial tables, normalized values, reordered rows or failed validation', () => {
    const sent = [ag(), cli()];
    for (const raw of [{ success: true }, null, payload([ag()]), payload([cli(), ag()]), payload([{ ...ag(), enabled: false }, cli()]), payload(sent, { validation: { antigravity: { valid: false, issues: [] }, geminicli: { valid: true, issues: [] } } }), payload(sent, { error: { code: 'synthetic-error' } })]) {
      expect(readSave(raw, sent).kind).toBe('unknown');
    }
    expect(readSave(payload([ag()]), [{ ...ag(), unknown: 'must survive' }]).kind).toBe('unknown');
    expect(readSave(payload([]), []).kind).toBe('acknowledged');
  });
  it('returns a definite rejection and mapped issues for HTTP400 validation errors', async () => {
    vi.mocked(requestJson).mockRejectedValue(new ApiError(400, { error: { code: 'MODEL_ROUTING_VALIDATION_FAILED', message: 'synthetic private message', issues: [diagnostic(), diagnostic()] } }));
    const result = await putRouting([ag(), cli(), ag()], new AbortController().signal);
    expect(result).toEqual({ kind: 'rejected', issues: [diagnostic()] });
    expect(JSON.stringify(result)).not.toContain('synthetic private message');
  });
  it.each([401, 403, 409, 422, 429])('classifies HTTP%s as rejected', async status => {
    vi.mocked(requestJson).mockRejectedValue(new ApiError(status, {}));
    expect((await putRouting([], new AbortController().signal)).kind).toBe('rejected');
  });
  it.each([new ApiError(500, {}), new ApiError(503, { error: { code: 'MODEL_ROUTING_UNAVAILABLE' } }), new TypeError('synthetic network failure'), new SyntaxError('synthetic broken response')])('keeps a possibly dispatched failure unknown', async error => {
    vi.mocked(requestJson).mockRejectedValue(error);
    expect((await putRouting([], new AbortController().signal)).kind).toBe('unknown');
    expect(requestJson).toHaveBeenCalledTimes(1);
  });
  it('requires precise unavailable provenance before allowing an empty recovery draft', async () => {
    for (const error of [new ApiError(503, {}), new ApiError(503, { error: { code: 'OTHER_UNAVAILABLE' } }), new ApiError(400, { error: { code: 'MODEL_ROUTING_UNAVAILABLE' } }), new TypeError('synthetic network failure')]) {
      vi.mocked(requestJson).mockRejectedValue(error);
      await expect(getRouting(new AbortController().signal)).rejects.toMatchObject({ recoveryAllowed: false });
      expect(canRecover(error)).toBe(false);
    }
    vi.mocked(requestJson).mockRejectedValue(new ApiError(503, { error: { code: 'MODEL_ROUTING_UNAVAILABLE', message: 'synthetic private message' } }));
    await expect(getRouting(new AbortController().signal)).rejects.toMatchObject({ recoveryAllowed: true, status: 503 });
    expect(canRecover(new RoutingReadError(true))).toBe(true);
  });
  it('rejects malformed diagnostic containers as an unknown 2xx outcome', () => {
    for (const raw of [
      payload([], { validation: { antigravity: { valid: true, issues: [null] }, geminicli: { valid: true, issues: [] } } }),
      payload([], { issues: 'not-an-array' }),
      payload([], { issues: [{ ...diagnostic(), related_rows: [-1] }] }),
    ]) {
      expect(() => readSnapshot(raw)).toThrow(RoutingReadError);
      expect(readSave(raw, []).kind).toBe('unknown');
    }
  });
  it('propagates aborts so stale reads and writes cannot publish an outcome', async () => {
    const controller = new AbortController();
    controller.abort();
    const error = new DOMException('synthetic abort', 'AbortError');
    vi.mocked(requestJson).mockRejectedValue(error);
    await expect(getRouting(controller.signal)).rejects.toBe(error);
    await expect(putRouting([], controller.signal)).rejects.toBe(error);
    await expect(getRouting(new AbortController().signal)).rejects.toBe(error);
    await expect(putRouting([], new AbortController().signal)).rejects.toBe(error);
  });
});

describe('isolated model-routing DEV fixture', () => {
  const url = new URL('http://localhost:3000/prefix/config/model-routing');
  const get = () => fixtureModelRoutingRequest(url, { method: 'GET' });
  const put = (routes: unknown[]) => fixtureModelRoutingRequest(url, { method: 'PUT', body: JSON.stringify({ routes }) });
  it('returns the complete contract with synthetic interleaved channels without network access', async () => {
    const snapshot = readSnapshot(await get().json());
    expect(snapshot.valid).toBe(true);
    expect(snapshot.capabilities).toContain('model.routing.aliases');
    expect(snapshot.routes.map(rowChannel)).toEqual(['antigravity', 'geminicli', 'antigravity', 'antigravity']);
    expect(snapshot.routes[1]).toMatchObject({ enabled: false });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('saves a whole table atomically in original order and permits explicit empty tables', async () => {
    const rows = [cli(), ag('next', false), ag('last')];
    expect(readSave(await put(rows).json(), rows).kind).toBe('acknowledged');
    expect((await get().json()).routes).toEqual(rows);
    expect(readSave(await put([]).json(), []).kind).toBe('acknowledged');
    expect((await get().json()).routes).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects invalid names, duplicate disabled names and object values without changing saved state', async () => {
    const original = await get().json();
    const response = put([ag('repeat'), cli(), ag('repeat', false), { ...ag('bad'), upstream_name: { historical: true } }, ag('has space')]);
    expect(response.status).toBe(400);
    const result = await response.json();
    const issues = collectIssues(result);
    expect(issues).toContainEqual(diagnostic({ row: 2, related_rows: [0] }));
    expect(issues).toContainEqual(diagnostic({ row: 3, field: 'upstream_name', reason: 'INVALID_FIELD_TYPE', related_rows: [] }));
    expect(issues).toContainEqual(diagnostic({ row: 4, field: 'public_name', reason: 'INVALID_NAME', related_rows: [] }));
    expect(await get().json()).toEqual(original);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('retains attributable historical invalid rows in reads and returns precise unavailable for global corruption', async () => {
    const historical = { ...ag(), public_name: { keep: [false] }, unknown: 'keep' };
    resetModelRoutingFixture([cli(), historical]);
    const snapshot = readSnapshot(await get().json());
    expect(snapshot.routes).toEqual([cli(), historical]);
    expect(snapshot.valid).toBe(false);
    expect(snapshot.issues.some(value => value.row === 1 && value.reason === 'UNKNOWN_FIELD')).toBe(true);
    resetModelRoutingFixture([{ channel: 'future', public_name: 'retained' }]);
    const unavailable = get();
    expect(unavailable.status).toBe(503);
    expect((await unavailable.json()).error.code).toBe('MODEL_ROUTING_UNAVAILABLE');
  });
  it('returns404 for unmatched endpoints and never delegates unknown requests to fetch', () => {
    expect(fixtureModelRoutingRequest(new URL('http://localhost:3000/config/other'), {}).status).toBe(404);
    expect(fixtureModelRoutingRequest(url, { method: 'DELETE' }).status).toBe(405);
    expect(fixtureModelRoutingRequest(url, { method: 'PUT', body: '{invalid' }).status).toBe(400);
    const controller = new AbortController(); controller.abort();
    expect(() => fixtureModelRoutingRequest(url, { signal: controller.signal })).toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});