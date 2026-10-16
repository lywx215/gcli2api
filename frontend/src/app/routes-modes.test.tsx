import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PanelChannelSnapshot } from "@/domain/panel";
import type { AcceptedPanelRouteSnapshot, RouteNavigation } from "./routes";

const releases = new Set<() => void>();

function trackRelease(release: () => void): () => void {
  releases.add(release);
  return () => {
    releases.delete(release);
    release();
  };
}

afterEach(() => {
  for (const release of Array.from(releases)) {
    try {
      release();
    } catch {
      // Isolate cleanup errors
    }
  }
  releases.clear();
});

async function loadRouterSuite(initialUrl = "/ui/#/overview", initialState: unknown = null) {
  window.history.replaceState(initialState, "", initialUrl);
  vi.resetModules();
  const session = await import("@/auth/session");
  const panel = await import("@/domain/panel");
  const routes = await import("./routes");
  return { session, panel, routes };
}

it("explicit GCLI startup first snapshot before any observer", async () => {
  const { routes, panel } = await loadRouterSuite("/ui/#/logs?channel=geminicli");

  // Read snapshot immediately before any observer/subscription
  const snapshot = routes.getAcceptedPanelRouteSnapshot();
  expect(snapshot.route).toBe("logs");
  expect(snapshot.mode).toBe("geminicli");
  expect(snapshot.navigationEpoch).toBe(1);
  expect(Object.isFrozen(snapshot)).toBe(true);

  // Pure getter returns stable reference
  expect(routes.getAcceptedPanelRouteSnapshot()).toBe(snapshot);

  // Core channel store matches
  const coreSnapshot = panel.getPanelChannelSnapshot();
  expect(coreSnapshot.mode).toBe("geminicli");
  expect(coreSnapshot.channelEpoch).toBe(1);

  // History entry is labeled
  expect(window.history.state).toEqual({
    panelRoute: "logs",
    panelMode: "geminicli",
    panelHash: "#/logs?channel=geminicli",
  });
});

it("startup without explicit mode preserves Core mode and labels initial canonical AG entry without advancing epochs", async () => {
  const { routes, panel } = await loadRouterSuite("/ui/#/model-routing", { foo: "survivor" });

  const snapshot = routes.getAcceptedPanelRouteSnapshot();
  expect(snapshot.route).toBe("model-routing");
  expect(snapshot.mode).toBe("antigravity");
  expect(snapshot.navigationEpoch).toBe(0);
  expect(Object.isFrozen(snapshot)).toBe(true);

  // Core channel store untouched
  const coreSnapshot = panel.getPanelChannelSnapshot();
  expect(coreSnapshot.mode).toBe("antigravity");
  expect(coreSnapshot.channelEpoch).toBe(0);

  // History state labeled, unrelated state foo survived, neither epoch advanced
  expect(window.history.state).toEqual({
    foo: "survivor",
    panelRoute: "model-routing",
    panelMode: "antigravity",
    panelHash: "#/model-routing",
  });
  expect(routes.getAcceptedPanelRouteSnapshot()).toBe(snapshot);
});

