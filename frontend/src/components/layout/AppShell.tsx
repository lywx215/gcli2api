import type { ReactNode } from "react";
import type { RouteId } from "@/app/routes";
import { Sidebar } from "./Sidebar";
import { Header } from "./Header";
export function AppShell({ route, children }: { route: RouteId; children: ReactNode }) {
  return <div className="min-h-svh md:grid md:grid-cols-[15rem_minmax(0,1fr)]">
    <a href="#main-content" onClick={event => { event.preventDefault(); document.getElementById("main-content")?.focus(); }} className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-background focus:p-3 focus:ring-2">跳到主要内容</a>
    <aside className="sticky top-0 hidden h-svh border-r bg-muted/20 md:block"><Sidebar route={route} /></aside>
    <div className="min-w-0"><Header route={route} /><main id="main-content" tabIndex={-1} className="min-w-0 p-4 outline-none md:p-8">{children}</main></div>
  </div>;
}
