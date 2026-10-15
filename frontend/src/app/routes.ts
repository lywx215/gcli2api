import { useSyncExternalStore } from "react";
import { getSessionSnapshot, subscribeSession } from "@/auth/session";
import {
  __commitPanelChannel,
  getPanelChannelSnapshot,
  isPanelMode,
  subscribePanelChannel,
  type PanelMode,
} from "@/domain/panel";

export const routes = [
  { id: "overview", title: "概览", description: "节点运行概况" },
  { id: "credentials", title: "凭证", description: "Antigravity 凭证管理" },
  { id: "import", title: "添加凭证", description: "导入与认证" },
  { id: "settings", title: "设置", description: "节点配置" },
  { id: "logs", title: "日志", description: "运行日志" },
  { id: "model-routing", title: "模型路由", description: "模型公开名称与目标名称" },
] as const;

export type RouteId = (typeof routes)[number]["id"];

export function routeFromHash(hash: string): RouteId {
  const id = hash.replace(/^#\/?/, "").split("?")[0];
  return routes.find(route => route.id === id)?.id ?? "overview";
}

export function panelRouteHref(route: RouteId, mode: PanelMode): string {
  if (!routes.some(r => r.id === route)) {
    throw new TypeError("Invalid route");
  }
  if (!isPanelMode(mode)) {
    throw new TypeError("Invalid panel mode");
  }
  return mode === "geminicli" ? `#/${route}?channel=geminicli` : `#/${route}`;
}

export type RouteNavigation = {
  from: RouteId;
  to: RouteId;
  href: string;
  retry(): void;
  fromMode?: PanelMode;
  toMode?: PanelMode;
};

export type AcceptedPanelRouteSnapshot = {
  readonly route: RouteId;
  readonly mode: PanelMode;
  readonly navigationEpoch: number;
};

type RouteGuard = (attempt: RouteNavigation) => boolean;
type Registration = { guard: RouteGuard };

interface PanelHistoryState {
  panelRoute?: RouteId;
  panelMode?: PanelMode;
  panelHash?: string;
  [key: string]: unknown;
}

function parseFragment(hash: string): { route: RouteId; explicitChannel?: PanelMode } {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const queryIndex = raw.indexOf("?");
  const pathPart = queryIndex === -1 ? raw : raw.slice(0, queryIndex);
  const queryPart = queryIndex === -1 ? "" : raw.slice(queryIndex + 1);

  const routeCandidate = pathPart.replace(/^\/+/, "");
  const route = routes.find(r => r.id === routeCandidate)?.id ?? "overview";

  let explicitChannel: PanelMode | undefined = undefined;
  if (queryPart) {
    const params = new URLSearchParams(queryPart);
    if (params.has("channel")) {
      const values = params.getAll("channel");
      if (values.length === 1 && values[0] === "geminicli") {
        explicitChannel = "geminicli";
      } else {
        // Exact "antigravity", or duplicate, or invalid all select safe "antigravity"
        explicitChannel = "antigravity";
      }
    }
  }

  return { route, explicitChannel };
}

function createEntryState(
  route: RouteId,
  mode: PanelMode,
  hash: string,
  existingState: unknown
): Record<string, unknown> {
  const base =
    existingState && typeof existingState === "object"
      ? { ...(existingState as Record<string, unknown>) }
      : {};
  delete base.panelHref;
  return {
    ...base,
    panelRoute: route,
    panelMode: mode,
    panelHash: hash,
  };
}

const listeners = new Set<() => void>();
const guards = new Set<Registration>();

let generation = 0;
let navigationEpoch = 0;
let inTransition = false;
let pendingSnapshot: AcceptedPanelRouteSnapshot | null = null;

let initialRoute: RouteId = "overview";
let initialExplicitChannel: PanelMode | undefined = undefined;
if (typeof window !== "undefined") {
  const parsed = parseFragment(window.location.hash);
  initialRoute = parsed.route;
  initialExplicitChannel = parsed.explicitChannel;
}

let acceptedRoute: RouteId = initialRoute;
let coreMode: PanelMode = getPanelChannelSnapshot().mode;
let acceptedMode: PanelMode = coreMode;
let channelEpoch = getPanelChannelSnapshot().channelEpoch;
let sessionEpoch = getSessionSnapshot().sessionEpoch;

let acceptedHref =
  typeof window !== "undefined"
    ? new URL(panelRouteHref(acceptedRoute, acceptedMode), window.location.href).href
    : "";

let currentSnapshot: AcceptedPanelRouteSnapshot = Object.freeze({
  route: acceptedRoute,
  mode: acceptedMode,
  navigationEpoch,
});

export function registerRouteGuard(guard: RouteGuard): () => void {
  if (
    typeof window !== "undefined" &&
    listeners.size === 0 &&
    guards.size === 0 &&
    window.location.href !== acceptedHref
  ) {
    transition(window.location.href);
  }
  const registration = { guard };
  guards.add(registration);
  return () => {
    guards.delete(registration);
  };
}

function notify(): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener();
    } catch {
      // Isolate listener exceptions
    }
  }
}

