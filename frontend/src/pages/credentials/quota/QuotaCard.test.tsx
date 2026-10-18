/**
 * CLIProxy QuotaCard unit tests for copy localization, brand preservation,
 * and GPT-OSS removal. Synthetic data only.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QuotaCard } from './QuotaCard';
import type { QuotaSummary } from './types';

describe('QuotaCard Component Copy & Localization', () => {
  const dummyOnRefresh = vi.fn();

  it('renders Gemini model group with target Chinese copy and brand casing', () => {
    const summary: QuotaSummary = {
      status: 'available',
      source: 'antigravity_quota_summary',
      captured_at: '2026-10-16T08:00:00Z',
      upstream_status: 200,
      reason: null,
      groups: [
        {
          group_id: 'gemini_group',
          display_name: 'Gemini Models',
          description: 'Models within this group: Gemini Flash, Gemini Pro',
          buckets: [
            {
              bucket_id: 'b_5h',
              display_name: 'Five Hour Limit Remaining',
              raw_window: '5h',
              window: '5h',
              remaining_fraction: 1.0,
              reset_at: '2026-10-16T12:00:00Z',
            },
            {
              bucket_id: 'b_weekly',
              display_name: 'Weekly Limit Remaining',
              raw_window: 'weekly',
              window: 'weekly',
              remaining_fraction: 0.75,
              reset_at: '2026-10-23T00:00:00Z',
            },
          ],
        },
      ],
    };

    render(
      <QuotaCard
        filename="synth-account-01.json"
        mode="antigravity"
        summary={summary}
        onRefresh={dummyOnRefresh}
      />
    );

    // Title must display 'Gemini 模型'
    expect(screen.getByText('Gemini 模型')).toBeInTheDocument();

    // Description must display '包含模型：Gemini Flash、Gemini Pro'
    expect(
      screen.getByText('包含模型：Gemini Flash、Gemini Pro')
    ).toBeInTheDocument();

    // 5h and weekly quota labels
    expect(screen.getByText('5小时剩余额度')).toBeInTheDocument();
    expect(screen.getByText('每周剩余额度')).toBeInTheDocument();

    // 100% semantics
    expect(screen.getByText('100% · 额度可用')).toBeInTheDocument();
    expect(screen.getByText('75%')).toBeInTheDocument();

    // Filename must not be translated
    expect(screen.getByText('synth-account-01.json')).toBeInTheDocument();
  });

  it('filters GPT-OSS from Claude mixed group while keeping Claude and real quota data', () => {
    const summary: QuotaSummary = {
      status: 'available',
      source: 'antigravity_quota_summary',
      captured_at: '2026-10-16T08:00:00Z',
      upstream_status: 200,
      reason: null,
      groups: [
        {
          group_id: 'claude_and_gpt_group',
          display_name: 'Claude and GPT Models',
          description:
            'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
          buckets: [
            {
              bucket_id: 'claude_gpt_5h',
              display_name: 'Five Hour Limit Remaining',
              raw_window: '5h',
              window: '5h',
              remaining_fraction: 0.85,
              reset_at: '2026-10-16T13:00:00Z',
            },
            {
              bucket_id: 'claude_gpt_weekly',
              display_name: 'Weekly Limit Remaining',
              raw_window: 'weekly',
              window: 'weekly',
              remaining_fraction: 0.0,
              reset_at: '2026-10-20T00:00:00Z',
            },
          ],
        },
      ],
    };

    const { container } = render(
      <QuotaCard
        filename="synth-hybrid-02.json"
        mode="antigravity"
        summary={summary}
        onRefresh={dummyOnRefresh}
      />
    );

    // Title must display 'Claude模型'
    expect(screen.getByText('Claude模型')).toBeInTheDocument();

    // Description must contain Claude models and omit GPT-OSS
    expect(
      screen.getByText('包含模型：Claude Opus、Claude Sonnet')
    ).toBeInTheDocument();

    // Real fraction values preserved: 85% and 0%
    expect(screen.getByText('85%')).toBeInTheDocument();
    expect(screen.getByText('0%')).toBeInTheDocument();

    // Entire container must not contain "GPT" or "GPT-OSS" text
    expect(container.textContent).not.toContain('GPT-OSS');
    expect(container.textContent).not.toContain('GPT');

    // ARIA label must use clean display title without GPT-OSS
    const meterBars = container.querySelectorAll('.qc-bar');
    expect(meterBars[0]).toHaveAttribute(
      'aria-label',
      'Claude模型 5小时剩余额度'
    );
    expect(meterBars[1]).toHaveAttribute(
      'aria-label',
      'Claude模型 每周剩余额度'
    );
  });

  it('hides standalone GPT-OSS group completely while preserving other groups', () => {
    const summary: QuotaSummary = {
      status: 'available',
      source: 'antigravity_quota_summary',
      captured_at: '2026-10-16T08:00:00Z',
      upstream_status: 200,
      reason: null,
      groups: [
        {
          group_id: 'gpt_oss_only',
          display_name: 'GPT-OSS Models',
          description: 'Models within this group: GPT-OSS',
          buckets: [
            {
              bucket_id: 'gpt_5h',
              display_name: 'Five Hour Limit Remaining',
              raw_window: '5h',
              window: '5h',
              remaining_fraction: 0.5,
              reset_at: null,
            },
          ],
        },
        {
          group_id: 'gemini_group',
          display_name: 'Gemini Models',
          description: 'Models within this group: Gemini Flash',
          buckets: [
            {
              bucket_id: 'gem_5h',
              display_name: 'Five Hour Limit Remaining',
              raw_window: '5h',
              window: '5h',
              remaining_fraction: 0.9,
              reset_at: null,
            },
          ],
        },
      ],
    };

    const { container } = render(
      <QuotaCard
        filename="synth-filter-03.json"
        mode="antigravity"
        summary={summary}
        onRefresh={dummyOnRefresh}
      />
    );

    // Standalone GPT-OSS group should not be rendered
    expect(screen.queryByText('GPT-OSS Models')).not.toBeInTheDocument();
    expect(container.textContent).not.toContain('GPT-OSS');

    // Other group remains visible
    expect(screen.getByText('Gemini 模型')).toBeInTheDocument();
    expect(screen.getByText('包含模型：Gemini Flash')).toBeInTheDocument();
    expect(screen.getByText('90%')).toBeInTheDocument();
  });

  it('renders placeholders for missing 5h and weekly windows without fabricating data', () => {
    const summary: QuotaSummary = {
      status: 'partial',
      source: 'geminicli_retrieve_user_quota',
      captured_at: '2026-10-16T08:00:00Z',
      upstream_status: 200,
      reason: 'Partially loaded',
      groups: [
        {
          group_id: 'empty_group',
          display_name: 'Gemini Models',
          description: null,
          buckets: [], // No buckets at all
        },
      ],
    };

    render(
      <QuotaCard
        filename="synth-placeholder-04.json"
        mode="geminicli"
        summary={summary}
        onRefresh={dummyOnRefresh}
      />
    );

    expect(screen.getByText('Gemini 模型')).toBeInTheDocument();
    expect(screen.getByText('5小时剩余额度')).toBeInTheDocument();
    expect(screen.getByText('每周剩余额度')).toBeInTheDocument();

    // Placeholders have '未知' for fraction and '未提供' for reset
    const unavailLabels = screen.getAllByText('未知');
    expect(unavailLabels.length).toBeGreaterThanOrEqual(2);

    const resetLabels = screen.getAllByText('未提供');
    expect(resetLabels.length).toBeGreaterThanOrEqual(2);
  });

  it('preserves unknown brand names and does not guess unknown windows', () => {
    const summary: QuotaSummary = {
      status: 'available',
      source: 'antigravity_quota_summary',
      captured_at: '2026-10-16T08:00:00Z',
      upstream_status: 200,
      reason: null,
      groups: [
        {
          group_id: 'custom_brand_group',
          display_name: 'Custom Research AI',
          description: 'Special experiment cluster',
          buckets: [
            {
              bucket_id: 'b_5h',
              display_name: '5小时限额',
              raw_window: '5h',
              window: '5h',
              remaining_fraction: 0.6,
              reset_at: null,
            },
            {
              bucket_id: 'b_custom',
              display_name: 'Burst Execution Allowance',
              raw_window: null,
              window: 'unknown',
              remaining_fraction: 0.4,
              reset_at: null,
            },
            {
              bucket_id: 'b_daily',
              display_name: 'Daily Limit Remaining',
              raw_window: 'daily',
              window: 'daily',
              remaining_fraction: 0.5,
              reset_at: null,
            },
          ],
        },
      ],
    };

    render(
      <QuotaCard
        filename="synth-unknown-05.json"
        mode="antigravity"
        summary={summary}
        onRefresh={dummyOnRefresh}
      />
    );

    // Unknown brand name remains verbatim
    expect(screen.getByText('Custom Research AI')).toBeInTheDocument();
    expect(screen.getByText('Special experiment cluster')).toBeInTheDocument();

    // Known 5h window mapped to Chinese
    expect(screen.getByText('5小时剩余额度')).toBeInTheDocument();

    // Known daily window mapped to Chinese
    expect(screen.getByText('每日剩余额度')).toBeInTheDocument();

    // Unknown window name remains verbatim, not guessed
    expect(screen.getByText('Burst Execution Allowance')).toBeInTheDocument();
  });

  it('preserves GPT-4 unknown group, description, and buckets with verbatim intrinsic branding', () => {
    const summary: QuotaSummary = {
      status: 'available',
      source: 'antigravity_quota_summary',
      captured_at: '2026-10-16T08:00:00Z',
      upstream_status: 200,
      reason: null,
      groups: [
        {
          group_id: 'gpt_4_research_group',
          display_name: 'GPT-4 Models',
          description: 'Models within this group: GPT-4, GPT-4o',
          buckets: [
            {
              bucket_id: 'gpt_4_5h',
              display_name: 'Five Hour Limit Remaining',
              raw_window: '5h',
              window: '5h',
              remaining_fraction: 0.9,
              reset_at: '2026-10-16T12:00:00Z',
            },
            {
              bucket_id: 'gpt_4_weekly',
              display_name: 'Weekly Limit Remaining',
              raw_window: 'weekly',
              window: 'weekly',
              remaining_fraction: 0.6,
              reset_at: '2026-10-23T00:00:00Z',
            },
            {
              bucket_id: 'gpt_4_custom',
              display_name: 'GPT-4 Burst Allowance',
              raw_window: null,
              window: 'unknown',
              remaining_fraction: 0.4,
              reset_at: null,
            },
          ],
        },
      ],
    };

    render(
      <QuotaCard
        filename="synth-gpt4-06.json"
        mode="antigravity"
        summary={summary}
        onRefresh={dummyOnRefresh}
      />
    );

    // Group title must retain 'GPT-4 Models' (not stripped or mapped to Claude)
    expect(screen.getByText('GPT-4 Models')).toBeInTheDocument();

    // Group description must retain 'GPT-4' and 'GPT-4o'
    expect(
      screen.getByText('包含模型：GPT-4、GPT-4o')
    ).toBeInTheDocument();

    // Windows
    expect(screen.getByText('5小时剩余额度')).toBeInTheDocument();
    expect(screen.getByText('每周剩余额度')).toBeInTheDocument();

    // Custom bucket name containing 'GPT-4' preserved
    expect(screen.getByText('GPT-4 Burst Allowance')).toBeInTheDocument();

    // Real fraction values
    expect(screen.getByText('90%')).toBeInTheDocument();
    expect(screen.getByText('60%')).toBeInTheDocument();
    expect(screen.getByText('40%')).toBeInTheDocument();
  });

  it('does not hide unknown mixed group containing GPT-OSS and removes GPT-OSS label while preserving other brands', () => {
    const summary: QuotaSummary = {
      status: 'available',
      source: 'antigravity_quota_summary',
      captured_at: '2026-10-16T08:00:00Z',
      upstream_status: 200,
      reason: null,
      groups: [
        {
          group_id: 'mistral_and_gpt_oss_group',
          display_name: 'Mistral and GPT-OSS Models',
          description: 'Models within this group: Mistral Large, GPT-OSS',
          buckets: [
            {
              bucket_id: 'm_5h',
              display_name: 'Five Hour Limit Remaining',
              raw_window: '5h',
              window: '5h',
              remaining_fraction: 0.65,
              reset_at: '2026-10-16T12:00:00Z',
            },
            {
              bucket_id: 'm_weekly',
              display_name: 'Weekly Limit Remaining',
              raw_window: 'weekly',
              window: 'weekly',
              remaining_fraction: 0.45,
              reset_at: '2026-10-23T00:00:00Z',
            },
            {
              bucket_id: 'm_other',
              display_name: 'Mistral and GPT-OSS Burst Allowance',
              raw_window: null,
              window: 'unknown',
              remaining_fraction: 0.5,
              reset_at: null,
            },
          ],
        },
      ],
    };

    const { container } = render(
      <QuotaCard
        filename="synth-hybrid-unknown-07.json"
        mode="antigravity"
        summary={summary}
        onRefresh={dummyOnRefresh}
      />
    );

    // Group is NOT hidden; title has GPT-OSS removed, preserving Mistral
    expect(screen.getByText('Mistral Models')).toBeInTheDocument();

    // Description retains Mistral Large and removes GPT-OSS
    expect(
      screen.getByText('包含模型：Mistral Large')
    ).toBeInTheDocument();

    // Extra bucket has GPT-OSS removed
    expect(screen.getByText('Mistral Burst Allowance')).toBeInTheDocument();

    // Fractions preserved
    expect(screen.getByText('65%')).toBeInTheDocument();
    expect(screen.getByText('45%')).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();

    // Container must not contain GPT-OSS
    expect(container.textContent).not.toContain('GPT-OSS');
  });

  it('filters standalone GPT-OSS primary 5h bucket without affecting normal shared bucket', () => {
    const summary: QuotaSummary = {
      status: 'available',
      source: 'antigravity_quota_summary',
      captured_at: '2026-10-16T08:00:00Z',
      upstream_status: 200,
      reason: null,
      groups: [
        {
          group_id: 'shared_compute_group',
          display_name: 'Shared Compute Models',
          description: 'Special experiment cluster',
          buckets: [
            {
              bucket_id: 'gpt_oss_exclusive_5h',
              display_name: 'GPT-OSS 5h Limit',
              raw_window: '5h',
              window: '5h',
              remaining_fraction: 0.1,
              reset_at: '2026-10-16T10:00:00Z',
            },
            {
              bucket_id: 'shared_5h_real',
              display_name: 'Five Hour Limit Remaining',
              raw_window: '5h',
              window: '5h',
              remaining_fraction: 0.88,
              reset_at: '2026-10-16T13:00:00Z',
            },
            {
              bucket_id: 'shared_weekly_real',
              display_name: 'Weekly Limit Remaining',
              raw_window: 'weekly',
              window: 'weekly',
              remaining_fraction: 0.42,
              reset_at: '2026-10-23T00:00:00Z',
            },
          ],
        },
      ],
    };

    const { container } = render(
      <QuotaCard
        filename="synth-bucket-filter-08.json"
        mode="antigravity"
        summary={summary}
        onRefresh={dummyOnRefresh}
      />
    );

    // Normal shared 5h bucket (88%) is matched, NOT the GPT-OSS exclusive 5h bucket (10%)
    expect(screen.getByText('88%')).toBeInTheDocument();
    expect(screen.queryByText('10%')).not.toBeInTheDocument();
    expect(screen.getByText('42%')).toBeInTheDocument();

    // GPT-OSS text is not present
    expect(container.textContent).not.toContain('GPT-OSS');
  });

  it('does not mutate the original summary object during rendering', () => {
    const summary: QuotaSummary = {
      status: 'available',
      source: 'antigravity_quota_summary',
      captured_at: '2026-10-16T08:00:00Z',
      upstream_status: 200,
      reason: null,
      groups: [
        {
          group_id: 'claude_and_gpt_group',
          display_name: 'Claude and GPT Models',
          description:
            'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
          buckets: [
            {
              bucket_id: 'claude_gpt_5h',
              display_name: 'Five Hour Limit Remaining',
              raw_window: '5h',
              window: '5h',
              remaining_fraction: 0.85,
              reset_at: '2026-10-16T13:00:00Z',
            },
          ],
        },
        {
          group_id: 'gpt_oss_only',
          display_name: 'GPT-OSS Models',
          description: 'Models within this group: GPT-OSS',
          buckets: [
            {
              bucket_id: 'gpt_5h',
              display_name: 'Five Hour Limit Remaining',
              raw_window: '5h',
              window: '5h',
              remaining_fraction: 0.5,
              reset_at: null,
            },
          ],
        },
      ],
    };

    const originalJson = JSON.stringify(summary);

    render(
      <QuotaCard
        filename="synth-immutable-09.json"
        mode="antigravity"
        summary={summary}
        onRefresh={dummyOnRefresh}
      />
    );

    // Summary must remain strictly unmodified
    expect(JSON.stringify(summary)).toBe(originalJson);
  });
});


describe('Antigravity Argon returned quota windows', () => {
  const onRefresh = vi.fn();
  const argonSummary = (fraction: number | null = 0.25): QuotaSummary => ({
    status: fraction === null ? 'partial' : 'available',
    source: 'antigravity_quota_summary',
    captured_at: '2026-10-16T08:00:00Z',
    upstream_status: 200,
    reason: fraction === null ? 'incomplete_quota_summary' : null,
    groups: [{
      group_id: 'synthetic-argon-group',
      display_name: 'Gemini 4 Argon Models',
      description: 'Synthetic weekly quota',
      buckets: [{
        bucket_id: 'gemini-argon-wtu-weekly',
        display_name: 'Gemini 4 Argon Weekly Limit',
        raw_window: 'weekly',
        window: 'weekly',
        remaining_fraction: fraction,
        reset_at: fraction === null ? null : '2026-10-23T08:00:00Z',
      }],
    }],
  });

  it.each([
    [0.25, '25%', '7天0小时后重置'],
    [0, '0%', '7天0小时后重置'],
    [null, '未知', '未提供'],
  ] as const)('renders only the returned weekly bucket for fraction %s', (fraction, label, reset) => {
    const summary = argonSummary(fraction);
    const original = JSON.stringify(summary);
    const { container } = render(
      <QuotaCard filename="synthetic-argon.json" mode="antigravity" summary={summary} onRefresh={onRefresh} />
    );

    expect(screen.getByText('Gemini 4 Argon Models')).toBeInTheDocument();
    expect(screen.getByText('Gemini 4 Argon Weekly Limit')).toBeInTheDocument();
    expect(screen.queryByText('5小时剩余额度')).not.toBeInTheDocument();
    expect(screen.queryByText('每周剩余额度')).not.toBeInTheDocument();
    expect(container.querySelectorAll('.qc-row')).toHaveLength(1);
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByText(reset)).toBeInTheDocument();
    const meter = screen.getByRole('progressbar', { name: 'Gemini 4 Argon Models Gemini 4 Argon Weekly Limit' });
    if (fraction === null) {
      expect(meter).not.toHaveAttribute('aria-valuenow');
    } else {
      expect(meter).toHaveAttribute('aria-valuenow', String(fraction * 100));
    }
    expect(JSON.stringify(summary)).toBe(original);
  });

  it('preserves all actual Argon buckets and does not infer windows from their names', () => {
    const summary = argonSummary();
    summary.groups[0].buckets[0].window = 'unknown';
    summary.groups[0].buckets[0].raw_window = null;
    summary.groups[0].buckets.push({
      bucket_id: 'synthetic-argon-extra',
      display_name: 'Additional Argon Allowance',
      raw_window: 'daily',
      window: 'daily',
      remaining_fraction: 0.5,
      reset_at: null,
    });
    render(<QuotaCard filename="synthetic-argon.json" mode="antigravity" summary={summary} onRefresh={onRefresh} />);

    expect(screen.getAllByRole('progressbar')).toHaveLength(2);
    expect(screen.getByText('Gemini 4 Argon Weekly Limit')).toBeInTheDocument();
    expect(screen.getByText('Additional Argon Allowance')).toBeInTheDocument();
    expect(screen.queryByText('5小时剩余额度')).not.toBeInTheDocument();
    expect(screen.queryByText('每周剩余额度')).not.toBeInTheDocument();
  });

  it.each(['geminicli', 'different-bucket'] as const)('does not enable Argon behavior for %s', (scenario) => {
    const summary = argonSummary();
    if (scenario === 'different-bucket') {
      summary.groups[0].buckets[0].bucket_id = 'gemini-argon-wtu-weekly-other';
    }
    render(
      <QuotaCard filename="synthetic-other.json" mode={scenario === 'geminicli' ? 'geminicli' : 'antigravity'} summary={summary} onRefresh={onRefresh} />
    );

    expect(screen.getAllByRole('progressbar')).toHaveLength(2);
    expect(screen.getByText('5小时剩余额度')).toBeInTheDocument();
    expect(screen.getByText('每周剩余额度')).toBeInTheDocument();
    expect(screen.getByText('未知')).toBeInTheDocument();
    expect(screen.getByText('25%')).toBeInTheDocument();
  });

  it('keeps ordinary groups unchanged and removes Argon when the next account does not return it', () => {
    const ordinarySummary: QuotaSummary = {
      ...argonSummary(),
      groups: [{
        group_id: 'synthetic-ordinary-group',
        display_name: 'Gemini Models',
        description: null,
        buckets: [{
          bucket_id: 'synthetic-ordinary-weekly',
          display_name: 'Weekly Limit',
          raw_window: 'weekly',
          window: 'weekly',
          remaining_fraction: 0.7,
          reset_at: '2026-10-23T08:00:00Z',
        }],
      }],
    };
    const summary = argonSummary();
    summary.groups.push(...ordinarySummary.groups);
    const { rerender } = render(
      <QuotaCard filename="synthetic-with-argon.json" mode="antigravity" summary={summary} onRefresh={onRefresh} />
    );
    expect(screen.getAllByRole('progressbar')).toHaveLength(3);
    expect(screen.getByText('Gemini 4 Argon Weekly Limit')).toBeInTheDocument();
    expect(screen.getByText('5小时剩余额度')).toBeInTheDocument();
    expect(screen.getByText('每周剩余额度')).toBeInTheDocument();
    expect(screen.getByText('未知')).toBeInTheDocument();
    expect(screen.getByText('70%')).toBeInTheDocument();

    rerender(
      <QuotaCard filename="synthetic-without-argon.json" mode="antigravity" summary={ordinarySummary} onRefresh={onRefresh} />
    );
    expect(screen.queryByText('Gemini 4 Argon Models')).not.toBeInTheDocument();
    expect(screen.queryByText('Gemini 4 Argon Weekly Limit')).not.toBeInTheDocument();
    expect(screen.getAllByRole('progressbar')).toHaveLength(2);
    expect(screen.getByText('Gemini 模型')).toBeInTheDocument();
    expect(screen.getByText('5小时剩余额度')).toBeInTheDocument();
    expect(screen.getByText('每周剩余额度')).toBeInTheDocument();
    expect(screen.getByText('未知')).toBeInTheDocument();
    expect(screen.getByText('70%')).toBeInTheDocument();
  });
});
