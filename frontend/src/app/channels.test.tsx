import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { StrictMode, type ReactNode } from "react";
import { setSessionToken } from "@/auth/session";
import { getPanelChannelSnapshot } from "@/domain/panel";
import {
  getAcceptedPanelRouteSnapshot,
  navigatePanel,
  registerRouteGuard,
  type RouteNavigation,
} from "./routes";
import { PanelChannelProvider, usePanelChannel } from "./channels";

const releases = new Set<() => void>();

function trackRelease(release: () => void): () => void {
  releases.add(release);
  return () => {
    releases.delete(release);
    release();
  };
}

beforeEach(() => {
  act(() => {
    navigatePanel("overview", "antigravity");
  });
});

afterEach(() => {
  for (const release of Array.from(releases)) {
    try {
      release();
    } catch {
      // Isolate cleanup errors
    }
  }
  releases.clear();
  cleanup();
});

it("fails explicitly when used outside PanelChannelProvider", () => {
  expect(() => {
    renderHook(() => usePanelChannel());
  }).toThrow("usePanelChannel must be used within a PanelChannelProvider");
});

it("coherent provider, Core, and route snapshots", () => {
  const { result } = renderHook(() => usePanelChannel(), {
    wrapper: PanelChannelProvider,
  });
  const coreSnap = getPanelChannelSnapshot();
  const routeSnap = getAcceptedPanelRouteSnapshot();

  expect(result.current.mode).toBe(coreSnap.mode);
  expect(result.current.channelEpoch).toBe(coreSnap.channelEpoch);
  expect(result.current.mode).toBe(routeSnap.mode);
  expect(typeof result.current.changeMode).toBe("function");
  expect(Object.isFrozen(coreSnap)).toBe(true);
  expect(Object.isFrozen(routeSnap)).toBe(true);
});

it("same-page refused mode switch and its one-use accepted retry", () => {
  act(() => {
    navigatePanel("overview", "antigravity");
  });

  const initialChannelEpoch = getPanelChannelSnapshot().channelEpoch;
  const initialNavEpoch = getAcceptedPanelRouteSnapshot().navigationEpoch;

  let capturedAttempt: RouteNavigation | null = null;
  const unguard = trackRelease(
    registerRouteGuard(attempt => {
      capturedAttempt = attempt;
      return false; // Refuse mode switch
    })
  );

  const { result } = renderHook(() => usePanelChannel(), {
    wrapper: PanelChannelProvider,
  });

  // Attempt mode switch to geminicli on the same page
  act(() => {
    result.current.changeMode("geminicli");
  });

  expect(capturedAttempt).not.toBeNull();
  expect(capturedAttempt!.from).toBe("overview");
  expect(capturedAttempt!.to).toBe("overview");
  expect(capturedAttempt!.fromMode).toBe("antigravity");
  expect(capturedAttempt!.toMode).toBe("geminicli");

  // Refusal leaves both stores and epochs unchanged
  expect(result.current.mode).toBe("antigravity");
  expect(result.current.channelEpoch).toBe(initialChannelEpoch);
  expect(getPanelChannelSnapshot().mode).toBe("antigravity");
  expect(getPanelChannelSnapshot().channelEpoch).toBe(initialChannelEpoch);
  expect(getAcceptedPanelRouteSnapshot().mode).toBe("antigravity");
  expect(getAcceptedPanelRouteSnapshot().navigationEpoch).toBe(initialNavEpoch);

  // One-use accepted retry
  act(() => {
    capturedAttempt!.retry();
  });

  expect(result.current.mode).toBe("geminicli");
  expect(result.current.channelEpoch).toBe(initialChannelEpoch + 1);
  expect(getPanelChannelSnapshot().mode).toBe("geminicli");
  expect(getPanelChannelSnapshot().channelEpoch).toBe(initialChannelEpoch + 1);
  expect(getAcceptedPanelRouteSnapshot().mode).toBe("geminicli");
  expect(getAcceptedPanelRouteSnapshot().navigationEpoch).toBe(initialNavEpoch + 1);

  // Subsequent retry is a no-op (one-use)
  act(() => {
    capturedAttempt!.retry();
  });
  expect(result.current.channelEpoch).toBe(initialChannelEpoch + 1);
  expect(getPanelChannelSnapshot().channelEpoch).toBe(initialChannelEpoch + 1);
  expect(getAcceptedPanelRouteSnapshot().navigationEpoch).toBe(initialNavEpoch + 1);

  unguard();
});

it("explicit return to antigravity", () => {
  act(() => {
    navigatePanel("logs", "geminicli");
  });

  const { result } = renderHook(() => usePanelChannel(), {
    wrapper: PanelChannelProvider,
  });

  expect(result.current.mode).toBe("geminicli");
  const cEpochBefore = getPanelChannelSnapshot().channelEpoch;
  const nEpochBefore = getAcceptedPanelRouteSnapshot().navigationEpoch;

  act(() => {
    result.current.changeMode("antigravity");
  });

  expect(result.current.mode).toBe("antigravity");
  expect(result.current.channelEpoch).toBe(cEpochBefore + 1);
  expect(getPanelChannelSnapshot().mode).toBe("antigravity");
  expect(getPanelChannelSnapshot().channelEpoch).toBe(cEpochBefore + 1);
  expect(getAcceptedPanelRouteSnapshot().mode).toBe("antigravity");
  expect(getAcceptedPanelRouteSnapshot().route).toBe("logs");
  expect(getAcceptedPanelRouteSnapshot().navigationEpoch).toBe(nEpochBefore + 1);
  expect(window.location.hash).toBe("#/logs");
});

