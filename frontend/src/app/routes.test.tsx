import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setSessionToken } from "@/auth/session";
import { registerRouteGuard, routeFromHash, routes, useRoute, type RouteNavigation } from "./routes";
const releases = new Set<() => void>();
function guard(callback: (attempt: RouteNavigation) => boolean) {
  const release = registerRouteGuard(callback); releases.add(release); return release;
}
function changeHash(hash: string) {
  // Model a committed browser fragment change; dispatch through the real shared subscription.
  window.history.pushState(window.history.state, "", hash);
  fireEvent(window, new HashChangeEvent("hashchange"));
}
beforeEach(() => window.history.replaceState(null, "", "/ui/#/model-routing"));
afterEach(() => { for (const release of releases) release(); releases.clear(); });

it("recognizes the sixth production route and recognizes legacy aliases while keeping unknown hash fallback", () => {
  vi.stubEnv("DEV", false);
  expect(routes).toHaveLength(6);
  expect(routeFromHash("#/model-routing")).toBe("model-routing");
  expect(routeFromHash("#model-routing")).toBe("model-routing");
  expect(routeFromHash("#manage")).toBe("credentials");
  expect(routeFromHash("#/manage")).toBe("credentials");
  expect(routeFromHash("#manage/")).toBe("credentials");
  expect(routeFromHash("#antigravity-manage")).toBe("credentials");
  expect(routeFromHash("#/antigravity-manage")).toBe("credentials");
  expect(routeFromHash("#antigravity-manage/")).toBe("credentials");
  expect(routeFromHash("#/unknown")).toBe("overview");
});

