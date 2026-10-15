import { describe, expect, it } from 'vitest'
import {
  CAP,
  CAP_BY_MODE,
  initialFilters,
  listQuery,
  manualResult,
  parsePage,
  supportedFilters,
  type Capabilities,
  type Filters,
} from './model'

describe('credential model-modes capability mapping and valid modes', () => {
  it('exposes exactly two valid panel modes in CAP_BY_MODE', () => {
    const modes = Object.keys(CAP_BY_MODE).sort()
    expect(modes).toEqual(['antigravity', 'geminicli'])
  })

  it('contains exact capability keys and values for antigravity mode', () => {
    expect(CAP_BY_MODE.antigravity).toBe(CAP)
    expect(Object.keys(CAP_BY_MODE.antigravity).sort()).toEqual([
      'credit',
      'family',
      'group',
      'permanent',
      'remark',
      'search',
    ])
    expect(CAP_BY_MODE.antigravity.search).toBe('antigravity.credentials.search')
    expect(CAP_BY_MODE.antigravity.group).toBe('antigravity.cooldown.group_filter')
    expect(CAP_BY_MODE.antigravity.family).toBe('antigravity.model_access.family_filter')
    expect(CAP_BY_MODE.antigravity.permanent).toBe('antigravity.credentials.permanent_disabled')
    expect(CAP_BY_MODE.antigravity.remark).toBe('antigravity.credentials.remark')
    expect(CAP_BY_MODE.antigravity.credit).toBe('antigravity.credentials.credit_mode')
  })

  it('contains exact capability keys and values for geminicli mode', () => {
    expect(Object.keys(CAP_BY_MODE.geminicli).sort()).toEqual([
      'permanent',
      'remark',
      'search',
    ])
    expect(CAP_BY_MODE.geminicli.search).toBe('geminicli.credentials.search')
    expect(CAP_BY_MODE.geminicli.permanent).toBe('geminicli.credentials.permanent_disabled')
    expect(CAP_BY_MODE.geminicli.remark).toBe('geminicli.credentials.remark')
    expect('group' in CAP_BY_MODE.geminicli).toBe(false)
    expect('family' in CAP_BY_MODE.geminicli).toBe(false)
    expect('credit' in CAP_BY_MODE.geminicli).toBe(false)
  })
})

describe('parsePage mode verification: absent vs valid vs invalid/mismatching', () => {
  const syntheticItems = [{ filename: 'synthetic-credential-1.json' }]

  it('accepts absent mode for both valid modes (legacy compatibility)', () => {
    const raw = { items: syntheticItems, total: 1 }
    const agRes = parsePage(raw, 'antigravity')
    expect(agRes.items[0].filename).toBe('synthetic-credential-1.json')
    expect(agRes.total).toBe(1)

    const gcliRes = parsePage(raw, 'geminicli')
    expect(gcliRes.items[0].filename).toBe('synthetic-credential-1.json')
    expect(gcliRes.total).toBe(1)
  })

  it('accepts matching explicit own mode for antigravity and geminicli', () => {
    const agPage = parsePage({ mode: 'antigravity', items: syntheticItems, total: 1 }, 'antigravity')
    expect(agPage.total).toBe(1)

    const gcliPage = parsePage({ mode: 'geminicli', items: syntheticItems, total: 1 }, 'geminicli')
    expect(gcliPage.total).toBe(1)
  })

  it('rejects mismatching modes between response and requested closed mode', () => {
    expect(() => parsePage({ mode: 'geminicli', items: syntheticItems, total: 1 }, 'antigravity')).toThrow('渠道模式不匹配')
    expect(() => parsePage({ mode: 'antigravity', items: syntheticItems, total: 1 }, 'geminicli')).toThrow('渠道模式不匹配')
  })

  it.each([
    ['empty string', ''],
    ['unknown string', 'unknown_mode'],
    ['vertex string', 'vertex'],
    ['null', null],
    ['false', false],
    ['number zero', 0],
    ['positive number', 123],
    ['boolean true', true],
  ])('rejects invalid mode value %s', (_, invalidMode) => {
    expect(() => parsePage({ mode: invalidMode, items: syntheticItems, total: 1 }, 'antigravity')).toThrow('渠道模式不匹配')
    expect(() => parsePage({ mode: invalidMode, items: syntheticItems, total: 1 }, 'geminicli')).toThrow('渠道模式不匹配')
  })
})

