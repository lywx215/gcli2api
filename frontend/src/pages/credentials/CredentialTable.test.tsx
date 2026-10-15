import { describe, it, expect, vi } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'
import { CredentialTable } from './CredentialTable'
import type { Credential } from './model'

const syntheticAgRow: Credential = {
  filename: 'cred-ag-alpha.json',
  user_email: 'ag-alpha@example.invalid',
  disabled: false,
  permanent_disabled: false,
  tier: 'tier-ag-standard',
  remark: 'Remark AG Alpha',
  quota_groups: {
    'gemini-shared': { restricted: false, blockedUnknown: false, cooldownUntil: null },
    'claude-gpt-shared': { restricted: true, blockedUnknown: false, cooldownUntil: 1800000000 },
  },
  quota_group_states: {
    'gemini-shared': { state: 'normal' },
    'claude-gpt-shared': { state: 'normal' },
  },
  model_access_families: {
    'claude-opus-5-5': { state: 'supported', checked_at: Math.floor(Date.now() / 1000) },
  },
}

const syntheticGcliRow1: Credential = {
  filename: 'cred-gcli-1.json',
  user_email: 'gcli-1@example.invalid',
  disabled: false,
  permanent_disabled: false,
  health_status: 'healthy',
  preview: true,
  tier: 'tier-pro',
  tier_raw_id: 'raw-id-pro',
  tier_raw_name: 'Pro Standard Raw',
  remark: 'Remark GCLI 1',
  model_cooldowns: {
    'gemini-1.5-pro': 1750000000,
  },
  quota_groups: {
    'gemini-shared': { restricted: true, blockedUnknown: true },
    'claude-gpt-shared': { restricted: true, blockedUnknown: true },
  },
  model_access_families: {
    'claude-opus-5-5': { state: 'supported', checked_at: Math.floor(Date.now() / 1000) },
  },
}

const syntheticGcliRow2: Credential = {
  filename: 'cred-gcli-2.json',
  user_email: 'gcli-2@example.invalid',
  disabled: true,
  permanent_disabled: false,
  health_status: 'risk_quarantined',
  preview: false,
  tier: 'tier-starter',
  tier_raw_id: 'raw-id-starter',
  tier_raw_name: 'Starter Plan Raw',
  remark: 'Remark GCLI 2',
  model_cooldowns: {},
}

const syntheticHostileRow1: Credential = {
  filename: 'cred-hostile-1.json',
  user_email: 'hostile-1@example.invalid',
  disabled: true,
  permanent_disabled: true,
  health_status: 'nonexistent_status_value',
  preview: 'true' as unknown as boolean,
  tier: { raw: 'object_must_not_leak' } as unknown as string,
  tier_raw_id: 12345 as unknown as string,
  tier_raw_name: ['bad', 'array'] as unknown as string,
  model_cooldowns: { 'model-neg': -500 } as unknown as Record<string, number>,
}

const syntheticHostileRow2: Credential = {
  filename: 'cred-hostile-2.json',
  user_email: 'hostile-2@example.invalid',
  disabled: false,
  permanent_disabled: false,
  health_status: null,
  preview: null,
  tier: null,
  tier_raw_id: null,
  tier_raw_name: null,
  model_cooldowns: 'not-an-object' as unknown as Record<string, number>,
}

