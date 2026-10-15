import { afterEach, describe, expect, it, vi } from "vitest";
import { setSessionToken, __setSessionValidationStatus, getSessionSnapshot } from "@/auth/session";
import { __commitPanelChannel, capturePanelScope } from "@/domain/panel";
import { ApiError } from "@/api/client";
import { createAdvancedCredentialApi } from "./advancedApi";

function setupVerifiedContext(mode: "antigravity" | "geminicli") {
  __commitPanelChannel(mode);
  setSessionToken("synthetic-test-token", false);
  const session = getSessionSnapshot();
  const scope = capturePanelScope(session.sessionEpoch);
  return { mode, scope, session };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Happy contracts parameterized", () => {
  it.each([
    {
      filename: "account.json",
      expectedPath: "http://localhost:3000/creds/configure-preview/account.json?mode=geminicli",
      writeback: { status: "applied" },
      expectedUpdates: [{ name: "preview", status: "applied" }],
    },
    {
      filename: "user#1%20 test.json",
      expectedPath: "http://localhost:3000/creds/configure-preview/user%231%2520%20test.json?mode=geminicli",
      writeback: { status: "failed", reason: "state_update_failed" },
      expectedUpdates: [{ name: "preview", status: "failed" }],
    },
    {
      filename: "plain.json",
      expectedPath: "http://localhost:3000/creds/configure-preview/plain.json?mode=geminicli",
      writeback: undefined,
      expectedUpdates: [{ name: "preview", status: "unknown" }],
    },
  ])(
    "GCLI Preview exact encoded path/mode/POST/no body and writeback %j",
    async ({ filename, expectedPath, writeback, expectedUpdates }) => {
      const { mode, scope } = setupVerifiedContext("geminicli");
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            preview: true,
            ...(writeback ? { state_update: { preview: writeback } } : {}),
          }),
          { status: 200 }
        )
      );
      vi.stubGlobal("fetch", mockFetch);

      const api = createAdvancedCredentialApi(mode, scope);
      const result = await api.configurePreview(filename);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [calledUrl, calledInit] = mockFetch.mock.calls[0];
      expect(calledUrl.toString()).toBe(expectedPath);
      expect(calledInit.method).toBe("POST");
      expect(calledInit.body).toBeUndefined();
      expect(result.success).toBe(true);
      expect(result.data.filename).toBe(filename);
      expect(result.data.preview).toBe(true);
      expect(result.data.state_update.preview.status).toBe(expectedUpdates[0].status);
      expect(result.updates).toEqual(expectedUpdates);
    }
  );

  it.each([
    { group: "claude-gpt-shared" },
    { group: "gemini-shared" },
    { group: "valid-canonical-custom-group" },
  ])("AG release exact raw filename/action/group body for %s", async ({ group }) => {
    const { mode, scope } = setupVerifiedContext("antigravity");
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          quota_group_states: {
            [group]: { state: "manual_override", revision: 2 },
            "other-group": { state: "blocked_unknown", revision: 1 },
          },
          model_cooldowns: {
            "claude-3-7-sonnet": 1780000000,
          },
          quota_groups: {
            [group]: { cooldownUntil: 1780000000 },
          },
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", mockFetch);

    const api = createAdvancedCredentialApi(mode, scope);
    const filename = "my-account#1%20.json";
    const result = await api.releaseQuotaGroup(filename, group);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = mockFetch.mock.calls[0];
    expect(calledUrl.toString()).toBe("http://localhost:3000/creds/action?mode=antigravity");
    expect(calledInit.method).toBe("POST");
    expect(JSON.parse(calledInit.body as string)).toEqual({
      filename: "my-account#1%20.json",
      action: "release_quota_group",
      group,
    });
    expect(result.success).toBe(true);
    expect(result.data.filename).toBe(filename);
    expect(result.data.group).toBe(group);
    expect(result.data.quota_group_states?.[group]).toEqual({ state: "manual_override", revision: 2 });
    expect(result.data.quota_group_states?.["other-group"]).toEqual({ state: "blocked_unknown", revision: 1 });
    expect(result.data.model_cooldowns?.["claude-3-7-sonnet"]).toBe(1780000000);
    expect(result.data.quota_groups?.[group]).toEqual({ cooldownUntil: 1780000000 });
  });

  it("rejects opposite channel before transport with 0 fetch calls", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const agCtx = setupVerifiedContext("antigravity");
    const agApi = createAdvancedCredentialApi(agCtx.mode, agCtx.scope);
    await expect(agApi.configurePreview("a.json")).rejects.toThrow("当前渠道不支持此操作。");

    const gcliCtx = setupVerifiedContext("geminicli");
    const gcliApi = createAdvancedCredentialApi(gcliCtx.mode, gcliCtx.scope);
    await expect(gcliApi.releaseQuotaGroup("a.json", "gemini-shared")).rejects.toThrow("当前渠道不支持此操作。");

    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it.each([
    "",
    "   ",
    ".json",
    "..json",
    "...json",
    "../foo.json",
    "foo/bar.json",
    "foo\\bar.json",
    "noextension",
    "bad\x00char.json",
    "bad\x1fchar.json",
  ])("rejects malformed filename %j before transport with 0 fetch calls", async (badFilename) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const gcliCtx = setupVerifiedContext("geminicli");
    const gcliApi = createAdvancedCredentialApi(gcliCtx.mode, gcliCtx.scope);
    await expect(gcliApi.configurePreview(badFilename)).rejects.toThrow("文件名无效。");

    const agCtx = setupVerifiedContext("antigravity");
    const agApi = createAdvancedCredentialApi(agCtx.mode, agCtx.scope);
    await expect(agApi.releaseQuotaGroup(badFilename, "gemini-shared")).rejects.toThrow("文件名无效。");

    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it.each([
    "",
    "a".repeat(201),
    "group\x00bad",
    "group\x1fbad",
  ])("rejects malformed group %j before transport with 0 fetch calls", async (badGroup) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const agCtx = setupVerifiedContext("antigravity");
    const agApi = createAdvancedCredentialApi(agCtx.mode, agCtx.scope);
    await expect(agApi.releaseQuotaGroup("valid.json", badGroup)).rejects.toThrow("额度组无效。");

    expect(fetchMock).toHaveBeenCalledTimes(0);
  });
});

