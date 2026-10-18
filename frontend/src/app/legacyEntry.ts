import { getServiceBase } from "@/api/client";

const STRICT_LEGACY_TABS = new Set(["upload", "status", "about"]);

/**
 * Checks whether a hash represents a strict legacy-only fragment.
 * Supports optional leading/trailing slashes (e.g., #upload, #/upload, #upload/, #/upload/).
 */
export function getStrictLegacyTab(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const queryIndex = raw.indexOf("?");
  const pathPart = queryIndex === -1 ? raw : raw.slice(0, queryIndex);
  const cleaned = pathPart.replace(/^\/+/, "");
  const tab = cleaned.endsWith("/") ? cleaned.slice(0, -1) : cleaned;
  return STRICT_LEGACY_TABS.has(tab) ? tab : null;
}

/**
 * Resolves the same-origin legacy URL for strict legacy-only startup fragments,
 * preserving the original search query and hash tab. Returns null if the location
 * should not be redirected.
 */
export function getLegacyStartupRedirectUrl(
  loc?: { origin: string; search: string; hash: string }
): string | null {
  if (typeof window === "undefined" && !loc) {
    return null;
  }
  const targetLoc = loc ?? window.location;
  const tab = getStrictLegacyTab(targetLoc.hash);
  if (!tab) {
    return null;
  }

  try {
    const base = getServiceBase();
    const target = new URL("legacy", base);
    // Ensure same-origin to prevent any open redirect
    if (target.origin !== targetLoc.origin) {
      return null;
    }
    target.search = targetLoc.search;
    target.hash = tab;
    return target.href;
  } catch {
    return null;
  }
}

/**
 * Safely redirects the browser using location.replace before router initialization
 * if a strict legacy-only startup fragment is detected.
 * Returns true if a redirect was triggered, false otherwise.
 */
export function maybeRedirectLegacyStartup(
  loc?: { origin: string; search: string; hash: string; replace: (url: string) => void }
): boolean {
  if (typeof window === "undefined" && !loc) {
    return false;
  }
  const targetLoc = loc ?? (window.location as unknown as { origin: string; search: string; hash: string; replace: (url: string) => void });
  const redirectUrl = getLegacyStartupRedirectUrl(targetLoc);
  if (!redirectUrl) {
    return false;
  }
  try {
    targetLoc.replace(redirectUrl);
    return true;
  } catch {
    return false;
  }
}
