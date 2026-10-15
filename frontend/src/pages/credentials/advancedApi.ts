import { ApiError, requestJson } from "@/api/client";
import {
  getSessionSnapshot,
  getSessionValidationSnapshot,
  subscribeSession,
  subscribeSessionValidation,
  type SessionValidationSnapshot,
} from "@/auth/session";
import {
  isPanelMode,
  isPanelScopeCurrent,
  subscribePanelChannel,
  getPanelChannelSnapshot,
  type PanelMode,
  type PanelScope,
} from "@/domain/panel";
import { manualResult } from "./model";

export type PreviewStateUpdateStatus = "applied" | "pending" | "skipped" | "failed" | "unknown";

export type SafePreviewStateUpdate = {
  readonly preview: {
    readonly status: PreviewStateUpdateStatus;
    readonly reason?: string;
  };
};

export type SafePreviewData = {
  readonly filename: string;
  readonly success: boolean;
  readonly preview: boolean;
  readonly state_update: SafePreviewStateUpdate;
  readonly error?: string;
};

export type SafeQuotaGroupState = {
  readonly state: "blocked_unknown" | "manual_override";
  readonly revision?: number;
};

export type SafeQuotaGroup = {
  readonly cooldownUntil?: number;
};

export type SafeReleaseData = {
  readonly filename: string;
  readonly group: string;
  readonly success: boolean;
  readonly quota_group_states?: Readonly<Record<string, SafeQuotaGroupState>>;
  readonly model_cooldowns?: Readonly<Record<string, number>>;
  readonly quota_groups?: Readonly<Record<string, SafeQuotaGroup>>;
  readonly quota_state_invalid?: boolean;
  readonly error?: string;
};

export type ConfigurePreviewResult = Omit<ReturnType<typeof manualResult>, "data"> & {
  readonly data: SafePreviewData;
};

export type ReleaseQuotaGroupResult = Omit<ReturnType<typeof manualResult>, "data"> & {
  readonly data: SafeReleaseData;
};

