/**
 * Page-lifetime hook managing quota summary state matching FULL_PARITY_CONTRACT.json.
 *
 * Provides:
 * - In-memory page-lifetime state keyed by (mode, sessionEpoch, detailEpoch, capability, ownership)
 * - Optional PanelScope ownership (`ownerScope`)
 * - Per-file request serial/generation and AbortController fencing
 * - Superseding refresh aborts previous request for the same identity
 * - Immediate synchronous clearing on mode/sessionEpoch/detailEpoch change, owner change, or capability withdrawal
 * - Synchronous cancel/close clearing in-flight loading and preventing late finally overwrites
 * - Target-specific close(A) cancels only A and clears activeFilename only if still A; stale close(A) cannot close B
 * - Close() without arguments cancels and clears current active target
 * - Owned hooks register registerChannelCleanup alongside registerSessionCleanup
 * - Unowned hooks retain session cleanup only without implicit global-channel binding
 * - Clear/reset function for paged/disappeared rows without touching list selection
 * - Safe error and status presentation distinguishing unloaded, loading, ready, and error states
 * - No initial/visibility/focus fetch, no polling, no timers, and no persistent storage
 *
 * Caller Operations (for P1C integration):
 * - `open(filename)`: User clicked "查看额度" to open the dialog for a credential. Sets
 *   activeFilename and starts quota summary loading if intent is valid.
 * - `refresh(filename)`: User clicked "刷新" in card or dialog. Aborts previous in-flight
 *   request for this identity and starts a fresh load.
 * - `close(filename?)`: User closed the dialog. Synchronously clears active target, aborts
 *   in-flight request, and prevents late promise/finally from reopening.
 * - `cancel(filename)`: Cancels in-flight loading for filename and marks loading=false.
 * - `clear(filenames?)`: Disposes entries (e.g. previous page rows on page switch) without
 *   touching list selection. If filenames omitted, clears all entries.
 * - `getState(filename)`: Returns QuotaItemState { summary, loading, unloaded, error }.
 * - `entries`: Reactive map of filename -> QuotaItemState.
 * - `activeFilename`: Currently active dialog target filename or null.
 * - `activeState`: QuotaItemState for active dialog target or null.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getSessionSnapshot, registerSessionCleanup } from '@/auth/session';
import {
  isPanelScopeCurrent,
  registerChannelCleanup,
  type PanelScope,
} from '@/domain/panel';
import type { QuotaMode, QuotaSummary } from './types';
import {
  fetchQuotaSummary,
  isQuotaCapabilitySupported,
  mapSafeQuotaError,
  mapSafeStatusReason,
} from './api';

export type { PanelScope } from '@/domain/panel';
export type { QuotaMode, QuotaSummary } from './types';

/**
 * Publicly usable per-file state distinguishing summary, unloaded/loading,
 * and a safe fixed error message. Contains zero raw response or credential material.
 */
export interface QuotaItemState {
  /** Normalized QuotaSummary DTO or null */
  summary: QuotaSummary | null;
  /** True while an in-flight request is actively loading */
  loading: boolean;
  /** True if this file has not been loaded yet in the current scope */
  unloaded: boolean;
  /** Fixed safe error or status message (in Chinese), or null if healthy */
  error: string | null;
}

/** Options for useQuotaSummary hook */
export interface UseQuotaSummaryOptions {
  /** Channel mode ('antigravity' or 'geminicli') */
  mode: QuotaMode;
  /** Workspace session epoch (changes on login/logout) */
  sessionEpoch: number;
  /** Workspace detail epoch (changes on credential list filter/refresh) */
  detailEpoch: number;
  /** Direct boolean indicator of summary capability */
  capabilityEnabled?: boolean;
  /** Set or list of advertised capabilities from which summary capability is derived */
  capabilities?: Set<string> | readonly string[];
  /** Optional panel owner scope */
  ownerScope?: PanelScope;
}

