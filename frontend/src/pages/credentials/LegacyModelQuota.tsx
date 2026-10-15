import { useState, useEffect, useRef, useMemo, useCallback, type JSX } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { PanelMode, PanelScope } from "@/domain/panel";

export interface LegacyModelQuotaProps {
  readonly models: Readonly<Record<string, unknown>>;
  readonly mode: PanelMode;
  readonly busy: boolean;
  readonly scope: Readonly<PanelScope>;
  readonly isCurrent: () => boolean;
  readonly onTestModel: (id: string) => void | Promise<void>;
  readonly onExpiryReadback?: () => void | Promise<void>;
}

type AgGroupCategory = "public" | "available" | "compatible" | "other";

const AG_GROUP_LABELS: Record<AgGroupCategory, string> = {
  public: "公开模型",
  available: "可用模型",
  compatible: "兼容模型",
  other: "其他模型",
};

const AG_GROUP_ORDER: readonly AgGroupCategory[] = ["public", "available", "compatible", "other"];

function getOwnerKey(s: Readonly<PanelScope> | undefined | null): string {
  if (!s || typeof s !== "object") return "";
  return `${s.mode}:${s.channelEpoch}:${s.sessionEpoch}`;
}

function hasOwn(obj: object, prop: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

function parseStrictZonedDate(raw: unknown): Date | null {
  if (typeof raw !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(raw);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const offsetHour = Number(match[7] ?? 0);
  const offsetMinute = Number(match[8] ?? 0);
  const calendar = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const date = new Date(raw);
  if (
    year < 1000 ||
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day ||
    calendar.getUTCHours() !== hour ||
    calendar.getUTCMinutes() !== minute ||
    calendar.getUTCSeconds() !== second ||
    offsetHour > 23 ||
    offsetMinute > 59 ||
    !Number.isFinite(date.getTime())
  ) {
    return null;
  }
  return date;
}

function formatBeijing(date: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "Asia/Shanghai",
    hourCycle: "h23",
  }).format(date);
}

interface ParsedModelEntry {
  readonly key: string;
  readonly rawModelId?: string;
  readonly displayName?: string;
  readonly friendlyLabel: string;
  readonly rawLabel: string;
  readonly testTarget: string | null;
  readonly remainingInfo: { readonly known: boolean; readonly fraction: number | null; readonly text: string };
  readonly meterProps: { readonly color: string; readonly width: number };
  readonly recoveryText: string;
  readonly deadlineMs: number | null;
  readonly agGroup: AgGroupCategory;
  readonly isPublic: boolean;
  readonly availability?: string;
  readonly badge?: unknown;
}

