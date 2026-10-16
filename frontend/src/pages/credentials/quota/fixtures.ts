/**
 * Synthetic DEV fixtures for quota card preview and testing.
 * Provides relative fresh resets, distinct 5H and weekly fractions,
 * two groups, and partial/error/unknown cases selected by filename.
 * No tokens, user data, or external requests.
 */

import type { QuotaMode, QuotaSummary } from './types';

export function quotaFixture(filename: string, mode: QuotaMode): QuotaSummary {
  const lower = filename.toLowerCase();
  const source = mode === 'antigravity'
    ? 'antigravity_quota_summary'
    : 'geminicli_retrieve_user_quota';

  const nowMs = Date.now();
  const capturedAt = new Date(nowMs - 60000).toISOString(); // 1 minute ago

  // Error case selected by filename
  if (lower.includes('error') || lower.includes('err')) {
    return {
      status: 'error',
      source,
      captured_at: capturedAt,
      upstream_status: 500,
      reason: 'upstream_service_unavailable',
      groups: [],
    };
  }

  // Unsupported case selected by filename
  if (lower.includes('unsupported')) {
    return {
      status: 'unsupported',
      source,
      captured_at: capturedAt,
      upstream_status: null,
      reason: 'credential_quota_unsupported',
      groups: [],
    };
  }

  // Unknown case selected by filename
  if (lower.includes('unknown')) {
    return {
      status: 'unknown',
      source,
      captured_at: capturedAt,
      upstream_status: null,
      reason: 'channel_quota_status_unknown',
      groups: [],
    };
  }

  // Helper for generating relative reset ISO timestamps
  const makeReset = (offsetMs: number) => new Date(nowMs + offsetMs).toISOString();

  // Partial case selected by filename: two groups, where group 2 lacks weekly bucket
  if (lower.includes('partial')) {
    return {
      status: 'partial',
      source,
      captured_at: capturedAt,
      upstream_status: 200,
      reason: 'partial_quota_available',
      groups: [
        {
          group_id: 'group_primary',
          display_name: '合成组 A',
          description: '合成 UI 预览数据（合成组 A）',
          buckets: [
            {
              bucket_id: 'bucket_5h_1',
              display_name: '5小时限额',
              raw_window: '5h',
              window: '5h',
              remaining_fraction: 0.35,
              reset_at: makeReset(2 * 3600000 + 15 * 60000), // in 2h 15m
            },
            {
              bucket_id: 'bucket_weekly_1',
              display_name: '每周限额',
              raw_window: 'weekly',
              window: 'weekly',
              remaining_fraction: 0.78,
              reset_at: makeReset(3 * 86400000 + 8 * 3600000), // in 3d 8h
            },
          ],
        },
        {
          group_id: 'group_secondary',
          display_name: '合成组 B',
          description: '合成 UI 预览数据（合成组 B）',
          buckets: [
            // Intentionally lacks weekly bucket to verify unavailable window placeholder
            {
              bucket_id: 'bucket_5h_2',
              display_name: '5小时限额',
              raw_window: '5h',
              window: '5h',
              remaining_fraction: 0.62,
              reset_at: makeReset(4 * 3600000 + 45 * 60000), // in 4h 45m
            },
          ],
        },
      ],
    };
  }

  // Default available case: two groups, distinct 5H and weekly fractions, fresh resets
  if (mode === 'antigravity') {
    return {
      status: 'available',
      source,
      captured_at: capturedAt,
      upstream_status: 200,
      reason: null,
      groups: [
        {
          group_id: 'gemini_models',
          display_name: '合成组 A',
          description: '合成 UI 预览数据（合成组 A）',
          buckets: [
            {
              bucket_id: 'ag_gemini_5h',
              display_name: '5小时限额',
              raw_window: '5h',
              window: '5h',
              remaining_fraction: 0.45,
              reset_at: makeReset(2 * 3600000 + 30 * 60000), // in 2h 30m
            },
            {
              bucket_id: 'ag_gemini_weekly',
              display_name: '每周限额',
              raw_window: 'weekly',
              window: 'weekly',
              remaining_fraction: 0.82,
              reset_at: makeReset(4 * 86400000 + 12 * 3600000), // in 4d 12h
            },
          ],
        },
        {
          group_id: 'claude_gpt_models',
          display_name: '合成组 B',
          description: '合成 UI 预览数据（合成组 B）',
          buckets: [
            {
              bucket_id: 'ag_claude_5h',
              display_name: '5小时限额',
              raw_window: '5h',
              window: '5h',
              remaining_fraction: 0.22,
              reset_at: makeReset(1 * 3600000 + 10 * 60000), // in 1h 10m
            },
            {
              bucket_id: 'ag_claude_weekly',
              display_name: '每周限额',
              raw_window: 'weekly',
              window: 'weekly',
              remaining_fraction: 0.65,
              reset_at: makeReset(5 * 86400000 + 6 * 3600000), // in 5d 6h
            },
          ],
        },
      ],
    };
  }

  // Gemini CLI default available case: two groups, distinct fractions, fresh resets
  return {
    status: 'available',
    source,
    captured_at: capturedAt,
    upstream_status: 200,
    reason: null,
    groups: [
      {
        group_id: 'gemini_pro_models',
        display_name: '合成组 A',
        description: '合成 UI 预览数据（合成组 A）',
        buckets: [
          {
            bucket_id: 'gcli_pro_5h',
            display_name: '5小时限额',
            raw_window: '5h',
            window: '5h',
            remaining_fraction: 0.58,
            reset_at: makeReset(1 * 3600000 + 40 * 60000), // in 1h 40m
          },
          {
            bucket_id: 'gcli_pro_weekly',
            display_name: '每周限额',
            raw_window: 'weekly',
            window: 'weekly',
            remaining_fraction: 0.88,
            reset_at: makeReset(3 * 86400000 + 16 * 3600000), // in 3d 16h
          },
        ],
      },
      {
        group_id: 'gemini_flash_models',
        display_name: '合成组 B',
        description: '合成 UI 预览数据（合成组 B）',
        buckets: [
          {
            bucket_id: 'gcli_flash_5h',
            display_name: '5小时限额',
            raw_window: '5h',
            window: '5h',
            remaining_fraction: 0.74,
            reset_at: makeReset(3 * 3600000 + 20 * 60000), // in 3h 20m
          },
          {
            bucket_id: 'gcli_flash_weekly',
            display_name: '每周限额',
            raw_window: 'weekly',
            window: 'weekly',
            remaining_fraction: 0.96,
            reset_at: makeReset(6 * 86400000 + 22 * 3600000), // in 6d 22h
          },
        ],
      },
    ],
  };
}
