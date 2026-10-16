import React, { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  getSessionSnapshot,
  getSessionValidationSnapshot,
  subscribeSession,
  subscribeSessionValidation,
  type SessionValidationSnapshot,
} from "@/auth/session";
import {
  isPanelScopeCurrent,
  subscribePanelChannel,
  type PanelMode,
  type PanelScope,
} from "@/domain/panel";
import type { ManualResult } from "./ResultView";
import { createAdvancedCredentialApi } from "./advancedApi";

export type AgQuotaEvidenceReceipt = Readonly<{
  source: "response" | "saved";
  filename: string;
  scope: Readonly<PanelScope>;
  validation: SessionValidationSnapshot;
  result: ManualResult;
}>;

export interface AgQuotaEvidenceProps {
  mode: PanelMode;
  scope: Readonly<PanelScope>;
  filename: string;
  receipt: AgQuotaEvidenceReceipt | null;
  disabled?: boolean;
  onRefresh?: () => void;
}

const KNOWN_GROUPS = Object.freeze(["gemini-shared", "claude-gpt-shared"] as const);

const KNOWN_OPUS_REASONS: Readonly<Record<string, string>> = Object.freeze({
  generation_404: "模型生成不可用 (404)",
  directory_missing: "模型未在目录中提供",
  directory_query_failed: "目录查询失败",
  directory_timeout: "目录查询超时",
});

const KNOWN_UPDATE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  quota: "quota",
  model_access: "model_access",
  preview: "preview",
});

const updateStates: Readonly<Record<string, string>> = Object.freeze({
  applied: "已更新",
  pending: "写回结果尚未确认",
  skipped: "未应用",
  failed: "更新失败",
  unknown: "写回状态未知",
});

function getSafeUpdateName(name: string): string {
  if (Object.prototype.hasOwnProperty.call(KNOWN_UPDATE_NAMES, name)) {
    return KNOWN_UPDATE_NAMES[name];
  }
  return "其他状态写回";
}

function isValidCredentialFilename(filename: unknown): filename is string {
  if (typeof filename !== "string" || !filename) return false;
  if (!filename.endsWith(".json")) return false;
  if (filename === ".json") return false;
  if (filename.includes("/") || filename.includes("\\")) return false;
  if (/[\x00-\x1f\x7f]/.test(filename)) return false;
  const base = filename.slice(0, -5);
  if (!base || base === "." || base === "..") return false;
  return true;
}

function isValidCanonicalGroup(group: unknown): group is string {
  if (typeof group !== "string") return false;
  if (group.length < 1 || group.length > 200) return false;
  if (group === "__proto__" || group === "prototype" || group === "constructor") return false;
  for (let i = 0; i < group.length; i++) {
    if (group.charCodeAt(i) < 32) return false;
  }
  return true;
}

function isValidUnixSecond(val: unknown): val is number {
  return typeof val === "number" && Number.isFinite(val) && val >= 0 && val * 1000 <= 8640000000000000;
}

function formatTimestamp(ts: number): string {
  try {
    const d = new Date(ts * 1000);
    if (!Number.isFinite(d.getTime())) return "时间无效";
    return `${new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZone: "Asia/Shanghai",
      hourCycle: "h23",
    }).format(d)}（北京时间）`;
  } catch {
    return "时间无效";
  }
}

function collectGroups(data: Record<string, unknown> | undefined): string[] {
  const groups = new Set<string>(KNOWN_GROUPS);
  if (!data || typeof data !== "object") return Array.from(groups);

  if (Object.prototype.hasOwnProperty.call(data, "quota_groups")) {
    const qg = data.quota_groups;
    if (qg && typeof qg === "object" && !Array.isArray(qg)) {
      for (const key of Object.keys(qg)) {
        if (isValidCanonicalGroup(key)) {
          groups.add(key);
        }
      }
    }
  }
  if (Object.prototype.hasOwnProperty.call(data, "quota_group_states")) {
    const qgs = data.quota_group_states;
    if (qgs && typeof qgs === "object" && !Array.isArray(qgs)) {
      for (const key of Object.keys(qgs)) {
        if (isValidCanonicalGroup(key)) {
          groups.add(key);
        }
      }
    }
  }
  return Array.from(groups);
}

