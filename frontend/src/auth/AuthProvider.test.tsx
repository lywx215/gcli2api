import { act, renderHook, waitFor } from "@testing-library/react";
import React, { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "./AuthProvider";
import {
  AUTH_STORAGE_KEY,
  getSessionSnapshot,
  getSessionValidationSnapshot,
  registerSessionCleanup,
  setSessionToken,
} from "./session";
import { requestJson } from "@/api/client";

const wrapper = AuthProvider;

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

describe("auth lifecycle", () => {
  it("logs in with the legacy body/key and logout advances the epoch", async () => {
    const { result } = renderHook(useAuth, { wrapper });
    const initial = result.current.sessionEpoch;
    vi.mocked(fetch).mockResolvedValue(Response.json({ token: "synthetic-login" }));
    await act(() => result.current.login("synthetic-password"));
    expect(result.current).toMatchObject({
      token: "synthetic-login",
      authenticated: true,
      sessionEpoch: initial + 1,
      validationStatus: "verified",
    });
    expect(vi.mocked(fetch).mock.calls[0][1]?.body).toBe('{"password":"synthetic-password"}');
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBe("synthetic-login");
    const cleared = vi.fn();
    const unregister = registerSessionCleanup(cleared);
    act(() => result.current.logout());
    expect(result.current).toMatchObject({
      token: null,
      authenticated: false,
      sessionEpoch: initial + 2,
      validationStatus: "anonymous",
    });
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(cleared).toHaveBeenCalledOnce();
    unregister();
  });

  it("keeps a memory session when storage throws and still clears it", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    const { result } = renderHook(useAuth, { wrapper });
    vi.mocked(fetch).mockResolvedValue(Response.json({ token: "synthetic-memory" }));
    await act(() => result.current.login("synthetic"));
    expect(result.current.authenticated).toBe(true);
    act(() => result.current.logout());
    expect(result.current.token).toBeNull();
  });

  it.each([{ success: false, token: "synthetic" }, {}, { token: "" }, { token: 12 }])(
    "rejects invalid HTTP 200 login payload %j",
    async (payload) => {
      const { result } = renderHook(useAuth, { wrapper });
      vi.mocked(fetch).mockResolvedValue(Response.json(payload));
      await act(async () => {
        await expect(result.current.login("synthetic")).rejects.toMatchObject({ status: 200 });
      });
      expect(result.current.authenticated).toBe(false);
    }
  );

  it("does not let an older login supersede the latest attempt", async () => {
    const { result } = renderHook(useAuth, { wrapper });
    let finish!: (value: Response) => void;
    vi.mocked(fetch)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        })
      )
      .mockResolvedValueOnce(Response.json({ token: "new-synthetic" }));
    const old = result.current.login("old-synthetic");
    const rejected = expect(old).rejects.toMatchObject({ name: "AbortError" });
    await act(() => result.current.login("new-synthetic"));
    finish(Response.json({ token: "old-synthetic" }));
    await rejected;
    expect(result.current.token).toBe("new-synthetic");
  });

  it("logout cancels a pending login even if the response arrives", async () => {
    const { result } = renderHook(useAuth, { wrapper });
    let finish!: (value: Response) => void;
    vi.mocked(fetch).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const pending = result.current.login("synthetic");
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    act(() => result.current.logout());
    finish(Response.json({ token: "synthetic" }));
    await rejected;
    expect(result.current.authenticated).toBe(false);
  });

  it("central 403 clears authenticated state", async () => {
    setSessionToken("synthetic");
    const { result } = renderHook(useAuth, { wrapper });
    vi.mocked(fetch).mockResolvedValue(Response.json({ detail: "Not authenticated" }, { status: 403 }));
    await act(async () => {
      await expect(requestJson("creds/status")).rejects.toMatchObject({ status: 403 });
    });
    expect(result.current.authenticated).toBe(false);
  });

  it("cross-tab replacement and clear advance epoch, while unrelated storage is ignored", () => {
    setSessionToken("synthetic-old");
    const { result } = renderHook(useAuth, { wrapper });
    const before = getSessionSnapshot().sessionEpoch;
    localStorage.setItem(AUTH_STORAGE_KEY, "synthetic-new");
    act(() =>
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: AUTH_STORAGE_KEY,
          newValue: "synthetic-new",
          storageArea: localStorage,
        })
      )
    );
    expect(result.current).toMatchObject({
      token: "synthetic-new",
      sessionEpoch: before + 1,
      validationStatus: "pending",
      authenticated: false,
    });
    act(() =>
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "unrelated",
          newValue: "ignored",
          storageArea: localStorage,
        })
      )
    );
    expect(result.current.sessionEpoch).toBe(before + 1);
    localStorage.clear();
    act(() =>
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: null,
          storageArea: localStorage,
        })
      )
    );
    expect(result.current).toMatchObject({
      token: null,
      sessionEpoch: before + 2,
      validationStatus: "anonymous",
      authenticated: false,
    });
  });

  it("a delayed old storage event cannot replace a newer current login", () => {
    setSessionToken("newer-synthetic-Y");
    const { result } = renderHook(useAuth, { wrapper });
    const epoch = result.current.sessionEpoch;
    act(() =>
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: AUTH_STORAGE_KEY,
          newValue: "older-synthetic-X",
          storageArea: localStorage,
        })
      )
    );
    expect(result.current).toMatchObject({ token: "newer-synthetic-Y", sessionEpoch: epoch });
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage })));
    expect(result.current).toMatchObject({ token: "newer-synthetic-Y", sessionEpoch: epoch });
  });

  it("storage read failures preserve the authoritative memory session", () => {
    setSessionToken("synthetic-memory");
    const { result } = renderHook(useAuth, { wrapper });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    act(() =>
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: AUTH_STORAGE_KEY,
          newValue: null,
          storageArea: localStorage,
        })
      )
    );
    expect(result.current.token).toBe("synthetic-memory");
  });
});

