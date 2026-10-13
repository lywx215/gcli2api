import { ArrowUpRight, LayoutDashboard, KeyRound, Upload, Settings, ScrollText, Route } from "lucide-react";
import { cn } from "@/domain/shared";
import { getServiceBase } from "@/api/client";
import { routes, type RouteId } from "@/app/routes";
const icons = { overview: LayoutDashboard, credentials: KeyRound, import: Upload, settings: Settings, logs: ScrollText, "model-routing": Route };
export function Sidebar({ route, onNavigate }: { route: RouteId; onNavigate?: () => void }) {
  return <div className="flex h-full flex-col gap-8 p-5">
    <div><p className="text-lg font-semibold tracking-tight">gcli2api</p><p className="mt-1 text-xs text-muted-foreground">节点控制台</p></div>
    <nav aria-label="主导航" className="space-y-1">
      {routes.map(item => { const Icon = icons[item.id]; return <a key={item.id} href={`#/${item.id}`} onClick={onNavigate} aria-current={route === item.id ? "page" : undefined} className={cn("flex min-h-11 items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", route === item.id ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground")}><Icon className="size-4" aria-hidden="true" />{item.title}</a>; })}
    </nav>
    <div className="mt-auto border-t pt-4"><a href={getServiceBase()} className="flex min-h-10 items-center gap-2 text-sm text-muted-foreground hover:text-foreground">现有控制面板<ArrowUpRight className="size-3.5" aria-hidden="true" /></a><p className="mt-2 text-xs leading-relaxed text-muted-foreground">Antigravity 与节点共享设置</p></div>
  </div>;
}