describe("Real owner lifecycle", () => {
  it("cloned caller scope cannot be mutated to retarget bound copy", async () => {
    const { mode, scope } = setupVerifiedContext("geminicli");
    const mutableScope = { ...scope };
    const api = createAdvancedCredentialApi(mode, mutableScope);

    (mutableScope as { mode: "antigravity" | "geminicli"; channelEpoch: number; sessionEpoch: number }).mode = "antigravity";
    (mutableScope as { mode: "antigravity" | "geminicli"; channelEpoch: number; sessionEpoch: number }).channelEpoch = 999;
    (mutableScope as { mode: "antigravity" | "geminicli"; channelEpoch: number; sessionEpoch: number }).sessionEpoch = 999;

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, preview: true }), { status: 200 })
    );
    vi.stubGlobal("fetch", mockFetch);

    const result = await api.configurePreview("test.json");
    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const calledUrl = mockFetch.mock.calls[0][0].toString();
    expect(calledUrl).toContain("mode=geminicli");
  });

  it("same-Scope pending/unavailable->verified permanently rejects old adapter, fresh adapter works", async () => {
    __commitPanelChannel("geminicli");
    setSessionToken("pending-token", false, { requiresValidation: true });
    const session = getSessionSnapshot();
    const scope = capturePanelScope(session.sessionEpoch);

    const oldApi = createAdvancedCredentialApi("geminicli", scope);

    const verifiedOk = __setSessionValidationStatus(session.sessionEpoch, "verified");
    expect(verifiedOk).toBe(true);

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, preview: true }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(oldApi.configurePreview("test.json")).rejects.toSatisfy((err: unknown) => {
      return err instanceof DOMException && err.name === "AbortError";
    });
    expect(fetchMock).toHaveBeenCalledTimes(0);

    const freshApi = createAdvancedCredentialApi("geminicli", scope);
    const result = await freshApi.configurePreview("test.json");
    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["pending", "unavailable"] as const)(
    "real verified->%s->verified with unchanged Scope3 rejects old adapter and rejects deferred transport",
    async (intermediateStatus) => {
      const { mode, scope, session } = setupVerifiedContext("geminicli");
      const oldApi = createAdvancedCredentialApi(mode, scope);

      let resolveFetch!: (val: Response) => void;
      const deferredFetch = vi.fn().mockImplementation(
        () => new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
      );
      vi.stubGlobal("fetch", deferredFetch);

      const controller = new AbortController();
      const deferredPromise = oldApi.configurePreview("test.json", controller.signal);
      expect(deferredFetch).toHaveBeenCalledTimes(1);

      const setIntermediateOk = __setSessionValidationStatus(session.sessionEpoch, intermediateStatus);
      expect(setIntermediateOk).toBe(true);

      const setRestoredOk = __setSessionValidationStatus(session.sessionEpoch, "verified");
      expect(setRestoredOk).toBe(true);

      resolveFetch(
        new Response(
          JSON.stringify({ success: true, preview: true, sensitive_canary: "leak" }),
          { status: 200 }
        )
      );

      await expect(deferredPromise).rejects.toSatisfy((err: unknown) => {
        return err instanceof DOMException && err.name === "AbortError";
      });

      await expect(oldApi.configurePreview("test.json")).rejects.toSatisfy((err: unknown) => {
        return err instanceof DOMException && err.name === "AbortError";
      });

      deferredFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, preview: true }), { status: 200 })
      );
      const freshApi = createAdvancedCredentialApi(mode, scope);
      const result = await freshApi.configurePreview("test.json");
      expect(result.success).toBe(true);
      expect(result.data.preview).toBe(true);
    }
  );

  it("channel ABA permanently invalidates old adapter", async () => {
    const { mode, scope } = setupVerifiedContext("geminicli");
    const api = createAdvancedCredentialApi(mode, scope);

    __commitPanelChannel("antigravity");
    __commitPanelChannel("geminicli");

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.configurePreview("test.json")).rejects.toSatisfy((err: unknown) => {
      return err instanceof DOMException && err.name === "AbortError";
    });
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("session replacement invalidates old adapter", async () => {
    const { mode, scope } = setupVerifiedContext("geminicli");
    const api = createAdvancedCredentialApi(mode, scope);

    setSessionToken("new-token", false);

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.configurePreview("test.json")).rejects.toSatisfy((err: unknown) => {
      return err instanceof DOMException && err.name === "AbortError";
    });
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("pre-aborted caller signal rejects without fetch", async () => {
    const { mode, scope } = setupVerifiedContext("geminicli");
    const api = createAdvancedCredentialApi(mode, scope);

    const controller = new AbortController();
    controller.abort();

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.configurePreview("test.json", controller.signal)).rejects.toSatisfy((err: unknown) => {
      return err instanceof DOMException && err.name === "AbortError";
    });
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("deferred fetch that ignores abort rejects without exposing results", async () => {
    const { mode, scope } = setupVerifiedContext("geminicli");
    const api = createAdvancedCredentialApi(mode, scope);

    let resolveFetch!: (val: Response) => void;
    const deferredFetch = vi.fn().mockImplementation(() => new Promise((resolve) => {
      resolveFetch = resolve;
    }));
    vi.stubGlobal("fetch", deferredFetch);

    const controller = new AbortController();
    const promise = api.configurePreview("test.json", controller.signal);

    expect(deferredFetch).toHaveBeenCalledTimes(1);

    controller.abort();

    resolveFetch(new Response(JSON.stringify({ success: true, preview: true, sensitive_canary: "leak" }), { status: 200 }));

    await expect(promise).rejects.toSatisfy((err: unknown) => {
      return err instanceof DOMException && err.name === "AbortError";
    });
  });

  it("deferred fetch during session invalidation rejects without exposing results", async () => {
    const { mode, scope } = setupVerifiedContext("antigravity");
    const api = createAdvancedCredentialApi(mode, scope);

    let resolveFetch!: (val: Response) => void;
    const deferredFetch = vi.fn().mockImplementation(() => new Promise((resolve) => {
      resolveFetch = resolve;
    }));
    vi.stubGlobal("fetch", deferredFetch);

    const promise = api.releaseQuotaGroup("test.json", "claude-gpt-shared");
    expect(deferredFetch).toHaveBeenCalledTimes(1);

    const session = getSessionSnapshot();
    __setSessionValidationStatus(session.sessionEpoch, "unavailable");

    resolveFetch(new Response(JSON.stringify({ success: true }), { status: 200 }));

    await expect(promise).rejects.toSatisfy((err: unknown) => {
      return err instanceof DOMException && err.name === "AbortError";
    });
  });
});

describe("Safe projection and failure", () => {
  it("HTTP200 malformed/inherited success/preview fields cannot establish success", async () => {
    const { mode, scope } = setupVerifiedContext("geminicli");
    const api = createAdvancedCredentialApi(mode, scope);

    const inheritedBody = Object.create({ success: true, preview: true });
    const mockResponse = new Response("{}", { status: 200 });
    vi.spyOn(mockResponse, "json").mockResolvedValue(inheritedBody);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const result = await api.configurePreview("test.json");
    expect(result.success).toBe(false);
    expect(result.data.success).toBe(false);
    expect(result.data.preview).toBe(false);
  });

  it("HTTP200 inherited release fields cannot establish success and preserve restriction", async () => {
    const { mode, scope } = setupVerifiedContext("antigravity");
    const api = createAdvancedCredentialApi(mode, scope);

    const stateVal = Object.create({ revision: 1 });
    stateVal.state = "manual_override";

    const inheritedReleaseBody = Object.create({ success: true });
    inheritedReleaseBody.success = true;
    inheritedReleaseBody.quota_group_states = {
      "claude-gpt-shared": stateVal,
    };
    inheritedReleaseBody.quota_groups = {
      "claude-gpt-shared": Object.create({ cooldownUntil: 1780000000 }),
    };

    const mockResponse = new Response("{}", { status: 200 });
    vi.spyOn(mockResponse, "json").mockResolvedValue(inheritedReleaseBody);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const result = await api.releaseQuotaGroup("test.json", "claude-gpt-shared");
    expect(result.success).toBe(false);
    expect(result.data.success).toBe(false);
    expect(result.data.quota_state_invalid).toBe(true);
    expect(result.data.quota_group_states?.["claude-gpt-shared"]?.state).toBe("manual_override");
    expect(result.data.quota_group_states?.["claude-gpt-shared"]?.revision).toBeUndefined();
    expect(result.data.quota_groups?.["claude-gpt-shared"]?.cooldownUntil).toBeUndefined();
  });

  it("false and error flags retained as safe failure", async () => {
    const { mode, scope } = setupVerifiedContext("geminicli");
    const api = createAdvancedCredentialApi(mode, scope);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        success: true,
        preview: true,
        error: "some_internal_error",
      }), { status: 200 })
    ));

    const result = await api.configurePreview("test.json");
    expect(result.success).toBe(false);
    expect(result.data.success).toBe(false);
    expect(result.data.error).toBe("request_failed");
  });

  it("unknown keys and nested token/error canaries never appear in results", async () => {
    const { mode, scope } = setupVerifiedContext("antigravity");
    const api = createAdvancedCredentialApi(mode, scope);

    const canaryPayload = {
      success: true,
      canary_secret_key: "CANARY_123456",
      auth_token: "CANARY_TOKEN",
      quota_credential_generation: 99,
      message: "CANARY_MESSAGE",
      quota_group_states: {
        "claude-gpt-shared": {
          state: "manual_override",
          revision: 1,
          nested_canary: "CANARY_NESTED",
        },
      },
      model_cooldowns: {
        "claude-3-7-sonnet": 1780000000,
      },
      quota_groups: {
        "claude-gpt-shared": {
          cooldownUntil: 1780000000,
          blockedUnknown: true,
          restricted: false,
          canary_prop: "CANARY_PROP",
        },
      },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify(canaryPayload), { status: 200 })
    ));

    const result = await api.releaseQuotaGroup("test.json", "claude-gpt-shared");
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("CANARY");
    expect(result.data).not.toHaveProperty("canary_secret_key");
    expect(result.data).not.toHaveProperty("auth_token");
    expect(result.data).not.toHaveProperty("quota_credential_generation");
    expect(result.data.quota_group_states?.["claude-gpt-shared"]).toEqual({
      state: "manual_override",
      revision: 1,
    });
    expect(result.data.quota_groups?.["claude-gpt-shared"]).toEqual({
      cooldownUntil: 1780000000,
    });
  });

  it("HTTP409 stays safe failed status and strips canaries/payload", async () => {
    const { mode, scope } = setupVerifiedContext("antigravity");
    const api = createAdvancedCredentialApi(mode, scope);

    const canaryErrorPayload = {
      detail: "CANARY_409_DETAIL",
      canary_token: "CANARY_TOKEN_SECRET",
      message: "session abort 作用域 会话 CANARY",
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify(canaryErrorPayload), { status: 409 })
    ));

    await expect(api.releaseQuotaGroup("test.json", "claude-gpt-shared")).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(409);
      expect(apiErr.payload).toBeNull();
      expect(apiErr.message).not.toContain("CANARY");
      expect(apiErr.message).toContain("409");
      return true;
    });
  });

  it("unknown error messages containing session/abort/作用域 are stripped", async () => {
    const { mode, scope } = setupVerifiedContext("geminicli");
    const api = createAdvancedCredentialApi(mode, scope);

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("session timeout abort CANARY_MSG 作用域已失效 会话")));

    await expect(api.configurePreview("test.json")).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(Error);
      const standardErr = err as Error;
      expect(standardErr.message).not.toContain("CANARY");
      expect(standardErr.message).toBe("操作未完成，请重试。");
      return true;
    });
  });

  it("malformed timers and states mark quota_state_invalid and do not establish success", async () => {
    const { mode, scope } = setupVerifiedContext("antigravity");
    const api = createAdvancedCredentialApi(mode, scope);

    const malformedPayload = {
      success: true,
      model_cooldowns: {
        "bad-model": -500,
      },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify(malformedPayload), { status: 200 })
    ));

    const result = await api.releaseQuotaGroup("test.json", "claude-gpt-shared");
    expect(result.success).toBe(false);
    expect(result.data.success).toBe(false);
    expect(result.data.quota_state_invalid).toBe(true);
    expect(result.data.error).toBe("invalid_state");
  });

  it("missing optional evidence is unknown and never zero cooldown fabricated", async () => {
    const { mode, scope } = setupVerifiedContext("antigravity");
    const api = createAdvancedCredentialApi(mode, scope);

    const partialPayload = {
      success: true,
      quota_groups: {
        "claude-gpt-shared": {},
      },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify(partialPayload), { status: 200 })
    ));

    const result = await api.releaseQuotaGroup("test.json", "claude-gpt-shared");
    expect(result.success).toBe(true);
    expect(result.data.quota_groups?.["claude-gpt-shared"]).toEqual({});
    expect(result.data.quota_groups?.["claude-gpt-shared"]?.cooldownUntil).toBeUndefined();
    expect(result.data.quota_group_states).toBeUndefined();
    expect(result.data.model_cooldowns).toBeUndefined();
  });

  it.each([
    {
      name: "missing revision",
      states: { "claude-gpt-shared": { state: "manual_override" } },
    },
    {
      name: "inherited revision",
      states: {
        "claude-gpt-shared": Object.assign(Object.create({ revision: 2 }), { state: "manual_override" }),
      },
    },
    {
      name: "negative revision",
      states: { "claude-gpt-shared": { state: "manual_override", revision: -1 } },
    },
    {
      name: "zero revision",
      states: { "claude-gpt-shared": { state: "manual_override", revision: 0 } },
    },
    {
      name: "non-integer revision",
      states: { "claude-gpt-shared": { state: "manual_override", revision: 1.5 } },
    },
  ])("quota_group_states with $name makes evidence invalid and preserves restriction", async ({ states }) => {
    const { mode, scope } = setupVerifiedContext("antigravity");
    const api = createAdvancedCredentialApi(mode, scope);

    const mockResponse = new Response("{}", { status: 200 });
    vi.spyOn(mockResponse, "json").mockResolvedValue({
      success: true,
      quota_group_states: states,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const result = await api.releaseQuotaGroup("test.json", "claude-gpt-shared");
    expect(result.success).toBe(false);
    expect(result.data.success).toBe(false);
    expect(result.data.quota_state_invalid).toBe(true);
    expect(result.data.error).toBe("invalid_state");
    expect(result.data.quota_group_states?.["claude-gpt-shared"]?.state).toBe("manual_override");
  });

  it.each([
    { name: "null cooldownUntil", cooldown: null },
    { name: "undefined cooldownUntil", cooldown: undefined },
    { name: "negative cooldownUntil", cooldown: -50 },
    { name: "NaN cooldownUntil", cooldown: NaN },
    { name: "out of Date range cooldownUntil", cooldown: 1e16 },
  ])("explicit $name makes evidence invalid against honest absent optional fields", async ({ cooldown }) => {
    const { mode, scope } = setupVerifiedContext("antigravity");
    const api = createAdvancedCredentialApi(mode, scope);

    const mockResponse = new Response("{}", { status: 200 });
    vi.spyOn(mockResponse, "json").mockResolvedValue({
      success: true,
      quota_groups: {
        "claude-gpt-shared": { cooldownUntil: cooldown },
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const result = await api.releaseQuotaGroup("test.json", "claude-gpt-shared");
    expect(result.success).toBe(false);
    expect(result.data.success).toBe(false);
    expect(result.data.quota_state_invalid).toBe(true);
    expect(result.data.error).toBe("invalid_state");
  });
});

describe("Canary and error sanitization boundaries", () => {
  it("caller-supplied DOMException AbortError with canary at entry emits fresh safe AbortError", async () => {
    const { mode, scope } = setupVerifiedContext("geminicli");
    const api = createAdvancedCredentialApi(mode, scope);

    const canaryErr = new DOMException("CANARY_MESSAGE_ENTRY", "AbortError");
    (canaryErr as unknown as Record<string, unknown>).cause = "CANARY_CAUSE_ENTRY";
    (canaryErr as unknown as Record<string, unknown>).payload = { leak: "CANARY_PAYLOAD_ENTRY" };
    (canaryErr as unknown as Record<string, unknown>).secret = "CANARY_SECRET_ENTRY";

    const controller = new AbortController();
    controller.abort(canaryErr);

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    try {
      await api.configurePreview("test.json", controller.signal);
      expect.unreachable("should have thrown");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(DOMException);
      expect(err).not.toBe(canaryErr);
      const domErr = err as DOMException;
      expect(domErr.name).toBe("AbortError");
      expect(domErr.message).toBe("操作已取消。");
      expect(String(err)).not.toContain("CANARY");
      expect((err as Error).stack ?? "").not.toContain("CANARY");
      expect((err as unknown as Record<string, unknown>).cause).toBeUndefined();
      expect((err as unknown as Record<string, unknown>).payload).toBeUndefined();
      expect((err as unknown as Record<string, unknown>).secret).toBeUndefined();
      expect(JSON.stringify(err)).not.toContain("CANARY");
    }
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("caller-supplied DOMException AbortError with canary at late abort emits fresh safe AbortError", async () => {
    const { mode, scope } = setupVerifiedContext("geminicli");
    const api = createAdvancedCredentialApi(mode, scope);

    let resolveFetch!: (val: Response) => void;
    const deferredFetch = vi.fn().mockImplementation(
      () => new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      })
    );
    vi.stubGlobal("fetch", deferredFetch);

    const canaryErr = new DOMException("CANARY_MESSAGE_LATE", "AbortError");
    (canaryErr as unknown as Record<string, unknown>).cause = "CANARY_CAUSE_LATE";
    (canaryErr as unknown as Record<string, unknown>).payload = { leak: "CANARY_PAYLOAD_LATE" };
    (canaryErr as unknown as Record<string, unknown>).secret = "CANARY_SECRET_LATE";

    const controller = new AbortController();
    const promise = api.configurePreview("test.json", controller.signal);
    expect(deferredFetch).toHaveBeenCalledTimes(1);

    controller.abort(canaryErr);
    resolveFetch(new Response(JSON.stringify({ success: true, preview: true }), { status: 200 }));

    try {
      await promise;
      expect.unreachable("should have thrown");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(DOMException);
      expect(err).not.toBe(canaryErr);
      const domErr = err as DOMException;
      expect(domErr.name).toBe("AbortError");
      expect(domErr.message).not.toContain("CANARY");
      expect(String(err)).not.toContain("CANARY");
      expect((err as Error).stack ?? "").not.toContain("CANARY");
      expect((err as unknown as Record<string, unknown>).cause).toBeUndefined();
      expect((err as unknown as Record<string, unknown>).payload).toBeUndefined();
      expect((err as unknown as Record<string, unknown>).secret).toBeUndefined();
      expect(JSON.stringify(err)).not.toContain("CANARY");
    }
  });

  it.each([
    { name: "inherited 409", err: Object.create({ status: 409 }) },
    { name: "NaN status", err: { status: NaN } },
    { name: "Infinity status", err: { status: Infinity } },
    { name: "negative status", err: { status: -400 } },
    { name: "fractional status", err: { status: 409.5 } },
    { name: "out-of-range low", err: { status: 99 } },
    { name: "out-of-range high", err: { status: 600 } },
    { name: "string status", err: { status: "409" } },
    { name: "ApiError with inherited status", err: Object.create(new ApiError(409, null)) },
  ])("invalid or inherited status ($name) falls back to safe generic error without invented HTTP evidence", async ({ name, err }) => {
    if (name === "ApiError with inherited status") {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(409);
      expect(Object.prototype.hasOwnProperty.call(err, "status")).toBe(false);
      expect((err as ApiError).hasOwnProperty("status")).toBe(false);
    }

    const { mode, scope } = setupVerifiedContext("geminicli");
    const api = createAdvancedCredentialApi(mode, scope);

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(err));

    await expect(api.configurePreview("test.json")).rejects.toSatisfy((e: unknown) => {
      expect(e).toBeInstanceOf(Error);
      expect(e).not.toBeInstanceOf(ApiError);
      const standardErr = e as Error;
      expect(standardErr.message).toBe("操作未完成，请重试。");
      expect(standardErr.message).not.toContain("HTTP");
      expect(standardErr.message).not.toContain("409");
      return true;
    });
  });

  it("true own 409 retains safe ApiError with status 409 and payload null", async () => {
    const { mode, scope } = setupVerifiedContext("geminicli");
    const api = createAdvancedCredentialApi(mode, scope);

    const realApiError = new ApiError(409, { secret_canary: "LEAK" }, "Original detailed 409 message");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(realApiError));

    await expect(api.configurePreview("test.json")).rejects.toSatisfy((e: unknown) => {
      expect(e).toBeInstanceOf(ApiError);
      const apiErr = e as ApiError;
      expect(apiErr.status).toBe(409);
      expect(apiErr.payload).toBeNull();
      expect(apiErr.message).toBe("请求状态冲突（HTTP 409）。");
      expect(apiErr.message).not.toContain("Original");
      expect(apiErr.message).not.toContain("LEAK");
      return true;
    });
  });
});

describe("Fixture mode and unverified factory paths", () => {
  it("rejects with safe 501 ApiError when VITE_UI_FIXTURES is true before transport", async () => {
    vi.stubEnv("VITE_UI_FIXTURES", "true");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const gcliCtx = setupVerifiedContext("geminicli");
    const gcliApi = createAdvancedCredentialApi(gcliCtx.mode, gcliCtx.scope);

    await expect(gcliApi.configurePreview("test.json")).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(501);
      return true;
    });

    const agCtx = setupVerifiedContext("antigravity");
    const agApi = createAdvancedCredentialApi(agCtx.mode, agCtx.scope);

    await expect(agApi.releaseQuotaGroup("test.json", "gemini-shared")).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(501);
      return true;
    });

    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("unverified factory construction fails closed with zero fetch calls", async () => {
    __commitPanelChannel("geminicli");
    setSessionToken(null);
    const scope = capturePanelScope(0);

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const api = createAdvancedCredentialApi("geminicli", scope);
    expect(fetchMock).toHaveBeenCalledTimes(0);

    await expect(api.configurePreview("test.json")).rejects.toSatisfy((err: unknown) => {
      return err instanceof DOMException && err.name === "AbortError";
    });
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });
});