describe('CredentialTable', () => {
  it('retains AG quota groups, desktop Opus badge, and interaction triggers when mode is omitted or antigravity', () => {
    const toggle = vi.fn()
    const open = vi.fn()
    const openQuota = vi.fn()
    const selected = new Set<string>()

    const { rerender } = render(
      <CredentialTable
        rows={[syntheticAgRow]}
        selected={selected}
        toggle={toggle}
        open={open}
        openQuota={openQuota}
        quotaCapabilityEnabled={true}
      />
    )

    const desktop = screen.getByTestId('desktop-branch')
    const mobile = screen.getByTestId('mobile-branch')

    expect(within(desktop).getByText('cred-ag-alpha.json')).toBeInTheDocument()
    expect(within(desktop).getByText('ag-alpha@example.invalid')).toBeInTheDocument()
    expect(within(desktop).getByText('已启用')).toBeInTheDocument()
    expect(within(desktop).getByText('tier-ag-standard')).toBeInTheDocument()
    expect(within(desktop).getByText(/Gemini：/)).toBeInTheDocument()
    expect(within(desktop).getByText(/Claude \/ GPT：/)).toBeInTheDocument()
    expect(within(desktop).getByText(/Opus 5\.5：目录支持/)).toBeInTheDocument()
    expect(within(desktop).getByText('Remark AG Alpha')).toBeInTheDocument()

    expect(within(mobile).getByText('cred-ag-alpha.json')).toBeInTheDocument()
    expect(within(mobile).getByText(/Gemini：/)).toBeInTheDocument()
    expect(within(mobile).getByText(/Claude \/ GPT：/)).toBeInTheDocument()
    expect(within(mobile).queryByText(/Opus 5\.5/)).not.toBeInTheDocument()

    fireEvent.click(within(desktop).getByRole('button', { name: 'cred-ag-alpha.json' }))
    expect(open).toHaveBeenCalledWith('cred-ag-alpha.json', 'desktop-name')

    fireEvent.click(within(desktop).getByRole('button', { name: '详情与操作' }))
    expect(open).toHaveBeenCalledWith('cred-ag-alpha.json', 'desktop-detail')

    fireEvent.click(within(mobile).getByRole('button', { name: '详情与操作' }))
    expect(open).toHaveBeenCalledWith('cred-ag-alpha.json', 'mobile-detail')

    fireEvent.click(within(desktop).getByRole('button', { name: '查看额度' }))
    expect(openQuota).toHaveBeenCalledWith('cred-ag-alpha.json', 'desktop-quota')

    fireEvent.click(within(mobile).getByRole('button', { name: '查看额度' }))
    expect(openQuota).toHaveBeenCalledWith('cred-ag-alpha.json', 'mobile-quota')

    rerender(
      <CredentialTable
        mode="antigravity"
        rows={[syntheticAgRow]}
        selected={selected}
        toggle={toggle}
        open={open}
        openQuota={openQuota}
        quotaCapabilityEnabled={false}
      />
    )

    const desktopQuotaBtn = within(desktop).getByRole('button', { name: '查看额度' })
    const mobileQuotaBtn = within(mobile).getByRole('button', { name: '查看额度' })
    expect(desktopQuotaBtn).toBeDisabled()
    expect(desktopQuotaBtn).toHaveAttribute('title', '当前服务未启用额度查询能力')
    expect(mobileQuotaBtn).toBeDisabled()
    expect(mobileQuotaBtn).toHaveAttribute('title', '当前服务未启用额度查询能力')
  })

  it('suppresses AG decorations and exposes literal Preview, safe tier, raw tier, health labels, and model cooldowns in both GCLI branches', () => {
    const toggle = vi.fn()
    const open = vi.fn()
    const openQuota = vi.fn()
    const selected = new Set<string>()

    const { rerender } = render(
      <CredentialTable
        mode="geminicli"
        rows={[syntheticGcliRow1, syntheticGcliRow2]}
        selected={selected}
        toggle={toggle}
        open={open}
        openQuota={openQuota}
        quotaCapabilityEnabled={true}
      />
    )

    const desktop = screen.getByTestId('desktop-branch')
    const mobile = screen.getByTestId('mobile-branch')

    expect(within(desktop).queryByText(/Gemini：/)).not.toBeInTheDocument()
    expect(within(desktop).queryByText(/Claude \/ GPT：/)).not.toBeInTheDocument()
    expect(within(desktop).queryByText(/Opus 5\.5/)).not.toBeInTheDocument()
    expect(within(mobile).queryByText(/Gemini：/)).not.toBeInTheDocument()
    expect(within(mobile).queryByText(/Claude \/ GPT：/)).not.toBeInTheDocument()

    expect(within(desktop).getByText('Preview: true')).toBeInTheDocument()
    expect(within(desktop).getByText('Preview: false')).toBeInTheDocument()
    expect(within(mobile).getByText('Preview: true')).toBeInTheDocument()
    expect(within(mobile).getByText('Preview: false')).toBeInTheDocument()

    expect(within(desktop).getByText('tier-pro')).toBeInTheDocument()
    expect(within(desktop).getByText('原始：Pro Standard Raw (raw-id-pro)')).toBeInTheDocument()
    expect(within(mobile).getByText('tier-pro')).toBeInTheDocument()
    expect(within(mobile).getByText('原始：Pro Standard Raw (raw-id-pro)')).toBeInTheDocument()

    expect(within(desktop).getByText('tier-starter')).toBeInTheDocument()
    expect(within(desktop).getByText('原始：Starter Plan Raw (raw-id-starter)')).toBeInTheDocument()
    expect(within(mobile).getByText('tier-starter')).toBeInTheDocument()
    expect(within(mobile).getByText('原始：Starter Plan Raw (raw-id-starter)')).toBeInTheDocument()

    expect(within(desktop).getByText('正常')).toBeInTheDocument()
    expect(within(desktop).getByText('风险隔离')).toBeInTheDocument()
    expect(within(mobile).getByText('正常')).toBeInTheDocument()
    expect(within(mobile).getByText('风险隔离')).toBeInTheDocument()

    expect(within(desktop).getByText(/gemini-1\.5-pro：冷却至/)).toBeInTheDocument()
    expect(within(desktop).getByText('模型冷却：无')).toBeInTheDocument()
    expect(within(mobile).getByText(/gemini-1\.5-pro：冷却至/)).toBeInTheDocument()
    expect(within(mobile).getByText('模型冷却：无')).toBeInTheDocument()

    expect(within(desktop).getByText('已启用')).toBeInTheDocument()
    expect(within(desktop).getByText('已禁用')).toBeInTheDocument()

    const checkingRow: Credential = {
      ...syntheticGcliRow1,
      filename: 'gcli-checking.json',
      health_status: 'checking',
    }
    const reviewRow: Credential = {
      ...syntheticGcliRow2,
      filename: 'gcli-review.json',
      health_status: 'manual_review',
    }
    rerender(
      <CredentialTable
        mode="geminicli"
        rows={[checkingRow, reviewRow]}
        selected={selected}
        toggle={toggle}
        open={open}
        openQuota={openQuota}
        quotaCapabilityEnabled={true}
      />
    )
    expect(within(desktop).getByText('检查中')).toBeInTheDocument()
    expect(within(desktop).getByText('人工复核')).toBeInTheDocument()
    expect(within(mobile).getByText('检查中')).toBeInTheDocument()
    expect(within(mobile).getByText('人工复核')).toBeInTheDocument()
  })

  it('keeps malformed or unrecognized GCLI fields unknown without leaks, coercion, or inferred health in both branches', () => {
    const toggle = vi.fn()
    const open = vi.fn()
    const selected = new Set<string>()

    render(
      <CredentialTable
        mode="geminicli"
        rows={[syntheticHostileRow1, syntheticHostileRow2]}
        selected={selected}
        toggle={toggle}
        open={open}
      />
    )

    const desktop = screen.getByTestId('desktop-branch')
    const mobile = screen.getByTestId('mobile-branch')

    for (const branch of [desktop, mobile]) {
      const healthBadges = within(branch).getAllByText('未知')
      expect(healthBadges.length).toBeGreaterThanOrEqual(2)
      expect(within(branch).queryByText('正常')).not.toBeInTheDocument()
      expect(within(branch).queryByText('风险隔离')).not.toBeInTheDocument()

      const previewUnknowns = within(branch).getAllByText('Preview: 未知')
      expect(previewUnknowns.length).toBe(2)
      expect(within(branch).queryByText('Preview: true')).not.toBeInTheDocument()

      expect(within(branch).queryByText(/object_must_not_leak/)).not.toBeInTheDocument()
      expect(within(branch).queryByText(/\[object Object\]/)).not.toBeInTheDocument()
      expect(within(branch).queryByText(/12345/)).not.toBeInTheDocument()
      expect(within(branch).queryByText(/bad/)).not.toBeInTheDocument()

      const cooldownUnknowns = within(branch).getAllByText('模型冷却：未知')
      expect(cooldownUnknowns.length).toBe(2)
      expect(within(branch).queryByText(/model-neg/)).not.toBeInTheDocument()

      expect(within(branch).getByText('永久禁用')).toBeInTheDocument()
      expect(within(branch).getByText('已启用')).toBeInTheDocument()
    }
  })

  it('manages selection, select-all toggle, individual rows, and disabled gates across desktop and mobile branches', () => {
    const toggle = vi.fn()
    const open = vi.fn()
    const openQuota = vi.fn()
    const rows = [syntheticGcliRow1, syntheticGcliRow2]

    const { rerender } = render(
      <CredentialTable
        mode="geminicli"
        rows={rows}
        selected={new Set()}
        toggle={toggle}
        open={open}
        openQuota={openQuota}
        quotaCapabilityEnabled={true}
      />
    )

    const desktop = screen.getByTestId('desktop-branch')
    const mobile = screen.getByTestId('mobile-branch')

    const selectAllCheckbox = within(desktop).getByRole('checkbox', { name: '选择当前页' })
    expect(selectAllCheckbox).toHaveAttribute('data-state', 'unchecked')
    fireEvent.click(selectAllCheckbox)
    expect(toggle).toHaveBeenCalledWith(['cred-gcli-1.json', 'cred-gcli-2.json'], true)

    const desktopRow1Checkbox = within(desktop).getByRole('checkbox', { name: '选择 cred-gcli-1.json' })
    expect(desktopRow1Checkbox).toHaveAttribute('data-state', 'unchecked')
    fireEvent.click(desktopRow1Checkbox)
    expect(toggle).toHaveBeenCalledWith(['cred-gcli-1.json'], true)

    const mobileRow2Checkbox = within(mobile).getByRole('checkbox', { name: '移动选择 cred-gcli-2.json' })
    expect(mobileRow2Checkbox).toHaveAttribute('data-state', 'unchecked')
    fireEvent.click(mobileRow2Checkbox)
    expect(toggle).toHaveBeenCalledWith(['cred-gcli-2.json'], true)

    rerender(
      <CredentialTable
        mode="geminicli"
        rows={rows}
        selected={new Set(['cred-gcli-1.json'])}
        toggle={toggle}
        open={open}
        openQuota={openQuota}
        quotaCapabilityEnabled={true}
      />
    )
    expect(within(desktop).getByRole('checkbox', { name: '选择当前页' })).toHaveAttribute('data-state', 'indeterminate')

    rerender(
      <CredentialTable
        mode="geminicli"
        rows={rows}
        selected={new Set(['cred-gcli-1.json', 'cred-gcli-2.json'])}
        toggle={toggle}
        open={open}
        openQuota={openQuota}
        quotaCapabilityEnabled={true}
      />
    )
    const allCheckedCheckbox = within(desktop).getByRole('checkbox', { name: '选择当前页' })
    expect(allCheckedCheckbox).toHaveAttribute('data-state', 'checked')
    fireEvent.click(allCheckedCheckbox)
    expect(toggle).toHaveBeenCalledWith(['cred-gcli-1.json', 'cred-gcli-2.json'], false)

    rerender(
      <CredentialTable
        mode="geminicli"
        rows={rows}
        selected={new Set()}
        toggle={toggle}
        open={open}
        openQuota={openQuota}
        quotaCapabilityEnabled={true}
        disabled={true}
      />
    )
    expect(within(desktop).getByRole('checkbox', { name: '选择当前页' })).toBeDisabled()
    expect(within(desktop).getByRole('checkbox', { name: '选择 cred-gcli-1.json' })).toBeDisabled()
    expect(within(mobile).getByRole('checkbox', { name: '移动选择 cred-gcli-1.json' })).toBeDisabled()
    expect(within(desktop).getAllByRole('button', { name: '查看额度' })[0]).toBeDisabled()
    expect(within(mobile).getAllByRole('button', { name: '查看额度' })[0]).toBeDisabled()

    rerender(
      <CredentialTable
        mode="geminicli"
        rows={[]}
        selected={new Set()}
        toggle={toggle}
        open={open}
      />
    )
    expect(within(desktop).getByRole('checkbox', { name: '选择当前页' })).toBeDisabled()
  })

  it('formats valid Unix seconds cooldowns without milliseconds inference and falls back to unknown for out-of-range or nonfinite deadlines in both branches', () => {
    const toggle = vi.fn()
    const open = vi.fn()
    const selected = new Set<string>()

    const validRow: Credential = {
      filename: 'cred-valid-cooldowns.json',
      user_email: 'valid-cooldowns@example.invalid',
      disabled: false,
      permanent_disabled: false,
      model_cooldowns: {
        'model-large': 1e12,
        'model-zero': 0,
        'model-frac': 1750000000.5,
      },
    }

    const { rerender } = render(
      <CredentialTable
        mode="geminicli"
        rows={[validRow]}
        selected={selected}
        toggle={toggle}
        open={open}
      />
    )

    const desktop = screen.getByTestId('desktop-branch')
    const mobile = screen.getByTestId('mobile-branch')

    const expectedLarge = `model-large：冷却至 ${new Date(1e12 * 1000).toLocaleString()}`
    const expectedZero = `model-zero：冷却至 ${new Date(0).toLocaleString()}`
    const expectedFrac = `model-frac：冷却至 ${new Date(1750000000.5 * 1000).toLocaleString()}`
    const inferredMsDate = new Date(1e12).toLocaleString()

    for (const branch of [desktop, mobile]) {
      expect(within(branch).getByText(expectedLarge)).toBeInTheDocument()
      expect(within(branch).getByText(expectedZero)).toBeInTheDocument()
      expect(within(branch).getByText(expectedFrac)).toBeInTheDocument()
      expect(within(branch).queryByText(/Invalid Date/i)).not.toBeInTheDocument()
      expect(within(branch).queryByText(new RegExp(inferredMsDate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).not.toBeInTheDocument()
      expect(within(branch).queryByText(/2001/)).not.toBeInTheDocument()
    }

    const outOfRangeRow: Credential = {
      filename: 'cred-out-of-range.json',
      user_email: 'out-of-range@example.invalid',
      disabled: false,
      permanent_disabled: false,
      model_cooldowns: {
        'model-huge': 1e20,
      },
    }

    const infRow: Credential = {
      filename: 'cred-inf.json',
      user_email: 'inf@example.invalid',
      disabled: false,
      permanent_disabled: false,
      model_cooldowns: {
        'model-inf': Number.POSITIVE_INFINITY,
      },
    }

    const nanRow: Credential = {
      filename: 'cred-nan.json',
      user_email: 'nan@example.invalid',
      disabled: false,
      permanent_disabled: false,
      model_cooldowns: {
        'model-nan': Number.NaN,
      },
    }

    rerender(
      <CredentialTable
        mode="geminicli"
        rows={[outOfRangeRow, infRow, nanRow]}
        selected={selected}
        toggle={toggle}
        open={open}
      />
    )

    for (const branch of [desktop, mobile]) {
      const unknowns = within(branch).getAllByText('模型冷却：未知')
      expect(unknowns.length).toBe(3)
      expect(within(branch).queryByText(/Invalid Date/i)).not.toBeInTheDocument()
      expect(within(branch).queryByText(/1e20/)).not.toBeInTheDocument()
      expect(within(branch).queryByText(/model-huge/)).not.toBeInTheDocument()
      expect(within(branch).queryByText(/model-inf/)).not.toBeInTheDocument()
      expect(within(branch).queryByText(/model-nan/)).not.toBeInTheDocument()
      expect(within(branch).queryByText(/Infinity/)).not.toBeInTheDocument()
      expect(within(branch).queryByText(/NaN/)).not.toBeInTheDocument()
    }
  })
})