describe("safe validation and snapshot contracts", () => {
  it("preserves exact two-field SessionSnapshot and separate stable SessionValidationSnapshot", () => {
    const sessionSnap = getSessionSnapshot();
    expect(Object.keys(sessionSnap).sort()).toEqual(["sessionEpoch", "token"]);
    expect(getSessionSnapshot()).toBe(sessionSnap);

    const validationSnap = getSessionValidationSnapshot();
    expect(Object.keys(validationSnap).sort()).toEqual(["sessionEpoch", "status"]);
    expect(validationSnap.status).toBe("anonymous");
    expect(getSessionValidationSnapshot()).toBe(validationSnap);
  });

  it("simulates pending token restore via public requiresValidation and authenticates once verified", async () => {
    setSessionToken("stored-token", true, { requiresValidation: true });
    const epoch = getSessionSnapshot().sessionEpoch;
    let finishProbe!: (r: Response) => void;
    vi.mocked(fetch).mockReturnValue(
      new Promise((resolve) => {
        finishProbe = resolve;
      })
    );

    const { result } = renderHook(useAuth, { wrapper });
    expect(result.current.token).toBe("stored-token");
    expect(result.current.validationStatus).toBe("pending");
    expect(result.current.authenticated).toBe(false);
    expect(result.current.sessionEpoch).toBe(epoch);

    await act(async () => {
      finishProbe(mockSafeConfigResponse());
    });

    await waitFor(() => {
      expect(result.current.validationStatus).toBe("verified");
    });
    expect(result.current.authenticated).toBe(true);
    expect(result.current.sessionEpoch).toBe(epoch);
    const probeUrl = new URL(String(vi.mocked(fetch).mock.calls[0][0]));
    expect(probeUrl.pathname).toBe("/config/get");
    expect(probeUrl.searchParams.get("include_secrets")).toBe("false");
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain("config/get?include_secrets=false");
  });

  it("runs exactly one safe probe in StrictMode and shares the result across remount", async () => {
    setSessionToken("strict-token", true, { requiresValidation: true });
    const epoch = getSessionSnapshot().sessionEpoch;
    vi.mocked(fetch).mockResolvedValue(mockSafeConfigResponse());

    const strictWrapper = ({ children }: { children: React.ReactNode }) => (
      <StrictMode>
        <AuthProvider>{children}</AuthProvider>
      </StrictMode>
    );

    const { result } = renderHook(useAuth, { wrapper: strictWrapper });
    await waitFor(() => {
      expect(result.current.authenticated).toBe(true);
    });
    expect(result.current.validationStatus).toBe("verified");
    expect(result.current.sessionEpoch).toBe(epoch);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    const probeUrl = new URL(String(vi.mocked(fetch).mock.calls[0][0]));
    expect(probeUrl.pathname).toBe("/config/get");
    expect(probeUrl.searchParams.get("include_secrets")).toBe("false");
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain("config/get?include_secrets=false");
  });

  it("marks transient probe error as unavailable while preserving token, and allows retryValidation", async () => {
    setSessionToken("failing-token", true, { requiresValidation: true });
    const epoch = getSessionSnapshot().sessionEpoch;
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: "gateway error" }, { status: 502 }));

    const { result } = renderHook(useAuth, { wrapper });
    await waitFor(() => {
      expect(result.current.validationStatus).toBe("unavailable");
    });
    expect(result.current.authenticated).toBe(false);
    expect(result.current.token).toBe("failing-token");
    expect(result.current.sessionEpoch).toBe(epoch);
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBe("failing-token");

    vi.mocked(fetch).mockResolvedValueOnce(mockSafeConfigResponse());
    act(() => {
      result.current.retryValidation();
    });
    expect(result.current.validationStatus).toBe("pending");

    await waitFor(() => {
      expect(result.current.authenticated).toBe(true);
    });
    expect(result.current.validationStatus).toBe("verified");
    expect(result.current.token).toBe("failing-token");
    expect(result.current.sessionEpoch).toBe(epoch);
  });

  it("cross-tab replacement token becomes pending and requires safe validation", async () => {
    setSessionToken("initial-tab-token");
    const { result } = renderHook(useAuth, { wrapper });
    expect(result.current.authenticated).toBe(true);

    let finishCrossTab!: (r: Response) => void;
    vi.mocked(fetch).mockReturnValue(
      new Promise((resolve) => {
        finishCrossTab = resolve;
      })
    );

    localStorage.setItem(AUTH_STORAGE_KEY, "cross-tab-token");
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: AUTH_STORAGE_KEY,
          newValue: "cross-tab-token",
          storageArea: localStorage,
        })
      );
    });

    expect(result.current.token).toBe("cross-tab-token");
    expect(result.current.validationStatus).toBe("pending");
    expect(result.current.authenticated).toBe(false);

    await act(async () => {
      finishCrossTab(mockSafeConfigResponse());
    });
    await waitFor(() => {
      expect(result.current.validationStatus).toBe("verified");
    });
    expect(result.current.authenticated).toBe(true);
  });

  it("in-flight probe is cancelled and fenced when logout occurs before probe completes", async () => {
    setSessionToken("fence-token", true, { requiresValidation: true });
    let finishProbe!: (r: Response) => void;
    vi.mocked(fetch).mockReturnValue(
      new Promise((resolve) => {
        finishProbe = resolve;
      })
    );

    const { result } = renderHook(useAuth, { wrapper });
    expect(result.current.validationStatus).toBe("pending");

    act(() => {
      result.current.logout();
    });
    expect(result.current.token).toBeNull();
    expect(result.current.validationStatus).toBe("anonymous");
    expect(result.current.authenticated).toBe(false);

    await act(async () => {
      finishProbe(mockSafeConfigResponse());
    });
    expect(result.current.token).toBeNull();
    expect(result.current.validationStatus).toBe("anonymous");
    expect(result.current.authenticated).toBe(false);
  });

  it("direct setSessionToken and login do not trigger redundant config probe", async () => {
    vi.mocked(fetch).mockClear();
    setSessionToken("direct-proven-token");
    const { result } = renderHook(useAuth, { wrapper });
    expect(result.current.authenticated).toBe(true);
    expect(result.current.validationStatus).toBe("verified");
    expect(fetch).not.toHaveBeenCalled();

    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ token: "new-login-token" }));
    await act(() => result.current.login("pass"));
    expect(result.current.authenticated).toBe(true);
    expect(result.current.validationStatus).toBe("verified");
    expect(result.current.token).toBe("new-login-token");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toMatch(/auth\/login/);
  });

  it("does not log out for a generic upstream or business 401/403 failure", async () => {
    setSessionToken("business-token");
    const { result } = renderHook(useAuth, { wrapper });
    expect(result.current.authenticated).toBe(true);

    vi.mocked(fetch).mockResolvedValue(
      Response.json({ detail: "upstream provider rejected key", code: "PROVIDER_AUTH_ERROR" }, { status: 401 })
    );
    await act(async () => {
      await expect(requestJson("creds/status")).rejects.toMatchObject({ status: 401 });
    });
    expect(result.current.token).toBe("business-token");
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBe("business-token");
  });
});