export interface AdvancedCredentialApi {
  configurePreview(filename: string, signal?: AbortSignal): Promise<ConfigurePreviewResult>;
  releaseQuotaGroup(filename: string, group: string, signal?: AbortSignal): Promise<ReleaseQuotaGroupResult>;
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

function isValidQuotaGroup(group: unknown): group is string {
  if (typeof group !== "string") return false;
  if (group.length < 1 || group.length > 200) return false;
  for (let i = 0; i < group.length; i++) {
    if (group.charCodeAt(i) < 32) return false;
  }
  return true;
}

function isValidQuotaGroupKey(key: string): boolean {
  if (typeof key !== "string" || key.length < 1 || key.length > 200) return false;
  if (key === "__proto__" || key === "prototype" || key === "constructor") return false;
  for (let i = 0; i < key.length; i++) {
    if (key.charCodeAt(i) < 32) return false;
  }
  return true;
}

function isValidModelKey(key: string): boolean {
  if (typeof key !== "string" || key.length < 1 || key.length > 200) return false;
  if (key === "__proto__" || key === "prototype" || key === "constructor") return false;
  for (let i = 0; i < key.length; i++) {
    if (key.charCodeAt(i) < 32) return false;
  }
  return true;
}

function isValidHttpStatus(status: unknown): status is number {
  return typeof status === "number" && Number.isSafeInteger(status) && status >= 100 && status <= 599;
}

function getOwnValidHttpStatus(err: object): number | null {
  if (Object.prototype.hasOwnProperty.call(err, "status")) {
    const status = (err as { status?: unknown }).status;
    if (isValidHttpStatus(status)) {
      return status;
    }
  }
  return null;
}

function sanitizeError(err: unknown): Error {
  if (err instanceof DOMException && err.name === "AbortError") {
    return new DOMException("操作已取消或已失效。", "AbortError");
  }
  if (err instanceof Error && err.name === "AbortError") {
    return new DOMException("操作已取消或已失效。", "AbortError");
  }
  if (err && typeof err === "object") {
    const status = getOwnValidHttpStatus(err);
    if (status !== null) {
      const safeMessage = (
        status === 400 ? "请求参数无效。" :
        status === 401 || status === 403 ? "登录已失效，请重新登录。" :
        status === 404 ? "凭证不存在。" :
        status === 409 ? "请求状态冲突（HTTP 409）。" :
        status === 501 ? "测试夹具不支持此操作。" :
        `请求未完成（HTTP ${status}）。`
      );
      return new ApiError(status, null, safeMessage);
    }
  }
  return new Error("操作未完成，请重试。");
}

function readOwnBoolean(target: Record<string, unknown>, key: string): boolean {
  if (Object.prototype.hasOwnProperty.call(target, key)) {
    const val = target[key];
    if (typeof val === "boolean") {
      return val;
    }
  }
  return false;
}

function isValidUnixSecondTimestamp(val: unknown): val is number {
  return typeof val === "number" && Number.isFinite(val) && val >= 0 && val * 1000 <= 8640000000000000;
}

function projectSafePreviewDto(raw: unknown, filename: string): SafePreviewData {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      filename,
      success: false,
      preview: false,
      state_update: { preview: { status: "unknown" } },
      error: "invalid_response",
    };
  }
  const rawObj = raw as Record<string, unknown>;

  const ownSuccess = readOwnBoolean(rawObj, "success");
  const ownPreview = readOwnBoolean(rawObj, "preview");
  const hasOwnError = Object.prototype.hasOwnProperty.call(rawObj, "error") && Boolean(rawObj.error);

  let status: PreviewStateUpdateStatus = "unknown";
  let reason: string | undefined = undefined;

  if (Object.prototype.hasOwnProperty.call(rawObj, "state_update")) {
    const rawStateUpdate = rawObj.state_update;
    if (rawStateUpdate && typeof rawStateUpdate === "object" && !Array.isArray(rawStateUpdate)) {
      if (Object.prototype.hasOwnProperty.call(rawStateUpdate, "preview")) {
        const rawPreviewUpdate = (rawStateUpdate as Record<string, unknown>).preview;
        if (rawPreviewUpdate && typeof rawPreviewUpdate === "object" && !Array.isArray(rawPreviewUpdate)) {
          if (Object.prototype.hasOwnProperty.call(rawPreviewUpdate, "status")) {
            const rawStatus = (rawPreviewUpdate as Record<string, unknown>).status;
            if (rawStatus === "applied" || rawStatus === "pending" || rawStatus === "skipped" || rawStatus === "failed") {
              status = rawStatus;
            }
          }
          if (Object.prototype.hasOwnProperty.call(rawPreviewUpdate, "reason")) {
            const rawReason = (rawPreviewUpdate as Record<string, unknown>).reason;
            if (rawReason === "state_update_failed" && status === "failed") {
              reason = "state_update_failed";
            }
          }
        }
      }
    }
  }

  const isSuccess = ownSuccess && ownPreview && !hasOwnError;

  return {
    filename,
    success: isSuccess,
    preview: ownPreview && isSuccess,
    state_update: {
      preview: {
        status,
        ...(reason !== undefined ? { reason } : {}),
      },
    },
    ...(!isSuccess ? { error: "request_failed" } : {}),
  };
}

