import { useSyncExternalStore } from "react";
import { getSessionSnapshot } from "@/auth/session";
export const routes = [
  { id: "overview", title: "概览", description: "节点运行概况" },
  { id: "credentials", title: "凭证", description: "Antigravity 凭证管理" },
  { id: "import", title: "添加凭证", description: "导入与认证" },
  { id: "settings", title: "设置", description: "节点配置" },
  { id: "logs", title: "日志", description: "运行日志" },
  { id: "model-routing", title: "模型路由", description: "模型公开名称与目标名称" },
] as const;
export type RouteId = typeof routes[number]["id"];
export function routeFromHash(hash: string): RouteId {
  const id = hash.replace(/^#\/?/, "");
  return routes.find(route => route.id === id)?.id ?? "overview";
}
export type RouteNavigation = { from: RouteId; to: RouteId; href: string; retry(): void };
type RouteGuard = (attempt: RouteNavigation) => boolean;
type Registration = { guard: RouteGuard };
const listeners = new Set<() => void>();
const guards = new Set<Registration>();
let acceptedHref = window.location.href;
let snapshot = routeFromHash(window.location.hash);
let generation = 0;

/** Guard hash navigation before the current page unmounts, including browser back/forward.
 * Return false to keep the current route. Confirmation may retry only this attempt once.
 * Document exits and beforeunload remain page-owned; no feature imports or draft storage here.
 */
export function registerRouteGuard(guard: RouteGuard): () => void {
  const registration = { guard };
  guards.add(registration);
  return () => { guards.delete(registration); };
}
function notify() { for (const listener of listeners) listener(); }
function transition(href: string, approved = new Set<Registration>(), replace = false) {
  const target = new URL(href, acceptedHref);
  const current = new URL(acceptedHref);
  if (target.origin !== current.origin || target.pathname !== current.pathname || target.search !== current.search) return;
  if (target.href === acceptedHref) return;
  if (target.hash === "#main-content") {
    window.history.replaceState(window.history.state, "", acceptedHref);
    document.getElementById("main-content")?.focus();
    return;
  }
  const to = routeFromHash(target.hash);
  const from = snapshot;
  const version = ++generation;
  const epoch = getSessionSnapshot().sessionEpoch;
  if (to !== from) {
    for (const registration of [...guards]) {
      if (approved.has(registration)) continue;
      let used = false;
      const attempt: RouteNavigation = { from, to, href: target.href, retry() {
        if (used || generation !== version || !guards.has(registration) || getSessionSnapshot().sessionEpoch !== epoch) return;
        used = true;
        transition(target.href, new Set([...approved, registration]), true);
      } };
      if (!registration.guard(attempt)) {
        // hashchange is not cancellable. Keep React on its accepted page and restore its URL.
        window.history.replaceState(window.history.state, "", acceptedHref);
        return;
      }
    }
  }
  if (replace) window.history.replaceState(window.history.state, "", target.href);
  acceptedHref = target.href;
  snapshot = to;
  notify();
}
function onHashChange() {
  // Read the current URL rather than replaying an obsolete queued event.newURL.
  transition(window.location.href);
}
function currentRoute() {
  if (!listeners.size) {
    acceptedHref = window.location.href;
    snapshot = routeFromHash(window.location.hash);
  }
  return snapshot;
}
function subscribe(listener: () => void) {
  if (!listeners.size) {
    currentRoute();
    window.addEventListener("hashchange", onHashChange);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { window.removeEventListener("hashchange", onHashChange); generation++; }
  };
}
export function useRoute() { return useSyncExternalStore(subscribe, currentRoute); }