describe('default AG signatures across model functions', () => {
  const syntheticItems = [{ filename: 'synthetic-credential-ag.json' }]

  it('defaults parsePage to antigravity mode when mode is omitted', () => {
    const p1 = parsePage({ items: syntheticItems, total: 1 })
    expect(p1.total).toBe(1)

    const p2 = parsePage({ mode: 'antigravity', items: syntheticItems, total: 1 })
    expect(p2.total).toBe(1)

    expect(() => parsePage({ mode: 'geminicli', items: syntheticItems, total: 1 })).toThrow('渠道模式不匹配')
  })

  it('defaults supportedFilters to antigravity mode when mode is omitted', () => {
    const agCaps = new Set<string>([CAP_BY_MODE.antigravity.group, CAP_BY_MODE.antigravity.family])
    const f: Filters = { ...initialFilters, group: 'cooldown_active', family: 'gemini-2-5-pro', access: 'supported' }
    const res = supportedFilters(f, agCaps)
    expect(res.group).toBe('cooldown_active')
    expect(res.family).toBe('gemini-2-5-pro')
    expect(res.access).toBe('supported')
  })

  it('defaults listQuery to antigravity mode when mode is omitted', () => {
    const q = listQuery(initialFilters, new Set(), 0, 25)
    expect(q.mode).toBe('antigravity')
    expect(q.limit).toBe(25)
    expect(q.offset).toBe(0)
  })
})

describe('geminicli query with supported fields only and no AG fields', () => {
  it('builds GCLI query without AG family/group/access parameters even if present in input', () => {
    const mixedCaps: Capabilities = new Set([
      CAP_BY_MODE.geminicli.search,
      CAP_BY_MODE.geminicli.remark,
      CAP_BY_MODE.geminicli.permanent,
      CAP_BY_MODE.antigravity.group,
      CAP_BY_MODE.antigravity.family,
    ])
    const filters: Filters = {
      ...initialFilters,
      search: 'query-term',
      remark: 'audit-note',
      family: 'claude-opus-5-5',
      group: 'quota-g1',
      access: 'supported',
      preview: 'preview_only',
      cooldown: 'cooling',
    }

    const query = listQuery(filters, mixedCaps, 0, 10, 'geminicli')

    expect(query).toEqual({
      mode: 'geminicli',
      offset: 0,
      limit: 10,
      status_filter: 'all',
      error_code_filter: 'all',
      tier_filter: 'all',
      preview_filter: 'preview_only',
      cooldown_filter: 'cooling',
      remark_filter: 'audit-note',
      search: 'query-term',
    })
    expect(query).not.toHaveProperty('model_access_family')
    expect(query).not.toHaveProperty('model_access_filter')
    expect(query).not.toHaveProperty('group')
  })

  it('excludes AG family/access in supportedFilters for geminicli without AG capability mapping', () => {
    const gcliCaps: Capabilities = new Set([CAP_BY_MODE.geminicli.search])
    const filters: Filters = {
      ...initialFilters,
      family: 'custom-family',
      group: 'custom-group',
      access: 'restricted',
    }
    const result = supportedFilters(filters, gcliCaps, 'geminicli')
    expect(result.preview).toBe('all')
    expect(result.cooldown).toBe('all')
  })
})

