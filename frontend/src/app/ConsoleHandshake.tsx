import { useEffect, useRef, useSyncExternalStore } from "react";
import { useAuth } from "@/auth/AuthProvider";
import {
  getSessionSnapshot,
  getSessionValidationSnapshot,
  subscribeSessionValidation,
  type SessionValidationSnapshot,
} from "@/auth/session";
import { usePanelChannel } from "./channels";
import {
  getAcceptedPanelRouteSnapshot,
  subscribeAcceptedPanelRoute,
} from "./routes";
import { getPanelChannelSnapshot } from "@/domain/panel";

export interface ConsoleHandshakeProps {
  active?: boolean;
}

export type EmbedPolicy =
  | { readonly mode: "any_https" }
  | { readonly mode: "exact"; readonly origins: readonly string[] };

export const CONSOLE_READY_PAYLOAD = Object.freeze({
  type: "gcli2api.console.ready",
  version: 1,
  tab: "manage",
} as const);

export function isValidCanonicalHttpsOrigin(value: unknown): value is string {
  if (typeof value !== "string" || !value) {
    return false;
  }
  if (value !== value.trim()) {
    return false;
  }
  if (value.includes("*")) {
    return false;
  }
  if (!value.startsWith("https://")) {
    return false;
  }
  if (value.includes("?") || value.includes("#") || value.includes("@") || value.endsWith("/")) {
    return false;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol !== "https:") {
    return false;
  }
  if (!url.hostname) {
    return false;
  }
  if (url.username !== "" || url.password !== "") {
    return false;
  }
  if (url.search !== "" || url.hash !== "") {
    return false;
  }
  if (url.pathname !== "" && url.pathname !== "/") {
    return false;
  }

  for (let i = 0; i < url.hostname.length; i++) {
    if (url.hostname.charCodeAt(i) > 127) {
      return false;
    }
  }
  if (url.hostname.endsWith(".")) {
    return false;
  }

  if (url.port === "443" || /:443(?::|$|\/)/.test(value)) {
    return false;
  }

  return value === url.origin;
}