function syncAcceptedState(nextRoute = acceptedRoute): boolean {
  const channel = getPanelChannelSnapshot();
  const session = getSessionSnapshot();
  if (
    nextRoute === acceptedRoute &&
    channel.mode === coreMode &&
    channel.mode === acceptedMode &&
    channel.channelEpoch === channelEpoch &&
    session.sessionEpoch === sessionEpoch
  ) {
    return false;
  }
  acceptedRoute = nextRoute;
  coreMode = channel.mode;
  acceptedMode = channel.mode;
  channelEpoch = channel.channelEpoch;
  sessionEpoch = session.sessionEpoch;
  navigationEpoch += 1;
  currentSnapshot = Object.freeze({
    route: acceptedRoute,
    mode: acceptedMode,
    navigationEpoch,
  });
  return true;
}

function onCoreOrSessionChange(): void {
  if (inTransition) return;
  if (syncAcceptedState()) {
    notify();
  }
}

subscribePanelChannel(onCoreOrSessionChange);
subscribeSession(onCoreOrSessionChange);

function transition(
  href: string,
  approved = new Set<Registration>(),
  _replace = false,
  explicitMode?: PanelMode,
  forcedRoute?: RouteId,
  isProgrammatic = false
): void {
  if (typeof window === "undefined") return;

  const target = new URL(href, window.location.href);
  const current = new URL(acceptedHref || window.location.href);

  if (
    target.origin !== current.origin ||
    target.pathname !== current.pathname ||
    target.search !== current.search
  ) {
    return;
  }

  if (target.hash === "#main-content") {
    window.history.replaceState(window.history.state, "", acceptedHref);
    document.getElementById("main-content")?.focus();
    return;
  }

  const { route: parsedRoute, explicitChannel } = parseFragment(target.hash);
  const to: RouteId = forcedRoute ?? parsedRoute;

  let toMode: PanelMode;
  if (explicitMode !== undefined) {
    toMode = explicitMode;
  } else if (explicitChannel !== undefined) {
    toMode = explicitChannel;
  } else {
    const state = window.history.state;
    if (state && typeof state === "object") {
      const s = state as PanelHistoryState;
      if (
        s.panelRoute === to &&
        isPanelMode(s.panelMode) &&
        typeof s.panelHash === "string" &&
        s.panelHash === target.hash
      ) {
        toMode = s.panelMode;
      } else {
        toMode = acceptedMode;
      }
    } else {
      toMode = acceptedMode;
    }
  }

  const canonicalRel = panelRouteHref(to, toMode);
  const canonicalHref = new URL(canonicalRel, window.location.href).href;

  if (
    target.href === acceptedHref &&
    to === acceptedRoute &&
    toMode === acceptedMode
  ) {
    return;
  }

  if (to === acceptedRoute && toMode === acceptedMode) {
    if (window.location.href !== canonicalHref) {
      window.history.replaceState(
        createEntryState(acceptedRoute, acceptedMode, canonicalRel, window.history.state),
        "",
        canonicalHref
      );
      acceptedHref = canonicalHref;
    }
    return;
  }

  const from = acceptedRoute;
  const fromMode = acceptedMode;
  const version = ++generation;
  const sessionEpochSnapshot = getSessionSnapshot().sessionEpoch;

  for (const registration of [...guards]) {
    if (approved.has(registration)) continue;
    let used = false;
    const attempt: RouteNavigation = {
      from,
      to,
      fromMode,
      toMode,
      href: canonicalHref,
      retry() {
        if (
          used ||
          generation !== version ||
          !guards.has(registration) ||
          getSessionSnapshot().sessionEpoch !== sessionEpochSnapshot
        ) {
          return;
        }
        used = true;
        transition(
          canonicalHref,
          new Set([...approved, registration]),
          true,
          toMode,
          to,
          false
        );
      },
    };
    if (!registration.guard(attempt)) {
      const acceptedRel = panelRouteHref(acceptedRoute, acceptedMode);
      window.history.replaceState(
        createEntryState(acceptedRoute, acceptedMode, acceptedRel, window.history.state),
        "",
        acceptedHref
      );
      return;
    }
  }

  const nextEntryState = createEntryState(to, toMode, canonicalRel, window.history.state);
  if (isProgrammatic) {
    window.history.pushState(nextEntryState, "", canonicalHref);
  } else {
    window.history.replaceState(nextEntryState, "", canonicalHref);
  }
  acceptedHref = canonicalHref;

  const modeChanged = toMode !== coreMode;
  if (modeChanged) {
    const nextNavigationEpoch = navigationEpoch + 1;
    pendingSnapshot = Object.freeze({
      route: to,
      mode: toMode,
      navigationEpoch: nextNavigationEpoch,
    });
    inTransition = true;
    try {
      __commitPanelChannel(toMode);
    } finally {
      inTransition = false;
    }
    acceptedRoute = to;
    acceptedMode = toMode;
    coreMode = toMode;
    channelEpoch = getPanelChannelSnapshot().channelEpoch;
    sessionEpoch = getSessionSnapshot().sessionEpoch;
    navigationEpoch = nextNavigationEpoch;
    currentSnapshot = pendingSnapshot;
    pendingSnapshot = null;
    notify();
  } else {
    navigationEpoch += 1;
    acceptedRoute = to;
    currentSnapshot = Object.freeze({
      route: acceptedRoute,
      mode: coreMode,
      navigationEpoch,
    });
    notify();
  }
}

