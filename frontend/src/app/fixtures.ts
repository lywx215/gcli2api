/** Synthetic development-only transport. Unknown routes never reach a backend. */
type FixtureHandler = (url: URL, init: RequestInit) => Response | Promise<Response>;
const handlers = new Set<FixtureHandler>();
export function registerFixtureHandler(handler: FixtureHandler) { handlers.add(handler); return () => { handlers.delete(handler); }; }
export async function fixtureFetch(url: URL, init: RequestInit): Promise<Response> {
  init.signal?.throwIfAborted();
  for (const handler of handlers) {
    const response = await handler(url, init);
    if (response.status !== 404) return response;
  }
  if (url.pathname.endsWith("/auth/login") && init.method === "POST") return Response.json({ token: "synthetic-ui-session" });
  return Response.json({ error: "synthetic_fixture_not_registered" }, { status: 501 });
}
