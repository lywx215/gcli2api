import {
  ArrowUpRight,
  LayoutDashboard,
  KeyRound,
  Upload,
  Settings,
  ScrollText,
  Route,
  LogOut,
} from "lucide-react";
import { useAuth } from "@/auth";
import { usePanelChannel } from "@/app/channels";
import { navigatePanel, panelRouteHref, type RouteId } from "@/app/routes";
import type { PanelMode } from "@/domain/panel";
import { Button } from "@/components/ui/button";
import { cn } from "@/domain/shared";
import { getServiceBase } from "@/api/client";

interface NavItem {
  id: string;
  title: string;
  icon: typeof LayoutDashboard;
  href: string;
  routeId: RouteId;
  targetMode?: PanelMode;
  isActive: boolean;
}

export function Sidebar({ route, onNavigate }: { route: RouteId; onNavigate?: () => void }) {
  const { logout } = useAuth();
  const { mode } = usePanelChannel();
  const legacyHash = mode === "geminicli" ? "#manage" : "#antigravity-manage";
  const legacyTarget = new URL("legacy", getServiceBase());
  legacyTarget.hash = legacyHash;
  const legacyHref = legacyTarget.href;

  const handleNavigate = (
    e: React.MouseEvent<HTMLAnchorElement>,
    targetRoute: RouteId,
    targetMode?: PanelMode
  ) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) {
      return;
    }
    e.preventDefault();
    navigatePanel(targetRoute, targetMode);
    onNavigate?.();
  };

  const navItems: NavItem[] = [
    {
      id: "overview",
      title: "概览",
      icon: LayoutDashboard,
      href: panelRouteHref("overview", mode),
      routeId: "overview",
      targetMode: mode,
      isActive: route === "overview",
    },
    {
      id: "credentials-antigravity",
      title: "Anti凭证",
      icon: KeyRound,
      href: "#/credentials?channel=antigravity",
      routeId: "credentials",
      targetMode: "antigravity",
      isActive: route === "credentials" && mode === "antigravity",
    },
    {
      id: "credentials-geminicli",
      title: "CLI凭证",
      icon: KeyRound,
      href: panelRouteHref("credentials", "geminicli"),
      routeId: "credentials",
      targetMode: "geminicli",
      isActive: route === "credentials" && mode === "geminicli",
    },
    {
      id: "import",
      title: "添加凭证",
      icon: Upload,
      href: panelRouteHref("import", mode),
      routeId: "import",
      targetMode: mode,
      isActive: route === "import",
    },
    {
      id: "settings",
      title: "设置",
      icon: Settings,
      href: panelRouteHref("settings", mode),
      routeId: "settings",
      targetMode: mode,
      isActive: route === "settings",
    },
    {
      id: "logs",
      title: "日志",
      icon: ScrollText,
      href: panelRouteHref("logs", mode),
      routeId: "logs",
      targetMode: mode,
      isActive: route === "logs",
    },
    {
      id: "model-routing",
      title: "模型路由",
      icon: Route,
      href: panelRouteHref("model-routing", mode),
      routeId: "model-routing",
      targetMode: mode,
      isActive: route === "model-routing",
    },
  ];

  return (
    <div className="flex h-full flex-col gap-4 p-3.5 overflow-y-auto">
      <div>
        <p className="text-base font-semibold tracking-tight leading-tight">gcli2api</p>
        <p className="mt-1 text-[11px] text-muted-foreground leading-tight">
          节点控制台 · {mode === "geminicli" ? "Gemini CLI" : "Antigravity"}
        </p>
      </div>
      <nav aria-label="主导航" className="space-y-1 flex-1">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <a
              key={item.id}
              href={item.href}
              onClick={(e) => handleNavigate(e, item.routeId, item.targetMode)}
              aria-current={item.isActive ? "page" : undefined}
              data-nav-link=""
              className={cn(
                "relative flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] transition-colors hover:bg-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                item.isActive
                  ? "bg-selected font-semibold text-foreground before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-primary"
                  : "text-muted-foreground"
              )}
            >
              <Icon className="size-4 shrink-0" aria-hidden="true" />
              {item.title}
            </a>
          );
        })}
      </nav>
      <div className="mt-auto border-t pt-3 space-y-2 shrink-0">
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start text-[12px] h-8 text-muted-foreground hover:text-foreground hover:bg-hover px-2.5"
          data-panel-action="logout"
          onClick={() => {
            onNavigate?.();
            logout();
          }}
        >
          <LogOut className="mr-2 size-3.5 shrink-0" aria-hidden="true" />
          退出登录
        </Button>
        <a
          href={legacyHref}
          data-nav-link=""
          className="flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
        >
          现有控制面板
          <ArrowUpRight className="size-3.5 shrink-0" aria-hidden="true" />
        </a>
        <p className="px-2.5 text-[11px] leading-relaxed text-muted-foreground">
          {mode === "geminicli" ? "Gemini CLI 与节点共享设置" : "Antigravity 与节点共享设置"}
        </p>
      </div>
    </div>
  );
}
