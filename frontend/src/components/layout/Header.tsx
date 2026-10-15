import { useEffect, useState, useSyncExternalStore } from "react";
import { Menu, LogOut } from "lucide-react";
import { useAuth } from "@/auth";
import { usePanelChannel } from "@/app/channels";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  getAcceptedPanelRouteSnapshot,
  routes,
  subscribeAcceptedPanelRoute,
  type RouteId,
} from "@/app/routes";
import { Sidebar } from "./Sidebar";

export function Header({ route }: { route: RouteId }) {
  const { logout, authenticated, sessionEpoch } = useAuth();
  const { mode, channelEpoch, changeMode } = usePanelChannel();
  const routeSnapshot = useSyncExternalStore(
    subscribeAcceptedPanelRoute,
    getAcceptedPanelRouteSnapshot,
    getAcceptedPanelRouteSnapshot
  );

  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(false);
  }, [route, routeSnapshot.navigationEpoch, channelEpoch, authenticated, sessionEpoch]);

  const isChannelRoute =
    route === "overview" || route === "credentials" || route === "import";

  return (
    <header className="flex min-h-16 flex-wrap items-center gap-3 border-b bg-popover px-4 py-3 md:px-8">
      <Sheet open={open && authenticated} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-label="打开导航"
          >
            <Menu className="size-5" />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-72 p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>节点导航</SheetTitle>
            <SheetDescription>选择控制台页面</SheetDescription>
          </SheetHeader>
          <Sidebar route={route} onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>

      <div className="min-w-0 flex-1">
        <h1 className="font-semibold">
          {routes.find((item) => item.id === route)?.title}
        </h1>
        <p className="text-xs text-muted-foreground">
          {isChannelRoute
            ? mode === "geminicli"
              ? "Gemini CLI"
              : "Antigravity"
            : "节点共享"}
        </p>
      </div>

      {isChannelRoute && (
        <div
          role="group"
          aria-label="渠道切换"
          className="flex items-center gap-1"
        >
          <Button
            variant={mode === "antigravity" ? "default" : "outline"}
            size="sm"
            aria-pressed={mode === "antigravity"}
            data-channel="antigravity"
            disabled={!authenticated}
            onClick={() => {
              if (authenticated) {
                changeMode("antigravity");
              }
            }}
          >
            Antigravity
          </Button>
          <Button
            variant={mode === "geminicli" ? "default" : "outline"}
            size="sm"
            aria-pressed={mode === "geminicli"}
            data-channel="geminicli"
            disabled={!authenticated}
            onClick={() => {
              if (authenticated) {
                changeMode("geminicli");
              }
            }}
          >
            Gemini CLI
          </Button>
        </div>
      )}

      <Button
        variant="ghost"
        size="sm"
        data-panel-action="logout"
        onClick={logout}
      >
        <LogOut className="mr-2 size-4" aria-hidden="true" />
        退出登录
      </Button>
    </header>
  );
}
