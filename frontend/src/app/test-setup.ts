import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { setSessionToken } from "@/auth/session";
beforeEach(() => {
  document.head.innerHTML = '<meta name="gcli-service-base" content="/">';
  window.localStorage.clear();
  setSessionToken(null);
  vi.stubEnv("VITE_UI_FIXTURES", "false");
  // Every test must explicitly opt into a synthetic response. No live backend calls.
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Unexpected test request"))));
});
afterEach(() => { cleanup(); });