export function readEmbedPolicy(): EmbedPolicy | null {
  if (typeof document === "undefined") {
    return null;
  }
  const meta = document.querySelector<HTMLMetaElement>('meta[name="gcli-embed-policy"]');
  if (!meta) {
    return null;
  }
  const content = meta.content ?? meta.getAttribute("content");
  if (!content || content === "__GCLI_EMBED_POLICY__") {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const { mode, origins } = parsed as { mode?: unknown; origins?: unknown };
  if (mode === "any_https") {
    return Object.freeze({ mode: "any_https" });
  }

  if (mode === "exact") {
    if (!Array.isArray(origins) || origins.length === 0) {
      return null;
    }
    const seen = new Set<string>();
    for (const item of origins) {
      if (!isValidCanonicalHttpsOrigin(item) || seen.has(item)) {
        return null;
      }
      seen.add(item);
    }
    return Object.freeze({
      mode: "exact",
      origins: Object.freeze(Array.from(seen)),
    });
  }

  return null;
}

export function resolveTargetOrigins(policy: EmbedPolicy): readonly string[] {
  if (policy.mode === "any_https") {
    return Object.freeze(["*"]);
  }

  const { origins } = policy;

  if (typeof window !== "undefined" && window.location) {
    try {
      const ancestorOrigins = (window.location as unknown as { ancestorOrigins?: DOMStringList | readonly string[] }).ancestorOrigins;
      if (ancestorOrigins && ancestorOrigins.length > 0) {
        const directAncestor = ancestorOrigins[0];
        if (typeof directAncestor === "string" && origins.includes(directAncestor)) {
          return Object.freeze([directAncestor]);
        }
      }
    } catch {
      // Continue to referrer hint on throwing getter or inspection failure
    }
  }

  if (typeof document !== "undefined") {
    try {
      const referrer = document.referrer;
      if (referrer) {
        const refOrigin = new URL(referrer).origin;
        if (origins.includes(refOrigin)) {
          return Object.freeze([refOrigin]);
        }
      }
    } catch {
      // Fall through to exact allowlist fallback on throwing getter or parse error
    }
  }

  return origins;
}

interface ActivationRecord {
  readonly sessionEpoch: number;
  readonly channelEpoch: number;
  readonly navigationEpoch: number;
  readonly validationSnapshot: SessionValidationSnapshot;
}

export function ConsoleHandshake({ active = false }: ConsoleHandshakeProps): null {
  const auth = useAuth();
  const channel = usePanelChannel();
  const routeSnapshot = useSyncExternalStore(
    subscribeAcceptedPanelRoute,
    getAcceptedPanelRouteSnapshot,
    getAcceptedPanelRouteSnapshot
  );
  const validationSnapshot = useSyncExternalStore(
    subscribeSessionValidation,
    getSessionValidationSnapshot,
    getSessionValidationSnapshot
  );

  const lastDeliveredRef = useRef<ActivationRecord | null>(null);

  const capturedValidation = validationSnapshot;
  const capturedNavigationEpoch = routeSnapshot.navigationEpoch;
  const capturedRoute = routeSnapshot.route;
  const capturedRouteMode = routeSnapshot.mode;
  const capturedChannelMode = channel.mode;
  const capturedChannelEpoch = channel.channelEpoch;
  const capturedSessionEpoch = auth.sessionEpoch;
  const capturedToken = auth.token;
  const isAuthenticated = auth.authenticated;
  const validationStatus = auth.validationStatus;

  useEffect(() => {
    if (!active) {
      lastDeliveredRef.current = null;
      return;
    }

    if (typeof window === "undefined" || window.parent === window) {
      return;
    }

    // Auth verification
    if (!isAuthenticated || validationStatus !== "verified" || capturedToken === null) {
      return;
    }

    // Direct session snapshot validation and captured validation object identity check
    if (
      capturedValidation.status !== "verified" ||
      capturedValidation.sessionEpoch !== capturedSessionEpoch
    ) {
      return;
    }

    const liveSession = getSessionSnapshot();
    const liveValidation = getSessionValidationSnapshot();
    if (
      liveSession.token === null ||
      liveSession.sessionEpoch !== capturedSessionEpoch ||
      liveValidation !== capturedValidation ||
      liveValidation.sessionEpoch !== capturedSessionEpoch ||
      liveValidation.status !== "verified"
    ) {
      return;
    }

    // Accepted route and channel
    if (capturedRoute !== "credentials" || capturedRouteMode !== "geminicli") {
      return;
    }

    const liveRoute = getAcceptedPanelRouteSnapshot();
    if (
      liveRoute.route !== "credentials" ||
      liveRoute.mode !== "geminicli" ||
      liveRoute.navigationEpoch !== capturedNavigationEpoch
    ) {
      return;
    }

    // Core panel channel
    if (capturedChannelMode !== "geminicli") {
      return;
    }

    const liveCore = getPanelChannelSnapshot();
    if (
      liveCore.mode !== "geminicli" ||
      liveCore.channelEpoch !== capturedChannelEpoch ||
      liveRoute.mode !== liveCore.mode
    ) {
      return;
    }

    // Embed policy
    const policy = readEmbedPolicy();
    if (!policy) {
      return;
    }

    const targets = resolveTargetOrigins(policy);
    if (targets.length === 0) {
      return;
    }

    const isSameActivation =
      lastDeliveredRef.current !== null &&
      lastDeliveredRef.current.sessionEpoch === capturedSessionEpoch &&
      lastDeliveredRef.current.channelEpoch === capturedChannelEpoch &&
      lastDeliveredRef.current.navigationEpoch === capturedNavigationEpoch &&
      lastDeliveredRef.current.validationSnapshot === capturedValidation;

    if (isSameActivation) {
      return;
    }
    lastDeliveredRef.current = {
      sessionEpoch: capturedSessionEpoch,
      channelEpoch: capturedChannelEpoch,
      navigationEpoch: capturedNavigationEpoch,
      validationSnapshot: capturedValidation,
    };

    let cancelled = false;

    for (const target of targets) {
      if (cancelled || !active || typeof window === "undefined" || window.parent === window) {
        break;
      }

      const currentSession = getSessionSnapshot();
      const currentValidation = getSessionValidationSnapshot();
      const currentRoute = getAcceptedPanelRouteSnapshot();
      const currentCore = getPanelChannelSnapshot();

      if (
        currentSession.token === null ||
        currentSession.sessionEpoch !== capturedSessionEpoch ||
        currentValidation !== capturedValidation ||
        currentValidation.status !== "verified" ||
        currentValidation.sessionEpoch !== capturedSessionEpoch ||
        currentRoute.route !== "credentials" ||
        currentRoute.mode !== "geminicli" ||
        currentRoute.navigationEpoch !== capturedNavigationEpoch ||
        currentCore.mode !== "geminicli" ||
        currentCore.channelEpoch !== capturedChannelEpoch ||
        currentRoute.mode !== currentCore.mode
      ) {
        break;
      }

      try {
        window.parent.postMessage(CONSOLE_READY_PAYLOAD, target);
      } catch {
        // Catch postMessage failure without loop/rawerror
      }
    }

    return () => {
      cancelled = true;
    };
  }, [
    active,
    isAuthenticated,
    validationStatus,
    capturedSessionEpoch,
    capturedToken,
    capturedChannelMode,
    capturedChannelEpoch,
    capturedRoute,
    capturedRouteMode,
    capturedNavigationEpoch,
    capturedValidation,
  ]);

  return null;
}