describe('capability-gated search, remark, and permanent status', () => {
  const allFilters: Filters = {
    ...initialFilters,
    search: 'synthetic-search',
    remark: 'synthetic-remark',
    status: 'permanent_disabled',
  }

  describe('geminicli mode capability gating', () => {
    it('gates search by geminicli.credentials.search', () => {
      const withCap = supportedFilters(allFilters, new Set([CAP_BY_MODE.geminicli.search]), 'geminicli')
      expect(withCap.search).toBe('synthetic-search')
      const queryWith = listQuery(allFilters, new Set([CAP_BY_MODE.geminicli.search]), 0, 10, 'geminicli')
      expect(queryWith.search).toBe('synthetic-search')

      const withoutCap = supportedFilters(allFilters, new Set(), 'geminicli')
      expect(withoutCap.search).toBe('')
      const queryWithout = listQuery(allFilters, new Set(), 0, 10, 'geminicli')
      expect(queryWithout).not.toHaveProperty('search')
    })

    it('gates remark by geminicli.credentials.remark', () => {
      const withCap = supportedFilters(allFilters, new Set([CAP_BY_MODE.geminicli.remark]), 'geminicli')
      expect(withCap.remark).toBe('synthetic-remark')
      const queryWith = listQuery(allFilters, new Set([CAP_BY_MODE.geminicli.remark]), 0, 10, 'geminicli')
      expect(queryWith.remark_filter).toBe('synthetic-remark')

      const withoutCap = supportedFilters(allFilters, new Set(), 'geminicli')
      expect(withoutCap.remark).toBe('__all__')
      const queryWithout = listQuery(allFilters, new Set(), 0, 10, 'geminicli')
      expect(queryWithout).not.toHaveProperty('remark_filter')
    })

    it('gates permanent_disabled status by geminicli.credentials.permanent_disabled', () => {
      const withCap = supportedFilters(allFilters, new Set([CAP_BY_MODE.geminicli.permanent]), 'geminicli')
      expect(withCap.status).toBe('permanent_disabled')
      const queryWith = listQuery(allFilters, new Set([CAP_BY_MODE.geminicli.permanent]), 0, 10, 'geminicli')
      expect(queryWith.status_filter).toBe('permanent_disabled')

      const withoutCap = supportedFilters(allFilters, new Set(), 'geminicli')
      expect(withoutCap.status).toBe('all')
      const queryWithout = listQuery(allFilters, new Set(), 0, 10, 'geminicli')
      expect(queryWithout.status_filter).toBe('all')

      const disabledF = supportedFilters({ ...allFilters, status: 'disabled' }, new Set(), 'geminicli')
      expect(disabledF.status).toBe('disabled')
      const enabledF = supportedFilters({ ...allFilters, status: 'enabled' }, new Set(), 'geminicli')
      expect(enabledF.status).toBe('enabled')
    })
  })

  describe('antigravity mode capability gating', () => {
    it('gates search, remark, and permanent_disabled by antigravity capability keys', () => {
      const agCaps = new Set([
        CAP_BY_MODE.antigravity.search,
        CAP_BY_MODE.antigravity.remark,
        CAP_BY_MODE.antigravity.permanent,
      ])
      const withCaps = supportedFilters(allFilters, agCaps, 'antigravity')
      expect(withCaps.search).toBe('synthetic-search')
      expect(withCaps.remark).toBe('synthetic-remark')
      expect(withCaps.status).toBe('permanent_disabled')

      const withoutCaps = supportedFilters(allFilters, new Set(), 'antigravity')
      expect(withoutCaps.search).toBe('')
      expect(withoutCaps.remark).toBe('__all__')
      expect(withoutCaps.status).toBe('all')
    })
  })
})

describe('optional preview and cooldown defaults and valid explicit values in geminicli', () => {
  it('falls back to default "all" when preview or cooldown are omitted or empty', () => {
    const rawF: Filters = { ...initialFilters }
    delete rawF.preview
    delete rawF.cooldown

    const supported = supportedFilters(rawF, new Set(), 'geminicli')
    expect(supported.preview).toBe('all')
    expect(supported.cooldown).toBe('all')

    const q = listQuery(rawF, new Set(), 0, 10, 'geminicli')
    expect(q.preview_filter).toBe('all')
    expect(q.cooldown_filter).toBe('all')

    const emptyF: Filters = { ...initialFilters, preview: '', cooldown: '' }
    const qEmpty = listQuery(emptyF, new Set(), 0, 10, 'geminicli')
    expect(qEmpty.preview_filter).toBe('all')
    expect(qEmpty.cooldown_filter).toBe('all')
  })

  it('preserves valid explicit preview and cooldown filter values', () => {
    const explicitF: Filters = {
      ...initialFilters,
      preview: 'preview_only',
      cooldown: 'cooling_only',
    }
    const supported = supportedFilters(explicitF, new Set(), 'geminicli')
    expect(supported.preview).toBe('preview_only')
    expect(supported.cooldown).toBe('cooling_only')

    const q = listQuery(explicitF, new Set(), 0, 10, 'geminicli')
    expect(q.preview_filter).toBe('preview_only')
    expect(q.cooldown_filter).toBe('cooling_only')
  })
})