/** Hook return interface designed for P1C integration */
export interface UseQuotaSummaryReturn {
  /** Reactive map of filename -> QuotaItemState for current scope */
  entries: Record<string, QuotaItemState>;
  /** Get state for a specific filename (unloaded if not yet requested) */
  getState: (filename: string) => QuotaItemState;
  /** Active dialog filename or null */
  activeFilename: string | null;
  /** State of the active dialog target or null */
  activeState: QuotaItemState | null;
  /** Whether the quota summary capability is available for this mode */
  capabilityEnabled: boolean;
  /** Open dialog for filename and initiate summary fetch */
  open: (filename: string) => Promise<QuotaSummary | null>;
  /** Refresh quota summary for filename */
  refresh: (filename: string) => Promise<QuotaSummary | null>;
  /** Close dialog and synchronously abort/clear active target */
  close: (filename?: string) => void;
  /** Cancel in-flight request for target and synchronously set loading to false */
  cancel: (filename: string) => void;
  /** Clear quota state for specific filenames or all entries (e.g. on pagination) */
  clear: (filenames?: string[]) => void;
}

/**
 * Page-lifetime hook managing quota summaries.
 * Supports both options object and positional argument signatures for P1C flexibility.
 */
export function useQuotaSummary(options: UseQuotaSummaryOptions): UseQuotaSummaryReturn;
export function useQuotaSummary(
  mode: QuotaMode,
  sessionEpoch: number,
  detailEpoch: number,
  capabilityOrCaps?: boolean | Set<string> | readonly string[],
): UseQuotaSummaryReturn;
export function useQuotaSummary(
  arg1: QuotaMode | UseQuotaSummaryOptions,
  arg2?: number,
  arg3?: number,
  arg4?: boolean | Set<string> | readonly string[],
): UseQuotaSummaryReturn {
  const options: UseQuotaSummaryOptions =
    typeof arg1 === 'object' && arg1 !== null
      ? arg1
      : {
          mode: arg1,
          sessionEpoch: arg2 ?? 0,
          detailEpoch: arg3 ?? 0,
          capabilityEnabled: typeof arg4 === 'boolean' ? arg4 : undefined,
          capabilities: typeof arg4 !== 'boolean' ? arg4 : undefined,
          ownerScope: undefined,
        };

  const { mode, sessionEpoch, detailEpoch, capabilityEnabled, capabilities, ownerScope } = options;

  // Derive exact capability availability
  const isCapabilityEnabled =
    typeof capabilityEnabled === 'boolean'
      ? capabilityEnabled
      : isQuotaCapabilitySupported(mode, capabilities);

  // Copy and freeze ownerScope if provided; memoize by primitive fields to avoid object-identity loops
  const ownerMode = ownerScope?.mode;
  const ownerEpoch = ownerScope?.channelEpoch;
  const ownerSession = ownerScope?.sessionEpoch;

  const copiedOwnerScope: PanelScope | undefined = useMemo(() => {
    if (!ownerScope || typeof ownerScope !== 'object') return undefined;
    return Object.freeze({
      mode: ownerScope.mode,
      channelEpoch: ownerScope.channelEpoch,
      sessionEpoch: ownerScope.sessionEpoch,
    });
  }, [ownerMode, ownerEpoch, ownerSession]);

  // Local-owner key encapsulates ownership mode, channelEpoch, and sessionEpoch
  const localOwnerKey = copiedOwnerScope
    ? `owned:${copiedOwnerScope.mode}:${copiedOwnerScope.channelEpoch}:${copiedOwnerScope.sessionEpoch}`
    : 'unowned';

  // Scope key encapsulates mode, session, detail epoch, capability status, and local-owner key
  const currentScopeKey = `${mode}:${sessionEpoch}:${detailEpoch}:${isCapabilityEnabled ? '1' : '0'}:${localOwnerKey}`;

  // Scope generation increments strictly on owner/capability/detail/session/mode transitions
  const lastScopeKeyRef = useRef(currentScopeKey);
  const scopeGenerationRef = useRef(0);

  if (lastScopeKeyRef.current !== currentScopeKey) {
    lastScopeKeyRef.current = currentScopeKey;
    scopeGenerationRef.current += 1;
  }
  const currentScopeGeneration = scopeGenerationRef.current;

  const [renderedScopeKey, setRenderedScopeKey] = useState(currentScopeKey);
  const [entries, setEntries] = useState<Record<string, QuotaItemState>>({});
  const [activeFilename, setActiveFilename] = useState<string | null>(null);

  // In-memory per-file tracking: generation counter and AbortController
  const requestRecords = useRef<
    Map<string, { generation: number; controller: AbortController | null }>
  >(new Map());

  const currentScopeRef = useRef(currentScopeKey);
  currentScopeRef.current = currentScopeKey;

  const sessionEpochRef = useRef(sessionEpoch);
  sessionEpochRef.current = sessionEpoch;

  const detailEpochRef = useRef(detailEpoch);
  detailEpochRef.current = detailEpoch;

  const modeRef = useRef(mode);
  modeRef.current = mode;

  const capabilityEnabledRef = useRef(isCapabilityEnabled);
  capabilityEnabledRef.current = isCapabilityEnabled;

  const ownerScopeRef = useRef<PanelScope | undefined>(copiedOwnerScope);
  ownerScopeRef.current = copiedOwnerScope;

  const activeFilenameRef = useRef<string | null>(null);
  activeFilenameRef.current = activeFilename;

  const isMountedRef = useRef(true);

  // Abort all in-flight requests and bump generations
  const abortAllWork = useCallback(() => {
    for (const record of requestRecords.current.values()) {
      record.generation++;
      if (record.controller) {
        try {
          record.controller.abort();
        } catch {
          /* ignore */
        }
        record.controller = null;
      }
    }
    requestRecords.current.clear();
  }, []);

  // Direct internal record cancellation without checking public callback validity
  const cancelRecord = useCallback((filename: string) => {
    const record = requestRecords.current.get(filename);
    if (record) {
      record.generation++;
      if (record.controller) {
        try {
          record.controller.abort();
        } catch {
          /* ignore */
        }
        record.controller = null;
      }
    }
    setEntries(prev => {
      const current = prev[filename];
      if (!current) return prev;
      return {
        ...prev,
        [filename]: {
          ...current,
          loading: false,
          unloaded: current.summary === null,
        },
      };
    });
  }, []);

  // Check if owner scope matches explicit options and current runtime scope
  const isOwnerValid = (scope: PanelScope | undefined): boolean => {
    if (!scope) return true;
    const currentSession = getSessionSnapshot().sessionEpoch;
    return (
      scope.mode === mode &&
      scope.sessionEpoch === sessionEpoch &&
      scope.sessionEpoch === currentSession &&
      isPanelScopeCurrent(scope, currentSession)
    );
  };

  const isOwnerCurrentlyValid = isOwnerValid(copiedOwnerScope);

  // Immediate synchronous clearing during render on scope change or capability withdrawal
  if (renderedScopeKey !== currentScopeKey) {
    setRenderedScopeKey(currentScopeKey);
    setEntries({});
    setActiveFilename(null);
    activeFilenameRef.current = null;
    abortAllWork();
  }

  // Ensure returned visible state immediately reflects the reset without waiting for effects
  const isScopeCurrent =
    renderedScopeKey === currentScopeKey &&
    isCapabilityEnabled &&
    isOwnerCurrentlyValid;
  const visibleEntries = isScopeCurrent ? entries : {};
  const visibleActiveFilename = isScopeCurrent ? activeFilename : null;

  // Single-file state reader with fallback (preserves exact filename without alias rewriting)
  const getState = useCallback(
    (filename: string): QuotaItemState => {
      if (!isCapabilityEnabled) {
        return {
          summary: null,
          loading: false,
          unloaded: true,
          error: '当前服务未启用额度查询能力。',
        };
      }
      return (
        visibleEntries[filename] ?? {
          summary: null,
          loading: false,
          unloaded: true,
          error: null,
        }
      );
    },
    [isCapabilityEnabled, visibleEntries],
  );

  const activeState = visibleActiveFilename ? getState(visibleActiveFilename) : null;

  // Captured render-specific identity values for public callbacks
  const capturedMode = mode;
  const capturedSessionEpoch = sessionEpoch;
  const capturedDetailEpoch = detailEpoch;
  const capturedCapabilityEnabled = isCapabilityEnabled;
  const capturedOwnerKey = localOwnerKey;
  const capturedOwnerScope = copiedOwnerScope;
  const capturedScopeKey = currentScopeKey;
  const capturedScopeGeneration = currentScopeGeneration;

  // Validate intent and callback identity before any active/loading/cache/controller change or query
  const isCallbackValid = useCallback((): boolean => {
    if (!isMountedRef.current) return false;
    if (!capturedCapabilityEnabled || !capabilityEnabledRef.current) return false;
    if (capabilityEnabledRef.current !== capturedCapabilityEnabled) return false;
    if (scopeGenerationRef.current !== capturedScopeGeneration) return false;
    if (currentScopeRef.current !== capturedScopeKey) return false;
    if (modeRef.current !== capturedMode) return false;
    if (sessionEpochRef.current !== capturedSessionEpoch) return false;
    if (detailEpochRef.current !== capturedDetailEpoch) return false;

    const currentSession = getSessionSnapshot().sessionEpoch;
    if (currentSession !== capturedSessionEpoch) return false;

    if (capturedOwnerScope) {
      const currentOwner = ownerScopeRef.current;
      if (!currentOwner) return false;
      if (
        currentOwner.mode !== capturedOwnerScope.mode ||
        currentOwner.channelEpoch !== capturedOwnerScope.channelEpoch ||
        currentOwner.sessionEpoch !== capturedOwnerScope.sessionEpoch
      ) {
        return false;
      }
      if (!isPanelScopeCurrent(capturedOwnerScope, currentSession)) {
        return false;
      }
    } else {
      if (ownerScopeRef.current !== undefined) return false;
    }

    return true;
  }, [
    capturedMode,
    capturedSessionEpoch,
    capturedDetailEpoch,
    capturedCapabilityEnabled,
    capturedOwnerKey,
    capturedOwnerScope,
    capturedScopeKey,
    capturedScopeGeneration,
  ]);

  // Cancel an in-flight request for target and synchronously set loading to false
  const cancel = useCallback(
    (filename: string) => {
      // Reject all-blank input without rewriting nonblank filenames
      if (!filename || !filename.trim()) {
        return;
      }
      if (!isCallbackValid()) {
        return;
      }
      cancelRecord(filename);
    },
    [isCallbackValid, cancelRecord],
  );

  // Close dialog: close(A) cancels only A and clears activeFilename only if still A;
  // stale close(A) cannot close B. close() without arguments uses current active target.
  const close = useCallback(
    (filename?: string) => {
      if (typeof filename === 'string' && !filename.trim()) {
        return;
      }
      if (!isCallbackValid()) {
        return;
      }

      if (typeof filename === 'string') {
        cancelRecord(filename);
        if (activeFilenameRef.current === filename) {
          activeFilenameRef.current = null;
        }
        setActiveFilename(prev => (prev === filename ? null : prev));
      } else {
        const target = activeFilenameRef.current;
        activeFilenameRef.current = null;
        setActiveFilename(null);
        if (target) {
          cancelRecord(target);
        }
      }
    },
    [isCallbackValid, cancelRecord],
  );

  // Clear specific or all entries without affecting list selection
  const clear = useCallback(
    (filenames?: string[]) => {
      if (!isCallbackValid()) {
        return;
      }

      if (filenames && filenames.length > 0) {
        // Whitespace trimming may only reject all-blank input, never rewrite nonblank filenames
        const validFilenames = filenames.filter(
          fn => typeof fn === 'string' && fn.trim().length > 0,
        );
        for (const fn of validFilenames) {
          const record = requestRecords.current.get(fn);
          if (record) {
            record.generation++;
            if (record.controller) {
              try {
                record.controller.abort();
              } catch {
                /* ignore */
              }
              record.controller = null;
            }
            requestRecords.current.delete(fn);
          }
        }
        setEntries(prev => {
          const next = { ...prev };
          for (const fn of validFilenames) {
            delete next[fn];
          }
          return next;
        });
        if (
          activeFilenameRef.current &&
          validFilenames.includes(activeFilenameRef.current)
        ) {
          activeFilenameRef.current = null;
        }
        setActiveFilename(prev =>
          prev && validFilenames.includes(prev) ? null : prev,
        );
      } else {
        abortAllWork();
        activeFilenameRef.current = null;
        setEntries({});
        setActiveFilename(null);
      }
    },
    [isCallbackValid, abortAllWork],
  );

  // Internal worker for open and refresh operations
  const queryQuota = useCallback(
    async (filename: string): Promise<QuotaSummary | null> => {
      if (!filename || !filename.trim()) {
        return null;
      }

      // Reject stale/mismatched intents before active/loading changes or transport
      if (!isCallbackValid()) {
        return null;
      }

      // 1. Capture exact request fields from render's immutable scope
      const capturedFilename = filename;
      const capturedMode = mode;
      const capturedSessionEpoch = sessionEpoch;
      const capturedDetailEpoch = detailEpoch;
      const capturedCapabilityEnabled = isCapabilityEnabled;
      const capturedScopeKey = currentScopeKey;
      const capturedScopeGeneration = currentScopeGeneration;
      const capturedOwner = copiedOwnerScope;

      // 2. Existing map-record/generation/controller identity
      let record = requestRecords.current.get(capturedFilename);
      if (!record) {
        record = { generation: 0, controller: null };
        requestRecords.current.set(capturedFilename, record);
      }

      // Superseding refresh: abort previous in-flight request for this identity
      if (record.controller) {
        try {
          record.controller.abort();
        } catch {
          /* ignore */
        }
        record.controller = null;
      }

      const thisGen = ++record.generation;
      const controller = new AbortController();
      record.controller = controller;

      // Set loading state synchronously
      setEntries(prev => {
        const existing = prev[capturedFilename];
        return {
          ...prev,
          [capturedFilename]: {
            summary: existing?.summary ?? null,
            loading: true,
            unloaded: false,
            error: null,
          },
        };
      });

      // Guard: validates controller identity, map identity, all explicit fields, generation, and current scope
      const isAuthoritative = (): boolean => {
        if (!isMountedRef.current) return false;
        if (controller.signal.aborted) return false;
        if (record.controller !== controller) return false;
        if (record.generation !== thisGen) return false;
        if (requestRecords.current.get(capturedFilename) !== record) return false;
        if (scopeGenerationRef.current !== capturedScopeGeneration) return false;
        if (currentScopeRef.current !== capturedScopeKey) return false;
        if (modeRef.current !== capturedMode) return false;
        if (sessionEpochRef.current !== capturedSessionEpoch) return false;
        if (detailEpochRef.current !== capturedDetailEpoch) return false;
        if (!capturedCapabilityEnabled || !capabilityEnabledRef.current) return false;
        if (capabilityEnabledRef.current !== capturedCapabilityEnabled) return false;

        const currentSession = getSessionSnapshot().sessionEpoch;
        if (currentSession !== capturedSessionEpoch) return false;

        if (capturedOwner) {
          const currentOwner = ownerScopeRef.current;
          if (!currentOwner) return false;
          if (
            currentOwner.mode !== capturedOwner.mode ||
            currentOwner.channelEpoch !== capturedOwner.channelEpoch ||
            currentOwner.sessionEpoch !== capturedOwner.sessionEpoch
          ) {
            return false;
          }
          if (!isPanelScopeCurrent(capturedOwner, currentSession)) {
            return false;
          }
        } else {
          if (ownerScopeRef.current !== undefined) return false;
        }

        return true;
      };

      try {
        const summary = await fetchQuotaSummary(
          capturedFilename,
          capturedMode,
          controller.signal,
          capturedOwner,
        );

        // Fencing guard: verify all identities and current owner before publishing ready state
        if (!isAuthoritative()) {
          return null;
        }

        let errorMessage: string | null = null;
        if (summary.status === 'error') {
          errorMessage = mapSafeStatusReason(
            summary.reason,
            summary.upstream_status,
          );
        }

        const nextState: QuotaItemState = {
          summary,
          loading: false,
          unloaded: false,
          error: errorMessage,
        };

        setEntries(prev => ({
          ...prev,
          [capturedFilename]: nextState,
        }));
        return summary;
      } catch (err) {
        // Fencing guard for error publication
        if (!isAuthoritative()) {
          return null;
        }

        if (
          (err instanceof DOMException && err.name === 'AbortError') ||
          (err as Error)?.name === 'AbortError'
        ) {
          return null;
        }

        const { message, summary } = mapSafeQuotaError(err, capturedMode);

        const errorState: QuotaItemState = {
          summary,
          loading: false,
          unloaded: false,
          error: message,
        };

        setEntries(prev => ({
          ...prev,
          [capturedFilename]: errorState,
        }));
        return summary;
      } finally {
        // Stale or aborted finally guard: never reset loading for a newer request or future owner
        if (isAuthoritative()) {
          record.controller = null;
          setEntries(prev => {
            const current = prev[capturedFilename];
            if (current && current.loading) {
              return {
                ...prev,
                [capturedFilename]: { ...current, loading: false },
              };
            }
            return prev;
          });
        }
      }
    },
    [
      isCallbackValid,
      mode,
      sessionEpoch,
      detailEpoch,
      isCapabilityEnabled,
      currentScopeKey,
      currentScopeGeneration,
      copiedOwnerScope,
    ],
  );

  const refresh = useCallback(
    (filename: string): Promise<QuotaSummary | null> => {
      if (!filename || !filename.trim()) {
        return Promise.resolve(null);
      }
      if (!isCallbackValid()) {
        return Promise.resolve(null);
      }
      return queryQuota(filename);
    },
    [isCallbackValid, queryQuota],
  );

  const open = useCallback(
    async (filename: string): Promise<QuotaSummary | null> => {
      if (!filename || !filename.trim()) {
        return null;
      }
      if (!isCallbackValid()) {
        return null;
      }
      activeFilenameRef.current = filename;
      setActiveFilename(filename);
      return queryQuota(filename);
    },
    [isCallbackValid, queryQuota],
  );

  // Owned hooks use actual registerChannelCleanup alongside registerSessionCleanup.
  // Unowned hooks retain session cleanup only with no implicit global channel binding.
  const isOwned = Boolean(copiedOwnerScope);

  useEffect(() => {
    isMountedRef.current = true;

    const handleCleanup = () => {
      abortAllWork();
      activeFilenameRef.current = null;
      if (isMountedRef.current) {
        setEntries({});
        setActiveFilename(null);
      }
    };

    const unregisterSession = registerSessionCleanup(handleCleanup);

    let unregisterChannel: (() => void) | undefined = undefined;
    if (isOwned) {
      unregisterChannel = registerChannelCleanup(handleCleanup);
    }

    return () => {
      isMountedRef.current = false;
      activeFilenameRef.current = null;
      unregisterSession();
      if (unregisterChannel) {
        unregisterChannel();
      }
      abortAllWork();
    };
  }, [abortAllWork, isOwned, ownerEpoch, ownerMode, ownerSession]);

  return {
    entries: visibleEntries,
    getState,
    activeFilename: visibleActiveFilename,
    activeState,
    capabilityEnabled: isCapabilityEnabled,
    open,
    refresh,
    close,
    cancel,
    clear,
  };
}