export function LegacyModelQuota({
  models,
  mode,
  busy,
  scope,
  isCurrent,
  onTestModel,
  onExpiryReadback,
}: LegacyModelQuotaProps): JSX.Element {
  const [showRawNames, setShowRawNames] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const currentOwnerKey = getOwnerKey(scope);
  const activeOwnerKeyRef = useRef(currentOwnerKey);
  activeOwnerKeyRef.current = currentOwnerKey;

  const activeModeRef = useRef(mode);
  activeModeRef.current = mode;

  const activeIsCurrentRef = useRef(isCurrent);
  activeIsCurrentRef.current = isCurrent;

  const busyRef = useRef(busy);
  busyRef.current = busy;

  const consumedDeadlinesRef = useRef<Map<string, Set<number>>>(new Map());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const deferredReadbackRef = useRef<{
    ownerKey: string;
    isCurrent: () => boolean;
    callback: () => void | Promise<void>;
    deadlines: number[];
  } | null>(null);

  // Parse visible model entries from models prop using only own keys and typed fields
  const parsedEntries = useMemo<ParsedModelEntry[]>(() => {
    if (!models || typeof models !== "object" || Array.isArray(models)) {
      return [];
    }
    const entries: ParsedModelEntry[] = [];
    for (const key of Object.keys(models)) {
      if (!hasOwn(models, key)) continue;
      const rawVal = models[key];
      if (!rawVal || typeof rawVal !== "object" || Array.isArray(rawVal)) continue;
      const rawObj = rawVal as Record<string, unknown>;

      // visible === false hides; omitted visible does not
      const hasOwnVisible = hasOwn(rawObj, "visible");
      if (hasOwnVisible && rawObj.visible === false) {
        continue;
      }

      const rawModelId =
        hasOwn(rawObj, "rawModelId") && typeof rawObj.rawModelId === "string" && rawObj.rawModelId.length > 0
          ? rawObj.rawModelId
          : undefined;
      const displayName =
        hasOwn(rawObj, "displayName") && typeof rawObj.displayName === "string" && rawObj.displayName.length > 0
          ? rawObj.displayName
          : undefined;
      const rawLabel = rawModelId || key;
      const friendlyLabel = displayName || rawModelId || key;

      // testTarget logic
      let testTarget: string | null = null;
      const hasOwnTestModel = hasOwn(rawObj, "testModel");
      if (hasOwnTestModel) {
        if (typeof rawObj.testModel === "string" && rawObj.testModel.length > 0) {
          testTarget = rawObj.testModel;
        } else {
          // Malformed present target (null, undefined, "", etc.) disables safely
          testTarget = null;
        }
      } else {
        // Absent own field:
        if (mode === "geminicli") {
          // Older GCLI missing testModel may use actual nonempty raw map key
          if (typeof key === "string" && key.length > 0) {
            testTarget = key;
          } else {
            testTarget = null;
          }
        } else {
          // Missing AG target disables safely
          testTarget = null;
        }
      }

      // Remaining quota parsing
      const hasOwnQuotaInfoPresent = hasOwn(rawObj, "quotaInfoPresent");
      const quotaInfoPresent = hasOwnQuotaInfoPresent ? rawObj.quotaInfoPresent : undefined;
      const hasOwnRemainingPresent = hasOwn(rawObj, "remainingPresent");
      const remainingPresent = hasOwnRemainingPresent ? rawObj.remainingPresent : undefined;
      const hasOwnRemainingValid = hasOwn(rawObj, "remainingValid");
      const remainingValid = hasOwnRemainingValid ? rawObj.remainingValid : undefined;
      const hasOwnRemaining = hasOwn(rawObj, "remaining");
      const remainingVal = hasOwnRemaining ? rawObj.remaining : undefined;

      let remainingInfo: { known: boolean; fraction: number | null; text: string };
      if (
        quotaInfoPresent === false ||
        remainingPresent === false ||
        remainingValid === false
      ) {
        remainingInfo = { known: false, fraction: null, text: "未知" };
      } else if (
        !hasOwnRemaining ||
        typeof remainingVal !== "number" ||
        !Number.isFinite(remainingVal) ||
        remainingVal < 0 ||
        remainingVal > 1
      ) {
        remainingInfo = { known: false, fraction: null, text: "未知" };
      } else {
        const percent = Number((remainingVal * 100).toFixed(2));
        let text: string;
        if (remainingVal > 0 && percent === 0) {
          text = "<0.01%";
        } else if (remainingVal < 1 && percent === 100) {
          text = ">99.99%";
        } else {
          text = `${percent}%`;
        }
        remainingInfo = { known: true, fraction: remainingVal, text };
      }

      // Meter props
      let meterProps = { color: "", width: 0 };
      if (remainingInfo.known) {
        const fraction = remainingInfo.fraction!;
        let color = "#c65746";
        if (fraction >= 0.7) {
          color = "#10b981";
        } else if (fraction >= 0.3) {
          color = "#e0aa14";
        }
        const rawPercent = fraction * 100;
        let width = rawPercent;
        if (fraction > 0 && width < 0.5) {
          width = 0.5;
        } else if (fraction < 1 && width > 99.5) {
          width = 99.5;
        }
        meterProps = { color, width };
      }

      // Recovery time and deadline
      const hasOwnRolling168h = hasOwn(rawObj, "rolling168h");
      const rolling168h = hasOwnRolling168h && rawObj.rolling168h === true;
      const hasOwnResetTimeRaw = hasOwn(rawObj, "resetTimeRaw");
      const resetTimeRawVal = hasOwnResetTimeRaw ? rawObj.resetTimeRaw : undefined;

      let recoveryText: string;
      let deadlineMs: number | null = null;
      if (rolling168h) {
        recoveryText = "恢复时间未知（上游滚动 168h）";
      } else if (hasOwnResetTimeRaw) {
        const date = parseStrictZonedDate(resetTimeRawVal);
        if (date) {
          deadlineMs = date.getTime();
          recoveryText = `${formatBeijing(date)}（北京时间）`;
        } else {
          recoveryText = "恢复时间未知";
        }
      } else {
        recoveryText = "恢复时间未知";
      }

      // AG grouping and badges
      const isPublic = hasOwn(rawObj, "public") && rawObj.public === true;
      const availabilityVal = hasOwn(rawObj, "availability") ? rawObj.availability : undefined;
      const availability = typeof availabilityVal === "string" ? availabilityVal : undefined;
      const badgeVal = hasOwn(rawObj, "badge") ? rawObj.badge : undefined;

      let agGroup: AgGroupCategory = "other";
      if (isPublic) {
        agGroup = "public";
      } else if (availability === "available") {
        agGroup = "available";
      } else if (availability === "compatible") {
        agGroup = "compatible";
      }

      entries.push({
        key,
        rawModelId,
        displayName,
        friendlyLabel,
        rawLabel,
        testTarget,
        remainingInfo,
        meterProps,
        recoveryText,
        deadlineMs,
        agGroup,
        isPublic,
        availability,
        badge: badgeVal,
      });
    }

    // Stable sorting by raw map key
    entries.sort((a, b) => a.key.localeCompare(b.key));
    return entries;
  }, [models, mode]);

  // Extract valid future nonrolling deadlines
  const validDeadlines = useMemo(() => {
    const list: number[] = [];
    for (const entry of parsedEntries) {
      if (entry.deadlineMs !== null) {
        list.push(entry.deadlineMs);
      }
    }
    return list;
  }, [parsedEntries]);

  // Deferred readback delivery when busy clears
  useEffect(() => {
    if (busy) return;
    const deferred = deferredReadbackRef.current;
    if (!deferred) return;
    deferredReadbackRef.current = null;

    if (!mountedRef.current) return;
    if (scope.mode !== mode) return;
    if (getOwnerKey(scope) !== deferred.ownerKey) return;
    // Same-Scope3 owner/filename/task or validation change must discard rather than rebound
    if (isCurrent !== deferred.isCurrent) return;
    if (!deferred.isCurrent()) return;
    if (!isCurrent()) return;

    let consumed = consumedDeadlinesRef.current.get(deferred.ownerKey);
    if (!consumed) {
      consumed = new Set();
      consumedDeadlinesRef.current.set(deferred.ownerKey, consumed);
    }

    const unconsumed = deferred.deadlines.filter((d) => !consumed!.has(d));
    if (unconsumed.length === 0) return;

    // Consume before callback, coalesce cards
    for (const d of unconsumed) {
      consumed.add(d);
    }

    if (typeof deferred.callback === "function") {
      try {
        const res = deferred.callback();
        if (res && typeof (res as Promise<void>).catch === "function") {
          (res as Promise<void>).catch(() => {});
        }
      } catch {
        // No retry after rejection
      }
    }
  }, [busy, mode, scope, isCurrent]);

  // At most one local timer for visible valid future nonrolling deadlines
  useEffect(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    if (scope.mode !== mode || !isCurrent()) {
      return;
    }

    const capturedOwnerKey = currentOwnerKey;
    const capturedIsCurrent = isCurrent;
    const capturedCallback = onExpiryReadback;
    const capturedMode = mode;
    const capturedScope = scope;

    const scheduleNext = () => {
      if (!mountedRef.current) return;
      if (activeModeRef.current !== capturedMode || capturedScope.mode !== capturedMode) return;
      if (activeOwnerKeyRef.current !== capturedOwnerKey) return;
      if (activeIsCurrentRef.current !== capturedIsCurrent) return;
      if (!capturedIsCurrent() || !activeIsCurrentRef.current()) return;

      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }

      let consumed = consumedDeadlinesRef.current.get(capturedOwnerKey);
      if (!consumed) {
        consumed = new Set();
        consumedDeadlinesRef.current.set(capturedOwnerKey, consumed);
      }

      const now = Date.now();
      const futureDeadlines = validDeadlines.filter((d) => d > now && !consumed!.has(d));
      if (futureDeadlines.length === 0) {
        return;
      }

      const earliestDeadline = Math.min(...futureDeadlines);
      const delay = Math.max(0, earliestDeadline - now);

      timerRef.current = setTimeout(() => {
        if (!mountedRef.current) return;
        if (activeModeRef.current !== capturedMode || capturedScope.mode !== capturedMode) return;
        if (activeOwnerKeyRef.current !== capturedOwnerKey) return;
        if (activeIsCurrentRef.current !== capturedIsCurrent) return;
        if (!capturedIsCurrent() || !activeIsCurrentRef.current()) return;

        timerRef.current = null;

        const nowTime = Date.now();
        let ownerConsumed = consumedDeadlinesRef.current.get(capturedOwnerKey);
        if (!ownerConsumed) {
          ownerConsumed = new Set();
          consumedDeadlinesRef.current.set(capturedOwnerKey, ownerConsumed);
        }

        const expiredDeadlines = validDeadlines.filter(
          (d) => d <= Math.max(earliestDeadline, nowTime) && !ownerConsumed!.has(d)
        );

        if (expiredDeadlines.length > 0) {
          if (busyRef.current) {
            // Defer readback while busy
            const existingDeferred = deferredReadbackRef.current;
            const combinedDeadlines =
              existingDeferred && existingDeferred.ownerKey === capturedOwnerKey
                ? Array.from(new Set([...existingDeferred.deadlines, ...expiredDeadlines]))
                : expiredDeadlines;
            deferredReadbackRef.current = {
              ownerKey: capturedOwnerKey,
              isCurrent: capturedIsCurrent,
              callback: capturedCallback || (() => {}),
              deadlines: combinedDeadlines,
            };
          } else {
            // Not busy: consume before callback, coalesce cards
            for (const d of expiredDeadlines) {
              ownerConsumed.add(d);
            }
            if (typeof capturedCallback === "function") {
              try {
                const res = capturedCallback();
                if (res && typeof (res as Promise<void>).catch === "function") {
                  (res as Promise<void>).catch(() => {});
                }
              } catch {
                // No retry after rejection
              }
            }
          }
        }

        // After processing this deadline, schedule next distinct deadline!
        scheduleNext();
      }, delay);
    };

    scheduleNext();

    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [validDeadlines, mode, scope, isCurrent, currentOwnerKey, onExpiryReadback]);

  // Test click handler guarded by lifetime and exact captured owner
  const handleTestClick = useCallback(
    (target: string | null) => {
      if (!mountedRef.current) return;
      if (busy || busyRef.current) return;
      if (scope.mode !== mode || activeModeRef.current !== mode) return;
      if (activeOwnerKeyRef.current !== currentOwnerKey || getOwnerKey(scope) !== currentOwnerKey) return;
      if (activeIsCurrentRef.current !== isCurrent) return;
      if (!isCurrent() || !activeIsCurrentRef.current()) return;
      if (!target) return;

      try {
        const res = onTestModel(target);
        if (res && typeof (res as Promise<void>).catch === "function") {
          (res as Promise<void>).catch(() => {});
        }
      } catch {
        // Parent controls operation results
      }
    },
    [busy, scope, mode, isCurrent, currentOwnerKey, onTestModel]
  );

  const hasModels = parsedEntries.length > 0;

  const renderCard = (entry: ParsedModelEntry) => {
    const isTestDisabled =
      busy || entry.testTarget === null || scope.mode !== mode || !isCurrent();

    const displayTitle = showRawNames ? entry.rawLabel : entry.friendlyLabel;
    const secondaryLabel = showRawNames
      ? entry.friendlyLabel !== entry.rawLabel
        ? entry.friendlyLabel
        : null
      : entry.friendlyLabel !== entry.rawLabel
      ? entry.rawLabel
      : null;

    return (
      <div
        key={entry.key}
        className="rounded-[14px] border border-[#e5e4e2] dark:border-[#383735] bg-[#faf9f6] dark:bg-[#1e1d1b] p-4 text-card-foreground shadow-sm flex flex-col justify-between gap-3"
        role="article"
        aria-label={`模型 ${displayTitle}`}
      >
        <div className="space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <h4 className="font-medium text-sm text-foreground truncate" title={displayTitle}>
                {displayTitle}
              </h4>
              {secondaryLabel && (
                <span
                  className="text-xs text-muted-foreground block truncate"
                  title={secondaryLabel}
                  aria-label={showRawNames ? "友好名称" : "原始模型标识"}
                >
                  {secondaryLabel}
                </span>
              )}
            </div>
            {mode === "antigravity" && (
              <div className="flex flex-wrap items-center gap-1 shrink-0">
                {entry.isPublic && (
                  <Badge variant="outline" className="text-[11px] px-1.5 py-0">
                    公开
                  </Badge>
                )}
                {entry.availability === "available" && (
                  <Badge variant="outline" className="text-[11px] px-1.5 py-0">
                    可用
                  </Badge>
                )}
                {entry.availability === "compatible" && (
                  <Badge variant="outline" className="text-[11px] px-1.5 py-0">
                    兼容
                  </Badge>
                )}
                {entry.badge !== undefined && entry.badge !== null && (
                  <Badge variant="secondary" className="text-[11px] px-1.5 py-0">
                    {String(entry.badge)}
                  </Badge>
                )}
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">剩余额度</span>
              <span className="font-medium text-foreground">{entry.remainingInfo.text}</span>
            </div>
            {entry.remainingInfo.known ? (
              <div
                role="progressbar"
                aria-valuenow={Math.round(entry.remainingInfo.fraction! * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`剩余额度 ${entry.remainingInfo.text}`}
                className="relative h-[6px] w-full overflow-hidden rounded-full bg-[#e8e6e1] dark:bg-[#2d2c2a]"
              >
                <div
                  className="h-full transition-all"
                  style={{
                    width: `${entry.meterProps.width}%`,
                    backgroundColor: entry.meterProps.color,
                  }}
                />
              </div>
            ) : (
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="剩余额度未知"
                className="relative h-[6px] w-full overflow-hidden rounded-full bg-[#e8e6e1] dark:bg-[#2d2c2a]"
              />
            )}
          </div>

          <div className="text-xs text-muted-foreground">
            <span>恢复时间：{entry.recoveryText}</span>
          </div>
        </div>

        <div className="pt-1 flex items-center justify-end">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={isTestDisabled}
            onClick={() => handleTestClick(entry.testTarget)}
            aria-label={`测试 ${displayTitle}`}
            className="h-8 px-3 text-xs"
          >
            测试
          </Button>
        </div>
      </div>
    );
  };

  return (
    <section className="grid gap-4" aria-label="模型额度">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-base font-semibold text-foreground">模型额度</h3>
        {hasModels && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setShowRawNames((prev) => !prev)}
            aria-pressed={showRawNames}
            aria-label={showRawNames ? "切换为友好名称" : "切换为原始标识"}
            className="text-xs"
          >
            {showRawNames ? "显示友好名称" : "显示原始标识"}
          </Button>
        )}
      </div>

      {!hasModels ? (
        <div className="rounded-[14px] border border-border/80 bg-card p-4 text-center text-sm text-muted-foreground">
          暂无可用模型数据
        </div>
      ) : mode === "antigravity" ? (
        <div className="grid gap-6">
          {AG_GROUP_ORDER.map((groupKey) => {
            const groupItems = parsedEntries.filter((item) => item.agGroup === groupKey);
            if (groupItems.length === 0) return null;
            return (
              <div
                key={groupKey}
                className="space-y-3"
                role="region"
                aria-label={AG_GROUP_LABELS[groupKey]}
              >
                <h4 className="text-sm font-medium text-muted-foreground">
                  {AG_GROUP_LABELS[groupKey]}
                </h4>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {groupItems.map(renderCard)}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {parsedEntries.map(renderCard)}
        </div>
      )}
    </section>
  );
}