export type ProjectedGroupState = {
  readonly group: string;
  readonly invalid: boolean;
  readonly known: boolean;
  readonly restricted: boolean | null;
  readonly blockedUnknown: boolean;
  readonly manualOverride: boolean;
  readonly cooldownUntil: number | null;
};

function projectQuotaGroup(d: Record<string, unknown> | undefined, group: string, now: number): ProjectedGroupState {
  if (!d || typeof d !== "object" || Array.isArray(d)) {
    return {
      group,
      invalid: true,
      known: false,
      restricted: true,
      blockedUnknown: false,
      manualOverride: false,
      cooldownUntil: null,
    };
  }

  const hasTopInvalid = Object.prototype.hasOwnProperty.call(d, "quota_state_invalid");
  const topInvalid = hasTopInvalid && d.quota_state_invalid === true;
  const malformedTopInvalid = hasTopInvalid && typeof d.quota_state_invalid !== "boolean";

  const hasRawGroups = Object.prototype.hasOwnProperty.call(d, "quota_groups");
  const rawGroups = hasRawGroups ? d.quota_groups : undefined;
  const malformedRawGroups = hasRawGroups && (rawGroups === null || typeof rawGroups !== "object" || Array.isArray(rawGroups));

  const hasRawStates = Object.prototype.hasOwnProperty.call(d, "quota_group_states");
  const rawStates = hasRawStates ? d.quota_group_states : undefined;
  const malformedRawStates = hasRawStates && (rawStates === null || typeof rawStates !== "object" || Array.isArray(rawStates));

  let malformedGroup = false;

  let rawP: Record<string, unknown> | null = null;
  if (rawGroups && typeof rawGroups === "object" && !Array.isArray(rawGroups)) {
    if (Object.prototype.hasOwnProperty.call(rawGroups, group)) {
      const pCandidate = (rawGroups as Record<string, unknown>)[group];
      if (pCandidate === null || typeof pCandidate !== "object" || Array.isArray(pCandidate)) {
        malformedGroup = true;
      } else {
        rawP = pCandidate as Record<string, unknown>;
      }
    }
  }

  let rawR: Record<string, unknown> | null = null;
  if (rawStates && typeof rawStates === "object" && !Array.isArray(rawStates)) {
    if (Object.prototype.hasOwnProperty.call(rawStates, group)) {
      const rCandidate = (rawStates as Record<string, unknown>)[group];
      if (rCandidate === null || typeof rCandidate !== "object" || Array.isArray(rCandidate)) {
        malformedGroup = true;
      } else {
        rawR = rCandidate as Record<string, unknown>;
      }
    }
  }

  let until: number | null = null;
  let hasCooldownUntil = false;
  if (rawP && Object.prototype.hasOwnProperty.call(rawP, "cooldownUntil")) {
    hasCooldownUntil = true;
    if (isValidUnixSecond(rawP.cooldownUntil)) {
      until = rawP.cooldownUntil;
    } else {
      malformedGroup = true;
    }
  }

  let hasRestricted = false;
  let pRestricted: boolean | null = null;
  if (rawP && Object.prototype.hasOwnProperty.call(rawP, "restricted")) {
    hasRestricted = true;
    if (typeof rawP.restricted === "boolean") {
      pRestricted = rawP.restricted;
    } else {
      malformedGroup = true;
    }
  }

  let hasBlockedUnknown = false;
  let pBlockedUnknown: boolean | null = null;
  if (rawP && Object.prototype.hasOwnProperty.call(rawP, "blockedUnknown")) {
    hasBlockedUnknown = true;
    if (typeof rawP.blockedUnknown === "boolean") {
      pBlockedUnknown = rawP.blockedUnknown;
    } else {
      malformedGroup = true;
    }
  }

  let hasState = false;
  let rState: string | null = null;
  if (rawR && Object.prototype.hasOwnProperty.call(rawR, "state")) {
    hasState = true;
    if (rawR.state === "blocked_unknown" || rawR.state === "manual_override") {
      rState = rawR.state;
    } else {
      malformedGroup = true;
    }
  }

  let hasRevision = false;
  if (rawR && Object.prototype.hasOwnProperty.call(rawR, "revision")) {
    hasRevision = true;
    if (!(typeof rawR.revision === "number" && Number.isSafeInteger(rawR.revision) && rawR.revision > 0)) {
      malformedGroup = true;
    }
  }

  const blocked = (hasState && rState === "blocked_unknown") || (hasBlockedUnknown && pBlockedUnknown === true);
  const manualOverride = hasState && rState === "manual_override";
  const inCooldown = until !== null && until > now;

  const conflict = (
    (manualOverride && hasBlockedUnknown && pBlockedUnknown === true) ||
    (hasState && rState === "blocked_unknown" && hasBlockedUnknown && pBlockedUnknown === false) ||
    (hasRestricted && pRestricted === false && (blocked || inCooldown))
  );

  const invalid = (
    topInvalid ||
    malformedTopInvalid ||
    malformedRawGroups ||
    malformedRawStates ||
    malformedGroup ||
    Boolean(conflict)
  );

  if (invalid) {
    return {
      group,
      invalid: true,
      known: true,
      restricted: true,
      blockedUnknown: Boolean(blocked),
      manualOverride,
      cooldownUntil: until,
    };
  }

  const hasAnyTypedEvidence = (
    hasRestricted ||
    hasBlockedUnknown ||
    hasCooldownUntil ||
    hasState ||
    hasRevision
  );

  if (!hasAnyTypedEvidence) {
    return {
      group,
      invalid: false,
      known: false,
      restricted: null,
      blockedUnknown: false,
      manualOverride: false,
      cooldownUntil: null,
    };
  }

  let restricted: boolean | null = null;
  if (blocked || inCooldown) {
    restricted = true;
  } else if (hasRestricted) {
    restricted = pRestricted;
  }

  return {
    group,
    invalid: false,
    known: true,
    restricted,
    blockedUnknown: Boolean(blocked),
    manualOverride,
    cooldownUntil: until,
  };
}