function projectSafeReleaseDto(raw: unknown, filename: string, group: string): SafeReleaseData {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      filename,
      group,
      success: false,
      quota_state_invalid: true,
      error: "invalid_response",
    };
  }
  const rawObj = raw as Record<string, unknown>;

  const ownSuccess = readOwnBoolean(rawObj, "success");
  const hasOwnError = Object.prototype.hasOwnProperty.call(rawObj, "error") && Boolean(rawObj.error);

  let quotaStateInvalid = false;
  if (Object.prototype.hasOwnProperty.call(rawObj, "quota_state_invalid") && rawObj.quota_state_invalid === true) {
    quotaStateInvalid = true;
  }

  let projectedStates: Record<string, SafeQuotaGroupState> | undefined = undefined;
  if (Object.prototype.hasOwnProperty.call(rawObj, "quota_group_states")) {
    const rawStates = rawObj.quota_group_states;
    if (rawStates && typeof rawStates === "object" && !Array.isArray(rawStates)) {
      const statesMap: Record<string, SafeQuotaGroupState> = Object.create(null);
      for (const [gKey, gVal] of Object.entries(rawStates)) {
        if (!isValidQuotaGroupKey(gKey)) continue;
        if (!gVal || typeof gVal !== "object" || Array.isArray(gVal)) {
          quotaStateInvalid = true;
          continue;
        }
        const hasOwnState = Object.prototype.hasOwnProperty.call(gVal, "state");
        const rawState = hasOwnState ? (gVal as { state?: unknown }).state : undefined;
        const isValidState = rawState === "blocked_unknown" || rawState === "manual_override";
        if (!isValidState) {
          quotaStateInvalid = true;
          continue;
        }
        const hasOwnRev = Object.prototype.hasOwnProperty.call(gVal, "revision");
        const rawRev = hasOwnRev ? (gVal as { revision?: unknown }).revision : undefined;
        let rev: number | undefined = undefined;
        if (typeof rawRev === "number" && Number.isSafeInteger(rawRev) && rawRev > 0) {
          rev = rawRev;
        } else {
          quotaStateInvalid = true;
        }
        statesMap[gKey] = Object.freeze({
          state: rawState,
          ...(rev !== undefined ? { revision: rev } : {}),
        });
      }
      projectedStates = Object.freeze(statesMap);
    } else {
      quotaStateInvalid = true;
    }
  }

  let projectedCooldowns: Record<string, number> | undefined = undefined;
  if (Object.prototype.hasOwnProperty.call(rawObj, "model_cooldowns")) {
    const rawCooldowns = rawObj.model_cooldowns;
    if (rawCooldowns && typeof rawCooldowns === "object" && !Array.isArray(rawCooldowns)) {
      const cooldownsMap: Record<string, number> = Object.create(null);
      for (const [mKey, mVal] of Object.entries(rawCooldowns)) {
        if (!isValidModelKey(mKey)) continue;
        if (isValidUnixSecondTimestamp(mVal)) {
          cooldownsMap[mKey] = mVal;
        } else {
          quotaStateInvalid = true;
        }
      }
      projectedCooldowns = Object.freeze(cooldownsMap);
    } else {
      quotaStateInvalid = true;
    }
  }

  let projectedGroups: Record<string, SafeQuotaGroup> | undefined = undefined;
  if (Object.prototype.hasOwnProperty.call(rawObj, "quota_groups")) {
    const rawGroups = rawObj.quota_groups;
    if (rawGroups && typeof rawGroups === "object" && !Array.isArray(rawGroups)) {
      const groupsMap: Record<string, SafeQuotaGroup> = Object.create(null);
      for (const [gKey, gVal] of Object.entries(rawGroups)) {
        if (!isValidQuotaGroupKey(gKey)) continue;
        if (!gVal || typeof gVal !== "object" || Array.isArray(gVal)) {
          quotaStateInvalid = true;
          continue;
        }
        let cooldownUntil: number | undefined = undefined;
        if (Object.prototype.hasOwnProperty.call(gVal, "cooldownUntil")) {
          const cd = (gVal as { cooldownUntil?: unknown }).cooldownUntil;
          if (isValidUnixSecondTimestamp(cd)) {
            cooldownUntil = cd;
          } else {
            quotaStateInvalid = true;
          }
        }
        groupsMap[gKey] = Object.freeze({
          ...(cooldownUntil !== undefined ? { cooldownUntil } : {}),
        });
      }
      projectedGroups = Object.freeze(groupsMap);
    } else {
      quotaStateInvalid = true;
    }
  }

  const isSuccess = ownSuccess && !hasOwnError && !quotaStateInvalid;

  return {
    filename,
    group,
    success: isSuccess,
    ...(projectedStates !== undefined ? { quota_group_states: projectedStates } : {}),
    ...(projectedCooldowns !== undefined ? { model_cooldowns: projectedCooldowns } : {}),
    ...(projectedGroups !== undefined ? { quota_groups: projectedGroups } : {}),
    ...(quotaStateInvalid ? { quota_state_invalid: true } : {}),
    ...(!isSuccess ? { error: quotaStateInvalid ? "invalid_state" : "request_failed" } : {}),
  };
}

