/**
 * CLIProxy Quota Card Component
 * Reference: commit 390718ecfec90b674fed474862e497522273e129
 * Copyright (c) 2026 Router-For.ME (MIT License)
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, Sparkles, Terminal } from 'lucide-react';
import type {
  QuotaBucket,
  QuotaCardProps,
  QuotaGroup,
  QuotaMode,
} from './types';
import './QuotaCard.css';

/**
 * Format ISO UTC captured_at timestamp to readable local date-time string.
 */
function formatCapturedAt(iso: string | null): string {
  if (!iso) return '未采集';
  try {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '未采集';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch {
    return '未采集';
  }
}

/**
 * Format remaining reset duration relative to estimated server clock.
 */
function formatResetCountdown(
  resetAt: string | null,
  currentServerTimeMs: number
): { text: string; isSoon: boolean } {
  if (!resetAt) return { text: '未提供', isSoon: false };
  const resetMs = new Date(resetAt).getTime();
  if (!Number.isFinite(resetMs)) return { text: '未提供', isSoon: false };

  const deltaMs = resetMs - currentServerTimeMs;
  if (deltaMs <= 0) {
    return { text: '已到重置时间，待刷新确认', isSoon: false };
  }

  const isSoon = deltaMs <= 3600000; // Within 1 hour
  const totalMinutes = Math.max(1, Math.ceil(deltaMs / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  let duration = '';
  if (days > 0) {
    duration = `${days}天${hours}小时`;
  } else if (hours > 0) {
    duration = `${hours}小时${minutes}分`;
  } else if (minutes > 0) {
    duration = `${minutes}分钟`;
  } else {
    duration = '不到1分钟';
  }

  return { text: `${duration}后重置`, isSoon };
}

interface QuotaMeterBarProps {
  percent: number | null;
  label?: string;
}

/**
 * 6px meter bar with thresholds: >=70 green, >=30 amber, <30 red;
 * percent === null renders null empty bar (width 0%).
 */
function QuotaMeterBar({ percent, label }: QuotaMeterBarProps) {
  let fillClass = 'qc-bar-fill-empty';
  let width = '0%';
  const isValidPercent =
    percent !== null &&
    Number.isFinite(percent) &&
    percent >= 0 &&
    percent <= 100;

  if (isValidPercent) {
    width = `${percent}%`;
    if (percent >= 70) {
      fillClass = 'qc-bar-fill-high';
    } else if (percent >= 30) {
      fillClass = 'qc-bar-fill-medium';
    } else {
      fillClass = 'qc-bar-fill-low';
    }
  }

  return (
    <div
      className="qc-bar"
      role="progressbar"
      aria-label={label}
      aria-valuenow={isValidPercent ? percent : undefined}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className={`qc-bar-fill ${fillClass}`} style={{ width }} />
    </div>
  );
}

interface DisplayBucketItem {
  id: string;
  name: string;
  fraction: number | null;
  resetAt: string | null;
  isPlaceholder: boolean;
}

/**
 * Resolve buckets for a group: 5H first, then weekly, followed by other real buckets.
 * Missing 5h or weekly windows are displayed as "未提供" placeholders without fabricating ratios or resets.
 */
function resolveGroupBuckets(group: QuotaGroup): DisplayBucketItem[] {
  const buckets = group.buckets ?? [];

  // Match 5H bucket by normalized window only
  const bucket5hIndex = buckets.findIndex((b) => b.window === '5h');
  // Match weekly bucket by normalized window only
  const bucketWeeklyIndex = buckets.findIndex((b) => b.window === 'weekly');

  const items: DisplayBucketItem[] = [];

  // 1. 5H Window
  if (bucket5hIndex >= 0) {
    const b = buckets[bucket5hIndex];
    items.push({
      id: b.bucket_id || `${group.group_id}_5h`,
      name: b.display_name || '5小时限额',
      fraction: b.remaining_fraction,
      resetAt: b.reset_at,
      isPlaceholder: false,
    });
  } else {
    items.push({
      id: `${group.group_id}_placeholder_5h`,
      name: '5小时限额',
      fraction: null,
      resetAt: null,
      isPlaceholder: true,
    });
  }

  // 2. Weekly Window
  if (bucketWeeklyIndex >= 0) {
    const b = buckets[bucketWeeklyIndex];
    items.push({
      id: b.bucket_id || `${group.group_id}_weekly`,
      name: b.display_name || '每周限额',
      fraction: b.remaining_fraction,
      resetAt: b.reset_at,
      isPlaceholder: false,
    });
  } else {
    items.push({
      id: `${group.group_id}_placeholder_weekly`,
      name: '每周限额',
      fraction: null,
      resetAt: null,
      isPlaceholder: true,
    });
  }

  // 3. Other real buckets (excluding the primary 5h and weekly matched)
  buckets.forEach((b: QuotaBucket, idx: number) => {
    if (idx !== bucket5hIndex && idx !== bucketWeeklyIndex) {
      items.push({
        id: b.bucket_id || `${group.group_id}_other_${idx}`,
        name: b.display_name || (b.window !== 'unknown' ? b.window : '其他限额'),
        fraction: b.remaining_fraction,
        resetAt: b.reset_at,
        isPlaceholder: false,
      });
    }
  });

  return items;
}

/**
 * Provider icon based on mode.
 */
function ProviderIcon({ mode }: { mode: QuotaMode }) {
  if (mode === 'antigravity') {
    return <Sparkles className="qc-icon" aria-hidden="true" />;
  }
  return <Terminal className="qc-icon" aria-hidden="true" />;
}

export function QuotaCard({
  filename,
  mode,
  summary,
  loading = false,
  onRefresh,
  disabled = false,
}: QuotaCardProps) {
  // Capture local monotonic time base when captured_at is received
  const monotonicBase = useRef(typeof performance !== 'undefined' ? performance.now() : Date.now());
  const [elapsedMs, setElapsedMs] = useState(0);

  const capturedServerMs = useMemo(() => {
    if (!summary?.captured_at) return null;
    const ms = new Date(summary.captured_at).getTime();
    return Number.isFinite(ms) ? ms : null;
  }, [summary?.captured_at]);

  // Local timer updates countdown display monotonically without making any requests
  useEffect(() => {
    monotonicBase.current = typeof performance !== 'undefined' ? performance.now() : Date.now();
    setElapsedMs(0);

    const timer = setInterval(() => {
      const nowMonotonic = typeof performance !== 'undefined' ? performance.now() : Date.now();
      setElapsedMs(nowMonotonic - monotonicBase.current);
    }, 10000);

    return () => clearInterval(timer);
  }, [summary?.captured_at]);

  // Current estimated server time
  const currentServerTimeMs =
    capturedServerMs !== null ? capturedServerMs + elapsedMs : Date.now();

  const providerLabel = mode === 'antigravity' ? 'Antigravity' : 'Gemini CLI';

  return (
    <article className="qc-card" aria-label={`额度卡片: ${filename}`}>
      {/* 头部：品牌图标 + 文件名 + 提供商标注 */}
      <header className="qc-head">
        <span className="qc-icon-wrap" title={providerLabel}>
          <ProviderIcon mode={mode} />
        </span>
        <div className="qc-head-title-wrap">
          <span className="qc-filename" title={filename}>
            {filename}
          </span>
          <span className="qc-provider-tag">{providerLabel}</span>
        </div>
      </header>

      {/* 卡片主体：根据状态渲染 */}
      <div className="qc-body">
        {loading ? (
          /* Loading 状态：双幽灵行骨架 */
          <div className="qc-skeleton" aria-busy="true">
            <span className="qc-sr-only">正在加载额度数据...</span>
            <div className="qc-skeleton-row" aria-hidden="true">
              <span className="qc-skeleton-label" />
              <span className="qc-skeleton-track" />
            </div>
            <div className="qc-skeleton-row" aria-hidden="true">
              <span className="qc-skeleton-label" />
              <span className="qc-skeleton-track" />
            </div>
          </div>
        ) : summary !== null ? (
          <>
            {/* 状态条判断：严格由 summary.status 决定，不以 reason 代替状态 */}
            {summary.status === 'error' && (
              <div className="qc-error-strip" role="alert">
                额度查询失败
                {summary.upstream_status ? ` (HTTP ${summary.upstream_status})` : ''}
                {summary.reason ? `: ${summary.reason}` : ''}
              </div>
            )}

            {summary.status === 'unsupported' && (
              <div className="qc-notice-strip" role="status">
                当前凭证不支持额度查询
                {summary.reason ? ` (${summary.reason})` : ''}
              </div>
            )}

            {summary.status === 'unknown' && (
              <div className="qc-notice-strip" role="status">
                额度状态未知
                {summary.reason ? ` (${summary.reason})` : ''}
              </div>
            )}

            {summary.status === 'partial' && (
              <div className="qc-notice-strip" role="status">
                <span className="qc-partial-tag">部分额度</span> 部分额度信息可用
                {summary.reason ? ` (${summary.reason})` : ''}
              </div>
            )}

            {/* 所有可用分组及桶渲染 */}
            {(summary.groups ?? []).map((group: QuotaGroup) => {
              const displayBuckets = resolveGroupBuckets(group);

              return (
                <div key={group.group_id} className="qc-group">
                  <div className="qc-group-header">
                    <span className="qc-group-title">{group.display_name}</span>
                    {group.description && (
                      <span className="qc-group-description">{group.description}</span>
                    )}
                  </div>

                  {displayBuckets.map((bucketItem: DisplayBucketItem) => {
                    const fraction = bucketItem.fraction;
                    const isValidFraction =
                      fraction !== null &&
                      Number.isFinite(fraction) &&
                      fraction >= 0 &&
                      fraction <= 1;

                    let percent: number | null = null;
                    let percentLabel = '未知';

                    if (isValidFraction) {
                      if (fraction === 1) {
                        percent = 100;
                        percentLabel = '100% · 额度可用';
                      } else if (fraction === 0) {
                        percent = 0;
                        percentLabel = '0%';
                      } else {
                        percent = Math.round(fraction * 100);
                        percentLabel = `${percent}%`;
                      }
                    }

                    const countdown = formatResetCountdown(
                      bucketItem.resetAt,
                      currentServerTimeMs
                    );

                    return (
                      <div key={bucketItem.id} className="qc-row">
                        <div className="qc-row-header">
                          <span className="qc-model" title={bucketItem.name}>
                            {bucketItem.name}
                          </span>
                          <div className="qc-meta">
                            <span
                              className={
                                percent !== null ? 'qc-percent' : 'qc-percent-unavailable'
                              }
                            >
                              {percentLabel}
                            </span>
                            <span
                              className={
                                countdown.isSoon ? 'qc-reset qc-reset-soon' : 'qc-reset'
                              }
                              title={countdown.isSoon ? '即将重置' : undefined}
                            >
                              {countdown.text}
                            </span>
                          </div>
                        </div>
                        <QuotaMeterBar
                          percent={percent}
                          label={`${group.display_name} ${bucketItem.name}`}
                        />
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </>
        ) : (
          /* Unloaded / Idle 状态：整块可点击加载 */
          <button
            type="button"
            className="qc-idle-body"
            onClick={onRefresh}
            disabled={disabled}
            title="点击加载额度"
          >
            <RefreshCw size={15} aria-hidden="true" className="qc-idle-glyph" />
            <span className="qc-idle-hint">未加载额度（点击查询）</span>
          </button>
        )}
      </div>

      {/* 底部：采集时间 + 右对齐刷新药丸 */}
      <footer className="qc-footer">
        <span className="qc-captured-time">
          采集时间: {formatCapturedAt(summary?.captured_at ?? null)}
        </span>
        <button
          type="button"
          className="qc-action-pill"
          onClick={onRefresh}
          disabled={disabled || loading}
          title="刷新额度"
          aria-label="刷新额度"
        >
          <RefreshCw
            size={13}
            className={loading ? 'qc-spinning' : undefined}
            aria-hidden="true"
          />
          <span>刷新</span>
        </button>
      </footer>
    </article>
  );
}
