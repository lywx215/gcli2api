import { describe, expect, it, vi } from "vitest";
import { ApiError, createServiceUrl, getServiceBase, requestBlob, requestJson } from "@/api/client";
import { getSessionSnapshot, registerSessionCleanup, setSessionToken } from "@/auth/session";
import {
  capturePanelScope,
  __commitPanelChannel,
  __invalidatePanelChannel,
  type PanelScope,
} from "@/domain/panel";
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
  it.each(["/creds/status", "//bad/", "https://bad/", "../creds", "a/../creds", "%2e%2e/creds", "a/%2fcreds", "a?x=y", "a#x", "a//b", "a/%", "a/%GG", ""])("rejects path escape %s", path => expect(() => createServiceUrl(path)).toThrow());
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
  for (const path of [slash + slash + "evil.example.invalid/path", "a" + slash + ".." + slash + "escape", "%5c%5cevil.example.invalid/path", "a/%5c../escape", "%2e./escape", ".%2e/escape"]) {
    expect(() => createServiceUrl(path), path).toThrow();
  }
  const url = createServiceUrl("creds/download/synthetic%20file.json");
  expect(url.origin).toBe(location.origin);
  expect(url.pathname).toBe("/tenant/node/creds/download/synthetic%20file.json");
});

it.each(["rate%.json", "rate%25.json", "100%完成.json", "凭证-测试.json", "literal%2f.json", "百分百🙂.json"])("preserves a filename encoded exactly once: %s", filename => {
  meta("/tenant/node/");
  const encoded = encodeURIComponent(filename);
  const url = createServiceUrl(`creds/download/${encoded}`);
  expect(url.origin).toBe(location.origin);
  expect(url.pathname).toBe(`/tenant/node/creds/download/${encoded}`);
  expect(decodeURIComponent(url.pathname.split("/").at(-1)!)).toBe(filename);
});
it("transmits percent and Unicode filenames without a second encoding or decoding", async () => {
  setSessionToken("synthetic-session");
  const filename = "额度-rate%25.json";
  vi.mocked(fetch).mockResolvedValue(new Response("synthetic download"));
  const { blob } = await requestBlob(`creds/download/${encodeURIComponent(filename)}`, { query: { mode: "antigravity" } });
  const url = new URL(String(vi.mocked(fetch).mock.calls[0][0]));
  expect(decodeURIComponent(url.pathname.slice("/creds/download/".length))).toBe(filename);
  expect(url.searchParams.get("mode")).toBe("antigravity");
  expect(await blob.text()).toBe("synthetic download");
  expect(fetch).toHaveBeenCalledOnce();
});

