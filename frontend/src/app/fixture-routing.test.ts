import { expect, it, vi } from "vitest";
import { requestJson } from "@/api/client";
import { setSessionToken } from "@/auth/session";
const mock = vi.hoisted(() => ({ handler: vi.fn() }));
vi.mock("@/pages/model-routing/fixtures", () => ({ fixtureModelRoutingRequest: mock.handler }));
it("routes explicit DEV requests through the shared transport and preserves PUT body/prefix", async () => {
  vi.stubEnv("DEV", true); vi.stubEnv("VITE_UI_FIXTURES", "true");
  document.querySelector<HTMLMetaElement>('meta[name="gcli-service-base"]')!.content = "/tenant/node/";
  setSessionToken("synthetic-routing-session");
  mock.handler.mockResolvedValue(Response.json({ success: true, routes: [] }));
  const body = { routes: [{ channel: "antigravity", public_name: "synthetic-public", upstream_name: "synthetic-target", enabled: true }] };
  expect(await requestJson("config/model-routing", { method: "PUT", body })).toEqual({ success: true, routes: [] });
  const [url, init] = mock.handler.mock.calls.at(-1)!;
  expect(url.href).toBe("http://localhost:3000/tenant/node/config/model-routing");
  expect(init.method).toBe("PUT"); expect(JSON.parse(init.body)).toEqual(body);
  expect(new Headers(init.headers).get("Authorization")).toBe("Bearer synthetic-routing-session");
  expect(fetch).not.toHaveBeenCalled();
});
it("production or fixture-disabled requests never invoke the synthetic routing handler", async () => {
  mock.handler.mockClear(); vi.mocked(fetch).mockResolvedValue(Response.json({ routes: [] }));
  vi.stubEnv("DEV", false); vi.stubEnv("VITE_UI_FIXTURES", "true");
  await requestJson("config/model-routing");
  vi.stubEnv("DEV", true); vi.stubEnv("VITE_UI_FIXTURES", "false");
  await requestJson("config/model-routing");
  expect(mock.handler).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(2);
});
it("unhandled and unsupported fixture routes fail closed without backend fallback", async () => {
  mock.handler.mockClear(); vi.stubEnv("DEV", true); vi.stubEnv("VITE_UI_FIXTURES", "true");
  mock.handler.mockResolvedValue(new Response(null, { status: 404 }));
  await expect(requestJson("config/model-routing", { method: "DELETE" })).rejects.toMatchObject({ status: 501 });
  await expect(requestJson("config/not-a-fixture")).rejects.toMatchObject({ status: 501 });
  expect(mock.handler).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
});
it("explicit abort cancels a synthetic handler response even if it ignores the signal", async () => {
  vi.stubEnv("DEV", true); vi.stubEnv("VITE_UI_FIXTURES", "true");
  let finish!: (response: Response) => void;
  mock.handler.mockReturnValue(new Promise<Response>(resolve => { finish = resolve; }));
  const controller = new AbortController();
  const request = requestJson("config/model-routing", { signal: controller.signal });
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  controller.abort(); finish(Response.json({ routes: ["stale"] }));
  await expect(request).rejects.toMatchObject({ name: "AbortError" });
  expect(fetch).not.toHaveBeenCalled();
});
