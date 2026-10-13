import { useEffect, useState } from "react";
import { Menu, LogOut } from "lucide-react";
import { useAuth } from "@/auth";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { routes, type RouteId } from "@/app/routes";
import { Sidebar } from "./Sidebar";
export function Header({ route }: { route: RouteId }) {
  const { logout, authenticated, sessionEpoch } = useAuth();
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(false); }, [authenticated, sessionEpoch]);
  return <header className="flex min-h-16 flex-wrap items-center gap-3 border-b bg-popover px-4 py-3 md:px-8">
    <Sheet open={open && authenticated} onOpenChange={setOpen}><SheetTrigger asChild><Button variant="ghost" size="icon" className="md:hidden" aria-label="打开导航"><Menu className="size-5" /></Button></SheetTrigger><SheetContent side="left" className="w-72 p-0"><SheetHeader className="sr-only"><SheetTitle>节点导航</SheetTitle><SheetDescription>选择控制台页面</SheetDescription></SheetHeader><Sidebar route={route} onNavigate={() => setOpen(false)} /></SheetContent></Sheet>
    <div className="min-w-0 flex-1"><h1 className="font-semibold">{routes.find(item => item.id === route)?.title}</h1><p className="text-xs text-muted-foreground">Antigravity</p></div>
    <Button variant="ghost" size="sm" data-panel-action="logout" onClick={logout}><LogOut className="mr-2 size-4" aria-hidden="true" />退出登录</Button>
  </header>;
}