it("mode-only guard cancellation with unchanged snapshots/Core epoch, then single-use retry retaining exact AG intent", async () => {
  const { routes, panel } = await loadRouterSuite("/ui/#/overview?channel=geminicli");
  const initialSnap = routes.getAcceptedPanelRouteSnapshot();
  expect(initialSnap.mode).toBe("geminicli");
  expect(initialSnap.navigationEpoch).toBe(1);

  let capturedAttempt: RouteNavigation | null = null;
  const unguard = trackRelease(
    routes.registerRouteGuard(attempt => {
      capturedAttempt = attempt;
      return false; // Cancel navigation
    })
  );

  // Mode-only navigation attempt on the same route
  routes.navigatePanel("overview", "antigravity");

  expect(capturedAttempt).not.toBeNull();
  expect(capturedAttempt!.from).toBe("overview");
  expect(capturedAttempt!.to).toBe("overview");
  expect(capturedAttempt!.fromMode).toBe("geminicli");
  expect(capturedAttempt!.toMode).toBe("antigravity");
  expect(capturedAttempt!.href).toBe(new URL("#/overview", window.location.href).href);

  // Snapshots and epochs must remain unchanged after cancellation
  expect(routes.getAcceptedPanelRouteSnapshot().mode).toBe("geminicli");
  expect(routes.getAcceptedPanelRouteSnapshot().navigationEpoch).toBe(1);
  expect(panel.getPanelChannelSnapshot().mode).toBe("geminicli");
  expect(panel.getPanelChannelSnapshot().channelEpoch).toBe(1);

  // Single-use retry retaining exact AG intent
  capturedAttempt!.retry();
  expect(routes.getAcceptedPanelRouteSnapshot().mode).toBe("antigravity");
  expect(routes.getAcceptedPanelRouteSnapshot().navigationEpoch).toBe(2);
  expect(panel.getPanelChannelSnapshot().mode).toBe("antigravity");
  expect(panel.getPanelChannelSnapshot().channelEpoch).toBe(2);

  // Calling retry again must be a no-op (single-use)
  capturedAttempt!.retry();
  expect(routes.getAcceptedPanelRouteSnapshot().navigationEpoch).toBe(2);
  expect(panel.getPanelChannelSnapshot().channelEpoch).toBe(2);

  unguard();
});

it("invalid runtime route/mode arguments with no mutation", async () => {
  const { routes } = await loadRouterSuite("/ui/#/overview");
  const snapBefore = routes.getAcceptedPanelRouteSnapshot();

  expect(() => routes.navigatePanel("bad-route" as any)).toThrow(TypeError);
  expect(() => routes.navigatePanel("overview", "bad-mode" as any)).toThrow(TypeError);
  expect(() => routes.panelRouteHref("bad-route" as any, "antigravity")).toThrow(TypeError);
  expect(() => routes.panelRouteHref("overview", "bad-mode" as any)).toThrow(TypeError);

  // Snapshot completely unmutated
  expect(routes.getAcceptedPanelRouteSnapshot()).toBe(snapBefore);
});

it("invalid/duplicate fragment channel selects AG and document search is ignored", async () => {
  // Duplicate channel parameter
  const dup = await loadRouterSuite("/ui/#/logs?channel=geminicli&channel=geminicli");
  expect(dup.routes.getAcceptedPanelRouteSnapshot().route).toBe("logs");
  expect(dup.routes.getAcceptedPanelRouteSnapshot().mode).toBe("antigravity");

  // Invalid channel parameter
  const unk = await loadRouterSuite("/ui/#/logs?channel=unsupported");
  expect(unk.routes.getAcceptedPanelRouteSnapshot().route).toBe("logs");
  expect(unk.routes.getAcceptedPanelRouteSnapshot().mode).toBe("antigravity");

  // Explicit antigravity channel parameter
  const ag = await loadRouterSuite("/ui/#/logs?channel=antigravity");
  expect(ag.routes.getAcceptedPanelRouteSnapshot().route).toBe("logs");
  expect(ag.routes.getAcceptedPanelRouteSnapshot().mode).toBe("antigravity");

  // Document search must be ignored
  const doc = await loadRouterSuite("/ui/?channel=geminicli#/overview");
  expect(doc.routes.getAcceptedPanelRouteSnapshot().route).toBe("overview");
  expect(doc.routes.getAcceptedPanelRouteSnapshot().mode).toBe("antigravity");
  expect(window.location.search).toBe("?channel=geminicli");
});

