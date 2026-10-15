/** Synthetic development-only transport. Unknown routes never reach a backend. */
export type FixtureHandler = (url: URL, init: RequestInit) => Response | Promise<Response>;

const handlers = new Set<FixtureHandler>();

export function registerFixtureHandler(handler: FixtureHandler) {
  handlers.add(handler);
  return () => { handlers.delete(handler); };
}

const safeConfigFixture = {
  config: {
    service_url: "https://example.invalid/service",
    proxy_url: "http://example.invalid:8080",
    theme: "system",
    request_timeout: 30,
  },
  capabilities: [
    "config.safe_read",
    "model.routing",
  ],
  env_locked: [],
  security: {
    auth_enabled: true,
  },
  secret_fields: {
    api_password: { configured: true },
    panel_password: { configured: true },
    password: { configured: false },
  },
};

export async function fixtureFetch(url: URL, init: RequestInit): Promise<Response> {
  init.signal?.throwIfAborted();
  for (const handler of Array.from(handlers)) {
    const response = await handler(url, init);
    init.signal?.throwIfAborted();
    if (response.status !== 404) return response;
  }
  if (import.meta.env.DEV && import.meta.env.VITE_UI_FIXTURES === "true" && url.pathname.endsWith("/config/model-routing")) {
    const { fixtureModelRoutingRequest } = await import("@/pages/model-routing/fixtures");
    const response = await fixtureModelRoutingRequest(url, init);
    init.signal?.throwIfAborted();
    if (response.status !== 404) return response;
  }
  if (url.pathname.endsWith("/auth/login") && (init.method ?? "POST").toUpperCase() === "POST") {
    init.signal?.throwIfAborted();
    return Response.json({ token: "synthetic-ui-session" });
  }
  if (url.pathname.endsWith("/config/get") && (init.method ?? "GET").toUpperCase() === "GET") {
    init.signal?.throwIfAborted();
    if (url.searchParams.get("include_secrets") === "false") {
      return Response.json(safeConfigFixture);
    }
  }
  return Response.json({ error: "synthetic_fixture_not_registered" }, { status: 501 });
}

