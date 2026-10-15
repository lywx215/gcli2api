import {
  lazy,
  Suspense,
  useEffect,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { AuthProvider, useAuth } from "@/auth";
import { LoginScreen } from "@/auth/LoginScreen";
import { AppShell } from "@/components/layout/AppShell";
import { Skeleton } from "@/components/ui/skeleton";
import { getServiceBase } from "@/api/client";
import { isPanelMode, type PanelMode } from "@/domain/panel";
import { PanelChannelProvider, usePanelChannel } from "./channels";
import { LoadBoundary } from "./LoadBoundary";
import { useRoute, type RouteId } from "./routes";

type PageModule = {
  default: ComponentType<any>;
  supportedPanelModes?: unknown;
};

let overviewModulePromise: Promise<PageModule> | null = null;
let resolvedOverviewModule: PageModule | null = null;

function loadOverview(): Promise<PageModule> {
  if (!overviewModulePromise) {
    overviewModulePromise = import("@/pages/overview")
      .then(mod => {
        resolvedOverviewModule = mod;
        return mod;
      })
      .catch(err => {
        overviewModulePromise = null;
        resolvedOverviewModule = null;
        throw err;
      });
  }
  return overviewModulePromise;
}

let credentialsModulePromise: Promise<PageModule> | null = null;
let resolvedCredentialsModule: PageModule | null = null;

function loadCredentials(): Promise<PageModule> {
  if (!credentialsModulePromise) {
    credentialsModulePromise = import("@/pages/credentials")
      .then(mod => {
        resolvedCredentialsModule = mod;
        return mod;
      })
      .catch(err => {
        credentialsModulePromise = null;
        resolvedCredentialsModule = null;
        throw err;
      });
  }
  return credentialsModulePromise;
}

const pages = {
  overview: lazy(loadOverview),
  credentials: lazy(loadCredentials),
  import: lazy(() => import("@/pages/import")),
  settings: lazy(() => import("@/pages/settings")),
  logs: lazy(() => import("@/pages/logs")),
  "model-routing": lazy(() => import("@/pages/model-routing")),
};

const SENSITIVE_ROUTES = new Set<RouteId>(["overview", "credentials", "import"]);

function isSensitiveRoute(route: RouteId): boolean {
  return SENSITIVE_ROUTES.has(route);
}

function isWellFormedPanelModeArray(value: unknown): value is readonly PanelMode[] {
  return Array.isArray(value) && value.every(isPanelMode);
}

function checkModuleSupport(mod: unknown, mode: PanelMode): boolean {
  if (mode === "antigravity") {
    return true;
  }
  if (!mod || typeof mod !== "object") {
    return false;
  }
  const modes = (mod as { supportedPanelModes?: unknown }).supportedPanelModes;
  if (!isWellFormedPanelModeArray(modes)) {
    return false;
  }
  return modes.includes(mode);
}

const PAGE_LOADING_FALLBACK = (
  <div role="status" aria-label="正在加载页面" className="space-y-4">
    <Skeleton className="h-8 w-40" />
    <Skeleton className="h-48 w-full" />
  </div>
);

function GcliUnsupportedPlaceholder() {
  const legacyHref = new URL("#manage", getServiceBase()).href;
  return (
    <div role="region" aria-label="当前渠道暂不支持" className="space-y-4 rounded-lg border p-6">
      <h1 className="text-lg font-semibold">当前渠道暂未支持</h1>
      <p className="text-sm text-muted-foreground">
        可前往旧版管理面板继续操作：
      </p>
      <a
        href={legacyHref}
        className="inline-block text-primary underline underline-offset-4 hover:text-primary-hover active:text-primary-active"
      >
        前往旧版管理面板
      </a>
    </div>
  );
}

function DiscoveryError({ error }: { error?: unknown }): ReactNode {
  throw error;
}

type MountedActivation = {
  route: RouteId;
  mode: PanelMode;
  sessionEpoch: number;
};

function SessionContent() {
  const { authenticated, sessionEpoch } = useAuth();
  const route = useRoute();
  const { mode } = usePanelChannel();

  const [verifiedActivation, setVerifiedActivation] = useState<MountedActivation | null>(() => {
    return authenticated ? { route, mode, sessionEpoch } : null;
  });

  useEffect(() => {
    if (authenticated) {
      setVerifiedActivation({ route, mode, sessionEpoch });
    }
  }, [authenticated, route, mode, sessionEpoch]);

  const activeActivation = authenticated
    ? { route, mode, sessionEpoch }
    : verifiedActivation;

  const activeRoute = activeActivation?.route;
  const activeMode = activeActivation?.mode;
  const activeEpoch = activeActivation?.sessionEpoch;

  const isSensitive = activeRoute ? isSensitiveRoute(activeRoute) : false;
  const boundaryKey = activeRoute
    ? (isSensitive ? `${activeRoute}:${activeMode}:${activeEpoch}` : activeRoute)
    : undefined;
  const Page = activeRoute ? pages[activeRoute] : null;

  const [overviewDiscovery, setOverviewDiscovery] = useState<{
    ownerKey: string;
    status: "loading" | "supported" | "unsupported" | "error";
    error?: unknown;
  } | null>(null);

  const [credentialsDiscovery, setCredentialsDiscovery] = useState<{
    ownerKey: string;
    status: "loading" | "supported" | "unsupported" | "error";
    error?: unknown;
  } | null>(null);

  useEffect(() => {
    if (!authenticated || route !== "overview") {
      return;
    }

    const activationOwnerKey = `${route}:${mode}:${sessionEpoch}`;

    if (resolvedOverviewModule) {
      return;
    }

    let cancelled = false;
    loadOverview()
      .then(mod => {
        if (cancelled) return;
        setOverviewDiscovery(prev => {
          const currentActiveKey = `${route}:${mode}:${sessionEpoch}`;
          if (currentActiveKey !== activationOwnerKey) {
            return prev;
          }
          const supported = checkModuleSupport(mod, mode);
          return {
            ownerKey: activationOwnerKey,
            status: supported ? "supported" : "unsupported",
          };
        });
      })
      .catch(err => {
        if (cancelled) return;
        setOverviewDiscovery(prev => {
          const currentActiveKey = `${route}:${mode}:${sessionEpoch}`;
          if (currentActiveKey !== activationOwnerKey) {
            return prev;
          }
          return {
            ownerKey: activationOwnerKey,
            status: "error",
            error: err,
          };
        });
      });

    return () => {
      cancelled = true;
    };
  }, [authenticated, route, mode, sessionEpoch]);

  useEffect(() => {
    if (!authenticated || route !== "credentials") {
      return;
    }

    const activationOwnerKey = `${route}:${mode}:${sessionEpoch}`;

    if (resolvedCredentialsModule) {
      return;
    }

    let cancelled = false;
    loadCredentials()
      .then(mod => {
        if (cancelled) return;
        setCredentialsDiscovery(prev => {
          const currentActiveKey = `${route}:${mode}:${sessionEpoch}`;
          if (currentActiveKey !== activationOwnerKey) {
            return prev;
          }
          const supported = checkModuleSupport(mod, mode);
          return {
            ownerKey: activationOwnerKey,
            status: supported ? "supported" : "unsupported",
          };
        });
      })
      .catch(err => {
        if (cancelled) return;
        setCredentialsDiscovery(prev => {
          const currentActiveKey = `${route}:${mode}:${sessionEpoch}`;
          if (currentActiveKey !== activationOwnerKey) {
            return prev;
          }
          return {
            ownerKey: activationOwnerKey,
            status: "error",
            error: err,
          };
        });
      });

    return () => {
      cancelled = true;
    };
  }, [authenticated, route, mode, sessionEpoch]);

  let content: ReactNode = null;
  if (activeMode === "geminicli" && isSensitive) {
    if (activeRoute === "overview") {
      if (
        overviewDiscovery !== null &&
        overviewDiscovery.ownerKey === boundaryKey &&
        overviewDiscovery.status === "error"
      ) {
        content = authenticated ? <DiscoveryError error={overviewDiscovery.error} /> : null;
      } else if (resolvedOverviewModule !== null) {
        if (checkModuleSupport(resolvedOverviewModule, "geminicli")) {
          content = authenticated ? (
            <Suspense fallback={PAGE_LOADING_FALLBACK}>
              {Page && <Page />}
            </Suspense>
          ) : null;
        } else {
          content = <GcliUnsupportedPlaceholder />;
        }
      } else {
        content = authenticated ? PAGE_LOADING_FALLBACK : null;
      }
    } else if (activeRoute === "credentials") {
      if (
        credentialsDiscovery !== null &&
        credentialsDiscovery.ownerKey === boundaryKey &&
        credentialsDiscovery.status === "error"
      ) {
        content = authenticated ? <DiscoveryError error={credentialsDiscovery.error} /> : null;
      } else if (resolvedCredentialsModule !== null) {
        if (checkModuleSupport(resolvedCredentialsModule, "geminicli")) {
          content = authenticated ? (
            <Suspense fallback={PAGE_LOADING_FALLBACK}>
              {Page && <Page />}
            </Suspense>
          ) : null;
        } else {
          content = <GcliUnsupportedPlaceholder />;
        }
      } else {
        content = authenticated ? PAGE_LOADING_FALLBACK : null;
      }
    } else {
      content = <GcliUnsupportedPlaceholder />;
    }
  } else if (Page) {
    if (!isSensitive || authenticated) {
      content = (
        <Suspense fallback={PAGE_LOADING_FALLBACK}>
          <Page />
        </Suspense>
      );
    }
  }

  return (
    <>
      {!authenticated && <LoginScreen />}
      {/* Retain non-sensitive settings drafts across reauthentication; each page disposes session data. */}
      {activeActivation && Page && (
        <div hidden={!authenticated} inert={!authenticated}>
          <LoadBoundary>
            <AppShell route={activeActivation.route}>
              <LoadBoundary key={boundaryKey}>
                {content}
              </LoadBoundary>
            </AppShell>
          </LoadBoundary>
        </div>
      )}
    </>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <PanelChannelProvider>
        <SessionContent />
      </PanelChannelProvider>
    </AuthProvider>
  );
}