it("plain links preserve GCLI mode", async () => {
  const { routes } = await loadRouterSuite("/ui/#/overview?channel=geminicli");
  expect(routes.getAcceptedPanelRouteSnapshot().mode).toBe("geminicli");

  const unlisten = trackRelease(routes.subscribeAcceptedPanelRoute(() => {}));

  // Simulate clicking a plain hash link (#/logs) without channel query param
  act(() => {
    window.history.pushState(null, "", "#/logs");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });

  expect(routes.getAcceptedPanelRouteSnapshot().route).toBe("logs");
  expect(routes.getAcceptedPanelRouteSnapshot().mode).toBe("geminicli");
  expect(window.location.hash).toBe("#/logs?channel=geminicli");

  unlisten();
});

it("real asynchronous history back/forward restores canonical AG plus unrelated state and migrates legacy panelHref", async () => {
  const initialHistoryState = {
    foo: "persistent-bar",
    panelHref: "http://localhost:3000/ui/?secret=synthetic_token123#/overview",
  };
  const { routes } = await loadRouterSuite("/ui/#/overview", initialHistoryState);

  // Legacy panelHref must be removed; foo and canonical keys retained
  expect(window.history.state.panelHref).toBeUndefined();
  expect(window.history.state.foo).toBe("persistent-bar");
  expect(window.history.state.panelRoute).toBe("overview");
  expect(window.history.state.panelMode).toBe("antigravity");
  expect(window.history.state.panelHash).toBe("#/overview");
  expect(window.location.search).toBe("");

  const unlisten = trackRelease(routes.subscribeAcceptedPanelRoute(() => {}));

  // Navigate to GCLI logs
  act(() => {
    routes.navigatePanel("logs", "geminicli");
  });
  expect(routes.getAcceptedPanelRouteSnapshot().route).toBe("logs");
  expect(routes.getAcceptedPanelRouteSnapshot().mode).toBe("geminicli");
  expect(window.location.hash).toBe("#/logs?channel=geminicli");

  // History back to canonical AG overview
  act(() => {
    window.history.back();
  });
  await waitFor(() => {
    expect(routes.getAcceptedPanelRouteSnapshot().route).toBe("overview");
  });
  expect(routes.getAcceptedPanelRouteSnapshot().mode).toBe("antigravity");
  expect(window.history.state.foo).toBe("persistent-bar");
  expect(window.history.state.panelHref).toBeUndefined();

  // History forward to GCLI logs
  act(() => {
    window.history.forward();
  });
  await waitFor(() => {
    expect(routes.getAcceptedPanelRouteSnapshot().route).toBe("logs");
  });
  expect(routes.getAcceptedPanelRouteSnapshot().mode).toBe("geminicli");

  unlisten();
});

it("assert frozen stable snapshots and getter reads without epochs", async () => {
  const { routes } = await loadRouterSuite("/ui/#/overview");
  const snap1 = routes.getAcceptedPanelRouteSnapshot();
  const snap2 = routes.getAcceptedPanelRouteSnapshot();

  expect(snap1).toBe(snap2);
  expect(Object.isFrozen(snap1)).toBe(true);
  expect(snap1.navigationEpoch).toBe(0);
});

it("route-only acceptance leaves Core epoch/cleanup alone; combined route+mode produces exactly one navigation activation and Core epoch", async () => {
  const { routes, panel } = await loadRouterSuite("/ui/#/overview");

  let cleanupCount = 0;
  const unregCleanup = trackRelease(
    panel.registerChannelCleanup(() => {
      cleanupCount++;
    })
  );

  const rEpoch0 = routes.getAcceptedPanelRouteSnapshot().navigationEpoch;
  const cEpoch0 = panel.getPanelChannelSnapshot().channelEpoch;

  // Route-only change
  routes.navigatePanel("logs", "antigravity");
  expect(routes.getAcceptedPanelRouteSnapshot().route).toBe("logs");
  expect(routes.getAcceptedPanelRouteSnapshot().mode).toBe("antigravity");
  expect(routes.getAcceptedPanelRouteSnapshot().navigationEpoch).toBe(rEpoch0 + 1);
  expect(panel.getPanelChannelSnapshot().channelEpoch).toBe(cEpoch0);
  expect(cleanupCount).toBe(0);

  // Combined route+mode change
  routes.navigatePanel("settings", "geminicli");
  expect(routes.getAcceptedPanelRouteSnapshot().route).toBe("settings");
  expect(routes.getAcceptedPanelRouteSnapshot().mode).toBe("geminicli");
  expect(routes.getAcceptedPanelRouteSnapshot().navigationEpoch).toBe(rEpoch0 + 2);
  expect(panel.getPanelChannelSnapshot().channelEpoch).toBe(cEpoch0 + 1);
  expect(cleanupCount).toBe(1);

  unregCleanup();
});

