import { useEffect, useState, useSyncExternalStore } from "react";
import { Menu } from "lucide-react";
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
  const { authenticated, sessionEpoch } = useAuth();
  const { mode, channelEpoch } = usePanelChannel();
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
    <header className="flex min-h-10 items-center justify-between gap-2.5 border-b bg-popover px-3 py-1.5 md:min-h-11 md:px-6">
      <div className="min-w-0 flex-1 flex flex-col justify-center sm:flex-row sm:items-center sm:gap-2">
        <span className="text-sm font-semibold truncate leading-tight">
          {routes.find((item) => item.id === route)?.title}
        </span>
        <span className="text-[11px] text-muted-foreground leading-tight">
          {isChannelRoute
            ? mode === "geminicli"
              ? "Gemini CLI"
              : "Antigravity"
            : "节点共享"}
        </span>
      </div>

      <Sheet open={open && authenticated} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="md:hidden shrink-0"
            aria-label="打开导航"
          >
            <Menu className="size-4" />
          </Button>
        </SheetTrigger>
        <SheetContent side="right" className="w-64 p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>节点导航</SheetTitle>
            <SheetDescription>选择控制台页面</SheetDescription>
          </SheetHeader>
          <Sidebar route={route} onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
    </header>
  );
}