describe("panel scope and channel fencing", () => {
  it("supports valid AG and GCLI scopes and guarantees captured scope immutability", async () => {
    setSessionToken("synthetic-session");
    __commitPanelChannel("antigravity");
    const agScope = capturePanelScope(getSessionSnapshot().sessionEpoch);
    vi.mocked(fetch).mockResolvedValue(Response.json({ mode: "ag" }));
    const agResult = await requestJson("creds/status", { scope: agScope });
    expect(agResult).toEqual({ mode: "ag" });

    __commitPanelChannel("geminicli");
    const gcliScope = capturePanelScope(getSessionSnapshot().sessionEpoch);
    vi.mocked(fetch).mockResolvedValue(Response.json({ mode: "gcli" }));
    const gcliResult = await requestJson("creds/status", { scope: gcliScope });
    expect(gcliResult).toEqual({ mode: "gcli" });

    // Immutability: caller mutating the passed scope object after request creation does not retarget request
    const mutableScope = { ...capturePanelScope(getSessionSnapshot().sessionEpoch) };
    const pending = deferred();
    vi.mocked(fetch).mockReturnValue(pending.promise);
    const promise = requestJson("creds/status", { scope: mutableScope });
    (mutableScope as { mode: string }).mode = "antigravity";
    (mutableScope as { channelEpoch: number }).channelEpoch = 999;
    pending.resolve(Response.json({ ok: true }));
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it("rejects stale scope before send with AbortError and zero transport", async () => {
    setSessionToken("synthetic-session");
    __commitPanelChannel("antigravity");
    const staleScope: PanelScope = {
      mode: "antigravity",
      channelEpoch: 999,
      sessionEpoch: getSessionSnapshot().sessionEpoch,
    };
    await expect(requestJson("creds/status", { scope: staleScope })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("aborts in-flight scoped request when channel switch occurs while pending", async () => {
    setSessionToken("synthetic-session");
    __commitPanelChannel("antigravity");
    const scope = capturePanelScope(getSessionSnapshot().sessionEpoch);
    const pending = deferred();
    vi.mocked(fetch).mockReturnValue(pending.promise);
    const promise = requestJson("creds/status", { scope });
    __commitPanelChannel("geminicli");
    pending.resolve(Response.json({ ok: true }));
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("fences delayed response headers when channel changes", async () => {
    setSessionToken("synthetic-session");
    __commitPanelChannel("antigravity");
    const scope = capturePanelScope(getSessionSnapshot().sessionEpoch);
    const pending = deferred();
    vi.mocked(fetch).mockReturnValue(pending.promise);
    const promise = requestJson("creds/status", { scope });
    __commitPanelChannel("geminicli");
    pending.resolve(Response.json({ items: [] }));
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("fences delayed success body when channel changes", async () => {
    setSessionToken("synthetic-session");
    __commitPanelChannel("antigravity");
    const scope = capturePanelScope(getSessionSnapshot().sessionEpoch);
    const response = new Response();
    let finishBody!: (value: unknown) => void;
    response.json = () => new Promise(resolve => { finishBody = resolve; });
    vi.mocked(fetch).mockResolvedValue(response);
    const promise = requestJson("creds/status", { scope });
    await vi.waitFor(() => expect(finishBody).toBeTypeOf("function"));
    __commitPanelChannel("geminicli");
    finishBody({ ok: true });
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("fences delayed error body when channel changes and preserves session", async () => {
    setSessionToken("preserve-token");
    __commitPanelChannel("antigravity");
    const scope = capturePanelScope(getSessionSnapshot().sessionEpoch);
    const response = new Response(null, { status: 401 });
    let finishText!: (value: string) => void;
    response.text = () => new Promise(resolve => { finishText = resolve; });
    vi.mocked(fetch).mockResolvedValue(response);
    const promise = requestJson("creds/status", { scope });
    await vi.waitFor(() => expect(finishText).toBeTypeOf("function"));
    __commitPanelChannel("geminicli");
    finishText(JSON.stringify({ detail: "密码错误" }));
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(getSessionSnapshot().token).toBe("preserve-token");
  });

  it("fences requests when transport ignores AbortSignal", async () => {
    setSessionToken("synthetic-session");
    __commitPanelChannel("antigravity");
    const scope = capturePanelScope(getSessionSnapshot().sessionEpoch);
    const controller = new AbortController();
    const pending = deferred();
    vi.mocked(fetch).mockReturnValue(pending.promise);
    const promise = requestJson("creds/status", { scope, signal: controller.signal });
    controller.abort();
    pending.resolve(Response.json({ ignoredAbort: true }));
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("prevents stale old-channel 401 payload from logging out current session on new channel", async () => {
    setSessionToken("current-valid-token");
    __commitPanelChannel("antigravity");
    const oldChannelScope = capturePanelScope(getSessionSnapshot().sessionEpoch);
    const pending = deferred();
    vi.mocked(fetch).mockReturnValue(pending.promise);
    const request = requestJson("creds/status", { scope: oldChannelScope });
    __commitPanelChannel("geminicli");
    pending.resolve(Response.json({ detail: "密码错误" }, { status: 401 }));
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(getSessionSnapshot().token).toBe("current-valid-token");
  });

  it("prevents stale old-session 401 payload from erasing a newer login", async () => {
    setSessionToken("first-login-token");
    const pending = deferred();
    vi.mocked(fetch).mockReturnValue(pending.promise);
    const request = requestJson("creds/status");
    setSessionToken("second-login-token");
    pending.resolve(Response.json({ detail: "密码错误" }, { status: 401 }));
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(getSessionSnapshot().token).toBe("second-login-token");
  });

  it("allows unscoped requests to survive channel switch", async () => {
    setSessionToken("stable-session");
    __commitPanelChannel("antigravity");
    const pending = deferred();
    vi.mocked(fetch).mockReturnValue(pending.promise);
    const request = requestJson("version/info");
    __commitPanelChannel("geminicli");
    pending.resolve(Response.json({ version: "1.0.0" }));
    expect(await request).toEqual({ version: "1.0.0" });
  });

  it("rejects query, JSON body and FormData mode conflicts before transport without rewrites", async () => {
    setSessionToken("synthetic-session");
    __commitPanelChannel("antigravity");
    const scope = capturePanelScope(getSessionSnapshot().sessionEpoch);

    // Query mismatch
    await expect(requestJson("creds/status", { scope, query: { mode: "geminicli" } })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();

    // JSON body mismatch
    await expect(requestJson("creds/action", { scope, method: "POST", body: { mode: "geminicli" } })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();

    // FormData mode mismatch
    const fdMismatch = new FormData();
    fdMismatch.append("mode", "geminicli");
    await expect(requestJson("creds/upload", { scope, method: "POST", body: fdMismatch })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();

    // FormData duplicate-conflicting
    const fdDuplicate = new FormData();
    fdDuplicate.append("mode", "antigravity");
    fdDuplicate.append("mode", "geminicli");
    await expect(requestJson("creds/upload", { scope, method: "POST", body: fdDuplicate })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();

    // FormData non-string
    const fdNonString = new FormData();
    fdNonString.append("mode", new Blob(["antigravity"]));
    await expect(requestJson("creds/upload", { scope, method: "POST", body: fdNonString })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();

    // Undefined optional query/body fields remain omitted and pass
    vi.mocked(fetch).mockImplementation(async () => Response.json({ ok: true }));
    await expect(requestJson("creds/status", { scope, query: { mode: undefined } })).resolves.toEqual({ ok: true });
    await expect(requestJson("creds/action", { scope, method: "POST", body: { mode: undefined, action: "test" } })).resolves.toEqual({ ok: true });

    // Matching query passes
    await expect(requestJson("creds/status", { scope, query: { mode: "antigravity" } })).resolves.toEqual({ ok: true });

    // Matching JSON body passes
    await expect(requestJson("creds/action", { scope, method: "POST", body: { mode: "antigravity" } })).resolves.toEqual({ ok: true });

    // Matching FormData mode passes and preserves FormData content and boundary
    vi.mocked(fetch).mockClear();
    vi.mocked(fetch).mockImplementation(async () => Response.json({ uploaded: true }));
    const fdValid = new FormData();
    fdValid.append("mode", "antigravity");
    fdValid.append("file", new Blob(["sample"]), "sample.txt");
    await expect(requestJson("creds/upload", { scope, method: "POST", body: fdValid })).resolves.toEqual({ uploaded: true });
    const init = vi.mocked(fetch).mock.calls[0][1];
    expect(init?.body).toBe(fdValid);
    expect(new Headers(init?.headers).has("Content-Type")).toBe(false);
  });
});

describe("exact local authentication matcher", () => {
  it.each([401, 403])("invalidates session on exact fourth string panel_authentication_required with %s", async status => {
    setSessionToken("target-token");
    vi.mocked(fetch).mockResolvedValue(Response.json({ detail: "panel_authentication_required" }, { status }));
    await expect(requestJson("creds/status")).rejects.toMatchObject({ status });
    expect(getSessionSnapshot().token).toBeNull();
  });

  it("never invalidates session on extra-field, business or arbitrary detail payloads", async () => {
    setSessionToken("protected-token");
    const epoch = getSessionSnapshot().sessionEpoch;

    // Extra field alongside exact panel string
    vi.mocked(fetch).mockResolvedValue(Response.json({ detail: "panel_authentication_required", extra: "forbidden" }, { status: 401 }));
    await expect(requestJson("creds/status")).rejects.toMatchObject({ status: 401 });
    expect(getSessionSnapshot()).toEqual({ token: "protected-token", sessionEpoch: epoch });

    // Business failure object
    vi.mocked(fetch).mockResolvedValue(Response.json({ filename: "key.json", status_code: 401, step: "validate", error: "denied" }, { status: 401 }));
    await expect(requestJson("creds/status")).rejects.toMatchObject({ status: 401 });
    expect(getSessionSnapshot()).toEqual({ token: "protected-token", sessionEpoch: epoch });

    // Arbitrary detail
    vi.mocked(fetch).mockResolvedValue(Response.json({ detail: "unrecognized detail string" }, { status: 401 }));
    await expect(requestJson("creds/status")).rejects.toMatchObject({ status: 401 });
    expect(getSessionSnapshot()).toEqual({ token: "protected-token", sessionEpoch: epoch });
  });
});