function onHashOrPopState(): void {
  if (typeof window === "undefined") return;
  transition(window.location.href);
}

export function navigatePanel(route: RouteId, mode?: PanelMode): void {
  if (!routes.some(r => r.id === route)) {
    throw new TypeError("Invalid route");
  }
  if (mode !== undefined && !isPanelMode(mode)) {
    throw new TypeError("Invalid panel mode");
  }
  if (typeof window === "undefined") {
    return;
  }
  const targetMode = mode ?? acceptedMode;
  const canonicalRel = panelRouteHref(route, targetMode);
  const targetHref = new URL(canonicalRel, window.location.href).href;
  transition(targetHref, new Set(), false, targetMode, route, true);
}

export function getAcceptedPanelRouteSnapshot(): AcceptedPanelRouteSnapshot {
  if (pendingSnapshot) {
    const channel = getPanelChannelSnapshot();
    if (channel.channelEpoch !== channelEpoch) {
      return pendingSnapshot;
    }
  }
  return currentSnapshot;
}

export function subscribeAcceptedPanelRoute(listener: () => void): () => void {
  if (typeof listener !== "function") {
    return () => {};
  }
  const wasEmpty = listeners.size === 0;
  listeners.add(listener);
  if (wasEmpty) {
    if (typeof window !== "undefined") {
      window.addEventListener("hashchange", onHashOrPopState);
      window.addEventListener("popstate", onHashOrPopState);
      if (window.location.href !== acceptedHref) {
        transition(window.location.href);
      }
    }
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      if (typeof window !== "undefined") {
        window.removeEventListener("hashchange", onHashOrPopState);
        window.removeEventListener("popstate", onHashOrPopState);
      }
      generation++;
    }
  };
}

function readAcceptedRoute(): RouteId {
  return getAcceptedPanelRouteSnapshot().route;
}

export function useRoute(): RouteId {
  return useSyncExternalStore(subscribeAcceptedPanelRoute, readAcceptedRoute);
}

function initRouter(): void {
  if (typeof window === "undefined") return;

  if (initialExplicitChannel !== undefined) {
    transition(window.location.href, new Set(), false, initialExplicitChannel);
  } else {
    const canonicalHash = panelRouteHref(acceptedRoute, acceptedMode);
    const canonicalHref = new URL(canonicalHash, window.location.href).href;
    window.history.replaceState(
      createEntryState(acceptedRoute, acceptedMode, canonicalHash, window.history.state),
      "",
      canonicalHref
    );
    acceptedHref = canonicalHref;
  }
}

initRouter();
