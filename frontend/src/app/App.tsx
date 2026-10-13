import { lazy, Suspense, useEffect, useState } from "react";
import { AuthProvider, useAuth } from "@/auth";
import { LoginScreen } from "@/auth/LoginScreen";
import { AppShell } from "@/components/layout/AppShell";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadBoundary } from "./LoadBoundary";
import { useRoute } from "./routes";
const pages = {
  overview: lazy(() => import("@/pages/overview")),
  credentials: lazy(() => import("@/pages/credentials")),
  import: lazy(() => import("@/pages/import")),
  settings: lazy(() => import("@/pages/settings")),
  logs: lazy(() => import("@/pages/logs")),
};
function SessionContent() {
  const { authenticated } = useAuth();
  const route = useRoute();
  const Page = pages[route];
  const [visited, setVisited] = useState(authenticated);
  useEffect(() => { if (authenticated) setVisited(true); }, [authenticated]);
  return <>
    {!authenticated && <LoginScreen />}
    {/* Retain non-sensitive settings drafts across reauthentication; each page disposes session data. */}
    {(visited || authenticated) && <div hidden={!authenticated} inert={!authenticated}>
      <LoadBoundary><AppShell route={route}><LoadBoundary key={route}><Suspense fallback={<div role="status" aria-label="正在加载页面" className="space-y-4"><Skeleton className="h-8 w-40" /><Skeleton className="h-48 w-full" /></div>}><Page /></Suspense></LoadBoundary></AppShell></LoadBoundary>
    </div>}
  </>;
}
export default function App() { return <AuthProvider><SessionContent /></AuthProvider>; }
