import { describe, expect, it, vi } from "vitest";
import {
  getStrictLegacyTab,
  getLegacyStartupRedirectUrl,
  maybeRedirectLegacyStartup,
} from "./legacyEntry";

describe("legacyEntry", () => {
  it("identifies strict legacy tabs with optional slashes", () => {
    expect(getStrictLegacyTab("#upload")).toBe("upload");
    expect(getStrictLegacyTab("#/upload")).toBe("upload");
    expect(getStrictLegacyTab("#upload/")).toBe("upload");
    expect(getStrictLegacyTab("#/upload/")).toBe("upload");
    expect(getStrictLegacyTab("#status")).toBe("status");
    expect(getStrictLegacyTab("#/status")).toBe("status");
    expect(getStrictLegacyTab("#status/")).toBe("status");
    expect(getStrictLegacyTab("#/status/")).toBe("status");
    expect(getStrictLegacyTab("#about")).toBe("about");
    expect(getStrictLegacyTab("#/about")).toBe("about");
    expect(getStrictLegacyTab("#about/")).toBe("about");
    expect(getStrictLegacyTab("#/about/")).toBe("about");
  });

  it("does not match new routes, aliases, unknown hashes, or empty hash", () => {
    expect(getStrictLegacyTab("")).toBeNull();
    expect(getStrictLegacyTab("#")).toBeNull();
    expect(getStrictLegacyTab("#/")).toBeNull();
    expect(getStrictLegacyTab("#/overview")).toBeNull();
    expect(getStrictLegacyTab("#/credentials")).toBeNull();
    expect(getStrictLegacyTab("#/import")).toBeNull();
    expect(getStrictLegacyTab("#/settings")).toBeNull();
    expect(getStrictLegacyTab("#/logs")).toBeNull();
    expect(getStrictLegacyTab("#/model-routing")).toBeNull();
    expect(getStrictLegacyTab("#manage")).toBeNull();
    expect(getStrictLegacyTab("#antigravity-manage")).toBeNull();
    expect(getStrictLegacyTab("#oauth")).toBeNull();
    expect(getStrictLegacyTab("#antigravity")).toBeNull();
    expect(getStrictLegacyTab("#config")).toBeNull();
    expect(getStrictLegacyTab("#/unknown")).toBeNull();
  });

  it("constructs prefix-safe same-origin legacy URL preserving page query and hash tab", () => {
    const loc = {
      origin: "http://localhost:3000",
      search: "?source=bookmark&mode=test",
      hash: "#upload",
    };
    const redirectUrl = getLegacyStartupRedirectUrl(loc);
    expect(redirectUrl).toBe("http://localhost:3000/legacy?source=bookmark&mode=test#upload");
  });

  it("normalizes slash variants of strict legacy tab to exact tab hash", () => {
    const loc = {
      origin: "http://localhost:3000",
      search: "",
      hash: "#/status/",
    };
    const redirectUrl = getLegacyStartupRedirectUrl(loc);
    expect(redirectUrl).toBe("http://localhost:3000/legacy#status");
  });

  it("returns null for non-legacy locations", () => {
    const loc = {
      origin: "http://localhost:3000",
      search: "",
      hash: "#/credentials",
    };
    expect(getLegacyStartupRedirectUrl(loc)).toBeNull();
  });

  it("maybeRedirectLegacyStartup triggers location.replace on match and returns true", () => {
    const replaceMock = vi.fn();
    const loc = {
      origin: "http://localhost:3000",
      search: "?foo=bar",
      hash: "#/about",
      replace: replaceMock,
    };
    const result = maybeRedirectLegacyStartup(loc);
    expect(result).toBe(true);
    expect(replaceMock).toHaveBeenCalledWith("http://localhost:3000/legacy?foo=bar#about");
  });

  it("maybeRedirectLegacyStartup is inert on non-matching locations and returns false", () => {
    const replaceMock = vi.fn();
    const loc = {
      origin: "http://localhost:3000",
      search: "",
      hash: "#/settings",
      replace: replaceMock,
    };
    const result = maybeRedirectLegacyStartup(loc);
    expect(result).toBe(false);
    expect(replaceMock).not.toHaveBeenCalled();
  });
});