it("older changeMode callback targets latest accepted route even after rejected hash navigation", () => {
  act(() => {
    navigatePanel("overview", "antigravity");
  });

  const { result } = renderHook(() => usePanelChannel(), {
    wrapper: PanelChannelProvider,
  });

  // Retain the older callback reference
  const retainedChangeMode = result.current.changeMode;

  // Navigate to settings route
  act(() => {
    navigatePanel("settings", "antigravity");
  });
  expect(getAcceptedPanelRouteSnapshot().route).toBe("settings");

  // Simulate a rejected hash navigation to logs
  const unguard = trackRelease(
    registerRouteGuard(() => false)
  );
  act(() => {
    window.history.pushState(null, "", "#/logs");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  // Accepted route is still settings, URL restored
  expect(getAcceptedPanelRouteSnapshot().route).toBe("settings");
  unguard();

  // Invoke the retained changeMode callback
  act(() => {
    retainedChangeMode("geminicli");
  });

  // Must target the latest accepted route (settings), not overview or logs
  expect(getAcceptedPanelRouteSnapshot().route).toBe("settings");
  expect(getAcceptedPanelRouteSnapshot().mode).toBe("geminicli");
  expect(getPanelChannelSnapshot().mode).toBe("geminicli");
  expect(result.current.mode).toBe("geminicli");
  expect(window.location.hash).toBe("#/settings?channel=geminicli");
});

it("StrictMode replay, route-only changes, and teardown manufacture no extra epochs or transport", () => {
  act(() => {
    navigatePanel("overview", "antigravity");
  });

  const cEpochStart = getPanelChannelSnapshot().channelEpoch;
  const nEpochStart = getAcceptedPanelRouteSnapshot().navigationEpoch;

  const { result, unmount } = renderHook(() => usePanelChannel(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <StrictMode>
        <PanelChannelProvider>{children}</PanelChannelProvider>
      </StrictMode>
    ),
  });

  expect(result.current.mode).toBe("antigravity");
  // Mount and StrictMode replay must not manufacture extra epochs
  expect(getPanelChannelSnapshot().channelEpoch).toBe(cEpochStart);
  expect(getAcceptedPanelRouteSnapshot().navigationEpoch).toBe(nEpochStart);

  // Route-only change does not advance Core epoch or change mode
  act(() => {
    navigatePanel("logs", "antigravity");
  });
  expect(getAcceptedPanelRouteSnapshot().route).toBe("logs");
  expect(getAcceptedPanelRouteSnapshot().navigationEpoch).toBe(nEpochStart + 1);
  expect(getPanelChannelSnapshot().channelEpoch).toBe(cEpochStart);
  expect(result.current.channelEpoch).toBe(cEpochStart);

  // Teardown without extra epochs or transport
  unmount();
  expect(getPanelChannelSnapshot().channelEpoch).toBe(cEpochStart);
  expect(getAcceptedPanelRouteSnapshot().navigationEpoch).toBe(nEpochStart + 1);
  expect(fetch).not.toHaveBeenCalled();
});

it("token replacement invalidates held retry exactly once while retaining mode", () => {
  act(() => {
    navigatePanel("overview", "antigravity");
  });

  const { result } = renderHook(() => usePanelChannel(), {
    wrapper: PanelChannelProvider,
  });

  let heldAttempt: RouteNavigation | null = null;
  const unguard = trackRelease(
    registerRouteGuard(attempt => {
      heldAttempt = attempt;
      return false;
    })
  );

  // Attempt mode change that gets refused and held
  act(() => {
    result.current.changeMode("geminicli");
  });
  expect(heldAttempt).not.toBeNull();
  expect(result.current.mode).toBe("antigravity");

  const cEpochBeforeToken = getPanelChannelSnapshot().channelEpoch;

  // Session token replacement
  act(() => {
    setSessionToken("synthetic-fresh-session-token");
  });

  // Invalidation advances channelEpoch once via session cleanup, retaining mode
  expect(getPanelChannelSnapshot().channelEpoch).toBe(cEpochBeforeToken + 1);
  expect(getPanelChannelSnapshot().mode).toBe("antigravity");
  expect(result.current.mode).toBe("antigravity");
  expect(getAcceptedPanelRouteSnapshot().mode).toBe("antigravity");

  // Held retry is invalidated and cannot execute
  act(() => {
    heldAttempt!.retry();
  });

  expect(result.current.mode).toBe("antigravity");
  expect(getPanelChannelSnapshot().mode).toBe("antigravity");
  expect(getAcceptedPanelRouteSnapshot().mode).toBe("antigravity");
  expect(getPanelChannelSnapshot().channelEpoch).toBe(cEpochBeforeToken + 1);

  // Calling retry again is still dead
  act(() => {
    heldAttempt!.retry();
  });
  expect(getPanelChannelSnapshot().channelEpoch).toBe(cEpochBeforeToken + 1);

  unguard();
});