it("during real Core cleanup both stores expose the old coherent route/mode; during synchronous Core publication observers see the new approved route/mode and the same eventual snapshot", async () => {
  const { routes, panel } = await loadRouterSuite("/ui/#/overview");

  let cleanupRouteSnap: AcceptedPanelRouteSnapshot | null = null;
  let cleanupCoreSnap: PanelChannelSnapshot | null = null;
  const unregCleanup = trackRelease(
    panel.registerChannelCleanup(() => {
      cleanupRouteSnap = routes.getAcceptedPanelRouteSnapshot();
      cleanupCoreSnap = panel.getPanelChannelSnapshot();
    })
  );

  let pubRouteSnap: AcceptedPanelRouteSnapshot | null = null;
  let pubCoreSnap: PanelChannelSnapshot | null = null;
  const unregChannel = trackRelease(
    panel.subscribePanelChannel(() => {
      pubRouteSnap = routes.getAcceptedPanelRouteSnapshot();
      pubCoreSnap = panel.getPanelChannelSnapshot();
    })
  );

  routes.navigatePanel("credentials", "geminicli");

  // During Core cleanup, both stores expose old coherent state
  expect(cleanupRouteSnap).not.toBeNull();
  expect(cleanupRouteSnap!.route).toBe("overview");
  expect(cleanupRouteSnap!.mode).toBe("antigravity");
  expect(cleanupCoreSnap).not.toBeNull();
  expect(cleanupCoreSnap!.mode).toBe("antigravity");

  // During Core publication, observers see new approved route/mode
  expect(pubRouteSnap).not.toBeNull();
  expect(pubRouteSnap!.route).toBe("credentials");
  expect(pubRouteSnap!.mode).toBe("geminicli");
  expect(pubCoreSnap).not.toBeNull();
  expect(pubCoreSnap!.mode).toBe("geminicli");

  // Eventual router snapshot is identical to published snapshot
  expect(routes.getAcceptedPanelRouteSnapshot()).toBe(pubRouteSnap);

  unregCleanup();
  unregChannel();
});

it("session replacement/logout triggers one activation despite Core cleanup and later session notification", async () => {
  const { routes, session } = await loadRouterSuite("/ui/#/overview");
  session.setSessionToken("session-token-alpha");

  let routeNotifiedCount = 0;
  const unlisten = trackRelease(
    routes.subscribeAcceptedPanelRoute(() => {
      routeNotifiedCount++;
    })
  );

  const initialEpoch = routes.getAcceptedPanelRouteSnapshot().navigationEpoch;
  routeNotifiedCount = 0;

  // Session replacement (new token)
  act(() => {
    session.setSessionToken("session-token-beta");
  });
  expect(routes.getAcceptedPanelRouteSnapshot().navigationEpoch).toBe(initialEpoch + 1);
  expect(routeNotifiedCount).toBe(1);

  // Session logout (null)
  act(() => {
    session.setSessionToken(null);
  });
  expect(routes.getAcceptedPanelRouteSnapshot().navigationEpoch).toBe(initialEpoch + 2);
  expect(routeNotifiedCount).toBe(2);

  unlisten();
});