function getGroupLabel(group: string): string {
  if (group === "gemini-shared") return "Gemini";
  if (group === "claude-gpt-shared") return "Claude / GPT";
  return group;
}

function formatGroupText(s: ProjectedGroupState, now: number): string {
  const parts: string[] = [];
  if (s.invalid) {
    parts.push("状态异常，受限");
  } else if (s.blockedUnknown) {
    parts.push("受限，恢复时间未知");
  } else if (s.restricted === true) {
    parts.push("受限，等待状态更新");
  } else if (s.restricted === false) {
    parts.push("未受限");
  } else {
    parts.push("状态不可用");
  }

  if (s.cooldownUntil !== null && s.cooldownUntil > now) {
    parts.push(`冷却至 ${formatTimestamp(s.cooldownUntil)}`);
  }
  if (s.manualOverride) {
    parts.push("人工解除异常拦截，计时冷却仍有效");
  }

  return parts.join("；");
}

function getGroupBadgeVariant(s: ProjectedGroupState): "destructive" | "warning" | "success" | "info" {
  if (s.invalid) return "destructive";
  if (s.restricted === true) return "warning";
  if (s.restricted === false) return "success";
  return "info";
}

const consumedReceiptTickets = new WeakMap<AgQuotaEvidenceReceipt, Set<string>>();
const retiredReceiptTickets = new WeakMap<AgQuotaEvidenceReceipt, Set<string>>();

function isTicketConsumed(receipt: AgQuotaEvidenceReceipt, group: string): boolean {
  return consumedReceiptTickets.get(receipt)?.has(group) ?? false;
}

function consumeTicket(receipt: AgQuotaEvidenceReceipt, group: string): void {
  let set = consumedReceiptTickets.get(receipt);
  if (!set) {
    set = new Set<string>();
    consumedReceiptTickets.set(receipt, set);
  }
  set.add(group);
}

function isTicketRetired(receipt: AgQuotaEvidenceReceipt, group: string): boolean {
  const set = retiredReceiptTickets.get(receipt);
  if (!set) return false;
  return set.has("*") || set.has(group);
}

