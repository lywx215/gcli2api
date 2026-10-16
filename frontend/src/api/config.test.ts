import { describe, it, expect, vi } from "vitest";
import { ApiError } from "@/api/client";
import { readSafeConfig, type SafeConfigResponse } from "@/api/config";

function createJsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createValidPayload() {
  return {
    config: {
      host: "127.0.0.1",
      port: 8000,
      proxy: "http://127.0.0.1:7890",
      debug_mode: false,
      routing_mode: "round-robin",
    },
    capabilities: ["antigravity_flash_non_stream", "antigravity_native_timeout"],
    env_locked: ["host", "port"],
    security: {
      node_management_token: "configured",
      embed_policy: { source: "default", locked: false, valid: true },
    },
    secret_fields: {
      api_password: { configured: true },
      panel_password: { configured: false },
      password: { configured: true },
    },
  };
}

function assertApiError(error: unknown): asserts error is ApiError {
  expect(error).toBeInstanceOf(ApiError);
  if (!(error instanceof ApiError)) {
    throw new Error("Expected ApiError");
  }
}

function assertDOMException(error: unknown): asserts error is DOMException {
  expect(error).toBeInstanceOf(DOMException);
  if (!(error instanceof DOMException)) {
    throw new Error("Expected DOMException");
  }
}

function assertAbortError(error: unknown): asserts error is { name: string } {
  expect(typeof error === "object" && error !== null && "name" in error).toBe(true);
  if (typeof error !== "object" || error === null || !("name" in error) || typeof error.name !== "string") {
    throw new Error("Expected error object with string name");
  }
}