describe('AG cooldown precedence with group capability', () => {
  const agGroupCap: Capabilities = new Set([CAP_BY_MODE.antigravity.group])

  it('omits cooldown_filter entirely when antigravity group capability is absent', () => {
    const f: Filters = { ...initialFilters, group: 'tier1_restricted', cooldown: 'cooling_override' }
    const supported = supportedFilters(f, new Set(), 'antigravity')
    expect(supported.group).toBe('all')
    expect(supported.cooldown).toBe('all')

    const q = listQuery(f, new Set(), 0, 25, 'antigravity')
    expect(q).not.toHaveProperty('cooldown_filter')
  })

  it('gives explicit non-empty cooldown precedence over group when group capability is present', () => {
    const f: Filters = { ...initialFilters, group: 'tier1_restricted', cooldown: 'cooling_override' }
    const supported = supportedFilters(f, agGroupCap, 'antigravity')
    expect(supported.group).toBe('tier1_restricted')
    expect(supported.cooldown).toBe('cooling_override')

    const q = listQuery(f, agGroupCap, 0, 25, 'antigravity')
    expect(q.cooldown_filter).toBe('cooling_override')
  })

  it('falls back to group when cooldown is undefined or empty string with group capability present', () => {
    const fUndefined: Filters = { ...initialFilters, group: 'tier1_restricted' }
    delete fUndefined.cooldown
    const qUndefined = listQuery(fUndefined, agGroupCap, 0, 25, 'antigravity')
    expect(qUndefined.cooldown_filter).toBe('tier1_restricted')

    const fEmpty: Filters = { ...initialFilters, group: 'tier1_restricted', cooldown: '' }
    const qEmpty = listQuery(fEmpty, agGroupCap, 0, 25, 'antigravity')
    expect(qEmpty.cooldown_filter).toBe('tier1_restricted')
  })
})

describe('exact 400 and 500 error values and limit 10', () => {
  it('passes limit 10 and exact 400 and 500 error filters in listQuery', () => {
    const q400 = listQuery({ ...initialFilters, error: '400' }, new Set(), 0, 10, 'geminicli')
    expect(q400.limit).toBe(10)
    expect(q400.offset).toBe(0)
    expect(q400.error_code_filter).toBe('400')

    const q500 = listQuery({ ...initialFilters, error: '500' }, new Set(), 0, 10, 'geminicli')
    expect(q500.limit).toBe(10)
    expect(q500.offset).toBe(0)
    expect(q500.error_code_filter).toBe('500')

    const agQuery10 = listQuery({ ...initialFilters, error: '500' }, new Set(), 0, 10, 'antigravity')
    expect(agQuery10.limit).toBe(10)
    expect(agQuery10.error_code_filter).toBe('500')
  })

  it('handles exact 400 and 500 HTTP statuses and payload status_codes in manualResult', () => {
    const r400 = manualResult({ success: true }, 400)
    expect(r400.success).toBe(false)
    expect(r400.httpStatus).toBe(400)

    const r500 = manualResult({ success: true }, 500)
    expect(r500.success).toBe(false)
    expect(r500.httpStatus).toBe(500)

    const rPayload400 = manualResult({ success: true, status_code: 400 }, 200)
    expect(rPayload400.success).toBe(false)

    const rPayload500 = manualResult({ success: true, status_code: 500 }, 200)
    expect(rPayload500.success).toBe(false)
  })
})