it("held retries die after supersession, unregister, logout/session replacement and last-observer unmount; confirmation still consults remaining guards", async () => {
  const { routes, session } = await loadRouterSuite("/ui/#/overview");

  // Case 1: supersession
  let attempt1: RouteNavigation | null = null;
  const releaseG1 = trackRelease(
    routes.registerRouteGuard(attempt => {
      attempt1 = attempt;
      return false;
    })
  );
  routes.navigatePanel("logs");
  expect(attempt1).not.toBeNull();
  const getAttempt1 = (): RouteNavigation | null => attempt1;
  const obsoleteAttempt1 = getAttempt1();

  // Superseding navigation
  routes.navigatePanel("settings");
  expect(routes.getAcceptedPanelRouteSnapshot().route).toBe("overview");
  obsoleteAttempt1!.retry();
  expect(routes.getAcceptedPanelRouteSnapshot().route).toBe("overview"); // Dead after supersession
  releaseG1();

  // Case 2: unregister
  let attempt2: RouteNavigation | null = null;
  const releaseG2 = routes.registerRouteGuard(attempt => {
    attempt2 = attempt;
    return false;
  });
  routes.navigatePanel("credentials");
  expect(attempt2).not.toBeNull();
  releaseG2(); // Unregister guard
  attempt2!.retry();
  expect(routes.getAcceptedPanelRouteSnapshot().route).toBe("overview"); // Dead after unregister

  // Case 3: session replacement/logout
  let attempt3: RouteNavigation | null = null;
  const releaseG3 = trackRelease(
    routes.registerRouteGuard(attempt => {
      attempt3 = attempt;
      return false;
    })
  );
  routes.navigatePanel("import");
  expect(attempt3).not.toBeNull();
  session.setSessionToken("session-fresh");
  attempt3!.retry();
  expect(routes.getAcceptedPanelRouteSnapshot().route).toBe("overview"); // Dead after session replacement
  releaseG3();

  // Case 4: last-observer unmount
  const { unmount } = renderHook(routes.useRoute);
  let attempt4: RouteNavigation | null = null;
  const releaseG4 = trackRelease(
    routes.registerRouteGuard(attempt => {
      attempt4 = attempt;
      return false;
    })
  );
  routes.navigatePanel("logs");
  expect(attempt4).not.toBeNull();
  unmount(); // Last observer unmounted
  attempt4!.retry();
  expect(routes.getAcceptedPanelRouteSnapshot().route).toBe("overview"); // Dead after unmount
  releaseG4();

  // Case 5: remaining guards consultation
  let gAAttempt: RouteNavigation | null = null;
  let gBAttempt: RouteNavigation | null = null;
  const releaseGA = trackRelease(
    routes.registerRouteGuard(attempt => {
      gAAttempt = attempt;
      return false;
    })
  );
  const releaseGB = trackRelease(
    routes.registerRouteGuard(attempt => {
      gBAttempt = attempt;
      return false;
    })
  );

  routes.navigatePanel("logs");
  expect(gAAttempt).not.toBeNull();
  // Confirm first guard; second guard must still be consulted
  gAAttempt!.retry();
  expect(routes.getAcceptedPanelRouteSnapshot().route).toBe("overview");
  expect(gBAttempt).not.toBeNull();

  // Confirm second guard; now transition succeeds
  gBAttempt!.retry();
  expect(routes.getAcceptedPanelRouteSnapshot().route).toBe("logs");

  releaseGA();
  releaseGB();
});

