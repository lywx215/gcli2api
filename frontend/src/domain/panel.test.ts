import "@/app/test-setup";
import { describe, it, expect, vi, afterEach } from "vitest";
import { setSessionToken, getSessionSnapshot } from "@/auth/session";
import {
  PANEL_MODES,
  isPanelMode,
  credentialIdentityKey,
  getPanelChannelSnapshot,
  subscribePanelChannel,
  registerChannelCleanup,
  capturePanelScope,
  isPanelScopeCurrent,
  notifyCredentialChange,
  subscribeCredentialChanges,
  __commitPanelChannel,
  __invalidatePanelChannel,
  type PanelMode,
  type CredentialChange,
} from "@/domain/panel";

describe("panel core domain", () => {
  afterEach(() => {
    // Restore channel mode to antigravity if modified during test
    if (getPanelChannelSnapshot().mode !== "antigravity") {
      __commitPanelChannel("antigravity");
    }
  });

  describe("PANEL_MODES and isPanelMode", () => {
    it("defines the closed enum of panel modes", () => {
      expect(PANEL_MODES).toEqual(["antigravity", "geminicli"]);
      expect(Object.isFrozen(PANEL_MODES)).toBe(true);
    });

    it("correctly identifies valid panel modes", () => {
      expect(isPanelMode("antigravity")).toBe(true);
      expect(isPanelMode("geminicli")).toBe(true);
    });

    it("rejects invalid values as panel modes", () => {
      expect(isPanelMode("")).toBe(false);
      expect(isPanelMode("vertex")).toBe(false);
      expect(isPanelMode("gemini")).toBe(false);
      expect(isPanelMode(null)).toBe(false);
      expect(isPanelMode(undefined)).toBe(false);
      expect(isPanelMode(123)).toBe(false);
      expect(isPanelMode({})).toBe(false);
    });
  });

  describe("credentialIdentityKey and collision resistance", () => {
    it("creates collision-free JSON tuple serialization", () => {
      const keyAg = credentialIdentityKey("antigravity", "account.json");
      const keyGcli = credentialIdentityKey("geminicli", "account.json");

      expect(keyAg).toBe(JSON.stringify(["antigravity", "account.json"]));
      expect(keyGcli).toBe(JSON.stringify(["geminicli", "account.json"]));
      expect(keyAg).not.toBe(keyGcli);

      // Deserialization recovers exact tuple components
      expect(JSON.parse(keyAg)).toEqual(["antigravity", "account.json"]);
      expect(JSON.parse(keyGcli)).toEqual(["geminicli", "account.json"]);
    });

    it("prevents delimiter collisions with tricky strings", () => {
      // With naive delimiter like 'mode:filename', 'antigravity:a:b' vs 'antigravity:a' and 'b' would collide.
      // JSON tuple avoids all such ambiguity:
      const k1 = credentialIdentityKey("antigravity", "a:b");
      const k2 = credentialIdentityKey("antigravity", "a,b");
      const k3 = credentialIdentityKey("antigravity", 'a", "b');
      const k4 = credentialIdentityKey("antigravity", '["antigravity","a"]');

      const set = new Set([k1, k2, k3, k4]);
      expect(set.size).toBe(4);
    });

    it("retains Unicode and percent characters without path encoding", () => {
      const unicodeKey = credentialIdentityKey("antigravity", "凭证_测试.json");
      expect(JSON.parse(unicodeKey)).toEqual(["antigravity", "凭证_测试.json"]);
      expect(unicodeKey).toContain("凭证_测试.json");

      const percentKey = credentialIdentityKey("geminicli", "file%20name%231.json");
      expect(JSON.parse(percentKey)).toEqual(["geminicli", "file%20name%231.json"]);
      expect(percentKey).toContain("%20");
    });

    it("rejects invalid mode or non-string filename", () => {
      expect(() => credentialIdentityKey("unknown" as PanelMode, "test.json")).toThrow(TypeError);
      expect(() => credentialIdentityKey("antigravity", 123 as unknown as string)).toThrow(TypeError);
      expect(() => credentialIdentityKey("antigravity", null as unknown as string)).toThrow(TypeError);
    });
  });

  describe("stable/no-op snapshots", () => {
    it("provides stable snapshot identity when unchanged", () => {
      const snap1 = getPanelChannelSnapshot();
      const snap2 = getPanelChannelSnapshot();
      expect(snap1).toBe(snap2);
      expect(snap1.mode).toBe("antigravity");
      expect(typeof snap1.channelEpoch).toBe("number");
      expect(Object.isFrozen(snap1)).toBe(true);
    });

    it("treats committing the current mode as a no-op", () => {
      const initial = getPanelChannelSnapshot();
      const listener = vi.fn();
      const cleanup = vi.fn();
      const unsubListener = subscribePanelChannel(listener);
      const unsubCleanup = registerChannelCleanup(cleanup);

      __commitPanelChannel(initial.mode);

      expect(getPanelChannelSnapshot()).toBe(initial);
      expect(getPanelChannelSnapshot().channelEpoch).toBe(initial.channelEpoch);
      expect(listener).not.toHaveBeenCalled();
      expect(cleanup).not.toHaveBeenCalled();

      unsubListener();
      unsubCleanup();
    });
  });

  describe("commit/invalidation/cancellation order", () => {
    it("advances channelEpoch once and performs synchronous cleanup before publishing new snapshot on commit", () => {
      const initial = getPanelChannelSnapshot();
      const executionOrder: string[] = [];
      let snapshotDuringCleanup: unknown = null;
      let snapshotDuringListener: unknown = null;

      const unsubCleanup = registerChannelCleanup(() => {
        executionOrder.push("cleanup");
        snapshotDuringCleanup = getPanelChannelSnapshot();
      });

      const unsubListener = subscribePanelChannel(() => {
        executionOrder.push("listener");
        snapshotDuringListener = getPanelChannelSnapshot();
      });

      __commitPanelChannel("geminicli");

      const updated = getPanelChannelSnapshot();
      expect(updated.mode).toBe("geminicli");
      expect(updated.channelEpoch).toBe(initial.channelEpoch + 1);

      // Cleanups must run BEFORE publishing the new snapshot
      expect(executionOrder).toEqual(["cleanup", "listener"]);
      expect(snapshotDuringCleanup).toBe(initial);
      expect(snapshotDuringListener).toBe(updated);

      unsubCleanup();
      unsubListener();
    });

    it("rejects invalid mode on commit without advancing or running cleanups", () => {
      const initial = getPanelChannelSnapshot();
      const cleanup = vi.fn();
      const listener = vi.fn();
      const unsubCleanup = registerChannelCleanup(cleanup);
      const unsubListener = subscribePanelChannel(listener);

      expect(() => __commitPanelChannel("invalid" as PanelMode)).toThrow(TypeError);

      expect(getPanelChannelSnapshot()).toBe(initial);
      expect(cleanup).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();

      unsubCleanup();
      unsubListener();
    });

    it("advances channelEpoch once and performs synchronous cleanup before publishing on __invalidatePanelChannel without resetting mode", () => {
      __commitPanelChannel("geminicli");
      const beforeInvalidation = getPanelChannelSnapshot();

      const executionOrder: string[] = [];
      let snapshotDuringCleanup: unknown = null;
      let snapshotDuringListener: unknown = null;

      const unsubCleanup = registerChannelCleanup(() => {
        executionOrder.push("cleanup");
        snapshotDuringCleanup = getPanelChannelSnapshot();
      });

      const unsubListener = subscribePanelChannel(() => {
        executionOrder.push("listener");
        snapshotDuringListener = getPanelChannelSnapshot();
      });

      __invalidatePanelChannel();

      const afterInvalidation = getPanelChannelSnapshot();
      // Harmless mode is preserved!
      expect(afterInvalidation.mode).toBe("geminicli");
      expect(afterInvalidation.channelEpoch).toBe(beforeInvalidation.channelEpoch + 1);

      expect(executionOrder).toEqual(["cleanup", "listener"]);
      expect(snapshotDuringCleanup).toBe(beforeInvalidation);
      expect(snapshotDuringListener).toBe(afterInvalidation);

      unsubCleanup();
      unsubListener();
    });
  });

  describe("session invalidation integration", () => {
    it("integrates with session cleanup and invalidates channel scope without resetting mode", () => {
      __commitPanelChannel("geminicli");
      const beforeSessionChange = getPanelChannelSnapshot();

      const channelCleanup = vi.fn();
      const channelListener = vi.fn();
      const unsubCleanup = registerChannelCleanup(channelCleanup);
      const unsubListener = subscribePanelChannel(channelListener);

      // Transition session token
      setSessionToken("test-bearer-token");

      const afterSessionChange = getPanelChannelSnapshot();
      // Channel epoch must advance by 1
      expect(afterSessionChange.channelEpoch).toBe(beforeSessionChange.channelEpoch + 1);
      // Mode must NOT be reset
      expect(afterSessionChange.mode).toBe("geminicli");

      expect(channelCleanup).toHaveBeenCalledTimes(1);
      expect(channelListener).toHaveBeenCalledTimes(1);

      unsubCleanup();
      unsubListener();
    });
  });

  describe("stale scopes and capturePanelScope", () => {
    it("captures current mode and channelEpoch with caller sessionEpoch", () => {
      const snap = getPanelChannelSnapshot();
      const sessionEpoch = getSessionSnapshot().sessionEpoch;
      const scope = capturePanelScope(sessionEpoch);

      expect(scope).toEqual({
        mode: snap.mode,
        channelEpoch: snap.channelEpoch,
        sessionEpoch,
      });
      expect(Object.isFrozen(scope)).toBe(true);
      // Token must not be in scope
      expect((scope as Record<string, unknown>).token).toBeUndefined();
    });

    it("correctly identifies current vs stale scopes", () => {
      const sessionEpoch = getSessionSnapshot().sessionEpoch;
      const scope = capturePanelScope(sessionEpoch);

      expect(isPanelScopeCurrent(scope, sessionEpoch)).toBe(true);

      // Mode mismatch makes scope stale
      __commitPanelChannel("geminicli");
      expect(isPanelScopeCurrent(scope, sessionEpoch)).toBe(false);

      // Scope re-captured for new mode
      const scope2 = capturePanelScope(sessionEpoch);
      expect(isPanelScopeCurrent(scope2, sessionEpoch)).toBe(true);

      // Channel invalidation makes scope stale
      __invalidatePanelChannel();
      expect(isPanelScopeCurrent(scope2, sessionEpoch)).toBe(false);

      // Session epoch mismatch makes scope stale
      const scope3 = capturePanelScope(sessionEpoch);
      expect(isPanelScopeCurrent(scope3, sessionEpoch + 1)).toBe(false);

      // Malformed scope
      expect(isPanelScopeCurrent(null as unknown as typeof scope3, sessionEpoch)).toBe(false);
      expect(isPanelScopeCurrent({} as unknown as typeof scope3, sessionEpoch)).toBe(false);
    });
  });

  describe("safe metadata events and whitelist", () => {
    it("whitelists mode, sessionEpoch, and deduplicated basename-like filenames", () => {
      const currentSessionEpoch = getSessionSnapshot().sessionEpoch;
      const receivedEvents: CredentialChange[] = [];

      const unsub = subscribeCredentialChanges((event) => {
        receivedEvents.push(event);
      });

      const inputWithSecrets = {
        mode: "antigravity" as const,
        sessionEpoch: currentSessionEpoch,
        filenames: [
          "/path/to/creds.json",
          "C:\\Users\\admin\\creds.json", // duplicate basename
          "second.json",
          "nested/dir/third.json",
          "folder/", // directory path, must be omitted
          "", // empty string, omitted
          "..", // traversal, omitted
          "凭证.json", // Unicode preserved
          "name%20with%20percent.json", // percent preserved
        ],
        // Secret fields that must be stripped:
        token: "secret-token",
        password: "secret-password",
        rawError: new Error("sensitive leak"),
        credentials: [{ secret: "data" }],
      };

      notifyCredentialChange(inputWithSecrets as unknown as CredentialChange);

      expect(receivedEvents).toHaveLength(1);
      const event = receivedEvents[0];

      // Whitelisted fields
      expect(event.mode).toBe("antigravity");
      expect(event.sessionEpoch).toBe(currentSessionEpoch);
      expect(event.filenames).toEqual([
        "creds.json",
        "second.json",
        "third.json",
        "凭证.json",
        "name%20with%20percent.json",
      ]);

      // Event is frozen
      expect(Object.isFrozen(event)).toBe(true);
      expect(Object.isFrozen(event.filenames)).toBe(true);

      // Secret fields are NOT retained or copied
      expect((event as Record<string, unknown>).token).toBeUndefined();
      expect((event as Record<string, unknown>).password).toBeUndefined();
      expect((event as Record<string, unknown>).rawError).toBeUndefined();
      expect((event as Record<string, unknown>).credentials).toBeUndefined();
      expect(Object.keys(event)).toEqual(["mode", "sessionEpoch", "filenames"]);

      unsub();
    });

    it("bounds filenames at 5000 items", () => {
      const currentSessionEpoch = getSessionSnapshot().sessionEpoch;
      let received: CredentialChange | null = null;
      const unsub = subscribeCredentialChanges((e) => { received = e; });

      const longList: string[] = [];
      for (let i = 0; i < 5050; i++) {
        longList.push(`cred_${i}.json`);
      }

      notifyCredentialChange({
        mode: "antigravity",
        sessionEpoch: currentSessionEpoch,
        filenames: longList,
      });

      expect(received).not.toBeNull();
      expect(received!.filenames).toHaveLength(5000);
      expect(received!.filenames![0]).toBe("cred_0.json");
      expect(received!.filenames![4999]).toBe("cred_4999.json");

      unsub();
    });

    it("omits filenames field when undefined in input", () => {
      const currentSessionEpoch = getSessionSnapshot().sessionEpoch;
      let received: CredentialChange | null = null;
      const unsub = subscribeCredentialChanges((e) => { received = e; });

      notifyCredentialChange({
        mode: "antigravity",
        sessionEpoch: currentSessionEpoch,
      });

      expect(received).not.toBeNull();
      expect(received!.mode).toBe("antigravity");
      expect(received!.sessionEpoch).toBe(currentSessionEpoch);
      expect(received!.filenames).toBeUndefined();
      expect(Object.keys(received!)).toEqual(["mode", "sessionEpoch"]);

      unsub();
    });

    it("drops stale-session events", () => {
      const currentSessionEpoch = getSessionSnapshot().sessionEpoch;
      const listener = vi.fn();
      const unsub = subscribeCredentialChanges(listener);

      // Event from previous or mismatched session epoch is dropped
      notifyCredentialChange({
        mode: "antigravity",
        sessionEpoch: currentSessionEpoch + 1,
        filenames: ["test.json"],
      });
      notifyCredentialChange({
        mode: "antigravity",
        sessionEpoch: currentSessionEpoch - 1,
        filenames: ["test.json"],
      });

      expect(listener).not.toHaveBeenCalled();
      unsub();
    });

    it("drops invalid events", () => {
      const listener = vi.fn();
      const unsub = subscribeCredentialChanges(listener);

      notifyCredentialChange(null as unknown as CredentialChange);
      notifyCredentialChange({} as unknown as CredentialChange);
      notifyCredentialChange({ mode: "unknown" as PanelMode, sessionEpoch: 0 });
      notifyCredentialChange({ mode: "antigravity", sessionEpoch: -1 });
      notifyCredentialChange({
        mode: "antigravity",
        sessionEpoch: getSessionSnapshot().sessionEpoch,
        filenames: "not-an-array" as unknown as string[],
      });

      expect(listener).not.toHaveBeenCalled();
      unsub();
    });
  });

  describe("exception isolation and idempotence", () => {
    it("isolates exceptions thrown by channel cleanups", () => {
      const cleanup1 = vi.fn(() => { throw new Error("cleanup 1 failed"); });
      const cleanup2 = vi.fn();

      const unsub1 = registerChannelCleanup(cleanup1);
      const unsub2 = registerChannelCleanup(cleanup2);

      // Must not throw despite cleanup1 failing
      expect(() => __commitPanelChannel("geminicli")).not.toThrow();

      expect(cleanup1).toHaveBeenCalledTimes(1);
      expect(cleanup2).toHaveBeenCalledTimes(1);

      unsub1();
      unsub2();
    });

    it("isolates exceptions thrown by channel listeners", () => {
      const listener1 = vi.fn(() => { throw new Error("listener 1 failed"); });
      const listener2 = vi.fn();

      const unsub1 = subscribePanelChannel(listener1);
      const unsub2 = subscribePanelChannel(listener2);

      expect(() => __commitPanelChannel("geminicli")).not.toThrow();

      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledTimes(1);

      unsub1();
      unsub2();
    });

    it("isolates exceptions thrown by credential change listeners", () => {
      const currentSessionEpoch = getSessionSnapshot().sessionEpoch;
      const listener1 = vi.fn(() => { throw new Error("cred listener 1 failed"); });
      const listener2 = vi.fn();

      const unsub1 = subscribeCredentialChanges(listener1);
      const unsub2 = subscribeCredentialChanges(listener2);

      expect(() => {
        notifyCredentialChange({
          mode: "antigravity",
          sessionEpoch: currentSessionEpoch,
        });
      }).not.toThrow();

      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledTimes(1);

      unsub1();
      unsub2();
    });

    it("supports idempotent unregister", () => {
      const listener = vi.fn();
      const unsub = subscribePanelChannel(listener);

      unsub();
      // Calling unsub a second time must be harmless
      expect(() => unsub()).not.toThrow();

      __commitPanelChannel("geminicli");
      expect(listener).not.toHaveBeenCalled();
    });

    it("deduplicates identical cleanup and listener registrations", () => {
      const cleanup = vi.fn();
      const unsub1 = registerChannelCleanup(cleanup);
      const unsub2 = registerChannelCleanup(cleanup);

      __commitPanelChannel("geminicli");
      expect(cleanup).toHaveBeenCalledTimes(1);

      unsub1();
      unsub2();
    });
  });
});