function retireTicket(receipt: AgQuotaEvidenceReceipt, group?: string): void {
  let set = retiredReceiptTickets.get(receipt);
  if (!set) {
    set = new Set<string>();
    retiredReceiptTickets.set(receipt, set);
  }
  set.add(group ?? "*");
}

function checkReleaseEligibility(
  props: AgQuotaEvidenceProps,
  groupState: ProjectedGroupState
): boolean {
  if (props.mode !== "antigravity") return false;
  if (props.disabled) return false;
  if (!props.receipt) return false;
  if (props.receipt.source !== "response") return false;
  if (!props.receipt.result.success) return false;

  if (props.receipt.filename !== props.filename) return false;
  if (!isValidCredentialFilename(props.filename)) return false;

  const currentSession = getSessionSnapshot();
  const currentValidation = getSessionValidationSnapshot();

  if (currentSession.token === null) return false;
  if (currentSession.sessionEpoch !== props.scope.sessionEpoch) return false;
  if (props.scope.mode !== "antigravity") return false;
  if (!isPanelScopeCurrent(props.scope, currentSession.sessionEpoch)) return false;

  if (props.receipt.scope.mode !== props.scope.mode) return false;
  if (props.receipt.scope.channelEpoch !== props.scope.channelEpoch) return false;
  if (props.receipt.scope.sessionEpoch !== props.scope.sessionEpoch) return false;

  if (props.receipt.validation !== currentValidation) return false;
  if (currentValidation.status !== "verified") return false;

  if (!groupState.blockedUnknown || groupState.invalid) return false;

  if (isTicketConsumed(props.receipt, groupState.group)) return false;
  if (isTicketRetired(props.receipt, groupState.group)) return false;

  return true;
}

function checkOpus55CatalogMissing(props: AgQuotaEvidenceProps, receipt: AgQuotaEvidenceReceipt | null): boolean {
  if (props.mode !== "antigravity") return false;
  if (!receipt) return false;
  if (receipt.source !== "response") return false;
  if (!receipt.result.success) return false;

  if (receipt.filename !== props.filename) return false;
  if (!isValidCredentialFilename(props.filename)) return false;

  const currentSession = getSessionSnapshot();
  const currentValidation = getSessionValidationSnapshot();

  if (currentSession.token === null) return false;
  if (currentSession.sessionEpoch !== props.scope.sessionEpoch) return false;
  if (props.scope.mode !== "antigravity") return false;
  if (!isPanelScopeCurrent(props.scope, currentSession.sessionEpoch)) return false;

  if (receipt.scope.mode !== props.scope.mode) return false;
  if (receipt.scope.channelEpoch !== props.scope.channelEpoch) return false;
  if (receipt.scope.sessionEpoch !== props.scope.sessionEpoch) return false;

  if (receipt.validation !== currentValidation) return false;
  if (currentValidation.status !== "verified") return false;

  const data = receipt.result.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;

  if (!Object.prototype.hasOwnProperty.call(data, "models")) return false;
  const models = (data as Record<string, unknown>).models;
  if (!models || typeof models !== "object" || Array.isArray(models)) return false;

  const keys = Object.keys(models);
  if (keys.length === 0) return false;

  const hasOpus55Tier = keys.some((k) => /^claude-opus-5-5-(low|medium|high)$/.test(k));
  return !hasOpus55Tier;
}

