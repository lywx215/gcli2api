import { ArrowUpRight, LayoutDashboard, KeyRound, Upload, Settings, ScrollText, Route } from "lucide-react";
import { cn } from "@/domain/shared";
import { getServiceBase } from "@/api/client";
import { usePanelChannel } from "@/app/channels";
import { panelRouteHref, routes, type RouteId } from "@/app/routes";

const icons = {
  overview: LayoutDashboard,
  credentials: KeyRound,
  import: Upload,
  settings: Settings,
  logs: ScrollText,
  "model-routing": Route,
};

export function Sidebar({ route, onNavigate }: { route: RouteId; onNavigate?: () => void }) {
  const { mode } = usePanelChannel();
  const legacyHash = mode === "geminicli" ? "#manage" : "#antigravity-manage";
  const legacyHref = new URL(legacyHash, getServiceBase()).href;

  return (
    <div className="flex h-full flex-col gap-8 p-5">
      <div>
        <p className="text-lg font-semibold tracking-tight">gcli2api</p>
        <p className="mt-1 text-xs text-muted-foreground">节点控制台</p>
      </div>
      <nav aria-label="主导航" className="space-y-1">
        {routes.map(item => {
          const Icon = icons[item.id];
          return (
            <a
              key={item.id}
              href={panelRouteHref(item.id, mode)}
              onClick={onNavigate}
              aria-current={route === item.id ? "page" : undefined}
              className={cn(
                "relative flex min-h-11 items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors hover:bg-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                route === item.id
                  ? "bg-selected font-semibold text-foreground before:absolute before:inset-y-3 before:left-0 before:w-0.5 before:rounded-full before:bg-primary"
                  : "text-muted-foreground"
              )}
            >
              <Icon className="size-4" aria-hidden="true" />
              {item.title}
            </a>
          );
        })}
      </nav>
      <div className="mt-auto border-t pt-4">
        <a
          href={legacyHref}
          className="flex min-h-10 items-center gap-2 rounded-md text-sm text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
        >
          现有控制面板
          <ArrowUpRight className="size-3.5" aria-hidden="true" />
        </a>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {mode === "geminicli" ? "Gemini CLI 与节点共享设置" : "Antigravity 与节点共享设置"}
        </p>
      </div>
    </div>
  );
}