it("retains focus-anchor and obsolete-event compatibility", async () => {
  const { routes } = await loadRouterSuite("/ui/#/overview");
  const unlisten = trackRelease(routes.subscribeAcceptedPanelRoute(() => {}));
  document.body.insertAdjacentHTML("beforeend", '<main id="main-content" tabindex="-1"></main>');

  let heldAttempt: RouteNavigation | null = null;
  const releaseGuard = trackRelease(
    routes.registerRouteGuard(attempt => {
      heldAttempt = attempt;
      return false;
    })
  );

  routes.navigatePanel("logs");
  expect(heldAttempt).not.toBeNull();

  // Focus anchor change
  act(() => {
    window.history.pushState(null, "", "#main-content");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });

  expect(routes.getAcceptedPanelRouteSnapshot().route).toBe("overview");
  expect(document.activeElement).toBe(document.getElementById("main-content"));

  // Held attempt is still valid and can confirm
  heldAttempt!.retry();
  expect(routes.getAcceptedPanelRouteSnapshot().route).toBe("logs");

  // Obsolete HashChangeEvent
  act(() => {
    window.dispatchEvent(
      new HashChangeEvent("hashchange", {
        oldURL: "http://localhost:3000/ui/#/overview",
        newURL: "http://localhost:3000/ui/#/overview",
      })
    );
  });
  expect(routes.getAcceptedPanelRouteSnapshot().route).toBe("logs");

  releaseGuard();
  unlisten();
});

it("legacy startup alias #manage establishes credentials+GCLI first snapshot before observers and canonicalizes URL", async () => {
  const { routes, panel } = await loadRouterSuite("/ui/#manage", {
    unrelatedState: "preserved",
    panelRoute: "settings",
    panelMode: "antigravity",
    panelHash: "#/settings",
  });

  // Snapshot immediately before any observer
  const snapshot = routes.getAcceptedPanelRouteSnapshot();
  expect(snapshot.route).toBe("credentials");
  expect(snapshot.mode).toBe("geminicli");
  expect(snapshot.navigationEpoch).toBe(1);
  expect(Object.isFrozen(snapshot)).toBe(true);

  // Core channel store matches
  const coreSnapshot = panel.getPanelChannelSnapshot();
  expect(coreSnapshot.mode).toBe("geminicli");
  expect(coreSnapshot.channelEpoch).toBe(1);

  // URL canonicalized
  expect(window.location.hash).toBe("#/credentials?channel=geminicli");

  // History state labeled, unrelated state preserved, conflicting mode not inherited
  expect(window.history.state).toEqual({
    unrelatedState: "preserved",
    panelRoute: "credentials",
    panelMode: "geminicli",
    panelHash: "#/credentials?channel=geminicli",
  });
});

it("legacy startup alias #antigravity-manage establishes credentials+AG without advancing epochs and canonicalizes URL", async () => {
  const { routes, panel } = await loadRouterSuite("/ui/#antigravity-manage", {
    foo: "survivor",
    panelRoute: "logs",
  });

  const snapshot = routes.getAcceptedPanelRouteSnapshot();
  expect(snapshot.route).toBe("credentials");
  expect(snapshot.mode).toBe("antigravity");
  expect(snapshot.navigationEpoch).toBe(0);
  expect(Object.isFrozen(snapshot)).toBe(true);

  // Core channel store untouched
  const coreSnapshot = panel.getPanelChannelSnapshot();
  expect(coreSnapshot.mode).toBe("antigravity");
  expect(coreSnapshot.channelEpoch).toBe(0);

  // URL canonicalized
  expect(window.location.hash).toBe("#/credentials");

  // History state labeled without advancing epochs
  expect(window.history.state).toEqual({
    foo: "survivor",
    panelRoute: "credentials",
    panelMode: "antigravity",
    panelHash: "#/credentials",
  });
});

it("legacy aliases with optional slashes and query params fix mode regardless of query content", async () => {
  // Slash normalization and query param override
  const gcli = await loadRouterSuite("/ui/#/manage/?channel=antigravity&foo=bar");
  expect(gcli.routes.getAcceptedPanelRouteSnapshot().route).toBe("credentials");
  expect(gcli.routes.getAcceptedPanelRouteSnapshot().mode).toBe("geminicli");
  expect(window.location.hash).toBe("#/credentials?channel=geminicli");

  const ag = await loadRouterSuite("/ui/#/antigravity-manage/?channel=geminicli&bar=baz");
  expect(ag.routes.getAcceptedPanelRouteSnapshot().route).toBe("credentials");
  expect(ag.routes.getAcceptedPanelRouteSnapshot().mode).toBe("antigravity");
  expect(window.location.hash).toBe("#/credentials");
});