it("legacy hash aliases #manage and #antigravity-manage undergo guard verification and retry to canonical URLs", async () => {
  function Harness() {
    const route = useRoute();
    return <p role="status">{route}</p>;
  }
  render(<Harness />);
  const attempts: RouteNavigation[] = [];
  guard(attempt => {
    attempts.push(attempt);
    return false;
  });

  // #manage navigation
  act(() => changeHash("#manage"));
  expect(attempts).toHaveLength(1);
  expect(attempts[0].to).toBe("credentials");
  expect(attempts[0].toMode).toBe("geminicli");
  expect(attempts[0].href).toContain("#/credentials?channel=geminicli");
  expect(screen.getByRole("status")).toHaveTextContent("model-routing");
  expect(location.hash).toBe("#/model-routing");

  // Retry #manage commits to canonical URL
  act(() => attempts[0].retry());
  expect(screen.getByRole("status")).toHaveTextContent("credentials");
  expect(location.hash).toBe("#/credentials?channel=geminicli");

  // #antigravity-manage navigation
  act(() => changeHash("#antigravity-manage"));
  expect(attempts).toHaveLength(2);
  expect(attempts[1].to).toBe("credentials");
  expect(attempts[1].toMode).toBe("antigravity");
  expect(attempts[1].href).toContain("#/credentials");
  expect(screen.getByRole("status")).toHaveTextContent("credentials");

  // Retry #antigravity-manage commits to canonical AG URL
  act(() => attempts[1].retry());
  expect(screen.getByRole("status")).toHaveTextContent("credentials");
  expect(location.hash).toBe("#/credentials");
});
it("a real hash link holds the page on cancel and retries once on confirmation", async () => {
  function Harness() { const route = useRoute(); return <><p role="status">{route}</p><a href="#/logs">日志</a></>; }
  render(<Harness />);
  const attempts: RouteNavigation[] = [];
  guard(attempt => { attempts.push(attempt); return false; });
  await userEvent.setup().click(screen.getByRole("link", { name: "日志" }));
  await waitFor(() => expect(attempts).toHaveLength(1));
  expect(screen.getByRole("status")).toHaveTextContent("model-routing");
  expect(location.hash).toBe("#/model-routing");
  // Cancellation is simply not consuming retry; a subsequent navigation replaces that attempt.
  act(() => changeHash("#/settings"));
  expect(attempts).toHaveLength(2);
  act(() => attempts[0].retry());
  expect(location.hash).toBe("#/model-routing");
  act(() => attempts[1].retry());
  expect(screen.getByRole("status")).toHaveTextContent("settings");
  const href = location.href;
  act(() => attempts[1].retry());
  expect(location.href).toBe(href);
  expect(attempts).toHaveLength(2);
});
it("protects browser back and forward before the route unmounts", async () => {
  window.history.replaceState(null, "", "/ui/#/overview");
  window.history.pushState(null, "", "#/model-routing");
  window.history.pushState(null, "", "#/logs");
  window.history.back();
  await waitFor(() => expect(location.hash).toBe("#/model-routing"));
  const { result } = renderHook(useRoute);
  const attempts: RouteNavigation[] = [];
  guard(attempt => { attempts.push(attempt); return false; });
  act(() => window.history.forward());
  await waitFor(() => expect(attempts).toHaveLength(1));
  expect(attempts[0].to).toBe("logs");
  expect(result.current).toBe("model-routing");
  expect(location.hash).toBe("#/model-routing");
  act(() => window.history.back());
  await waitFor(() => expect(location.hash).toBe("#/model-routing"));
  act(() => window.history.back());
  await waitFor(() => expect(attempts).toHaveLength(2));
  expect(attempts[1].to).toBe("overview");
  expect(result.current).toBe("model-routing");
  act(() => attempts[1].retry());
  expect(result.current).toBe("overview");
  expect(location.hash).toBe("#/overview");
});
it("a queued obsolete hash event cannot replace a newer navigation attempt", () => {
  const { result } = renderHook(useRoute);
  const attempts: RouteNavigation[] = [];
  guard(attempt => { attempts.push(attempt); return false; });
  act(() => changeHash("#/logs"));
  act(() => changeHash("#/settings"));
  act(() => fireEvent(window, new HashChangeEvent("hashchange", { oldURL: "http://localhost:3000/ui/#/model-routing", newURL: "http://localhost:3000/ui/#/logs" })));
  expect(attempts).toHaveLength(2);
  act(() => attempts[0].retry()); expect(result.current).toBe("model-routing");
  act(() => attempts[1].retry()); expect(result.current).toBe("settings");
});
it.each(["session", "unregister", "unmount"])("invalidates a held confirmation after %s", reason => {
  const { result, unmount } = renderHook(useRoute);
  let pending!: RouteNavigation;
  const release = guard(attempt => { pending = attempt; return false; });
  act(() => changeHash("#/logs"));
  if (reason === "session") act(() => setSessionToken(null));
  if (reason === "unregister") release();
  if (reason === "unmount") unmount();
  act(() => pending.retry());
  expect(location.hash).toBe("#/model-routing");
  if (reason !== "unmount") expect(result.current).toBe("model-routing");
});
it("confirming one guard still consults other active guards", () => {
  const { result } = renderHook(useRoute);
  let first!: RouteNavigation, second!: RouteNavigation;
  guard(attempt => { first = attempt; return false; });
  guard(attempt => { second = attempt; return false; });
  act(() => changeHash("#/logs"));
  act(() => first.retry());
  expect(result.current).toBe("model-routing");
  expect(second.to).toBe("logs");
  act(() => second.retry());
  expect(result.current).toBe("logs");
});
it("a same-page anchor focuses content without leaving the page or consuming confirmation", () => {
  const { result } = renderHook(useRoute);
  document.body.insertAdjacentHTML("beforeend", '<main id="main-content" tabindex="-1"></main>');
  let pending!: RouteNavigation;
  const callback = vi.fn((attempt: RouteNavigation) => { pending = attempt; return false; });
  guard(callback);
  act(() => changeHash("#/logs"));
  act(() => changeHash("#main-content"));
  expect(callback).toHaveBeenCalledOnce();
  expect(result.current).toBe("model-routing");
  expect(document.activeElement).toBe(document.getElementById("main-content"));
  act(() => pending.retry()); expect(result.current).toBe("logs");
});
it("without a guard, settings internal navigation retains the existing normal behavior", () => {
  window.history.replaceState(null, "", "/ui/#/settings");
  const { result } = renderHook(useRoute);
  act(() => changeHash("#/model-routing"));
  expect(result.current).toBe("model-routing");
  expect(location.hash).toBe("#/model-routing");
});

it("a new destination starts a fresh confirmation chain", () => {
  const { result } = renderHook(useRoute);
  const first: RouteNavigation[] = [], second: RouteNavigation[] = [];
  guard(attempt => { first.push(attempt); return false; });
  guard(attempt => { second.push(attempt); return false; });
  act(() => changeHash("#/logs"));
  act(() => first[0].retry());
  expect(second).toHaveLength(1);
  act(() => changeHash("#/settings"));
  expect(first).toHaveLength(2);
  act(() => second[0].retry()); expect(result.current).toBe("model-routing");
  act(() => first[1].retry());
  expect(second).toHaveLength(2);
  act(() => second[1].retry());
  expect(result.current).toBe("settings");
});
