import { useSyncExternalStore } from "react";
export const routes = [
  { id: "overview", title: "概览", description: "节点运行概况" },
  { id: "credentials", title: "凭证", description: "Antigravity 凭证管理" },
  { id: "import", title: "添加凭证", description: "导入与认证" },
  { id: "settings", title: "设置", description: "节点配置" },
  { id: "logs", title: "日志", description: "运行日志" },
] as const;
export type RouteId = typeof routes[number]["id"];
export function routeFromHash(hash: string): RouteId {
  const id = hash.replace(/^#\/?/, "");
  return routes.find(route => route.id === id)?.id ?? "overview";
}
function subscribe(listener: () => void) {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}
export function useRoute() { return useSyncExternalStore(subscribe, () => routeFromHash(window.location.hash)); }