function projectFamilyState(
  rawFamilies: unknown,
  familyName: "claude-opus-5-5" | "claude-opus-4-6",
  isCatalogMissing: boolean,
  now: number
) {
  const families = rawFamilies && typeof rawFamilies === "object" && !Array.isArray(rawFamilies)
    ? (rawFamilies as Record<string, unknown>)
    : null;
  const entry = families && Object.prototype.hasOwnProperty.call(families, familyName) && typeof families[familyName] === "object" && families[familyName] !== null && !Array.isArray(families[familyName])
    ? (families[familyName] as Record<string, unknown>)
    : null;

  let checkedAt: number | null = null;
  let lastAttemptAt: number | null = null;
  let nextCheckAt: number | null = null;
  let blockedUntil: number | null = null;
  let reasonText: string | null = null;
  let ownState: string | null = null;

  if (entry) {
    if (Object.prototype.hasOwnProperty.call(entry, "state") && typeof entry.state === "string") {
      ownState = entry.state;
    }
    if (Object.prototype.hasOwnProperty.call(entry, "checked_at") && isValidUnixSecond(entry.checked_at)) {
      if (entry.checked_at <= now) {
        checkedAt = entry.checked_at;
      }
    }
    if (Object.prototype.hasOwnProperty.call(entry, "last_attempt_at") && isValidUnixSecond(entry.last_attempt_at)) {
      if (entry.last_attempt_at <= now) {
        lastAttemptAt = entry.last_attempt_at;
      }
    }
    if (Object.prototype.hasOwnProperty.call(entry, "next_check_at") && isValidUnixSecond(entry.next_check_at)) {
      nextCheckAt = entry.next_check_at;
    }
    if (Object.prototype.hasOwnProperty.call(entry, "blocked_until") && isValidUnixSecond(entry.blocked_until)) {
      blockedUntil = entry.blocked_until;
    }
    if (Object.prototype.hasOwnProperty.call(entry, "reason") && typeof entry.reason === "string") {
      if (Object.prototype.hasOwnProperty.call(KNOWN_OPUS_REASONS, entry.reason)) {
        reasonText = KNOWN_OPUS_REASONS[entry.reason];
      }
    }
  }

  let statusText = "待确认";
  let badgeVariant: "success" | "warning" | "destructive" | "info" = "info";

  if (isCatalogMissing) {
    statusText = "目录未提供 5.5 模型";
    badgeVariant = "warning";
  } else if (entry && ownState !== null) {
    if (ownState === "supported") {
      if (checkedAt !== null && checkedAt <= now && now < checkedAt + 43200) {
        statusText = "目录支持";
        badgeVariant = "success";
      } else {
        statusText = "待确认";
        badgeVariant = "info";
      }
    } else if (ownState === "unavailable") {
      statusText = "暂不可用";
      badgeVariant = "warning";
    }
  }

  return {
    statusText,
    badgeVariant,
    checkedAt,
    lastAttemptAt,
    nextCheckAt,
    blockedUntil,
    reasonText,
  };
}

type ConfirmationActor = {
  readonly id: symbol;
  readonly receipt: AgQuotaEvidenceReceipt;
  readonly group: string;
  readonly filename: string;
  readonly scope: Readonly<PanelScope>;
  retired: boolean;
};