export function createAdvancedCredentialApi(mode: PanelMode, scope: PanelScope): AdvancedCredentialApi {
  const capturedScope: PanelScope = Object.freeze({
    mode: scope?.mode,
    channelEpoch: scope?.channelEpoch,
    sessionEpoch: scope?.sessionEpoch,
  });

  const capturedValidation: SessionValidationSnapshot = getSessionValidationSnapshot();

  const currentChannel = getPanelChannelSnapshot();
  const currentSession = getSessionSnapshot();

  const validAtConstruction = (
    isPanelMode(mode) &&
    Boolean(scope) &&
    typeof scope === "object" &&
    scope.mode === mode &&
    scope.channelEpoch === currentChannel.channelEpoch &&
    scope.mode === currentChannel.mode &&
    scope.sessionEpoch === currentSession.sessionEpoch &&
    currentSession.token !== null &&
    capturedValidation.sessionEpoch === scope.sessionEpoch &&
    capturedValidation.status === "verified"
  );

  function assertValid(callerSignal?: AbortSignal): void {
    if (callerSignal?.aborted) {
      throw new DOMException("操作已取消。", "AbortError");
    }
    if (!validAtConstruction) {
      throw new DOMException("作用域或会话已失效。", "AbortError");
    }
    const currentValidation = getSessionValidationSnapshot();
    if (currentValidation !== capturedValidation || currentValidation.status !== "verified") {
      throw new DOMException("作用域或会话已失效。", "AbortError");
    }
    const currentSession = getSessionSnapshot();
    if (currentSession.sessionEpoch !== capturedScope.sessionEpoch || currentSession.token === null) {
      throw new DOMException("作用域或会话已失效。", "AbortError");
    }
    if (!isPanelScopeCurrent(capturedScope, currentSession.sessionEpoch)) {
      throw new DOMException("作用域已变更。", "AbortError");
    }
    if (callerSignal?.aborted) {
      throw new DOMException("操作已取消。", "AbortError");
    }
  }

  return {
    async configurePreview(filename: string, signal?: AbortSignal): Promise<ConfigurePreviewResult> {
      assertValid(signal);

      if (capturedScope.mode !== "geminicli") {
        throw new Error("当前渠道不支持此操作。");
      }

      if (!isValidCredentialFilename(filename)) {
        throw new Error("文件名无效。");
      }

      if (import.meta.env.DEV && import.meta.env.VITE_UI_FIXTURES === "true") {
        throw new ApiError(501, null, "测试夹具不支持此操作。");
      }

      assertValid(signal);

      const localController = new AbortController();
      const forwardAbort = () => {
        try {
          localController.abort(new DOMException("操作已取消。", "AbortError"));
        } catch { /* ignore */ }
      };

      if (signal?.aborted) {
        forwardAbort();
      } else {
        signal?.addEventListener("abort", forwardAbort, { once: true });
      }

      const unsubscribeValidation = subscribeSessionValidation(() => {
        const current = getSessionValidationSnapshot();
        if (current !== capturedValidation || current.status !== "verified") {
          try {
            localController.abort(new DOMException("作用域或会话已失效。", "AbortError"));
          } catch { /* ignore */ }
        }
      });

      const unsubscribeChannel = subscribePanelChannel(() => {
        if (!isPanelScopeCurrent(capturedScope, getSessionSnapshot().sessionEpoch)) {
          try {
            localController.abort(new DOMException("作用域已变更。", "AbortError"));
          } catch { /* ignore */ }
        }
      });

      const unsubscribeSession = subscribeSession(() => {
        const s = getSessionSnapshot();
        if (s.sessionEpoch !== capturedScope.sessionEpoch || s.token === null) {
          try {
            localController.abort(new DOMException("会话已失效。", "AbortError"));
          } catch { /* ignore */ }
        }
      });

      try {
        let rawResponse: unknown;
        try {
          assertValid(signal);
          const encodedFilename = encodeURIComponent(filename);
          rawResponse = await requestJson(`creds/configure-preview/${encodedFilename}`, {
            method: "POST",
            query: { mode: "geminicli" },
            signal: localController.signal,
            scope: capturedScope,
          });
          assertValid(signal);
        } catch (err: unknown) {
          assertValid(signal);
          throw sanitizeError(err);
        }

        const safeDto = projectSafePreviewDto(rawResponse, filename);
        assertValid(signal);

        const baseResult = manualResult(safeDto, 200);
        assertValid(signal);

        return {
          ...baseResult,
          data: safeDto,
        };
      } finally {
        unsubscribeValidation();
        unsubscribeChannel();
        unsubscribeSession();
        signal?.removeEventListener("abort", forwardAbort);
      }
    },

    async releaseQuotaGroup(filename: string, group: string, signal?: AbortSignal): Promise<ReleaseQuotaGroupResult> {
      assertValid(signal);

      if (capturedScope.mode !== "antigravity") {
        throw new Error("当前渠道不支持此操作。");
      }

      if (!isValidCredentialFilename(filename)) {
        throw new Error("文件名无效。");
      }

      if (!isValidQuotaGroup(group)) {
        throw new Error("额度组无效。");
      }

      if (import.meta.env.DEV && import.meta.env.VITE_UI_FIXTURES === "true") {
        throw new ApiError(501, null, "测试夹具不支持此操作。");
      }

      assertValid(signal);

      const localController = new AbortController();
      const forwardAbort = () => {
        try {
          localController.abort(new DOMException("操作已取消。", "AbortError"));
        } catch { /* ignore */ }
      };

      if (signal?.aborted) {
        forwardAbort();
      } else {
        signal?.addEventListener("abort", forwardAbort, { once: true });
      }

      const unsubscribeValidation = subscribeSessionValidation(() => {
        const current = getSessionValidationSnapshot();
        if (current !== capturedValidation || current.status !== "verified") {
          try {
            localController.abort(new DOMException("作用域或会话已失效。", "AbortError"));
          } catch { /* ignore */ }
        }
      });

      const unsubscribeChannel = subscribePanelChannel(() => {
        if (!isPanelScopeCurrent(capturedScope, getSessionSnapshot().sessionEpoch)) {
          try {
            localController.abort(new DOMException("作用域已变更。", "AbortError"));
          } catch { /* ignore */ }
        }
      });

      const unsubscribeSession = subscribeSession(() => {
        const s = getSessionSnapshot();
        if (s.sessionEpoch !== capturedScope.sessionEpoch || s.token === null) {
          try {
            localController.abort(new DOMException("会话已失效。", "AbortError"));
          } catch { /* ignore */ }
        }
      });

      try {
        let rawResponse: unknown;
        try {
          assertValid(signal);
          rawResponse = await requestJson("creds/action", {
            method: "POST",
            query: { mode: "antigravity" },
            body: {
              filename,
              action: "release_quota_group",
              group,
            },
            signal: localController.signal,
            scope: capturedScope,
          });
          assertValid(signal);
        } catch (err: unknown) {
          assertValid(signal);
          throw sanitizeError(err);
        }

        const safeDto = projectSafeReleaseDto(rawResponse, filename, group);
        assertValid(signal);

        const baseResult = manualResult(safeDto, 200);
        assertValid(signal);

        return {
          ...baseResult,
          data: safeDto,
        };
      } finally {
        unsubscribeValidation();
        unsubscribeChannel();
        unsubscribeSession();
        signal?.removeEventListener("abort", forwardAbort);
      }
    },
  };
}
