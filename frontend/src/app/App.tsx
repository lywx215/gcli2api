import { lazy, Suspense, useEffect, useState } from "react";
import { AuthProvider, useAuth } from "@/auth";
import { LoginScreen } from "@/auth/LoginScreen";
import { AppShell } from "@/components/layout/AppShell";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadBoundary } from "./LoadBoundary";
import { useRoute } from "./routes";
// Integration replaces only this loader with each independently owned page module.
const PlaceholderPage = lazy(() => import("./PlaceholderPage"));
function SessionContent() {
  const { authenticated } = useAuth();
  const route = useRoute();
  const [visited, setVisited] = useState(authenticated);
  useEffect(() => { if (authenticated) setVisited(true); }, [authenticated]);
  return <>
    {!authenticated && <LoginScreen />}
    {/* Keep mounted drafts across reauthentication. Pages clear reads and sensitive fields on epoch changes. */}
    {(visited || authenticated) && <div hidden={!authenticated} inert={!authenticated}>
      <AppShell route={route}><LoadBoundary key={route}><Suspense fallback={<div role="status" aria-label="正在加载页面" className="space-y-4"><Skeleton className="h-8 w-40" /><Skeleton className="h-48 w-full" /></div>}><PlaceholderPage route={route} /></Suspense></LoadBoundary></AppShell>
    </div>}
  </>;
}
export default function App() { return <AuthProvider><SessionContent /></AuthProvider>; }