export function AgQuotaEvidence(props: AgQuotaEvidenceProps): React.ReactElement | null {
  const [confirmationActor, setConfirmationActor] = useState<ConfirmationActor | null>(null);

  const [, setConsumedRevision] = useState(0);

  const [releaseOutcome, setReleaseOutcome] = useState<{
    receipt: AgQuotaEvidenceReceipt;
    filename: string;
    group: string;
    success: boolean;
    message: string;
  } | null>(null);

  const activeActorRef = useRef<ConfirmationActor | null>(null);
  const inFlightAbortRef = useRef<AbortController | null>(null);
  const currentRequestTokenRef = useRef<symbol | null>(null);

  const abortAndRetire = (receiptToRetire?: AgQuotaEvidenceReceipt | null) => {
    if (inFlightAbortRef.current) {
      try {
        inFlightAbortRef.current.abort();
      } catch { /* ignore */ }
      inFlightAbortRef.current = null;
    }
    currentRequestTokenRef.current = null;
    if (activeActorRef.current) {
      activeActorRef.current.retired = true;
      activeActorRef.current = null;
      setConfirmationActor(null);
    }
    if (receiptToRetire) {
      retireTicket(receiptToRetire);
    }
    setReleaseOutcome(null);
  };

  useEffect(() => {
    if (props.mode !== "antigravity" || props.disabled) {
      abortAndRetire(props.receipt);
    }

    const unsubSession = subscribeSession(() => {
      const s = getSessionSnapshot();
      if (s.sessionEpoch !== props.scope.sessionEpoch || s.token === null) {
        abortAndRetire(props.receipt);
      }
    });

    const unsubValidation = subscribeSessionValidation(() => {
      const v = getSessionValidationSnapshot();
      if (props.receipt && (v !== props.receipt.validation || v.status !== "verified")) {
        abortAndRetire(props.receipt);
      }
    });

    const unsubChannel = subscribePanelChannel(() => {
      if (!isPanelScopeCurrent(props.scope, getSessionSnapshot().sessionEpoch)) {
        abortAndRetire(props.receipt);
      }
    });

    return () => {
      unsubSession();
      unsubValidation();
      unsubChannel();
      abortAndRetire(props.receipt);
    };
  }, [props.mode, props.scope, props.receipt, props.filename, props.disabled]);

  if (props.mode !== "antigravity") {
    return null;
  }

  if (!props.receipt) {
    return (
      <div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground" aria-label="Antigravity 额度与目录证据">
        未获取额度信息
      </div>
    );
  }

  const now = Date.now() / 1000;
  const receipt = props.receipt;
  const data = receipt.result.data as Record<string, unknown>;

  const groups = collectGroups(data);
  const isOpus55CatalogMissing = checkOpus55CatalogMissing(props, receipt);
  const rawFamilies = (
    data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    Object.prototype.hasOwnProperty.call(data, "model_access_families")
  )
    ? data.model_access_families
    : undefined;
  const opus55 = projectFamilyState(rawFamilies, "claude-opus-5-5", isOpus55CatalogMissing, now);
  const opus46 = projectFamilyState(rawFamilies, "claude-opus-4-6", false, now);

  const handleOpenReleaseConfirm = (group: string) => {
    const groupState = projectQuotaGroup(data, group, now);
    if (!checkReleaseEligibility(props, groupState)) return;

    const actor: ConfirmationActor = {
      id: Symbol(),
      receipt,
      group,
      filename: props.filename,
      scope: props.scope,
      retired: false,
    };
    activeActorRef.current = actor;
    setConfirmationActor(actor);
  };

  const handleCancelRelease = (actorToCancel: ConfirmationActor) => {
    if (activeActorRef.current?.id === actorToCancel.id) {
      activeActorRef.current.retired = true;
      activeActorRef.current = null;
    }
    actorToCancel.retired = true;
    setConfirmationActor((current) => (current?.id === actorToCancel.id ? null : current));
  };

  const handleConfirmRelease = async (actorToConfirm: ConfirmationActor) => {
    if (!actorToConfirm || actorToConfirm.retired) {
      return;
    }
    if (activeActorRef.current?.id !== actorToConfirm.id) {
      return;
    }

    actorToConfirm.retired = true;
    activeActorRef.current = null;
    setConfirmationActor((current) => (current?.id === actorToConfirm.id ? null : current));

    if (props.mode !== "antigravity" || props.disabled) return;
    if (props.receipt !== actorToConfirm.receipt) return;
    if (props.filename !== actorToConfirm.filename) return;
    if (
      props.scope.mode !== actorToConfirm.scope.mode ||
      props.scope.channelEpoch !== actorToConfirm.scope.channelEpoch ||
      props.scope.sessionEpoch !== actorToConfirm.scope.sessionEpoch
    ) return;

    const groupState = projectQuotaGroup(data, actorToConfirm.group, Date.now() / 1000);
    if (!checkReleaseEligibility(props, groupState)) return;

    consumeTicket(actorToConfirm.receipt, actorToConfirm.group);
    setConsumedRevision((c) => c + 1);

    const controller = new AbortController();
    inFlightAbortRef.current = controller;
    const token = Symbol();
    currentRequestTokenRef.current = token;

    const capturedReceipt = actorToConfirm.receipt;
    const capturedFilename = actorToConfirm.filename;
    const capturedScope = actorToConfirm.scope;
    const capturedValidation = capturedReceipt.validation;
    const capturedGroup = actorToConfirm.group;

    try {
      const api = createAdvancedCredentialApi(props.mode, props.scope);
      const res = await api.releaseQuotaGroup(capturedFilename, capturedGroup, controller.signal);

      if (currentRequestTokenRef.current !== token || controller.signal.aborted) {
        return;
      }

      const curSession = getSessionSnapshot();
      const curVal = getSessionValidationSnapshot();
      if (
        props.receipt !== capturedReceipt ||
        props.filename !== capturedFilename ||
        props.scope.mode !== capturedScope.mode ||
        props.scope.channelEpoch !== capturedScope.channelEpoch ||
        props.scope.sessionEpoch !== capturedScope.sessionEpoch ||
        curVal !== capturedValidation ||
        curVal.status !== "verified" ||
        curSession.token === null ||
        curSession.sessionEpoch !== capturedScope.sessionEpoch ||
        !isPanelScopeCurrent(capturedScope, curSession.sessionEpoch)
      ) {
        return;
      }

      if (res.success) {
        setReleaseOutcome({
          receipt: capturedReceipt,
          filename: capturedFilename,
          group: capturedGroup,
          success: true,
          message: "异常拦截已解除，计时冷却仍有效。",
        });
        props.onRefresh?.();
      } else {
        setReleaseOutcome({
          receipt: capturedReceipt,
          filename: capturedFilename,
          group: capturedGroup,
          success: false,
          message: "解除未成功，请重新读取状态。",
        });
      }
    } catch {
      if (currentRequestTokenRef.current !== token || controller.signal.aborted) {
        return;
      }
      const curSession = getSessionSnapshot();
      const curVal = getSessionValidationSnapshot();
      if (
        props.receipt !== capturedReceipt ||
        props.filename !== capturedFilename ||
        props.scope.mode !== capturedScope.mode ||
        props.scope.channelEpoch !== capturedScope.channelEpoch ||
        props.scope.sessionEpoch !== capturedScope.sessionEpoch ||
        curVal !== capturedValidation ||
        curVal.status !== "verified" ||
        curSession.token === null ||
        curSession.sessionEpoch !== capturedScope.sessionEpoch ||
        !isPanelScopeCurrent(capturedScope, curSession.sessionEpoch)
      ) {
        return;
      }
      setReleaseOutcome({
        receipt: capturedReceipt,
        filename: capturedFilename,
        group: capturedGroup,
        success: false,
        message: "操作未完成，请重试。",
      });
    } finally {
      if (currentRequestTokenRef.current === token) {
        currentRequestTokenRef.current = null;
        inFlightAbortRef.current = null;
      }
    }
  };

  return (
    <section className="grid gap-4 rounded-xl border bg-card p-4 text-sm text-card-foreground" aria-label="Antigravity 额度与目录证据">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-2">
        <h3 className="font-semibold text-base">额度保护与目录支持</h3>
        <div className="flex items-center gap-2">
          <Badge variant="outline">来源：{receipt.source === "response" ? "当前响应" : "已保存状态"}</Badge>
          {receipt.source === "saved" && (
            <span className="text-xs text-muted-foreground">（仅供参考展示，不可用于解除拦截）</span>
          )}
        </div>
      </div>

      <div className="grid gap-3">
        <h4 className="font-medium text-xs text-muted-foreground">配额组保护状态</h4>
        <div className="grid gap-2">
          {groups.map((group) => {
            const groupState = projectQuotaGroup(data, group, now);
            const eligible = checkReleaseEligibility(props, groupState);
            const consumed = isTicketConsumed(receipt, group);
            const outcome = (
              releaseOutcome &&
              releaseOutcome.receipt === receipt &&
              releaseOutcome.filename === props.filename &&
              releaseOutcome.group === group
            ) ? releaseOutcome : null;

            return (
              <div key={group} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-background/50 p-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={getGroupBadgeVariant(groupState)} className="max-w-full whitespace-normal">
                    {getGroupLabel(group)}：{formatGroupText(groupState, now)}
                  </Badge>
                  {consumed && !outcome && (
                    <Badge variant="info">已提交解除申请</Badge>
                  )}
                  {outcome && (
                    <span className={`text-xs ${outcome.success ? "text-success font-medium" : "text-destructive"}`}>
                      {outcome.message}
                    </span>
                  )}
                </div>
                {eligible && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={props.disabled || consumed}
                    onClick={() => handleOpenReleaseConfirm(group)}
                    data-testid={`release-quota-btn-${group}`}
                  >
                    解除异常拦截
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="grid gap-2 border-t pt-3">
        <h4 className="font-medium text-xs text-muted-foreground">Opus 目录与生成验证</h4>
        <div className="grid gap-2 text-xs">
          <div className="rounded-lg border bg-background/50 p-2.5 space-y-1">
            <div className="flex items-center gap-2">
              <span className="font-medium">Opus 5.5：</span>
              <Badge variant={opus55.badgeVariant}>{opus55.statusText}</Badge>
            </div>
            {opus55.checkedAt !== null && (
              <p className="text-muted-foreground">检查时间：{formatTimestamp(opus55.checkedAt)}</p>
            )}
            {opus55.lastAttemptAt !== null && (
              <p className="text-muted-foreground">最近尝试：{formatTimestamp(opus55.lastAttemptAt)}</p>
            )}
            {opus55.nextCheckAt !== null && (
              <p className="text-muted-foreground">下次检查：{formatTimestamp(opus55.nextCheckAt)}</p>
            )}
            {opus55.blockedUntil !== null && (
              <p className="text-muted-foreground">拦截至：{formatTimestamp(opus55.blockedUntil)}</p>
            )}
            {opus55.reasonText !== null && (
              <p className="text-muted-foreground">原因：{opus55.reasonText}</p>
            )}
          </div>

          <div className="rounded-lg border bg-background/50 p-2.5 space-y-1">
            <div className="flex items-center gap-2">
              <span className="font-medium">Opus 4.6：</span>
              <Badge variant={opus46.badgeVariant}>{opus46.statusText}</Badge>
            </div>
            {opus46.checkedAt !== null && (
              <p className="text-muted-foreground">检查时间：{formatTimestamp(opus46.checkedAt)}</p>
            )}
            {opus46.lastAttemptAt !== null && (
              <p className="text-muted-foreground">最近尝试：{formatTimestamp(opus46.lastAttemptAt)}</p>
            )}
            {opus46.nextCheckAt !== null && (
              <p className="text-muted-foreground">下次检查：{formatTimestamp(opus46.nextCheckAt)}</p>
            )}
            {opus46.blockedUntil !== null && (
              <p className="text-muted-foreground">拦截至：{formatTimestamp(opus46.blockedUntil)}</p>
            )}
            {opus46.reasonText !== null && (
              <p className="text-muted-foreground">原因：{opus46.reasonText}</p>
            )}
          </div>

          <p className="text-muted-foreground">目录支持有效期为 12 小时；权限、额度与生成验证分别判断。</p>
        </div>
      </div>

      {(receipt.result.verifiedReply !== null || (receipt.result.updates && receipt.result.updates.length > 0)) && (
        <div className="grid gap-2 border-t pt-3 text-xs">
          <h4 className="font-medium text-muted-foreground">生成校验与状态写回</h4>
          {receipt.result.verifiedReply !== null && (
            <p className={receipt.result.verifiedReply ? "text-success font-medium" : "text-destructive font-medium"}>
              固定回复校验：{receipt.result.verifiedReply ? "通过" : "未通过"}
            </p>
          )}
          {receipt.result.updates && receipt.result.updates.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {receipt.result.updates.map((u) => (
                <Badge
                  key={u.name}
                  variant={u.status === "applied" ? "success" : u.status === "failed" ? "destructive" : u.status === "pending" ? "warning" : "info"}
                >
                  {getSafeUpdateName(u.name)}：{updateStates[u.status] ?? "写回状态未知"}
                </Badge>
              ))}
            </div>
          )}
        </div>
      )}

      <AlertDialog
        open={confirmationActor !== null}
        onOpenChange={(open) => {
          if (!open && confirmationActor) {
            handleCancelRelease(confirmationActor);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认解除异常拦截</AlertDialogTitle>
            <AlertDialogDescription>
              凭证：{confirmationActor?.filename}，额度组：{confirmationActor?.group}。确认解除该额度组的异常拦截？解除操作仅清除未知异常拦截状态，已有计时冷却仍然有效。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => confirmationActor && handleCancelRelease(confirmationActor)}
              data-testid="cancel-release-btn"
            >
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirmationActor && handleConfirmRelease(confirmationActor)}
              data-testid="confirm-release-btn"
            >
              确认解除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