describe("readSafeConfig", () => {
  describe("query parameters and endpoint targeting", () => {
    it("calls config/get with query include_secrets=false using GET method", async () => {
      const payload = createValidPayload();
      const fetchMock = vi.fn().mockResolvedValue(createJsonResponse(payload));
      vi.stubGlobal("fetch", fetchMock);

      await readSafeConfig();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [calledUrl, calledInit] = fetchMock.mock.calls[0] as [URL, RequestInit];
      const url = new URL(calledUrl.toString());

      expect(url.pathname).toBe("/config/get");
      expect(url.searchParams.get("include_secrets")).toBe("false");
      expect(url.searchParams.getAll("include_secrets")).toEqual(["false"]);
      expect(calledInit.method).toBe("GET");
    });
  });

  describe("prefix and abort forwarding", () => {
    it("forwards service base prefix in request URL", async () => {
      document.head.innerHTML = '<meta name="gcli-service-base" content="/custom-prefix/">';
      try {
        const payload = createValidPayload();
        const fetchMock = vi.fn().mockResolvedValue(createJsonResponse(payload));
        vi.stubGlobal("fetch", fetchMock);

        await readSafeConfig();

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [calledUrl] = fetchMock.mock.calls[0] as [URL, RequestInit];
        const url = new URL(calledUrl.toString());
        expect(url.pathname).toBe("/custom-prefix/config/get");
        expect(url.searchParams.get("include_secrets")).toBe("false");
      } finally {
        document.head.innerHTML = '<meta name="gcli-service-base" content="/">';
      }
    });

    it("forwards AbortSignal to transport options", async () => {
      const controller = new AbortController();
      const payload = createValidPayload();
      const fetchMock = vi.fn().mockResolvedValue(createJsonResponse(payload));
      vi.stubGlobal("fetch", fetchMock);

      await readSafeConfig(controller.signal);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, calledInit] = fetchMock.mock.calls[0] as [URL, RequestInit];
      expect(calledInit.signal).toBeDefined();
    });

    it("rejects immediately with AbortError if signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const errorPromise = readSafeConfig(controller.signal);
      await expect(errorPromise).rejects.toThrow();
      const err: unknown = await errorPromise.catch((e: unknown) => e);
      assertAbortError(err);
      expect(err.name).toBe("AbortError");
      expect(err).toBe(controller.signal.reason);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("propagates AbortError if aborted during transport execution", async () => {
      const controller = new AbortController();
      const fetchMock = vi.fn().mockImplementation((_url: URL, init: RequestInit) => {
        return new Promise((_, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted", "AbortError"));
          });
          controller.abort();
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const errorPromise = readSafeConfig(controller.signal);
      await expect(errorPromise).rejects.toThrow();
      const err = await errorPromise.catch((e: unknown) => e as DOMException);
      assertDOMException(err);
      expect(err.name).toBe("AbortError");
    });
  });

  describe("valid safe shape projection", () => {
    it("returns projected SafeConfigResponse for valid payload", async () => {
      const payload = createValidPayload();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(createJsonResponse(payload)));

      const result: SafeConfigResponse = await readSafeConfig();

      expect(result).toEqual({
        config: {
          host: "127.0.0.1",
          port: 8000,
          proxy: "http://127.0.0.1:7890",
          debug_mode: false,
          routing_mode: "round-robin",
        },
        capabilities: ["antigravity_flash_non_stream", "antigravity_native_timeout"],
        env_locked: ["host", "port"],
        security: {
          node_management_token: "configured",
          embed_policy: { source: "default", locked: false, valid: true },
        },
        secret_fields: {
          api_password: { configured: true },
          panel_password: { configured: false },
          password: { configured: true },
        },
      });
    });

    it("accepts valid payload when all secret fields are not configured", async () => {
      const payload = createValidPayload();
      payload.secret_fields.api_password.configured = false;
      payload.secret_fields.panel_password.configured = false;
      payload.secret_fields.password.configured = false;
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(createJsonResponse(payload)));

      const result = await readSafeConfig();
      expect(result.secret_fields).toEqual({
        api_password: { configured: false },
        panel_password: { configured: false },
        password: { configured: false },
      });
    });
  });

  describe("poisoned secret key rejection", () => {
    it.each([
      ["api_password string value", { api_password: "sensitive_api_secret" }],
      ["api_password blank string", { api_password: "" }],
      ["panel_password string value", { panel_password: "sensitive_panel_secret" }],
      ["panel_password blank string", { panel_password: "" }],
      ["password string value", { password: "sensitive_master_secret" }],
      ["password blank string", { password: "" }],
      ["password null value", { password: null }],
      ["password false boolean value", { password: false }],
      ["password undefined value", { password: undefined }],
    ])("rejects config containing %s with fixed ApiError(200, null)", async (_, secretEntry) => {
      const payload = createValidPayload();
      Object.assign(payload.config, secretEntry);
      const response = createJsonResponse(payload);
      vi.spyOn(response, "json").mockResolvedValue(payload);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

      const errorPromise = readSafeConfig();
      await expect(errorPromise).rejects.toThrow();
      const err = await errorPromise.catch((e: unknown) => e as ApiError);

      assertApiError(err);
      expect(err.status).toBe(200);
      expect(err.payload).toBeNull();

      for (const val of Object.values(secretEntry)) {
        if (typeof val === "string" && val.length > 0) {
          expect(err.message).not.toContain(val);
        }
      }
    });

    it("accepts payload when undefined password is omitted by JSON serialization", async () => {
      const payload = createValidPayload();
      Object.assign(payload.config, { password: undefined });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(createJsonResponse(payload)));

      const result = await readSafeConfig();
      expect("password" in result.config).toBe(false);
      expect(result.config.host).toBe("127.0.0.1");
    });
  });

  describe("malformed data envelope rejection", () => {
    it.each([
      ["null response", null],
      ["array response", []],
      ["string response", "malformed response body"],
      ["number response", 42],
      ["missing config", { ...createValidPayload(), config: null }],
      ["array config", { ...createValidPayload(), config: [] }],
      ["string config", { ...createValidPayload(), config: "invalid" }],
      ["non-array capabilities", { ...createValidPayload(), capabilities: "flash" }],
      ["capabilities with non-string elements", { ...createValidPayload(), capabilities: [123, "flash"] }],
      ["capabilities with null element", { ...createValidPayload(), capabilities: [null] }],
      ["null env_locked", { ...createValidPayload(), env_locked: null }],
      ["non-array env_locked", { ...createValidPayload(), env_locked: "host" }],
      ["env_locked with non-string element", { ...createValidPayload(), env_locked: ["host", 1] }],
      ["null security object", { ...createValidPayload(), security: null }],
      ["array security object", { ...createValidPayload(), security: [] }],
      ["string security", { ...createValidPayload(), security: "secure" }],
      ["missing secret_fields", { ...createValidPayload(), secret_fields: null }],
      ["array secret_fields", { ...createValidPayload(), secret_fields: [] }],
      [
        "secret_fields missing api_password",
        {
          ...createValidPayload(),
          secret_fields: {
            panel_password: { configured: false },
            password: { configured: true },
          },
        },
      ],
      [
        "secret_fields missing panel_password",
        {
          ...createValidPayload(),
          secret_fields: {
            api_password: { configured: true },
            password: { configured: true },
          },
        },
      ],
      [
        "secret_fields missing password",
        {
          ...createValidPayload(),
          secret_fields: {
            api_password: { configured: true },
            panel_password: { configured: false },
          },
        },
      ],
      [
        "secret_fields configured as string",
        {
          ...createValidPayload(),
          secret_fields: {
            api_password: { configured: "true" },
            panel_password: { configured: false },
            password: { configured: true },
          },
        },
      ],
      [
        "secret_fields configured as number",
        {
          ...createValidPayload(),
          secret_fields: {
            api_password: { configured: 1 },
            panel_password: { configured: false },
            password: { configured: true },
          },
        },
      ],
      [
        "secret_fields configured as null",
        {
          ...createValidPayload(),
          secret_fields: {
            api_password: { configured: null },
            panel_password: { configured: false },
            password: { configured: true },
          },
        },
      ],
      [
        "secret_fields item is not an object",
        {
          ...createValidPayload(),
          secret_fields: {
            api_password: true,
            panel_password: { configured: false },
            password: { configured: true },
          },
        },
      ],
      [
        "secret_fields item missing configured property",
        {
          ...createValidPayload(),
          secret_fields: {
            api_password: {},
            panel_password: { configured: false },
            password: { configured: true },
          },
        },
      ],
    ])("rejects %s with fixed ApiError(200, null)", async (_, malformedData) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(createJsonResponse(malformedData)));

      const errorPromise = readSafeConfig();
      await expect(errorPromise).rejects.toThrow();
      const err = await errorPromise.catch((e: unknown) => e as ApiError);

      assertApiError(err);
      expect(err.status).toBe(200);
      expect(err.payload).toBeNull();
    });
  });

  describe("transport and API error provenance", () => {
    it("preserves 401 ApiError provenance with structured payload", async () => {
      const errorPayload = { detail: "Not authenticated" };
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(createJsonResponse(errorPayload, 401)));

      const errorPromise = readSafeConfig();
      await expect(errorPromise).rejects.toThrow();
      const err = await errorPromise.catch((e: unknown) => e as ApiError);

      assertApiError(err);
      expect(err.status).toBe(401);
      expect(err.payload).toEqual(errorPayload);
    });

    it("preserves 403 ApiError provenance with structured payload", async () => {
      const errorPayload = { detail: "密码错误" };
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(createJsonResponse(errorPayload, 403)));

      const errorPromise = readSafeConfig();
      await expect(errorPromise).rejects.toThrow();
      const err = await errorPromise.catch((e: unknown) => e as ApiError);

      assertApiError(err);
      expect(err.status).toBe(403);
      expect(err.payload).toEqual(errorPayload);
    });

    it("preserves 500 ApiError provenance with payload", async () => {
      const errorPayload = { detail: "Internal Server Error" };
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(createJsonResponse(errorPayload, 500)));

      const errorPromise = readSafeConfig();
      await expect(errorPromise).rejects.toThrow();
      const err = await errorPromise.catch((e: unknown) => e as ApiError);

      assertApiError(err);
      expect(err.status).toBe(500);
      expect(err.payload).toEqual(errorPayload);
    });

    it("preserves network transport rejection provenance", async () => {
      const networkError = new TypeError("Failed to fetch");
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(networkError));

      await expect(readSafeConfig()).rejects.toThrow(networkError);
    });
  });

  describe("absence of caching and storage persistence", () => {
    it("executes distinct transport requests and never persists to browser storage", async () => {
      const payloadA = createValidPayload();
      payloadA.config.host = "10.0.0.1";
      const payloadB = createValidPayload();
      payloadB.config.host = "10.0.0.2";

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(createJsonResponse(payloadA))
        .mockResolvedValueOnce(createJsonResponse(payloadB));
      vi.stubGlobal("fetch", fetchMock);

      const resA = await readSafeConfig();
      const resB = await readSafeConfig();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(resA.config.host).toBe("10.0.0.1");
      expect(resB.config.host).toBe("10.0.0.2");

      expect(window.localStorage.getItem("gcli2api_safe_config")).toBeNull();
      expect(window.sessionStorage.getItem("gcli2api_safe_config")).toBeNull();
    });
  });
});
