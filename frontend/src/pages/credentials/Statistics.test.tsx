import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CAP_BY_MODE, type Credential, type CredentialPage } from './model'
import { Statistics } from './Statistics'

function getCardValue(label: string): string | null {
  const labelEl = screen.queryByText(label)
  if (!labelEl) return null
  const card = labelEl.closest('div')
  const valueEl = card?.querySelector('.tabular-nums')
  return valueEl?.textContent ?? null
}

function createSyntheticPage(overrides?: Partial<CredentialPage>): CredentialPage {
  return {
    items: [],
    total: 25,
    hasMore: false,
    caps: new Set([CAP_BY_MODE.antigravity.permanent]),
    stats: {
      total: 100,
      normal: 70,
      disabled: 30,
      permanent_disabled: 12,
      in_cooldown: 5,
      no_cooldown: 65,
      quota_restricted: 4,
      quota_unrestricted: 60,
      quota_blocked_unknown: 1,
      quota_state_invalid: 2,
    },
    familySummary: {
      total: 42,
      family_counts: {
        'claude-opus-5-5': { supported: 10, unavailable: 2, unknown: 1 },
        'claude-opus-4-6': { supported: 8, unavailable: 0, unknown: 3 },
      },
    },
    ...overrides,
  }
}

describe('Statistics Component', () => {
  it('case 1: omitted mode and explicit AG retain original labels/family text, all six additional supplied counters appear independently, global/filtered totals differ and empty items cannot alter them', () => {
    const page = createSyntheticPage({
      items: [],
      total: 25,
      stats: {
        total: 100,
        normal: 70,
        disabled: 30,
        permanent_disabled: 12,
        in_cooldown: 5,
        no_cooldown: 65,
        quota_restricted: 4,
        quota_unrestricted: 60,
        quota_blocked_unknown: 1,
        quota_state_invalid: 2,
      },
    })

    // Sub-part A: mode is omitted (defaults to antigravity)
    const { rerender } = render(<Statistics page={page} />)

    // Original labels are retained
    expect(screen.getByText('全局凭证')).toBeInTheDocument()
    expect(screen.getByText('全局启用')).toBeInTheDocument()
    expect(screen.getByText('全局禁用')).toBeInTheDocument()
    expect(screen.getByText('全局永久禁用')).toBeInTheDocument()
    expect(screen.getByText('筛选后匹配')).toBeInTheDocument()

    // Global and filtered totals differ and are displayed accurately
    expect(getCardValue('全局凭证')).toBe('100')
    expect(getCardValue('筛选后匹配')).toBe('25')

    // Empty items cannot alter global or filtered totals
    expect(page.items).toHaveLength(0)
    expect(getCardValue('全局凭证')).not.toBe('0')
    expect(getCardValue('筛选后匹配')).not.toBe('0')

    // All six additional supplied counters appear independently with their exact values
    expect(getCardValue('冷却中')).toBe('5')
    expect(getCardValue('无冷却')).toBe('65')
    expect(getCardValue('额度受限')).toBe('4')
    expect(getCardValue('额度未受限')).toBe('60')
    expect(getCardValue('未知拦截')).toBe('1')
    expect(getCardValue('状态异常')).toBe('2')

    // Antigravity family text is retained
    expect(screen.getByText(/权限汇总：基础筛选后 42 项（跨全部分页，尚未应用版本权限筛选）。/)).toBeInTheDocument()
    expect(screen.getByText(/claude-opus-5-5：目录支持 10 \/ 暂不可用 2 \/ 待确认 1/)).toBeInTheDocument()
    expect(screen.getByText(/claude-opus-4-6：目录支持 8 \/ 暂不可用 0 \/ 待确认 3/)).toBeInTheDocument()
    expect(screen.getByText(/目录支持不代表剩余额度或已验证生成。/)).toBeInTheDocument()

    // Sub-part B: explicit AG mode with non-empty items
    const populatedItems: Credential[] = [
      { filename: 'cred-1.json' },
      { filename: 'cred-2.json' },
    ]
    const explicitAgPage = createSyntheticPage({
      items: populatedItems,
      total: 25,
      stats: {
        total: 100,
        normal: 70,
        disabled: 30,
        permanent_disabled: 12,
        in_cooldown: 5,
        no_cooldown: 65,
        quota_restricted: 4,
        quota_unrestricted: 60,
        quota_blocked_unknown: 1,
        quota_state_invalid: 2,
      },
    })
    rerender(<Statistics page={explicitAgPage} mode="antigravity" />)

    // Verify row items do not alter server aggregate totals
    expect(explicitAgPage.items).toHaveLength(2)
    expect(getCardValue('全局凭证')).toBe('100')
    expect(getCardValue('筛选后匹配')).toBe('25')

    // Counters and family output remain consistent
    expect(getCardValue('冷却中')).toBe('5')
    expect(getCardValue('无冷却')).toBe('65')
    expect(getCardValue('额度受限')).toBe('4')
    expect(getCardValue('额度未受限')).toBe('60')
    expect(getCardValue('未知拦截')).toBe('1')
    expect(getCardValue('状态异常')).toBe('2')
    expect(screen.getByText(/权限汇总：基础筛选后 42 项/)).toBeInTheDocument()
  })

  it('case 2: rerender GCLI and AG with each opposite-channel capability, verifying permanent count unlocks only for matching mode, GCLI never renders AG quota/family content even with polluted data, and common cooldown counters remain', () => {
    // Polluted synthetic page containing AG quota fields and family summary
    const pollutedPage: CredentialPage = {
      items: [],
      total: 10,
      hasMore: false,
      caps: new Set([CAP_BY_MODE.antigravity.permanent]), // opposite channel capability for GCLI
      stats: {
        total: 80,
        normal: 60,
        disabled: 20,
        permanent_disabled: 15,
        in_cooldown: 8,
        no_cooldown: 52,
        // Polluted AG fields
        quota_restricted: 99,
        quota_unrestricted: 88,
        quota_blocked_unknown: 77,
        quota_state_invalid: 66,
        quota_next_expiry: 1800000000,
      },
      familySummary: {
        total: 80,
        family_counts: {
          'claude-opus-5-5': { supported: 50, unavailable: 10, unknown: 5 },
          'claude-opus-4-6': { supported: 40, unavailable: 5, unknown: 2 },
        },
      },
    }

    // 1. Render in geminicli mode with opposite-channel permanent capability
    const { rerender } = render(<Statistics page={pollutedPage} mode="geminicli" />)

    // Permanent count must remain locked (不可用) because geminicli capability is absent
    expect(getCardValue('全局永久禁用')).toBe('不可用')

    // Common cooldown counters remain rendered and accurate
    expect(getCardValue('冷却中')).toBe('8')
    expect(getCardValue('无冷却')).toBe('52')

    // GCLI must NEVER render AG quota counters even when polluted data exists
    expect(screen.queryByText('额度受限')).toBeNull()
    expect(screen.queryByText('额度未受限')).toBeNull()
    expect(screen.queryByText('未知拦截')).toBeNull()
    expect(screen.queryByText('状态异常')).toBeNull()
    expect(screen.queryByText('99')).toBeNull()
    expect(screen.queryByText('88')).toBeNull()
    expect(screen.queryByText('77')).toBeNull()
    expect(screen.queryByText('66')).toBeNull()

    // GCLI must NEVER render AG family content
    expect(screen.queryByText(/权限汇总/)).toBeNull()
    expect(screen.queryByText(/claude-opus-5-5/)).toBeNull()
    expect(screen.queryByText(/claude-opus-4-6/)).toBeNull()
    expect(screen.queryByText(/目录支持不代表剩余额度/)).toBeNull()

    // Excluded quota_next_expiry must never appear
    expect(screen.queryByText('1800000000')).toBeNull()

    // 2. Rerender GCLI with matching channel capability
    const gcliMatchingPage: CredentialPage = {
      ...pollutedPage,
      caps: new Set([CAP_BY_MODE.geminicli.permanent]),
    }
    rerender(<Statistics page={gcliMatchingPage} mode="geminicli" />)

    // Permanent count unlocks only for matching mode
    expect(getCardValue('全局永久禁用')).toBe('15')
    expect(getCardValue('冷却中')).toBe('8')
    expect(getCardValue('无冷却')).toBe('52')
    // AG quota and family content still hidden in GCLI
    expect(screen.queryByText('额度受限')).toBeNull()
    expect(screen.queryByText(/权限汇总/)).toBeNull()

    // 3. Render in antigravity mode with opposite-channel permanent capability (geminicli)
    const agOppositePage: CredentialPage = {
      ...pollutedPage,
      caps: new Set([CAP_BY_MODE.geminicli.permanent]), // opposite channel capability for AG
    }
    rerender(<Statistics page={agOppositePage} mode="antigravity" />)

    // Permanent count must remain locked (不可用) for AG because antigravity capability is absent
    expect(getCardValue('全局永久禁用')).toBe('不可用')

    // AG quota counters ARE rendered in antigravity mode
    expect(getCardValue('额度受限')).toBe('99')
    expect(getCardValue('额度未受限')).toBe('88')
    expect(getCardValue('未知拦截')).toBe('77')
    expect(getCardValue('状态异常')).toBe('66')

    // AG family content IS rendered in antigravity mode
    expect(screen.getByText(/权限汇总：基础筛选后 80 项/)).toBeInTheDocument()

    // 4. Rerender AG with matching channel capability
    const agMatchingPage: CredentialPage = {
      ...pollutedPage,
      caps: new Set([CAP_BY_MODE.antigravity.permanent]),
    }
    rerender(<Statistics page={agMatchingPage} mode="antigravity" />)

    // Permanent count unlocks for matching AG mode
    expect(getCardValue('全局永久禁用')).toBe('15')
  })

  it('case 3: parameterized valid zero versus absent/null/negative/fractional/string values stays accurate and unavailable values never become zero', () => {
    // Part A: Valid zero values across all counters stay exactly 0
    const zeroPage: CredentialPage = {
      items: [],
      total: 0,
      hasMore: false,
      caps: new Set([CAP_BY_MODE.antigravity.permanent]),
      stats: {
        total: 0,
        normal: 0,
        disabled: 0,
        permanent_disabled: 0,
        in_cooldown: 0,
        no_cooldown: 0,
        quota_restricted: 0,
        quota_unrestricted: 0,
        quota_blocked_unknown: 0,
        quota_state_invalid: 0,
        quota_next_expiry: 0,
      },
      familySummary: {
        total: 0,
        family_counts: {
          'claude-opus-5-5': { supported: 0, unavailable: 0, unknown: 0 },
          'claude-opus-4-6': { supported: 0, unavailable: 0, unknown: 0 },
        },
      },
    }

    const { rerender } = render(<Statistics page={zeroPage} mode="antigravity" />)

    const expectedLabels = [
      '全局凭证',
      '全局启用',
      '全局禁用',
      '全局永久禁用',
      '筛选后匹配',
      '冷却中',
      '无冷却',
      '额度受限',
      '额度未受限',
      '未知拦截',
      '状态异常',
    ]

    for (const label of expectedLabels) {
      const val = getCardValue(label)
      expect(val).toBe('0')
      expect(val).not.toBe('不可用')
    }

    // Excluded quota_next_expiry must not be rendered as a card
    expect(screen.queryByText(/quota_next_expiry/i)).toBeNull()

    // Part B: Parameterized test for invalid, negative, fractional, string, and absent inputs
    const testCases: Array<{ label: string; key: string; invalidValue: unknown; desc: string }> = [
      { label: '冷却中', key: 'in_cooldown', invalidValue: undefined, desc: 'absent undefined' },
      { label: '冷却中', key: 'in_cooldown', invalidValue: null, desc: 'null' },
      { label: '冷却中', key: 'in_cooldown', invalidValue: -1, desc: 'negative integer -1' },
      { label: '冷却中', key: 'in_cooldown', invalidValue: 3.14, desc: 'fractional float 3.14' },
      { label: '冷却中', key: 'in_cooldown', invalidValue: '0', desc: 'numeric string "0"' },
      { label: '冷却中', key: 'in_cooldown', invalidValue: 'abc', desc: 'string text' },
      { label: '冷却中', key: 'in_cooldown', invalidValue: NaN, desc: 'NaN' },
      { label: '无冷却', key: 'no_cooldown', invalidValue: undefined, desc: 'absent undefined' },
      { label: '无冷却', key: 'no_cooldown', invalidValue: -42, desc: 'negative integer -42' },
      { label: '无冷却', key: 'no_cooldown', invalidValue: 0.5, desc: 'fractional float 0.5' },
      { label: '无冷却', key: 'no_cooldown', invalidValue: 'no_cooldown', desc: 'string text' },
      { label: '额度受限', key: 'quota_restricted', invalidValue: null, desc: 'null' },
      { label: '额度受限', key: 'quota_restricted', invalidValue: -5, desc: 'negative integer -5' },
      { label: '额度受限', key: 'quota_restricted', invalidValue: '5', desc: 'numeric string "5"' },
      { label: '额度未受限', key: 'quota_unrestricted', invalidValue: undefined, desc: 'absent undefined' },
      { label: '额度未受限', key: 'quota_unrestricted', invalidValue: -10, desc: 'negative integer -10' },
      { label: '未知拦截', key: 'quota_blocked_unknown', invalidValue: null, desc: 'null' },
      { label: '未知拦截', key: 'quota_blocked_unknown', invalidValue: 1.99, desc: 'fractional 1.99' },
      { label: '状态异常', key: 'quota_state_invalid', invalidValue: 'invalid', desc: 'string text' },
      { label: '状态异常', key: 'quota_state_invalid', invalidValue: -1, desc: 'negative integer -1' },
      { label: '全局永久禁用', key: 'permanent_disabled', invalidValue: -1, desc: 'negative integer -1' },
      { label: '全局永久禁用', key: 'permanent_disabled', invalidValue: null, desc: 'null' },
      { label: '全局凭证', key: 'total', invalidValue: -1, desc: 'negative integer -1' },
      { label: '全局启用', key: 'normal', invalidValue: 'active', desc: 'string text' },
      { label: '全局禁用', key: 'disabled', invalidValue: 2.718, desc: 'fractional float 2.718' },
    ]

    for (const tc of testCases) {
      const statsObj: Record<string, unknown> = {
        total: 10,
        normal: 8,
        disabled: 2,
        permanent_disabled: 1,
        in_cooldown: 0,
        no_cooldown: 8,
        quota_restricted: 0,
        quota_unrestricted: 8,
        quota_blocked_unknown: 0,
        quota_state_invalid: 0,
      }
      if (tc.invalidValue === undefined) {
        delete statsObj[tc.key]
      } else {
        statsObj[tc.key] = tc.invalidValue
      }

      const invalidPage: CredentialPage = {
        items: [],
        total: 10,
        hasMore: false,
        caps: new Set([CAP_BY_MODE.antigravity.permanent]),
        stats: statsObj,
        familySummary: { total: 0, family_counts: {} },
      }

      rerender(<Statistics page={invalidPage} mode="antigravity" />)
      const val = getCardValue(tc.label)
      expect(val, `Expected ${tc.label} with ${tc.desc} to be 不可用`).toBe('不可用')
      expect(val, `Expected ${tc.label} with ${tc.desc} never to be 0`).not.toBe('0')
    }
  })
})
