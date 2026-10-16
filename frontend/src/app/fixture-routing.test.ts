import { expect, it, vi } from "vitest";
import { requestJson } from "@/api/client";
import { setSessionToken } from "@/auth/session";
import { fixtureFetch, registerFixtureHandler } from "./fixtures";

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
  mock.handler.mockClear(); vi.mocked(fetch).mockImplementation(async () => Response.json({ routes: [] }));
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

it("returns SafeConfigResponse for GET config/get with explicit include_secrets=false", async () => {
  const res = await fixtureFetch(
    new URL("http://localhost:3000/config/get?include_secrets=false"),
    { method: "GET" }
  );
  expect(res.status).toBe(200);
  const data = await res.json();
  expect(data).toHaveProperty("config");
  expect(data).toHaveProperty("capabilities");
  expect(data).toHaveProperty("env_locked");
  expect(data).toHaveProperty("security");
  expect(data).toHaveProperty("secret_fields");

  expect(Object.keys(data.config)).not.toContain("api_password");
  expect(Object.keys(data.config)).not.toContain("panel_password");
  expect(Object.keys(data.config)).not.toContain("password");

  expect(data.secret_fields).toEqual({
    api_password: { configured: true },
    panel_password: { configured: true },
    password: { configured: false },
  });
  expect(Array.isArray(data.capabilities)).toBe(true);
  expect(Array.isArray(data.env_locked)).toBe(true);
});

it("fails closed with 501 when config/get has absent or true include_secrets", async () => {
  const absent = await fixtureFetch(
    new URL("http://localhost:3000/config/get"),
    { method: "GET" }
  );
  expect(absent.status).toBe(501);
  expect(await absent.json()).toEqual({ error: "synthetic_fixture_not_registered" });

  const trueFlag = await fixtureFetch(
    new URL("http://localhost:3000/config/get?include_secrets=true"),
    { method: "GET" }
  );
  expect(trueFlag.status).toBe(501);
  expect(await trueFlag.json()).toEqual({ error: "synthetic_fixture_not_registered" });
  expect(fetch).not.toHaveBeenCalled();
});

it("supports prefix paths for safe config fixture", async () => {
  const res = await fixtureFetch(
    new URL("http://localhost:3000/tenant/node/config/get?include_secrets=false"),
    { method: "GET" }
  );
  expect(res.status).toBe(200);
  const data = await res.json();
  expect(data.capabilities).toEqual(["config.safe_read", "model.routing"]);
});

it("supports registerFixtureHandler with custom registration, first non-404 priority, and idempotent unregister", async () => {
  const customHandler = vi.fn(async (url: URL) => {
    if (url.pathname.endsWith("/custom/test")) {
      return Response.json({ custom: "data" });
    }
    return new Response(null, { status: 404 });
  });
  const unregister = registerFixtureHandler(customHandler);

  const resCustom = await fixtureFetch(
    new URL("http://localhost:3000/custom/test"),
    { method: "GET" }
  );
  expect(resCustom.status).toBe(200);
  expect(await resCustom.json()).toEqual({ custom: "data" });

  // 404 falls through to next handler (e.g. safe config fixture)
  const resFallthrough = await fixtureFetch(
    new URL("http://localhost:3000/config/get?include_secrets=false"),
    { method: "GET" }
  );
  expect(resFallthrough.status).toBe(200);

  // Idempotent unregister
  unregister();
  unregister();

  const resAfterUnregister = await fixtureFetch(
    new URL("http://localhost:3000/custom/test"),
    { method: "GET" }
  );
  expect(resAfterUnregister.status).toBe(501);
});

it("checks abort signal before and after handlers in fixtureFetch", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    fixtureFetch(new URL("http://localhost:3000/config/get?include_secrets=false"), {
      method: "GET",
      signal: controller.signal,
    })
  ).rejects.toMatchObject({ name: "AbortError" });

  const asyncController = new AbortController();
  const unregisterAsync = registerFixtureHandler(async () => {
    asyncController.abort();
    return Response.json({ late: true });
  });
  await expect(
    fixtureFetch(new URL("http://localhost:3000/anything"), {
      method: "GET",
      signal: asyncController.signal,
    })
  ).rejects.toMatchObject({ name: "AbortError" });
  unregisterAsync();
});

