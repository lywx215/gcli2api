import { describe, expect, it, vi } from "vitest";
import { ApiError, createServiceUrl, getServiceBase, requestBlob, requestJson } from "@/api/client";
import { getSessionSnapshot, registerSessionCleanup, setSessionToken } from "@/auth/session";
const meta = (value: string) => { document.querySelector<HTMLMetaElement>('meta[name="gcli-service-base"]')!.content = value; };
const deferred = () => { let resolve!: (value: Response) => void; const promise = new Promise<Response>(done => { resolve = done; }); return { resolve, promise }; };

describe("service root", () => {
  it.each(["/", "/node/", "http://localhost:3000/tenant/node/"])("supports injected root %s", value => {
    meta(value);
    const base = new URL(value, location.origin).href;
    expect(getServiceBase()).toBe(base);
    expect(createServiceUrl("creds/status", { mode: "antigravity", search: "a & b", enabled: false, page: 0, skip: null }).href).toBe(base + "creds/status?mode=antigravity&search=a+%26+b&enabled=false&page=0");
    const ws = createServiceUrl("logs/stream", { token: "synthetic only" });
    ws.protocol = ws.protocol === "https:" ? "wss:" : "ws:";
    expect(ws.protocol).toBe("ws:");
  });
  it.each(["https://elsewhere.example.invalid/", "//example.invalid/", "/node", "/a/../", "/%2e%2e/", "javascript:bad/", " /node/", "/node/?x=/", "/node/#x/", "http://u:p@localhost:3000/"])("rejects unsafe injected root %s", value => {
    meta(value); expect(() => getServiceBase()).toThrow();
  });
  it("only DEV permits a missing injection", () => {
    document.head.innerHTML = "";
    vi.stubEnv("DEV", true); expect(getServiceBase()).toBe(location.origin + "/");
    vi.stubEnv("DEV", false); expect(() => getServiceBase()).toThrow();
    document.head.innerHTML = '<meta name="gcli-service-base" content="__GCLI_SERVICE_BASE__">';
    expect(() => getServiceBase()).toThrow();
  });
  it.each(["/creds/status", "//bad/", "https://bad/", "../creds", "a/../creds", "%2e%2e/creds", "a/%2fcreds", "%252e%252e/creds", "a?x=y", "a#x", "a//b", ""])("rejects path escape %s", path => expect(() => createServiceUrl(path)).toThrow());
});

