import { act, render, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "@/auth/AuthProvider";
import {
  getSessionSnapshot,
  getSessionValidationSnapshot,
  setSessionToken,
  __setSessionValidationStatus,
  type SessionValidationSnapshot,
} from "@/auth/session";
import { PanelChannelProvider } from "./channels";
import { getAcceptedPanelRouteSnapshot, navigatePanel } from "./routes";
import { ConsoleHandshake, CONSOLE_READY_PAYLOAD } from "./ConsoleHandshake";

function mockSafeConfigResponse() {
  return Response.json({
    config: { theme: "system" },
    capabilities: ["config.safe_read"],
    env_locked: [],
    security: {},
    secret_fields: {
      api_password: { configured: true },
      panel_password: { configured: true },
      password: { configured: false },
    },
  });
}

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <PanelChannelProvider>{children}</PanelChannelProvider>
    </AuthProvider>
  );
}

function setMetaPolicy(policyContent: string | null) {
  document.querySelectorAll('meta[name="gcli-embed-policy"]').forEach(el => el.remove());
  if (policyContent !== null) {
    const meta = document.createElement("meta");
    meta.setAttribute("name", "gcli-embed-policy");
    meta.setAttribute("content", policyContent);
    document.head.appendChild(meta);
  }
}

describe("ConsoleHandshake", () => {
  let originalParentDesc: PropertyDescriptor | undefined;
  let originalReferrerDesc: PropertyDescriptor | undefined;
  let originalAncestorOriginsDesc: PropertyDescriptor | undefined;
  let mockPostMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalParentDesc = Object.getOwnPropertyDescriptor(window, "parent");
    originalReferrerDesc = Object.getOwnPropertyDescriptor(document, "referrer");
    originalAncestorOriginsDesc = Object.getOwnPropertyDescriptor(window.location, "ancestorOrigins");

    mockPostMessage = vi.fn();
    Object.defineProperty(window, "parent", {
      configurable: true,
      writable: true,
      value: { postMessage: mockPostMessage },
    });

    act(() => {
      navigatePanel("overview", "antigravity");
    });
    setSessionToken(null);
    setMetaPolicy(null);
  });

  afterEach(() => {
    if (originalParentDesc !== undefined) {
      Object.defineProperty(window, "parent", originalParentDesc);
    } else {
      delete (window as unknown as Record<string, unknown>).parent;
    }

    if (originalReferrerDesc !== undefined) {
      Object.defineProperty(document, "referrer", originalReferrerDesc);
    } else {
      delete (document as unknown as Record<string, unknown>).referrer;
    }

    if (originalAncestorOriginsDesc !== undefined) {
      Object.defineProperty(window.location, "ancestorOrigins", originalAncestorOriginsDesc);
    } else {
      delete (window.location as unknown as Record<string, unknown>).ancestorOrigins;
    }

    setMetaPolicy(null);
    act(() => {
      navigatePanel("overview", "antigravity");
    });
    setSessionToken(null);
  });

  it("zero messages while unverified, inactive, non-credentials route, or Antigravity mode", async () => {
    setMetaPolicy(JSON.stringify({ mode: "exact", origins: ["https://parent.example.com"] }));

    // 1a. active = false, even when verified and route is credentials geminicli
    setSessionToken("test-token");
    act(() => navigatePanel("credentials", "geminicli"));
    const { rerender, unmount } = render(<ConsoleHandshake active={false} />, { wrapper: Wrapper });
    expect(mockPostMessage).not.toHaveBeenCalled();

    // 1b. active = true, but anonymous (token is null)
    setSessionToken(null);
    rerender(<ConsoleHandshake active={true} />);
    expect(mockPostMessage).not.toHaveBeenCalled();

    // 1c. active = true, token present but pending validation
    setSessionToken("pending-token", true, { requiresValidation: true });
    rerender(<ConsoleHandshake active={true} />);
    expect(mockPostMessage).not.toHaveBeenCalled();

    // 1d. active = true, verified, but route is overview (not credentials)
    setSessionToken("valid-token");
    act(() => navigatePanel("overview", "geminicli"));
    rerender(<ConsoleHandshake active={true} />);
    expect(mockPostMessage).not.toHaveBeenCalled();

    // 1e. active = true, verified, credentials route, but mode is antigravity
    act(() => navigatePanel("credentials", "antigravity"));
    rerender(<ConsoleHandshake active={true} />);
    expect(mockPostMessage).not.toHaveBeenCalled();

    // 1f. active = true, verified, credentials geminicli, but top-level (window.parent === window)
    Object.defineProperty(window, "parent", {
      configurable: true,
      writable: true,
      value: window,
    });
    act(() => navigatePanel("credentials", "geminicli"));
    rerender(<ConsoleHandshake active={true} />);
    expect(mockPostMessage).not.toHaveBeenCalled();

    unmount();
  });

  it("emits exact three-field payload to precise target after actual ready and avoids duplicate delivery", async () => {
    setMetaPolicy(JSON.stringify({ mode: "exact", origins: ["https://parent.example.com"] }));
    Object.defineProperty(window.location, "ancestorOrigins", {
      configurable: true,
      writable: true,
      value: ["https://parent.example.com"],
    });

    setSessionToken("verified-token");
    act(() => navigatePanel("credentials", "geminicli"));

    // Initial render with active=true inside ready state
    const { rerender, unmount } = render(<ConsoleHandshake active={true} />, { wrapper: Wrapper });

    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    const [payload, targetOrigin] = mockPostMessage.mock.calls[0];

    // Exact three-field payload
    expect(payload).toEqual({
      type: "gcli2api.console.ready",
      version: 1,
      tab: "manage",
    });
    expect(Object.keys(payload).sort()).toEqual(["tab", "type", "version"]);
    expect(payload).toBe(CONSOLE_READY_PAYLOAD);

    // Precise target from matching ancestorOrigins
    expect(targetOrigin).toBe("https://parent.example.com");

    // Duplicate effect delivery prevention for unchanged mounted activation
    rerender(<ConsoleHandshake active={true} />);
    rerender(<ConsoleHandshake active={true} />);
    expect(mockPostMessage).toHaveBeenCalledTimes(1);

    // Toggling active false and then true is a legitimate new activation
    rerender(<ConsoleHandshake active={false} />);
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    rerender(<ConsoleHandshake active={true} />);
    expect(mockPostMessage).toHaveBeenCalledTimes(2);

    unmount();
  });

  it("handles exact multiple targets when no referrer / ancestor match, and any_https with *", async () => {
    // 3a. Exact mode with multiple targets and no ancestorOrigins / no referrer
    const origins = ["https://a.example.com", "https://b.example.com:8443"];
    setMetaPolicy(JSON.stringify({ mode: "exact", origins }));
    Object.defineProperty(document, "referrer", {
      configurable: true,
      writable: true,
      value: "",
    });

    setSessionToken("multi-token");
    act(() => navigatePanel("credentials", "geminicli"));

    const { rerender, unmount } = render(<ConsoleHandshake active={true} />, { wrapper: Wrapper });

    expect(mockPostMessage).toHaveBeenCalledTimes(2);
    expect(mockPostMessage).toHaveBeenNthCalledWith(1, CONSOLE_READY_PAYLOAD, "https://a.example.com");
    expect(mockPostMessage).toHaveBeenNthCalledWith(2, CONSOLE_READY_PAYLOAD, "https://b.example.com:8443");
    expect(mockPostMessage).not.toHaveBeenCalledWith(expect.anything(), "*");

    // 3b. Exact mode with matching referrer prefers the matching referrer origin
    mockPostMessage.mockClear();
    Object.defineProperty(document, "referrer", {
      configurable: true,
      writable: true,
      value: "https://b.example.com:8443/app/dashboard",
    });
    rerender(<ConsoleHandshake active={false} />);
    rerender(<ConsoleHandshake active={true} />);
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    expect(mockPostMessage).toHaveBeenCalledWith(CONSOLE_READY_PAYLOAD, "https://b.example.com:8443");

    // 3c. Explicit any_https mode sends to * under backend CSP
    mockPostMessage.mockClear();
    setMetaPolicy(JSON.stringify({ mode: "any_https" }));
    rerender(<ConsoleHandshake active={false} />);
    rerender(<ConsoleHandshake active={true} />);
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    expect(mockPostMessage).toHaveBeenCalledWith(CONSOLE_READY_PAYLOAD, "*");

    unmount();
  });

  it("fails closed and sends nothing for malformed, missing, placeholder, or disabled embed policies", async () => {
    setSessionToken("verified-token");
    act(() => navigatePanel("credentials", "geminicli"));

    const invalidPolicies = [
      null,
      "__GCLI_EMBED_POLICY__",
      JSON.stringify({ mode: "disabled" }),
      "{ malformed json",
      JSON.stringify({ mode: "unknown" }),
      JSON.stringify({ mode: "exact", origins: [] }),
      JSON.stringify({ mode: "exact", origins: "https://parent.example.com" }),
      JSON.stringify({ mode: "exact", origins: ["http://insecure.example.com"] }),
      JSON.stringify({ mode: "exact", origins: ["https://parent.example.com:443"] }),
      JSON.stringify({ mode: "exact", origins: ["https://parent.example.com/path"] }),
      JSON.stringify({ mode: "exact", origins: ["https://parent.example.com/"] }),
      JSON.stringify({ mode: "exact", origins: ["https://*.example.com"] }),
      JSON.stringify({ mode: "exact", origins: ["https://user:pass@example.com"] }),
      JSON.stringify({ mode: "exact", origins: ["https://example.com?query=1"] }),
      JSON.stringify({ mode: "exact", origins: ["https://example.com#fragment"] }),
      JSON.stringify({ mode: "exact", origins: ["https://example.com."] }),
      JSON.stringify({ mode: "exact", origins: ["https://valid.example.com", "https://valid.example.com"] }),
      JSON.stringify({ mode: "exact", origins: ["https://valid.example.com", "https://invalid.example.com/path"] }),
    ];

    for (const policy of invalidPolicies) {
      mockPostMessage.mockClear();
      setMetaPolicy(policy);
      const { unmount } = render(<ConsoleHandshake active={true} />, { wrapper: Wrapper });
      expect(mockPostMessage).not.toHaveBeenCalled();
      unmount();
    }
  });

  it("invalidates on revalidation, channel switch, route change, unmount, and leaves no late pending effect", async () => {
    setMetaPolicy(JSON.stringify({ mode: "exact", origins: ["https://parent.example.com"] }));
    setSessionToken("initial-token");
    act(() => navigatePanel("credentials", "geminicli"));

    const { rerender, unmount } = render(<ConsoleHandshake active={true} />, { wrapper: Wrapper });
    expect(mockPostMessage).toHaveBeenCalledTimes(1);

    // 5a. Channel switch to antigravity: does not emit
    act(() => navigatePanel("credentials", "antigravity"));
    expect(mockPostMessage).toHaveBeenCalledTimes(1);

    // 5b. Channel switch back to geminicli: new activation emits
    act(() => navigatePanel("credentials", "geminicli"));
    expect(mockPostMessage).toHaveBeenCalledTimes(2);

    // 5c. Route change away to settings: does not emit
    act(() => navigatePanel("settings", "geminicli"));
    expect(mockPostMessage).toHaveBeenCalledTimes(2);

    // Return to credentials: emits for new route navigation
    act(() => navigatePanel("credentials", "geminicli"));
    expect(mockPostMessage).toHaveBeenCalledTimes(3);

    // 5d. Revalidation invalidation: token requires validation
    vi.mocked(fetch).mockResolvedValueOnce(mockSafeConfigResponse());
    act(() => {
      setSessionToken("revalidating-token", true, { requiresValidation: true });
    });
    // During revalidation, no new post
    expect(mockPostMessage).toHaveBeenCalledTimes(3);

    // Once probe resolves and verified, emits for the verified session
    await waitFor(() => {
      expect(mockPostMessage).toHaveBeenCalledTimes(4);
    });

    // 5e. PostMessage failure is caught silently without loop or throwing
    mockPostMessage.mockImplementationOnce(() => {
      throw new DOMException("Cross-origin error", "SecurityError");
    });
    rerender(<ConsoleHandshake active={false} />);
    expect(() => {
      rerender(<ConsoleHandshake active={true} />);
    }).not.toThrow();
    expect(mockPostMessage).toHaveBeenCalledTimes(5);

    // 5f. Unmount leaves no late pending effects
    unmount();
    mockPostMessage.mockClear();

    act(() => {
      navigatePanel("credentials", "geminicli");
      setSessionToken("another-token");
    });
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it("uses correct remaining targets without throw on throwing ancestor getter and referrer fallback failure", async () => {
    const origins = ["https://a.example.com", "https://b.example.com"];
    setMetaPolicy(JSON.stringify({ mode: "exact", origins }));

    setSessionToken("getter-token");
    act(() => {
      navigatePanel("credentials", "geminicli");
    });

    // Subcase 1: Throwing ancestorOrigins getter, matching referrer hint
    Object.defineProperty(window.location, "ancestorOrigins", {
      configurable: true,
      get() {
        throw new DOMException("ancestorOrigins access denied", "SecurityError");
      },
    });
    Object.defineProperty(document, "referrer", {
      configurable: true,
      writable: true,
      value: "https://b.example.com/app",
    });

    const { rerender, unmount } = render(<ConsoleHandshake active={true} />, { wrapper: Wrapper });
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    expect(mockPostMessage).toHaveBeenCalledWith(CONSOLE_READY_PAYLOAD, "https://b.example.com");

    // Subcase 2: Throwing ancestorOrigins getter AND throwing referrer getter
    mockPostMessage.mockClear();
    Object.defineProperty(document, "referrer", {
      configurable: true,
      get() {
        throw new DOMException("document.referrer access denied", "SecurityError");
      },
    });

    rerender(<ConsoleHandshake active={false} />);
    rerender(<ConsoleHandshake active={true} />);

    expect(mockPostMessage).toHaveBeenCalledTimes(2);
    expect(mockPostMessage).toHaveBeenNthCalledWith(1, CONSOLE_READY_PAYLOAD, "https://a.example.com");
    expect(mockPostMessage).toHaveBeenNthCalledWith(2, CONSOLE_READY_PAYLOAD, "https://b.example.com");

    unmount();
    setSessionToken(null);
    act(() => {
      navigatePanel("overview", "antigravity");
    });
  });

  it("stops multi-target loop when first post synchronously changes real validation pending->verified at unchanged sessionEpoch and delivers fresh activation", async () => {
    const origins = ["https://a.example.com", "https://b.example.com"];
    setMetaPolicy(JSON.stringify({ mode: "exact", origins }));
    Object.defineProperty(document, "referrer", {
      configurable: true,
      writable: true,
      value: "",
    });
    delete (window.location as unknown as Record<string, unknown>).ancestorOrigins;

    setSessionToken("verified-token");
    act(() => {
      navigatePanel("credentials", "geminicli");
    });

    const initialSession = getSessionSnapshot();
    const initialValidation = getSessionValidationSnapshot();
    expect(initialValidation.status).toBe("verified");
    const initialEpoch = initialSession.sessionEpoch;

    let callCount = 0;
    const recordedTargets: string[] = [];
    const validationSnapshots: {
      beforeChange: SessionValidationSnapshot | null;
      afterChange: SessionValidationSnapshot | null;
    } = {
      beforeChange: null,
      afterChange: null,
    };

    mockPostMessage.mockImplementation((_payload: unknown, target: string) => {
      callCount++;
      recordedTargets.push(target);
      if (callCount === 1) {
        validationSnapshots.beforeChange = getSessionValidationSnapshot();
        // Synchronously change real validation pending -> verified at unchanged sessionEpoch
        __setSessionValidationStatus(initialEpoch, "pending");
        __setSessionValidationStatus(initialEpoch, "verified");
        validationSnapshots.afterChange = getSessionValidationSnapshot();
      }
    });

    const { unmount } = render(<ConsoleHandshake active={true} />, { wrapper: Wrapper });

    // Assert actual identity and epoch transitions
    expect(validationSnapshots.beforeChange).toBe(initialValidation);
    expect(validationSnapshots.afterChange).not.toBeNull();
    expect(validationSnapshots.afterChange).not.toBe(validationSnapshots.beforeChange);
    expect(validationSnapshots.afterChange?.status).toBe("verified");
    expect(validationSnapshots.afterChange?.sessionEpoch).toBe(initialEpoch);

    // Original loop stopped before its second target; fresh activation delivered both targets
    expect(mockPostMessage).toHaveBeenCalledTimes(3);
    expect(recordedTargets).toEqual([
      "https://a.example.com",
      "https://a.example.com",
      "https://b.example.com",
    ]);

    unmount();
    setSessionToken(null);
    act(() => {
      navigatePanel("overview", "antigravity");
    });
  });

  it("stops multi-target loop when first post synchronously navigates away->back changing navigationEpoch and delivers fresh activation", async () => {
    const origins = ["https://a.example.com", "https://b.example.com"];
    setMetaPolicy(JSON.stringify({ mode: "exact", origins }));
    Object.defineProperty(document, "referrer", {
      configurable: true,
      writable: true,
      value: "",
    });
    delete (window.location as unknown as Record<string, unknown>).ancestorOrigins;

    setSessionToken("nav-token");
    act(() => {
      navigatePanel("credentials", "geminicli");
    });

    const initialRoute = getAcceptedPanelRouteSnapshot();
    const initialEpoch = initialRoute.navigationEpoch;
    expect(initialRoute.route).toBe("credentials");
    expect(initialRoute.mode).toBe("geminicli");

    let callCount = 0;
    const recordedTargets: string[] = [];
    let epochBeforeNav = -1;
    let epochAfterNav = -1;

    mockPostMessage.mockImplementation((_payload: unknown, target: string) => {
      callCount++;
      recordedTargets.push(target);
      if (callCount === 1) {
        epochBeforeNav = getAcceptedPanelRouteSnapshot().navigationEpoch;
        // Separate first-post real navigatePanel away->back changes navigationEpoch
        navigatePanel("overview", "geminicli");
        navigatePanel("credentials", "geminicli");
        epochAfterNav = getAcceptedPanelRouteSnapshot().navigationEpoch;
      }
    });

    const { unmount } = render(<ConsoleHandshake active={true} />, { wrapper: Wrapper });

    // Assert actual navigationEpoch transitions
    expect(epochBeforeNav).toBe(initialEpoch);
    expect(epochAfterNav).toBe(initialEpoch + 2);
    expect(getAcceptedPanelRouteSnapshot().route).toBe("credentials");
    expect(getAcceptedPanelRouteSnapshot().mode).toBe("geminicli");

    // Original loop stopped before its second target; fresh activation delivered both targets
    expect(mockPostMessage).toHaveBeenCalledTimes(3);
    expect(recordedTargets).toEqual([
      "https://a.example.com",
      "https://a.example.com",
      "https://b.example.com",
    ]);

    unmount();
    setSessionToken(null);
    act(() => {
      navigatePanel("overview", "antigravity");
    });
  });
});