it("runtime navigation to legacy aliases supports guards, cancellation, retry, and back-forward", async () => {
  const { routes, panel } = await loadRouterSuite("/ui/#/overview");
  trackRelease(routes.subscribeAcceptedPanelRoute(() => {}));
  expect(routes.getAcceptedPanelRouteSnapshot().route).toBe("overview");
  expect(routes.getAcceptedPanelRouteSnapshot().mode).toBe("antigravity");

  let capturedAttempt: RouteNavigation | null = null;
  const unguard = trackRelease(
    routes.registerRouteGuard(attempt => {
      capturedAttempt = attempt;
      return false; // Cancel
    })
  );

  // Runtime navigation via hash change to #manage
  act(() => {
    window.history.pushState(null, "", "#manage");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });

  expect(capturedAttempt).not.toBeNull();
  expect(capturedAttempt!.from).toBe("overview");
  expect(capturedAttempt!.to).toBe("credentials");
  expect(capturedAttempt!.fromMode).toBe("antigravity");
  expect(capturedAttempt!.toMode).toBe("geminicli");
  expect(capturedAttempt!.href).toContain("#/credentials?channel=geminicli");

  // Cancellation keeps snapshot and epochs unchanged, reverts URL
  expect(routes.getAcceptedPanelRouteSnapshot().route).toBe("overview");
  expect(routes.getAcceptedPanelRouteSnapshot().mode).toBe("antigravity");
  expect(routes.getAcceptedPanelRouteSnapshot().navigationEpoch).toBe(0);
  expect(panel.getPanelChannelSnapshot().channelEpoch).toBe(0);
  expect(window.location.hash).toBe("#/overview");

  // Retry commits once
  act(() => {
    capturedAttempt!.retry();
  });
  expect(routes.getAcceptedPanelRouteSnapshot().route).toBe("credentials");
  expect(routes.getAcceptedPanelRouteSnapshot().mode).toBe("geminicli");
  expect(routes.getAcceptedPanelRouteSnapshot().navigationEpoch).toBe(1);
  expect(panel.getPanelChannelSnapshot().mode).toBe("geminicli");
  expect(panel.getPanelChannelSnapshot().channelEpoch).toBe(1);
  expect(window.location.hash).toBe("#/credentials?channel=geminicli");

  // Calling retry again is inert
  act(() => {
    capturedAttempt!.retry();
  });
  expect(routes.getAcceptedPanelRouteSnapshot().navigationEpoch).toBe(1);

  // Unregister guard and navigate to #antigravity-manage
  unguard();
  act(() => {
    window.history.pushState(window.history.state, "", "#antigravity-manage");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  expect(routes.getAcceptedPanelRouteSnapshot().route).toBe("credentials");
  expect(routes.getAcceptedPanelRouteSnapshot().mode).toBe("antigravity");
  expect(routes.getAcceptedPanelRouteSnapshot().navigationEpoch).toBe(2);
  expect(panel.getPanelChannelSnapshot().mode).toBe("antigravity");
  expect(panel.getPanelChannelSnapshot().channelEpoch).toBe(2);
  expect(window.location.hash).toBe("#/credentials");

  // History back/forward coherence
  act(() => {
    window.history.back();
  });
  await waitFor(() => {
    expect(routes.getAcceptedPanelRouteSnapshot().route).toBe("credentials");
    expect(routes.getAcceptedPanelRouteSnapshot().mode).toBe("geminicli");
  });
  expect(panel.getPanelChannelSnapshot().mode).toBe("geminicli");

  act(() => {
    window.history.forward();
  });
  await waitFor(() => {
    expect(routes.getAcceptedPanelRouteSnapshot().route).toBe("credentials");
    expect(routes.getAcceptedPanelRouteSnapshot().mode).toBe("antigravity");
  });
  expect(panel.getPanelChannelSnapshot().mode).toBe("antigravity");
});