describe("transport", () => {
  it("adds bearer, safely serializes JSON and keeps HTTP 200 business failure intact", async () => {
    setSessionToken("synthetic-session");
    vi.mocked(fetch).mockResolvedValue(Response.json({ success: false, errors: ["synthetic"] }));
    const result = await requestJson("creds/action", { method: "POST", query: { mode: "antigravity" }, body: { action: "test-only" } });
    expect(result).toEqual({ success: false, errors: ["synthetic"] });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toBe("http://localhost:3000/creds/action?mode=antigravity");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer synthetic-session");
    expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
    expect(init).toMatchObject({ method: "POST", body: '{"action":"test-only"}', redirect: "error", cache: "no-store" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("sends FormData without manufacturing a boundary", async () => {
    const body = new FormData(); body.append("file", new Blob(["synthetic"]), "synthetic.txt");
    vi.mocked(fetch).mockResolvedValue(Response.json({ success: true }));
    await requestJson("creds/upload", { method: "POST", body });
    const init = vi.mocked(fetch).mock.calls[0][1];
    expect(init?.body).toBe(body); expect(new Headers(init?.headers).has("Content-Type")).toBe(false);
  });
  it("returns downloads as blobs", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("synthetic log", { headers: { "Content-Type": "text/plain" } }));
    const { blob, response } = await requestBlob("logs/download");
    expect(response.headers.get("Content-Type")).toBe("text/plain");
    expect(await blob.text()).toBe("synthetic log");
  });
  it("keeps structured errors while not echoing secret payload in its message", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ detail: "synthetic-secret" }, { status: 501 }));
    const error = await requestJson("creds/status").catch(value => value);
    expect(error).toBeInstanceOf(ApiError); if (!(error instanceof ApiError)) throw error; expect(error.status).toBe(501);
    expect(error.payload).toEqual({ detail: "synthetic-secret" }); expect(error.message).not.toContain("synthetic-secret");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("normalizes non-JSON errors without reflecting an HTML body", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("<h1>synthetic secret</h1>", { status: 502 }));
    await expect(requestBlob("logs/download")).rejects.toMatchObject({ status: 502, payload: null });
  });
  it("clears session/read caches once for concurrent authentication failures", async () => {
    setSessionToken("synthetic-session"); const epoch = getSessionSnapshot().sessionEpoch;
    const cleared = vi.fn(); const unsubscribe = registerSessionCleanup(cleared);
    vi.mocked(fetch).mockImplementation(async () => Response.json({ detail: "密码错误" }, { status: 401 }));
    const results = await Promise.allSettled([requestJson("creds/status"), requestJson("version/info")]);
    expect(results.every(result => result.status === "rejected")).toBe(true);
    expect(getSessionSnapshot()).toEqual({ token: null, sessionEpoch: epoch + 1 });
    expect(cleared).toHaveBeenCalledTimes(1); unsubscribe();
  });
  it.each([200, 401, 403])("discards an old session's %s after relogin even if fetch ignores abort", async status => {
    setSessionToken("old-synthetic"); const pending = deferred(); vi.mocked(fetch).mockReturnValue(pending.promise);
    const request = requestJson("creds/status");
    setSessionToken("new-synthetic");
    pending.resolve(Response.json({ items: ["stale"] }, { status }));
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(getSessionSnapshot().token).toBe("new-synthetic");
  });
  it("checks the epoch after a delayed response body", async () => {
    const response = new Response(); let finish!: (value: unknown) => void;
    response.json = () => new Promise(resolve => { finish = resolve; });
    vi.mocked(fetch).mockResolvedValue(response);
    const promise = requestJson("creds/status"); await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    setSessionToken(null); finish({ stale: true });
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });
  it("does not log out a session on a failed login attempt", async () => {
    setSessionToken("synthetic-current");
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 401 }));
    await expect(requestJson("auth/login", { method: "POST", body: { password: "synthetic-invalid" } })).rejects.toMatchObject({ status: 401 });
    expect(getSessionSnapshot().token).toBe("synthetic-current");
    expect(new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers).has("Authorization")).toBe(false);
  });
  it("preserves abort and network failure categories and never retries writes", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(requestJson("creds/action", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
    vi.mocked(fetch).mockRejectedValue(new TypeError("Network failure"));
    await expect(requestJson("creds/action", { method: "POST", body: {} })).rejects.toBeInstanceOf(TypeError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("uses DEV synthetic transport exclusively and never falls through", async () => {
    vi.stubEnv("DEV", true); vi.stubEnv("VITE_UI_FIXTURES", "true");
    expect(await requestJson("auth/login", { method: "POST", body: { password: "synthetic" } })).toEqual({ token: "synthetic-ui-session" });
    await expect(requestJson("unknown/path")).rejects.toMatchObject({ status: 501 });
    expect(fetch).not.toHaveBeenCalled();
    vi.stubEnv("DEV", false); vi.mocked(fetch).mockResolvedValue(Response.json({ productionTransport: true }));
    expect(await requestJson("version/info")).toEqual({ productionTransport: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

it.each([401, 403])("upstream and unclassified %s never log out the panel", async status => {
  setSessionToken("synthetic-session"); const epoch = getSessionSnapshot().sessionEpoch;
  for (const payload of [
    { detail: "密码错误", response_source: "google", upstream_status: status },
    { response_source: "google", upstream_status: status, error: "synthetic" },
    { detail: "quota refused" },
  ]) {
    vi.mocked(fetch).mockResolvedValue(Response.json(payload, { status }));
    await expect(requestJson("creds/quota/synthetic")).rejects.toMatchObject({ status, payload });
    expect(getSessionSnapshot()).toEqual({ token: "synthetic-session", sessionEpoch: epoch });
  }
});

it("rejects raw/encoded backslashes and asserts service-prefix containment", () => {
  meta("/tenant/node/");
  const slash = String.fromCharCode(92);
  for (const path of [slash + slash + "evil.example.invalid/path", "a" + slash + ".." + slash + "escape", "%5c%5cevil.example.invalid/path", "a/%5c../escape", "%2e./escape", ".%2e/escape", "a/%252fescape", "a/%255cescape"]) {
    expect(() => createServiceUrl(path), path).toThrow();
  }
  const url = createServiceUrl("creds/download/synthetic%20file.json");
  expect(url.origin).toBe(location.origin);
  expect(url.pathname).toBe("/tenant/node/creds/download/synthetic%20file.json");
});
