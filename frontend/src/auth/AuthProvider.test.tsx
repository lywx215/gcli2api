import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "./AuthProvider";
import { AUTH_STORAGE_KEY, getSessionSnapshot, registerSessionCleanup, setSessionToken } from "./session";
import { requestJson } from "@/api/client";
const wrapper = AuthProvider;

describe("auth lifecycle", () => {
  it("logs in with the legacy body/key and logout advances the epoch", async () => {
    const { result } = renderHook(useAuth, { wrapper });
    const initial = result.current.sessionEpoch;
    vi.mocked(fetch).mockResolvedValue(Response.json({ token: "synthetic-login" }));
    await act(() => result.current.login("synthetic-password"));
    expect(result.current).toMatchObject({ token: "synthetic-login", authenticated: true, sessionEpoch: initial + 1 });
    expect(vi.mocked(fetch).mock.calls[0][1]?.body).toBe('{"password":"synthetic-password"}');
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBe("synthetic-login");
    const cleared = vi.fn(); const unregister = registerSessionCleanup(cleared);
    act(() => result.current.logout());
    expect(result.current).toMatchObject({ token: null, authenticated: false, sessionEpoch: initial + 2 });
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(cleared).toHaveBeenCalledOnce(); unregister();
  });
  it("keeps a memory session when storage throws and still clears it", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    const { result } = renderHook(useAuth, { wrapper });
    vi.mocked(fetch).mockResolvedValue(Response.json({ token: "synthetic-memory" }));
    await act(() => result.current.login("synthetic"));
    expect(result.current.authenticated).toBe(true);
    act(() => result.current.logout()); expect(result.current.token).toBeNull();
  });
  it.each([{ success: false, token: "synthetic" }, {}, { token: "" }, { token: 12 }])("rejects invalid HTTP 200 login payload %j", async payload => {
    const { result } = renderHook(useAuth, { wrapper });
    vi.mocked(fetch).mockResolvedValue(Response.json(payload));
    await act(async () => { await expect(result.current.login("synthetic")).rejects.toMatchObject({ status: 200 }); });
    expect(result.current.authenticated).toBe(false);
  });
  it("does not let an older login supersede the latest attempt", async () => {
    const { result } = renderHook(useAuth, { wrapper });
    let finish!: (value: Response) => void;
    vi.mocked(fetch).mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(Response.json({ token: "new-synthetic" }));
    const old = result.current.login("old-synthetic");
    const rejected = expect(old).rejects.toMatchObject({ name: "AbortError" });
    await act(() => result.current.login("new-synthetic"));
    finish(Response.json({ token: "old-synthetic" }));
    await rejected; expect(result.current.token).toBe("new-synthetic");
  });
  it("logout cancels a pending login even if the response arrives", async () => {
    const { result } = renderHook(useAuth, { wrapper });
    let finish!: (value: Response) => void;
    vi.mocked(fetch).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const pending = result.current.login("synthetic");
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    act(() => result.current.logout()); finish(Response.json({ token: "synthetic" })); await rejected;
    expect(result.current.authenticated).toBe(false);
  });
  it("central 403 clears authenticated state", async () => {
    setSessionToken("synthetic"); const { result } = renderHook(useAuth, { wrapper });
    vi.mocked(fetch).mockResolvedValue(Response.json({ detail: "Not authenticated" }, { status: 403 }));
    await act(async () => { await expect(requestJson("creds/status")).rejects.toMatchObject({ status: 403 }); });
    expect(result.current.authenticated).toBe(false);
  });
  it("cross-tab replacement and clear advance epoch, while unrelated storage is ignored", () => {
    setSessionToken("synthetic-old"); const { result } = renderHook(useAuth, { wrapper });
    const before = getSessionSnapshot().sessionEpoch;
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: AUTH_STORAGE_KEY, newValue: "synthetic-new", storageArea: localStorage })));
    expect(result.current).toMatchObject({ token: "synthetic-new", sessionEpoch: before + 1 });
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: "unrelated", newValue: "ignored", storageArea: localStorage })));
    expect(result.current.sessionEpoch).toBe(before + 1);
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage })));
    expect(result.current).toMatchObject({ token: null, sessionEpoch: before + 2 });
  });
});
