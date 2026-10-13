import { getSessionSnapshot, invalidateSession, registerSessionCleanup } from "@/auth/session";
import type { Query } from "@/domain/shared";
export type { Query } from "@/domain/shared";
export type RequestOptions = { method?: string; query?: Query; body?: unknown | FormData; signal?: AbortSignal };
export class ApiError extends Error {
  constructor(public status: number, public payload: unknown, message = `请求未完成（HTTP ${status}）`) {
    super(message); this.name = "ApiError";
  }
}
/** Inject an origin-relative root or same-origin absolute URL, with a trailing slash. */
export function getServiceBase(): string {
  const raw = document.querySelector<HTMLMetaElement>('meta[name="gcli-service-base"]')?.content;
  if ((!raw || raw === "__GCLI_SERVICE_BASE__") && import.meta.env.DEV) return new URL("/", location.origin).href;
  if (!raw || raw !== raw.trim() || !raw.endsWith("/") || raw.includes("\\") || /[\?#\s]/.test(raw) || /%/.test(raw)) {
    throw new Error("服务地址未正确配置，请重新加载或联系管理员。");
  }
  if (!(raw.startsWith("/") && !raw.startsWith("//")) && !/^https?:\/\//.test(raw)) {
    throw new Error("服务地址未正确配置，请重新加载或联系管理员。");
  }
  let url: URL;
  try { url = new URL(raw, location.origin); } catch { throw new Error("服务地址无效。"); }
  if (url.origin !== location.origin || url.username || url.password || !["http:", "https:"].includes(url.protocol) || raw.split("/").some(p => p === "." || p === "..")) {
    throw new Error("服务地址无效，必须使用同源服务根。");
  }
  return url.href;
}
export function createServiceUrl(path: string, query?: Query): URL {
  if (!path || path.startsWith("/") || path.includes("\\") || /[\?#\s:]/.test(path)) throw new Error("接口路径必须相对于服务根。");
  for (const segment of path.split("/")) {
    let decoded: string;
    // Validate the same single decoding step used by the backend path parameter.
    // A remaining percent is a literal filename character, not another escape to decode.
    try { decoded = decodeURIComponent(segment); } catch { throw new Error("接口路径编码无效。"); }
    if (decoded.includes("\\") || !decoded || decoded === "." || decoded === ".." || /[\/\x00-\x1f\x7f]/.test(decoded)) throw new Error("接口路径不能越过服务根。");
  }
  const base = new URL(getServiceBase());
  const url = new URL(path, base);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw new Error("接口路径不能越过服务根。");
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
  }
  return url;
}
/** Match the existing FastAPI panel dependency, never an upstream/business 401. */
function isPanelAuthFailure(status: number, payload: unknown): boolean {
  if ((status !== 401 && status !== 403) || !payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const record = payload as Record<string, unknown>;
  // The dependency emits only detail. Any business provenance or additional fields are not a panel proof.
  return Object.keys(record).length === 1 && typeof record.detail === "string"
    && ["密码错误", "Not authenticated", "Invalid authentication credentials"].includes(record.detail);
}
export type BlobResult = { blob: Blob; response: Response };
function staleRequest(): DOMException { return new DOMException("会话已变更，请重新读取。", "AbortError"); }
async function request(path: string, options: RequestOptions, kind: "json" | "blob"): Promise<unknown> {
  const session = getSessionSnapshot();
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) forwardAbort();
  else options.signal?.addEventListener("abort", forwardAbort, { once: true });
  const unregister = registerSessionCleanup(() => controller.abort(staleRequest()));
  const assertCurrent = () => {
    if (session.sessionEpoch !== getSessionSnapshot().sessionEpoch) throw staleRequest();
    controller.signal.throwIfAborted();
  };
  try {
    assertCurrent();
    const headers = new Headers({ Accept: kind === "json" ? "application/json" : "*/*" });
    const isLogin = path === "auth/login";
    if (session.token && !isLogin) headers.set("Authorization", `Bearer ${session.token}`);
    let body: BodyInit | undefined;
    if (options.body instanceof FormData) body = options.body;
    else if (options.body !== undefined) { body = JSON.stringify(options.body); headers.set("Content-Type", "application/json"); }
    const url = createServiceUrl(path, options.query);
    const init: RequestInit = { method: options.method ?? "GET", headers, body, signal: controller.signal, credentials: "same-origin", redirect: "error", cache: "no-store" };
    const response = import.meta.env.DEV && import.meta.env.VITE_UI_FIXTURES === "true"
      ? await (await import("@/app/fixtures")).fixtureFetch(url, init)
      : await fetch(url, init);
    assertCurrent();
    if (!response.ok) {
      let payload: unknown = null;
      try {
        const text = await response.text();
        try { payload = JSON.parse(text); } catch { payload = null; }
      } catch { /* status remains authoritative */ }
      assertCurrent();
      const authFailed = !isLogin && isPanelAuthFailure(response.status, payload);
      if (authFailed) invalidateSession(session.sessionEpoch);
      throw new ApiError(response.status, payload, authFailed ? "登录已失效，请重新登录。" : undefined);
    }
    const result = kind === "blob" ? { blob: await response.blob(), response } : response.status === 204 ? null : await response.json();
    assertCurrent();
    // Endpoint adapters determine success / partial / error semantics of a 2xx body.
    return result;
  } finally {
    unregister();
    options.signal?.removeEventListener("abort", forwardAbort);
  }
}
export async function requestJson<T>(path: string, options: RequestOptions = {}): Promise<T> { return await request(path, options, "json") as T; }
export async function requestBlob(path: string, options: RequestOptions = {}): Promise<BlobResult> { return await request(path, options, "blob") as BlobResult; }