describe("regressions for coordinator inspected defects", () => {
  it("failed login moves pending restored validation safely to unavailable, preserves token, and allows retry", async () => {
    setSessionToken("restored-pending", true, { requiresValidation: true });
    const epoch = getSessionSnapshot().sessionEpoch;
    let finishProbe!: (r: Response) => void;
    vi.mocked(fetch).mockReturnValueOnce(
      new Promise((resolve) => {
        finishProbe = resolve;
      })
    );

    const { result } = renderHook(useAuth, { wrapper });
    expect(result.current.validationStatus).toBe("pending");

    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ detail: "密码错误" }, { status: 401 }));
    await act(async () => {
      await expect(result.current.login("wrong-password")).rejects.toMatchObject({ status: 401 });
    });

    expect(result.current.token).toBe("restored-pending");
    expect(result.current.sessionEpoch).toBe(epoch);
    expect(result.current.validationStatus).toBe("unavailable");
    expect(result.current.authenticated).toBe(false);

    vi.mocked(fetch).mockResolvedValueOnce(mockSafeConfigResponse());
    act(() => {
      result.current.retryValidation();
    });
    expect(result.current.validationStatus).toBe("pending");

    await waitFor(() => {
      expect(result.current.validationStatus).toBe("verified");
    });
    expect(result.current.authenticated).toBe(true);
    expect(result.current.token).toBe("restored-pending");
    expect(result.current.sessionEpoch).toBe(epoch);

    await act(async () => {
      finishProbe(mockSafeConfigResponse());
    });
    expect(result.current.authenticated).toBe(true);
    expect(result.current.token).toBe("restored-pending");
    expect(result.current.sessionEpoch).toBe(epoch);
    expect(result.current.validationStatus).toBe("verified");
  });

  it("invalid HTTP 200 login payload on pending session moves validation to unavailable without stranding pending", async () => {
    setSessionToken("pending-token-200", true, { requiresValidation: true });
    const epoch = getSessionSnapshot().sessionEpoch;
    let finishProbe!: (r: Response) => void;
    vi.mocked(fetch).mockReturnValueOnce(
      new Promise((resolve) => {
        finishProbe = resolve;
      })
    );

    const { result } = renderHook(useAuth, { wrapper });
    expect(result.current.validationStatus).toBe("pending");

    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ success: false, token: "bad" }));
    await act(async () => {
      await expect(result.current.login("password")).rejects.toMatchObject({ status: 200 });
    });

    expect(result.current.token).toBe("pending-token-200");
    expect(result.current.sessionEpoch).toBe(epoch);
    expect(result.current.validationStatus).toBe("unavailable");
    expect(result.current.authenticated).toBe(false);

    await act(async () => {
      finishProbe(mockSafeConfigResponse());
    });
    expect(result.current.token).toBe("pending-token-200");
    expect(result.current.sessionEpoch).toBe(epoch);
    expect(result.current.validationStatus).toBe("unavailable");
    expect(result.current.authenticated).toBe(false);
  });

  it("failed login never affects an already-verified prior session", async () => {
    setSessionToken("already-verified-token");
    const { result } = renderHook(useAuth, { wrapper });
    const epoch = result.current.sessionEpoch;
    expect(result.current.authenticated).toBe(true);
    expect(result.current.validationStatus).toBe("verified");

    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ detail: "密码错误" }, { status: 401 }));
    await act(async () => {
      await expect(result.current.login("wrong-pass")).rejects.toMatchObject({ status: 401 });
    });

    expect(result.current.token).toBe("already-verified-token");
    expect(result.current.sessionEpoch).toBe(epoch);
    expect(result.current.authenticated).toBe(true);
    expect(result.current.validationStatus).toBe("verified");
  });

  it("older superseded login failure does not corrupt a newer login attempt", async () => {
    setSessionToken("restored-token", true, { requiresValidation: true });
    const { result } = renderHook(useAuth, { wrapper });

    let finishOldLogin!: (r: Response) => void;
    vi.mocked(fetch)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishOldLogin = resolve;
        })
      )
      .mockResolvedValueOnce(Response.json({ token: "brand-new-token" }));

    const oldLoginPromise = result.current.login("old-attempt");
    const oldRejected = expect(oldLoginPromise).rejects.toMatchObject({ name: "AbortError" });

    await act(() => result.current.login("new-attempt"));
    expect(result.current.token).toBe("brand-new-token");
    expect(result.current.authenticated).toBe(true);
    expect(result.current.validationStatus).toBe("verified");

    finishOldLogin(Response.json({ detail: "密码错误" }, { status: 401 }));
    await oldRejected;

    expect(result.current.token).toBe("brand-new-token");
    expect(result.current.authenticated).toBe(true);
    expect(result.current.validationStatus).toBe("verified");
  });

  it("queued probe success after true provider unmount does not write validation status", async () => {
    setSessionToken("unmount-token", true, { requiresValidation: true });
    const epoch = getSessionSnapshot().sessionEpoch;
    let finishProbe!: (r: Response) => void;
    vi.mocked(fetch).mockReturnValue(
      new Promise((resolve) => {
        finishProbe = resolve;
      })
    );

    const { result, unmount } = renderHook(useAuth, { wrapper });
    expect(result.current.validationStatus).toBe("pending");

    unmount();

    await act(async () => {
      finishProbe(mockSafeConfigResponse());
      await Promise.resolve();
    });

    const validationSnap = getSessionValidationSnapshot();
    expect(validationSnap.sessionEpoch).toBe(epoch);
    expect(validationSnap.status).toBe("pending");
  });

  it("queued probe failure after true provider unmount does not write validation status", async () => {
    setSessionToken("unmount-fail-token", true, { requiresValidation: true });
    const epoch = getSessionSnapshot().sessionEpoch;
    let rejectProbe!: (err: Error) => void;
    vi.mocked(fetch).mockReturnValue(
      new Promise((_, reject) => {
        rejectProbe = reject;
      })
    );

    const { result, unmount } = renderHook(useAuth, { wrapper });
    expect(result.current.validationStatus).toBe("pending");

    unmount();

    await act(async () => {
      rejectProbe(new Error("network failure"));
      await Promise.resolve();
    });

    const validationSnap = getSessionValidationSnapshot();
    expect(validationSnap.sessionEpoch).toBe(epoch);
    expect(validationSnap.status).toBe("pending");
  });

  it("late probe completion from older session does not overwrite newer session", async () => {
    setSessionToken("epoch-1-token", true, { requiresValidation: true });
    const epoch1 = getSessionSnapshot().sessionEpoch;
    let finishProbe1!: (r: Response) => void;
    vi.mocked(fetch).mockReturnValueOnce(
      new Promise((resolve) => {
        finishProbe1 = resolve;
      })
    );

    const { result } = renderHook(useAuth, { wrapper });
    expect(result.current.sessionEpoch).toBe(epoch1);
    expect(result.current.validationStatus).toBe("pending");

    act(() => {
      setSessionToken("epoch-2-token");
    });
    expect(result.current.token).toBe("epoch-2-token");
    expect(result.current.sessionEpoch).toBe(epoch1 + 1);
    expect(result.current.validationStatus).toBe("verified");

    await act(async () => {
      finishProbe1(mockSafeConfigResponse());
      await Promise.resolve();
    });

    expect(result.current.token).toBe("epoch-2-token");
    expect(result.current.sessionEpoch).toBe(epoch1 + 1);
    expect(result.current.validationStatus).toBe("verified");
    expect(result.current.authenticated).toBe(true);
  });

  it("actually restores storage token lazily on fresh module load", async () => {
    vi.resetModules();
    localStorage.setItem(AUTH_STORAGE_KEY, "real-lazy-token");
    vi.mocked(fetch).mockResolvedValueOnce(mockSafeConfigResponse());

    const { AuthProvider: FreshAuthProvider, useAuth: freshUseAuth } = await import("./AuthProvider");
    const { getSessionSnapshot: freshGetSessionSnapshot, getSessionValidationSnapshot: freshGetValidationSnapshot } =
      await import("./session");

    const initialSnap = freshGetSessionSnapshot();
    expect(initialSnap).toEqual({ token: "real-lazy-token", sessionEpoch: 0 });
    expect(freshGetValidationSnapshot()).toEqual({ sessionEpoch: 0, status: "pending" });

    const freshWrapper = FreshAuthProvider;
    const { result } = renderHook(freshUseAuth, { wrapper: freshWrapper });
    expect(result.current.token).toBe("real-lazy-token");
    expect(result.current.validationStatus).toBe("pending");
    expect(result.current.authenticated).toBe(false);
    expect(result.current.sessionEpoch).toBe(0);

    await waitFor(() => {
      expect(result.current.validationStatus).toBe("verified");
    });
    expect(result.current.authenticated).toBe(true);
    expect(result.current.sessionEpoch).toBe(0);
    const probeUrl = new URL(String(vi.mocked(fetch).mock.calls[0][0]));
    expect(probeUrl.pathname).toBe("/config/get");
    expect(probeUrl.searchParams.get("include_secrets")).toBe("false");
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain("config/get?include_secrets=false");
  });
});
