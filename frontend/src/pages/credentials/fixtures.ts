import { CAP, parsePage, type Filters } from './model'

function scenarioFilename(i: number): string {
  if (i === 0) return 'synthetic-1.json'
  if (i === 1) return 'synthetic-2-partial.json'
  if (i === 2) return 'synthetic-3-error.json'
  if (i === 3) return 'synthetic-4-unknown.json'
  if (i === 4) return 'synthetic-5-unsupported.json'
  return `synthetic-${i + 1}.json`
}

const rows = Array.from({ length: 62 }, (_, i) => ({
  filename: scenarioFilename(i),
  user_email: `preview${i + 1}@example.invalid`,
  disabled: i % 5 === 0,
  permanent_disabled: i === 5,
  tier: i % 2 ? 'pro' : 'free',
  remark: i % 3 ? '' : '合成预览',
  enable_credit: false,
  error_codes: i % 5 ? [] : [403],
  quota_groups: {
    'gemini-shared': { restricted: false, blockedUnknown: false, cooldownUntil: 0 },
    'claude-gpt-shared': { restricted: i % 3 === 0, blockedUnknown: i % 3 === 0, cooldownUntil: 0 },
  },
  model_access_families: { 'claude-opus-5-5': { state: 'unknown' } },
}))

export function fixturePage(f: Filters, offset: number, limit: number) {
  const matching = rows.filter(
    r =>
      (!f.search || `${r.filename} ${r.user_email}`.includes(f.search)) &&
      (f.status === 'all' ||
        (f.status === 'enabled' && !r.disabled) ||
        (f.status === 'disabled' && r.disabled) ||
        (f.status === 'permanent_disabled' && r.permanent_disabled)),
  )
  return parsePage({
    items: matching.slice(offset, offset + limit),
    total: matching.length,
    has_more: offset + limit < matching.length,
    panel_capabilities: [...Object.values(CAP), 'antigravity.quota.summary'],
    stats: { total: 62, normal: 49, disabled: 13, permanent_disabled: 1 },
    model_access_summary: {
      total: matching.length,
      family_counts: { 'claude-opus-5-5': { unknown: matching.length } },
    },
  })
}
