/**
 * Quota types and DTO interfaces matching FULL_PARITY_CONTRACT.json.
 * Frozen contract reference: commit 390718ecfec90b674fed474862e497522273e129
 */

export type QuotaMode = 'antigravity' | 'geminicli';

export type QuotaStatus = 'available' | 'partial' | 'unsupported' | 'unknown' | 'error';

export type QuotaSource = 'antigravity_quota_summary' | 'geminicli_retrieve_user_quota';

export type QuotaWindow = '5h' | 'weekly' | 'daily' | 'monthly' | 'unknown';

export interface QuotaBucket {
  bucket_id: string;
  display_name: string;
  raw_window: string | null;
  window: QuotaWindow;
  remaining_fraction: number | null;
  reset_at: string | null;
}

export interface QuotaGroup {
  group_id: string;
  display_name: string;
  description: string | null;
  buckets: QuotaBucket[];
}

export interface QuotaSummary {
  status: QuotaStatus;
  source: QuotaSource;
  captured_at: string | null;
  upstream_status: number | null;
  reason: string | null;
  groups: QuotaGroup[];
}

export interface QuotaCardProps {
  filename: string;
  mode: QuotaMode;
  summary: QuotaSummary | null;
  loading?: boolean;
  onRefresh: () => void;
  disabled?: boolean;
}
