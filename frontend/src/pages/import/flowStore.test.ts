import "@/app/test-setup";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  setSessionToken,
  getSessionSnapshot,
  __setSessionValidationStatus,
} from "@/auth/session";
import {
  __commitPanelChannel,
  __invalidatePanelChannel,
  capturePanelScope,
  getPanelChannelSnapshot,
  type PanelScope,
} from "@/domain/panel";
import {
  claimImportFlowOwner,
  getImportFlowSnapshot,
  subscribeImportFlow,
  resetImportFlow,
  beginImportFlowTask,
  stopImportFlowTask,
  getVerifiedFlowOwner,
  getFlowStoreSnapshot,
  subscribeFlowStore,
  registerOAuthTask,
  registerEmailJob,
  cancelFlowTask,
  __resetFlowStore,
  type ImportFlowOwner,
  type ImportFlowTaskHandle,
  type FlowOwner,
  type FlowTaskHandle,
} from "./flowStore";

const VALID_JOB_ID_1 = "0123456789abcdef0123456789abcdef";
const VALID_JOB_ID_2 = "abcdef0123456789abcdef0123456789";

function loginAndVerify(
  token = "test-bearer-token",
  mode: "antigravity" | "geminicli" = "antigravity",
): ImportFlowOwner {
  if (getPanelChannelSnapshot().mode !== mode) {
    __commitPanelChannel(mode);
  }
  setSessionToken(token);
  const session = getSessionSnapshot();
  __setSessionValidationStatus(session.sessionEpoch, "verified");
  const owner = getVerifiedFlowOwner();
  if (!owner) {
    throw new Error("Failed to create verified owner in test setup");
  }
  return owner;
}

describe("flowStore registry and lifecycle", () => {
  afterEach(() => {
    __resetFlowStore();
    if (getPanelChannelSnapshot().mode !== "antigravity") {
      __commitPanelChannel("antigravity");
    }
    setSessionToken(null);
  });

  describe("current verified Scope3 owner and claimImportFlowOwner", () => {
    it("returns null when session is anonymous", () => {
      setSessionToken(null);
      expect(getVerifiedFlowOwner()).toBeNull();
      expect(claimImportFlowOwner(capturePanelScope(getSessionSnapshot().sessionEpoch))).toBeNull();
    });

    it("returns null when session validation status is pending", () => {
      setSessionToken("test-token", true, { requiresValidation: true });
      expect(getVerifiedFlowOwner()).toBeNull();
      expect(claimImportFlowOwner(capturePanelScope(getSessionSnapshot().sessionEpoch))).toBeNull();
    });

    it("returns null when session validation status is unavailable", () => {
      setSessionToken("test-token");
      const session = getSessionSnapshot();
      __setSessionValidationStatus(session.sessionEpoch, "unavailable");
      expect(getVerifiedFlowOwner()).toBeNull();
      expect(claimImportFlowOwner(capturePanelScope(getSessionSnapshot().sessionEpoch))).toBeNull();
    });

    it("returns frozen FlowOwner when session has token and is verified", () => {
      const owner = loginAndVerify("test-token", "antigravity");
      expect(owner.mode).toBe("antigravity");
      expect(owner.channelEpoch).toBe(getPanelChannelSnapshot().channelEpoch);
      expect(owner.sessionEpoch).toBe(getSessionSnapshot().sessionEpoch);
      expect(Object.isFrozen(owner)).toBe(true);
    });

    it("provides stable owner object identity when state is unchanged", () => {
      loginAndVerify("test-token", "antigravity");
      const owner1 = getVerifiedFlowOwner();
      const owner2 = getVerifiedFlowOwner();
      expect(owner1).toBe(owner2);
    });

    it("validates claimImportFlowOwner against current Scope3 without disrupting active owner on invalid claim", () => {
      const owner = loginAndVerify("test-token", "antigravity");
      const currentChannel = getPanelChannelSnapshot();
      const currentSession = getSessionSnapshot();

      // Valid claim returns reference-stable owner
      const validScope: PanelScope = {
        mode: currentChannel.mode,
        channelEpoch: currentChannel.channelEpoch,
        sessionEpoch: currentSession.sessionEpoch,
      };
      const claimed = claimImportFlowOwner(validScope);
      expect(claimed).toBe(owner);

      // Invalid claim (wrong mode) returns null and does not disrupt active owner
      const invalidScopeMode: PanelScope = {
        mode: "geminicli",
        channelEpoch: currentChannel.channelEpoch,
        sessionEpoch: currentSession.sessionEpoch,
      };
      expect(claimImportFlowOwner(invalidScopeMode)).toBeNull();
      expect(getVerifiedFlowOwner()).toBe(owner);

      // Invalid claim (wrong channel epoch) returns null
      const invalidScopeEpoch: PanelScope = {
        mode: currentChannel.mode,
        channelEpoch: currentChannel.channelEpoch + 99,
        sessionEpoch: currentSession.sessionEpoch,
      };
      expect(claimImportFlowOwner(invalidScopeEpoch)).toBeNull();
      expect(getVerifiedFlowOwner()).toBe(owner);

      // Invalid object payload returns null
      expect(claimImportFlowOwner(null as unknown as PanelScope)).toBeNull();
      expect(claimImportFlowOwner({} as unknown as PanelScope)).toBeNull();
      expect(getVerifiedFlowOwner()).toBe(owner);
    });
  });

  describe("immutable stable snapshots", () => {
    it("provides stable snapshot identity when unchanged", () => {
      loginAndVerify("test-token", "antigravity");
      const snap1 = getFlowStoreSnapshot();
      const snap2 = getFlowStoreSnapshot();
      const canonSnap = getImportFlowSnapshot();
      expect(snap1).toBe(snap2);
      expect(snap1).toBe(canonSnap);
      expect(snap1.owner).not.toBeNull();
      expect(snap1.records).toEqual([]);
      expect(Object.isFrozen(snap1)).toBe(true);
      expect(Object.isFrozen(snap1.records)).toBe(true);
    });

    it("freezes records and tasks collections against mutations", () => {
      const owner = loginAndVerify("test-token", "antigravity");
      registerOAuthTask(owner);
      const snap = getFlowStoreSnapshot();
      expect(Object.isFrozen(snap)).toBe(true);
      expect(Object.isFrozen(snap.records)).toBe(true);
      expect(snap.records.length).toBe(1);
      expect(() => {
        (snap.records as unknown as unknown[]).push({});
      }).toThrow();
    });

    it("provides stable empty snapshot identity before login, after logout, and after reset", () => {
      // Before login: anonymous
      setSessionToken(null);
      const snapAnon1 = getFlowStoreSnapshot();
      const snapAnon2 = getFlowStoreSnapshot();
      expect(snapAnon1).toBe(snapAnon2);
      expect(snapAnon1.owner).toBeNull();
      expect(snapAnon1.records).toEqual([]);
      expect(snapAnon1.records).toBe(snapAnon2.records);
      expect(snapAnon1.tasks).toBe(snapAnon1.records);
      expect(Object.isFrozen(snapAnon1)).toBe(true);

      // Login and register
      loginAndVerify("test-token", "antigravity");
      const snapLoggedIn1 = getFlowStoreSnapshot();
      const snapLoggedIn2 = getFlowStoreSnapshot();
      expect(snapLoggedIn1).toBe(snapLoggedIn2);
      expect(snapLoggedIn1.owner).not.toBeNull();

      // Logout
      setSessionToken(null);
      const snapLogout1 = getFlowStoreSnapshot();
      const snapLogout2 = getFlowStoreSnapshot();
      expect(snapLogout1).toBe(snapLogout2);
      expect(snapLogout1.owner).toBeNull();
      expect(snapLogout1.records).toBe(snapAnon1.records);

      // Reset
      __resetFlowStore();
      const snapReset1 = getFlowStoreSnapshot();
      const snapReset2 = getFlowStoreSnapshot();
      expect(snapReset1).toBe(snapReset2);
      expect(snapReset1.owner).toBeNull();
      expect(snapReset1.records).toBe(snapAnon1.records);
    });

    it("advances snapshot generation monotonically across mutations and preserves it across reads", () => {
      __resetFlowStore();
      const snap0 = getFlowStoreSnapshot();
      expect(snap0.generation).toBe(0);

      // Repeated read does not increment generation
      expect(getFlowStoreSnapshot().generation).toBe(0);

      const owner = loginAndVerify("test-token", "antigravity");
      const snapLogin = getFlowStoreSnapshot();
      expect(snapLogin.generation).toBeGreaterThan(0);
      const genLogin = snapLogin.generation;

      // Read preserves generation
      expect(getFlowStoreSnapshot().generation).toBe(genLogin);

      // Task 1 registration increments generation
      const handle1 = registerOAuthTask(owner);
      const snapT1 = getFlowStoreSnapshot();
      expect(snapT1.generation).toBeGreaterThan(genLogin);
      const genT1 = snapT1.generation;

      // Task 2 (email) registration increments generation
      const handle2 = registerEmailJob(owner, VALID_JOB_ID_1);
      const snapT2 = getFlowStoreSnapshot();
      expect(snapT2.generation).toBeGreaterThan(genT1);
      const genT2 = snapT2.generation;

      // Deduplicated email registration does NOT increment generation
      const handle2Dup = registerEmailJob(owner, VALID_JOB_ID_1);
      expect(handle2Dup).toBe(handle2);
      expect(getFlowStoreSnapshot().generation).toBe(genT2);

      // Cancellation increments generation
      cancelFlowTask(handle1!, owner);
      const snapCancel = getFlowStoreSnapshot();
      expect(snapCancel.generation).toBeGreaterThan(genT2);
    });
  });

  describe("Lifecycle Case 1: Route subscriber removal preserves registry and signals", () => {
    it("preserves registered tasks and does not abort signals when route subscriber unsubscribes", () => {
      const owner = loginAndVerify("test-token", "antigravity");
      const listener = vi.fn();
      const unsubscribe = subscribeFlowStore(listener);
      const canonListener = vi.fn();
      const canonUnsub = subscribeImportFlow(canonListener);

      const oauthHandle = registerOAuthTask(owner);
      expect(oauthHandle).not.toBeNull();
      const emailHandle = registerEmailJob(owner, VALID_JOB_ID_1);
      expect(emailHandle).not.toBeNull();

      expect(listener).toHaveBeenCalled();
      expect(canonListener).toHaveBeenCalled();
      const beforeUnsubSnap = getFlowStoreSnapshot();
      expect(beforeUnsubSnap.records.length).toBe(2);
      expect(oauthHandle!.signal.aborted).toBe(false);
      expect(emailHandle!.signal.aborted).toBe(false);

      // Route subscriber unmounts / unregisters
      unsubscribe();
      canonUnsub();

      // Registry records and signals must remain fully intact!
      const afterUnsubSnap = getFlowStoreSnapshot();
      expect(afterUnsubSnap.records.length).toBe(2);
      expect(afterUnsubSnap.records[0].id).toBe(oauthHandle!.id);
      expect(afterUnsubSnap.records[1].id).toBe(emailHandle!.id);
      expect(oauthHandle!.signal.aborted).toBe(false);
      expect(emailHandle!.signal.aborted).toBe(false);

      // Future subscriber can re-subscribe and observe existing tasks
      const newListener = vi.fn();
      const unsubNew = subscribeFlowStore(newListener);
      expect(getFlowStoreSnapshot().records.length).toBe(2);
      unsubNew();
    });
  });

  describe("Lifecycle Case 2: Same-session channel change synchronously clears records and aborts tasks", () => {
    it("aborts all tasks and clears registry synchronously on __commitPanelChannel", () => {
      const owner = loginAndVerify("test-token", "antigravity");
      const oauthHandle = registerOAuthTask(owner);
      const emailHandle = registerEmailJob(owner, VALID_JOB_ID_1);

      expect(oauthHandle).not.toBeNull();
      expect(emailHandle).not.toBeNull();
      expect(getFlowStoreSnapshot().records.length).toBe(2);
      expect(oauthHandle!.signal.aborted).toBe(false);
      expect(emailHandle!.signal.aborted).toBe(false);

      let snapshotDuringChannelListener: ReturnType<typeof getFlowStoreSnapshot> | null = null;
      const channelListener = vi.fn(() => {
        snapshotDuringChannelListener = getFlowStoreSnapshot();
      });
      const unsubChannel = subscribeFlowStore(channelListener);

      // Same-session channel change
      __commitPanelChannel("geminicli");

      // Verify synchronous abort and clearing
      expect(oauthHandle!.signal.aborted).toBe(true);
      expect(emailHandle!.signal.aborted).toBe(true);
      expect(getFlowStoreSnapshot().records.length).toBe(0);
      expect(snapshotDuringChannelListener).not.toBeNull();
      expect(snapshotDuringChannelListener!.records.length).toBe(0);

      unsubChannel();
    });

    it("aborts all tasks and clears registry synchronously on __invalidatePanelChannel", () => {
      const owner = loginAndVerify("test-token", "antigravity");
      const oauthHandle = registerOAuthTask(owner);
      expect(oauthHandle).not.toBeNull();

      __invalidatePanelChannel();

      expect(oauthHandle!.signal.aborted).toBe(true);
      expect(getFlowStoreSnapshot().records.length).toBe(0);
    });
  });

  describe("Lifecycle Case 3: Session change or logout synchronously clears records and aborts tasks", () => {
    it("aborts all tasks and clears registry synchronously on logout", () => {
      const owner = loginAndVerify("test-token", "antigravity");
      const oauthHandle = registerOAuthTask(owner);
      const emailHandle = registerEmailJob(owner, VALID_JOB_ID_1);

      expect(getFlowStoreSnapshot().records.length).toBe(2);

      // Logout
      setSessionToken(null);

      expect(oauthHandle!.signal.aborted).toBe(true);
      expect(emailHandle!.signal.aborted).toBe(true);
      expect(getFlowStoreSnapshot().records.length).toBe(0);
      expect(getFlowStoreSnapshot().owner).toBeNull();
    });

    it("aborts all tasks and clears registry synchronously on session token change", () => {
      const owner = loginAndVerify("token-A", "antigravity");
      const oauthHandle = registerOAuthTask(owner);
      expect(oauthHandle).not.toBeNull();

      // Session token replaced with token-B
      setSessionToken("token-B");

      expect(oauthHandle!.signal.aborted).toBe(true);
      expect(getFlowStoreSnapshot().records.length).toBe(0);
    });

    it("rejects old owners across logout and same-token relogin while maintaining stable current identities", () => {
      const owner1 = loginAndVerify("test-token", "antigravity");
      const handle1 = registerOAuthTask(owner1);
      expect(handle1).not.toBeNull();

      // Stable repeated current reads and claims return same identity
      const read1 = getVerifiedFlowOwner();
      const read2 = getVerifiedFlowOwner();
      const claim1 = claimImportFlowOwner(capturePanelScope(getSessionSnapshot().sessionEpoch));
      const claim2 = claimImportFlowOwner(capturePanelScope(getSessionSnapshot().sessionEpoch));
      expect(read1).toBe(owner1);
      expect(read2).toBe(owner1);
      expect(claim1).toBe(owner1);
      expect(claim2).toBe(owner1);

      // Logout clears tasks and invalidates owner
      setSessionToken(null);
      expect(handle1!.signal.aborted).toBe(true);
      expect(getVerifiedFlowOwner()).toBeNull();

      // Relogin with same token produces fresh owner identity
      const owner2 = loginAndVerify("test-token", "antigravity");
      expect(owner2).not.toBe(owner1);

      // Old owner from previous session cannot register, stop or reset
      expect(registerOAuthTask(owner1)).toBeNull();
      expect(beginImportFlowTask(owner1, "oauth")).toBeNull();
      expect(resetImportFlow(owner1)).toBe(false);

      // New owner registers and stops successfully
      const handle2 = registerOAuthTask(owner2);
      expect(handle2).not.toBeNull();
      expect(stopImportFlowTask(owner1, handle2!)).toBe(false);
      expect(stopImportFlowTask(owner2, handle2!)).toBe(true);
      expect(handle2!.signal.aborted).toBe(true);
    });
  });

  describe("Lifecycle Case 4: Validation loss synchronously clears records and aborts tasks", () => {
    it("aborts tasks and clears records synchronously when status changes to unavailable", () => {
      const owner = loginAndVerify("test-token", "antigravity");
      const oauthHandle = registerOAuthTask(owner);
      const emailHandle = registerEmailJob(owner, VALID_JOB_ID_1);

      expect(getFlowStoreSnapshot().records.length).toBe(2);

      // Session validation status drops to unavailable
      const currentSession = getSessionSnapshot();
      __setSessionValidationStatus(currentSession.sessionEpoch, "unavailable");

      expect(oauthHandle!.signal.aborted).toBe(true);
      expect(emailHandle!.signal.aborted).toBe(true);
      expect(getFlowStoreSnapshot().records.length).toBe(0);
      expect(getFlowStoreSnapshot().owner).toBeNull();
    });

    it("aborts tasks and clears records synchronously when status changes to pending", () => {
      const owner = loginAndVerify("test-token", "antigravity");
      const oauthHandle = registerOAuthTask(owner);
      expect(oauthHandle).not.toBeNull();

      const currentSession = getSessionSnapshot();
      __setSessionValidationStatus(currentSession.sessionEpoch, "pending");

      expect(oauthHandle!.signal.aborted).toBe(true);
      expect(getFlowStoreSnapshot().records.length).toBe(0);
      expect(getFlowStoreSnapshot().owner).toBeNull();
    });
  });

  describe("Lifecycle Case 5: Exact captured owner/handle identities, stale calls and ABA protection", () => {
    it("prevents stale handles and forged references from cancelling replacement tasks (ABA protection)", () => {
      const owner = loginAndVerify("test-token", "antigravity");

      // Register Task 1
      const handle1 = registerOAuthTask(owner);
      expect(handle1).not.toBeNull();
      expect(handle1!.id).toBe(1);

      // Cancel Task 1 with explicit owner
      const cancelled1 = cancelFlowTask(handle1!, owner);
      expect(cancelled1).toBe(true);
      expect(handle1!.signal.aborted).toBe(true);
      expect(getFlowStoreSnapshot().records.length).toBe(0);

      // Register Task 2 -> Store-generated numeric ID monotonically increases
      const handle2 = registerOAuthTask(owner);
      expect(handle2).not.toBeNull();
      expect(handle2!.id).toBe(2);
      expect(handle2!.id).not.toBe(handle1!.id);
      expect(getFlowStoreSnapshot().records.length).toBe(1);

      // Attempt to cancel using stale handle 1
      const staleCancelResult = cancelFlowTask(handle1!, owner);
      expect(staleCancelResult).toBe(false);

      // Task 2 must remain completely unaffected
      expect(handle2!.signal.aborted).toBe(false);
      expect(getFlowStoreSnapshot().records.length).toBe(1);

      // Attempt to cancel with forged handle having handle2's ID but different object identity
      const forgedHandle = {
        id: handle2!.id,
        kind: "oauth" as const,
        owner,
        signal: new AbortController().signal,
        cancel: () => false,
      };
      const forgedCancelResult = cancelFlowTask(forgedHandle as FlowTaskHandle, owner);
      expect(forgedCancelResult).toBe(false);
      expect(handle2!.signal.aborted).toBe(false);
      expect(getFlowStoreSnapshot().records.length).toBe(1);

      // Valid cancellation using handle2's own cancel method (which captures exact owner and handle)
      expect(handle2!.cancel()).toBe(true);
      expect(handle2!.signal.aborted).toBe(true);
      expect(getFlowStoreSnapshot().records.length).toBe(0);
    });

    it("rejects numeric-ID mutations without affecting active tasks", () => {
      const owner = loginAndVerify("test-token", "antigravity");
      const handle = registerOAuthTask(owner);
      expect(handle).not.toBeNull();
      expect(getFlowStoreSnapshot().records.length).toBe(1);

      // Attempt mutation passing bare numeric ID with owner
      const result = cancelFlowTask(handle!.id as unknown as FlowTaskHandle, owner);
      expect(result).toBe(false);
      expect(handle!.signal.aborted).toBe(false);
      expect(getFlowStoreSnapshot().records.length).toBe(1);

      // Bare numeric ID without owner
      expect(cancelFlowTask(handle!.id as unknown as FlowTaskHandle)).toBe(false);

      // Bare literal number with owner
      expect(cancelFlowTask(999 as unknown as FlowTaskHandle, owner)).toBe(false);
      expect(getFlowStoreSnapshot().records.length).toBe(1);
    });

    it("rejects ownerless object mutations without affecting active tasks", () => {
      const owner = loginAndVerify("test-token", "antigravity");
      const handle = registerOAuthTask(owner);
      expect(handle).not.toBeNull();

      // Attempt mutation passing handle without owner parameter
      expect(cancelFlowTask(handle!)).toBe(false);

      // Attempt mutation passing object without owner property
      const ownerless = { id: handle!.id };
      expect(cancelFlowTask(ownerless as unknown as FlowTaskHandle, owner)).toBe(false);

      // Attempt mutation passing object with invalid owner
      const invalidOwner = { id: handle!.id, owner: { mode: "unknown" } };
      expect(cancelFlowTask(invalidOwner as unknown as FlowTaskHandle, owner)).toBe(false);

      expect(handle!.signal.aborted).toBe(false);
      expect(getFlowStoreSnapshot().records.length).toBe(1);
    });

    it("rejects cancellation attempts when passed a mismatched or stale owner", () => {
      const owner = loginAndVerify("test-token", "antigravity");
      const handle = registerOAuthTask(owner);
      expect(handle).not.toBeNull();

      const staleOwner: FlowOwner = {
        mode: owner.mode,
        channelEpoch: owner.channelEpoch,
        sessionEpoch: owner.sessionEpoch + 1,
      };

      // Attempt to cancel with stale owner
      const result = cancelFlowTask(handle!, staleOwner);
      expect(result).toBe(false);
      expect(handle!.signal.aborted).toBe(false);
      expect(getFlowStoreSnapshot().records.length).toBe(1);
    });

    it("protects against Channel ABA (Antigravity -> GeminiCLI -> Antigravity)", () => {
      const ownerA1 = loginAndVerify("test-token", "antigravity");
      const epochA1 = ownerA1.channelEpoch;
      const handleA1 = registerOAuthTask(ownerA1);
      expect(handleA1).not.toBeNull();
      expect(handleA1!.signal.aborted).toBe(false);

      // Transition to B: GeminiCLI
      __commitPanelChannel("geminicli");
      expect(handleA1!.signal.aborted).toBe(true);
      expect(getFlowStoreSnapshot().records.length).toBe(0);

      // Transition back to A: Antigravity (Channel ABA: mode is antigravity again, but advanced channel epoch)
      __commitPanelChannel("antigravity");
      const ownerA2 = getVerifiedFlowOwner();
      expect(ownerA2).not.toBeNull();
      expect(ownerA2!.mode).toBe("antigravity");
      expect(ownerA2!.channelEpoch).toBeGreaterThan(epochA1);

      // Attempt to cancel handleA1 in epoch A2 -> rejected!
      expect(cancelFlowTask(handleA1!, ownerA2!)).toBe(false);
      expect(cancelFlowTask(handleA1!, ownerA1)).toBe(false);

      // Attempt to register task using stale ownerA1 in epoch A2 -> rejected!
      expect(registerOAuthTask(ownerA1)).toBeNull();
      expect(registerEmailJob(ownerA1, VALID_JOB_ID_1)).toBeNull();
      expect(beginImportFlowTask(ownerA1, "oauth")).toBeNull();
      expect(resetImportFlow(ownerA1)).toBe(false);

      // Structural clone of ownerA2 rejected
      expect(registerOAuthTask({ ...ownerA2! })).toBeNull();
      expect(beginImportFlowTask({ ...ownerA2! }, "oauth")).toBeNull();

      // Registering with new ownerA2 succeeds
      const handleA2 = registerOAuthTask(ownerA2!);
      expect(handleA2).not.toBeNull();
      expect(handleA2!.id).toBeGreaterThan(handleA1!.id);
      expect(handleA2!.signal.aborted).toBe(false);
      expect(getFlowStoreSnapshot().records.length).toBe(1);

      // Attempting to cancel handleA2 using stale ownerA1 -> rejected!
      expect(cancelFlowTask(handleA2!, ownerA1)).toBe(false);
      expect(stopImportFlowTask(ownerA1, handleA2!)).toBe(false);
      expect(handleA2!.signal.aborted).toBe(false);
    });

    it("protects against Validation ABA (Verified -> Pending/Unavailable -> Restored) with exact owner admission", () => {
      // 1. Pending subcase
      const oldOwnerPending = loginAndVerify("test-token", "antigravity");
      const session = getSessionSnapshot();
      const oldHandlePending = registerOAuthTask(oldOwnerPending);
      expect(oldHandlePending).not.toBeNull();
      expect(getFlowStoreSnapshot().records.length).toBe(1);

      // Validation drops to pending
      __setSessionValidationStatus(session.sessionEpoch, "pending");
      expect(oldHandlePending!.signal.aborted).toBe(true);
      expect(getFlowStoreSnapshot().records.length).toBe(0);
      expect(getFlowStoreSnapshot().owner).toBeNull();

      // Validation restored to verified for the session with unchanged Scope3
      __setSessionValidationStatus(session.sessionEpoch, "verified");

      // Old owner, structural clone, and omitted owner registration MUST reject
      expect(registerOAuthTask(oldOwnerPending)).toBeNull();
      expect(registerOAuthTask({ ...oldOwnerPending })).toBeNull();
      expect(registerOAuthTask()).toBeNull();
      expect(beginImportFlowTask(oldOwnerPending, "oauth")).toBeNull();
      expect(beginImportFlowTask({ ...oldOwnerPending }, "oauth")).toBeNull();

      // Fresh exact issued owner registers
      const freshOwnerPending = claimImportFlowOwner(capturePanelScope(getSessionSnapshot().sessionEpoch));
      expect(freshOwnerPending).not.toBeNull();
      expect(freshOwnerPending).not.toBe(oldOwnerPending);
      const freshHandlePending = beginImportFlowTask(freshOwnerPending!, "oauth");
      expect(freshHandlePending).not.toBeNull();
      expect(freshHandlePending!.signal.aborted).toBe(false);
      expect(getFlowStoreSnapshot().records.length).toBe(1);

      // Old / cloned owner with fresh handle: stop/reset reject and fresh task remains
      expect(stopImportFlowTask(oldOwnerPending, freshHandlePending!)).toBe(false);
      expect(stopImportFlowTask({ ...freshOwnerPending! }, freshHandlePending!)).toBe(false);
      expect(resetImportFlow(oldOwnerPending)).toBe(false);
      expect(resetImportFlow({ ...freshOwnerPending! })).toBe(false);
      expect(cancelFlowTask(freshHandlePending!, oldOwnerPending)).toBe(false);
      expect(cancelFlowTask(freshHandlePending!, { ...freshOwnerPending! })).toBe(false);
      expect(cancelFlowTask(freshHandlePending!)).toBe(false);
      expect(freshHandlePending!.signal.aborted).toBe(false);
      expect(getFlowStoreSnapshot().records.length).toBe(1);

      // Naked numeric IDs and forged handles reject
      expect(cancelFlowTask(freshHandlePending!.id as unknown as FlowTaskHandle, freshOwnerPending!)).toBe(false);
      expect(
        stopImportFlowTask(
          freshOwnerPending!,
          { id: freshHandlePending!.id, signal: new AbortController().signal } as unknown as ImportFlowTaskHandle,
        ),
      ).toBe(false);
      expect(freshHandlePending!.signal.aborted).toBe(false);
      expect(getFlowStoreSnapshot().records.length).toBe(1);

      // Valid owner + exact handle succeeds
      expect(stopImportFlowTask(freshOwnerPending!, freshHandlePending!)).toBe(true);
      expect(freshHandlePending!.signal.aborted).toBe(true);
      expect(getFlowStoreSnapshot().records.length).toBe(0);

      // 2. Unavailable subcase
      const oldOwnerUnavail = loginAndVerify("test-token", "antigravity");
      const unavailableSession = getSessionSnapshot();
      const oldHandleUnavail = beginImportFlowTask(oldOwnerUnavail, "oauth");
      expect(oldHandleUnavail).not.toBeNull();
      expect(getFlowStoreSnapshot().records.length).toBe(1);

      // Validation drops to unavailable
      expect(__setSessionValidationStatus(unavailableSession.sessionEpoch, "unavailable")).toBe(true);
      expect(oldHandleUnavail!.signal.aborted).toBe(true);
      expect(getFlowStoreSnapshot().records.length).toBe(0);
      expect(getFlowStoreSnapshot().owner).toBeNull();

      // Validation restored to verified for the session
      expect(__setSessionValidationStatus(unavailableSession.sessionEpoch, "verified")).toBe(true);

      // Old owner, structural clone, omitted owner registration reject
      expect(registerOAuthTask(oldOwnerUnavail)).toBeNull();
      expect(registerOAuthTask({ ...oldOwnerUnavail })).toBeNull();
      expect(registerOAuthTask()).toBeNull();
      expect(beginImportFlowTask(oldOwnerUnavail, "oauth")).toBeNull();
      expect(beginImportFlowTask({ ...oldOwnerUnavail }, "oauth")).toBeNull();

      // Fresh exact issued owner registers
      const freshOwnerUnavail = getVerifiedFlowOwner();
      expect(freshOwnerUnavail).not.toBeNull();
      expect(freshOwnerUnavail).not.toBe(oldOwnerUnavail);
      const freshHandleUnavail = registerOAuthTask(freshOwnerUnavail!);
      expect(freshHandleUnavail).not.toBeNull();
      expect(getFlowStoreSnapshot().records.length).toBe(1);

      // Fresh task can be stopped by exact valid owner
      expect(stopImportFlowTask(freshOwnerUnavail!, freshHandleUnavail!)).toBe(true);
      expect(freshHandleUnavail!.signal.aborted).toBe(true);
      expect(getFlowStoreSnapshot().records.length).toBe(0);
    });

    it("supports resetImportFlow with exact owner admission and stale repeated reset as no-op", () => {
      const owner = loginAndVerify("test-token", "antigravity");
      const handle1 = registerOAuthTask(owner);
      const handle2 = registerEmailJob(owner, VALID_JOB_ID_1);
      expect(handle1).not.toBeNull();
      expect(handle2).not.toBeNull();
      expect(getFlowStoreSnapshot().records.length).toBe(2);

      // Cloned owner reset is rejected
      expect(resetImportFlow({ ...owner })).toBe(false);
      expect(handle1!.signal.aborted).toBe(false);
      expect(handle2!.signal.aborted).toBe(false);
      expect(getFlowStoreSnapshot().records.length).toBe(2);

      // Valid reset clears records and aborts active tasks
      const resetOk = resetImportFlow(owner);
      expect(resetOk).toBe(true);
      expect(handle1!.signal.aborted).toBe(true);
      expect(handle2!.signal.aborted).toBe(true);
      expect(getFlowStoreSnapshot().records.length).toBe(0);

      // Stale repeated reset is a no-op and returns false
      expect(resetImportFlow(owner)).toBe(false);

      // Claim a replacement owner
      const replacementOwner = claimImportFlowOwner(capturePanelScope(getSessionSnapshot().sessionEpoch));
      expect(replacementOwner).not.toBeNull();
      expect(replacementOwner).not.toBe(owner);

      // Stale old owner cannot reset replacement owner
      expect(resetImportFlow(owner)).toBe(false);
    });

    it("deduplicates same-owner email jobs and returns existing handle without mutation", () => {
      const owner = loginAndVerify("test-token", "antigravity");

      const handle1 = registerEmailJob(owner, VALID_JOB_ID_1);
      expect(handle1).not.toBeNull();
      expect(getFlowStoreSnapshot().records.length).toBe(1);

      // Register identical job for same owner
      const handle2 = registerEmailJob(owner, VALID_JOB_ID_1);
      expect(handle2).toBe(handle1); // Deduplicated reference!
      expect(getFlowStoreSnapshot().records.length).toBe(1);

      // Different job ID creates distinct task
      const handle3 = registerEmailJob(owner, VALID_JOB_ID_2);
      expect(handle3).not.toBeNull();
      expect(handle3).not.toBe(handle1);
      expect(getFlowStoreSnapshot().records.length).toBe(2);
    });

    it("caps active records at 128 and rejects excess registrations without mutation", () => {
      const owner = loginAndVerify("test-token", "antigravity");

      // Register 128 tasks
      for (let i = 0; i < 128; i++) {
        const handle = registerOAuthTask(owner);
        expect(handle).not.toBeNull();
      }
      expect(getFlowStoreSnapshot().records.length).toBe(128);

      // 129th task must be rejected
      const excessOAuth = registerOAuthTask(owner);
      expect(excessOAuth).toBeNull();

      const excessEmail = registerEmailJob(owner, VALID_JOB_ID_1);
      expect(excessEmail).toBeNull();

      // Registry remains capped at 128 without mutation
      expect(getFlowStoreSnapshot().records.length).toBe(128);
    });

    it("rejects invalid inputs without mutating store", () => {
      const owner = loginAndVerify("test-token", "antigravity");

      // Invalid email job IDs (uppercase hex, non-hex, wrong length)
      expect(registerEmailJob(owner, "0123456789ABCDEF0123456789ABCDEF")).toBeNull();
      expect(registerEmailJob(owner, "not-a-hex-string")).toBeNull();
      expect(registerEmailJob(owner, "0123456789abcdef")).toBeNull(); // 16 chars
      expect(registerEmailJob(owner, "0123456789abcdef0123456789abcdef0")).toBeNull(); // 33 chars

      // Gemini CLI mode does not support email jobs
      __commitPanelChannel("geminicli");
      const gcliOwner = getVerifiedFlowOwner()!;
      expect(registerEmailJob(gcliOwner, VALID_JOB_ID_1)).toBeNull();
      expect(beginImportFlowTask(gcliOwner, "email", VALID_JOB_ID_1)).toBeNull();

      // Registration rejected when session is unverified
      setSessionToken(null);
      expect(registerOAuthTask()).toBeNull();
      expect(registerOAuthTask(owner)).toBeNull();
      expect(registerEmailJob(VALID_JOB_ID_1)).toBeNull();
      expect(registerEmailJob(owner, VALID_JOB_ID_1)).toBeNull();

      expect(getFlowStoreSnapshot().records.length).toBe(0);
    });
  });

  describe("Lifecycle Case 6: Prepublication cleanup blocking and reentrant abort/subscriber registration", () => {
    it("blocks registration during task cancellation abort handler (reentrant abort registration)", () => {
      const owner = loginAndVerify("test-token", "antigravity");
      const handle = registerOAuthTask(owner);
      expect(handle).not.toBeNull();

      let reentrantOAuthResult: FlowTaskHandle | null = undefined as unknown as FlowTaskHandle | null;
      let reentrantEmailResult: FlowTaskHandle | null = undefined as unknown as FlowTaskHandle | null;

      handle!.signal.addEventListener("abort", () => {
        // Reentrant registration attempts during abort notification must be blocked
        reentrantOAuthResult = registerOAuthTask(owner);
        reentrantEmailResult = registerEmailJob(owner, VALID_JOB_ID_1);
      });

      // Cancel the task
      const cancelOk = cancelFlowTask(handle!, owner);
      expect(cancelOk).toBe(true);

      // Both reentrant registrations must have been blocked!
      expect(reentrantOAuthResult).toBeNull();
      expect(reentrantEmailResult).toBeNull();
      expect(getFlowStoreSnapshot().records.length).toBe(0);
    });

    it("blocks registration during Core prepublication cleanup on channel change", () => {
      const owner = loginAndVerify("test-token", "antigravity");
      const handle = registerOAuthTask(owner);
      expect(handle).not.toBeNull();

      let reentrantOAuthResult: FlowTaskHandle | null = undefined as unknown as FlowTaskHandle | null;
      let reentrantEmailResult: FlowTaskHandle | null = undefined as unknown as FlowTaskHandle | null;

      handle!.signal.addEventListener("abort", () => {
        reentrantOAuthResult = registerOAuthTask(owner);
        reentrantEmailResult = registerEmailJob(owner, VALID_JOB_ID_1);
      });

      // Trigger Core prepublication cleanup via channel switch
      __commitPanelChannel("geminicli");

      // Verified that registration was blocked throughout prepublication cleanup
      expect(reentrantOAuthResult).toBeNull();
      expect(reentrantEmailResult).toBeNull();
      expect(getFlowStoreSnapshot().records.length).toBe(0);
    });

    it("safely allows subscriber registration from an abort handler", () => {
      const owner = loginAndVerify("test-token", "antigravity");
      const handle = registerOAuthTask(owner);
      expect(handle).not.toBeNull();

      let reentrantSubscribed = false;
      let listenerCalledCount = 0;
      const subscriberListener = vi.fn(() => {
        listenerCalledCount++;
      });

      handle!.signal.addEventListener("abort", () => {
        subscribeFlowStore(subscriberListener);
        reentrantSubscribed = true;
      });

      cancelFlowTask(handle!, owner);
      expect(reentrantSubscribed).toBe(true);

      // Future mutation triggers the subscriber registered during abort
      registerOAuthTask(owner);
      expect(listenerCalledCount).toBeGreaterThan(0);
    });

    it("preserves owner identity of surviving tasks when a stopped task's abort listener reads snapshot", () => {
      const owner = loginAndVerify("test-token", "antigravity");
      const handle1 = registerOAuthTask(owner);
      const handle2 = registerOAuthTask(owner);
      expect(handle1).not.toBeNull();
      expect(handle2).not.toBeNull();
      expect(getFlowStoreSnapshot().records.length).toBe(2);

      let abortListenerRan = false;
      let snapshotDuringAbort: ReturnType<typeof getFlowStoreSnapshot> | null = null;
      let ownerDuringAbort: ImportFlowOwner | null = null;

      handle1!.signal.addEventListener("abort", () => {
        abortListenerRan = true;
        snapshotDuringAbort = getFlowStoreSnapshot();
        ownerDuringAbort = getVerifiedFlowOwner();
      });

      // Stop Task 1
      const stopped1 = stopImportFlowTask(owner, handle1!);
      expect(stopped1).toBe(true);
      expect(abortListenerRan).toBe(true);
      expect(snapshotDuringAbort).not.toBeNull();
      expect(snapshotDuringAbort!.records.length).toBe(1);
      expect(snapshotDuringAbort!.records[0].id).toBe(handle2!.id);
      expect(ownerDuringAbort).toBe(owner);

      // Owner must still be valid for surviving Task 2!
      expect(handle2!.signal.aborted).toBe(false);
      expect(getFlowStoreSnapshot().records.length).toBe(1);
      const stopped2 = stopImportFlowTask(owner, handle2!);
      expect(stopped2).toBe(true);
      expect(handle2!.signal.aborted).toBe(true);
      expect(getFlowStoreSnapshot().records.length).toBe(0);
    });

    it("safely handles reentrant subscriber registration and unsubscription during subscriber notification", () => {
      const owner = loginAndVerify("test-token", "antigravity");
      const nestedListener = vi.fn();
      const nestedHolder: { unsubscribe: (() => void) | null } = { unsubscribe: null };

      let unsubOuter: (() => void) | null = null;
      const outerListener = vi.fn(() => {
        // Reentrantly subscribe a nested listener
        nestedHolder.unsubscribe = subscribeFlowStore(nestedListener);
        // Reentrantly unsubscribe outer listener
        if (unsubOuter) unsubOuter();
      });

      unsubOuter = subscribeFlowStore(outerListener);

      // Trigger mutation
      registerOAuthTask(owner);
      expect(outerListener).toHaveBeenCalledTimes(1);

      // Next mutation: outer listener was unsubscribed, nested listener is active
      registerOAuthTask(owner);
      expect(outerListener).toHaveBeenCalledTimes(1);
      expect(nestedListener).toHaveBeenCalledTimes(1);

      if (nestedHolder.unsubscribe) nestedHolder.unsubscribe();
    });
  });

  describe("Safe metadata and secrets exclusion", () => {
    it("never retains credentials, tokens, callback URLs, or arbitrary results in store records", () => {
      const owner = loginAndVerify("test-token", "antigravity");
      const oauthHandle = registerOAuthTask(owner);
      const emailHandle = registerEmailJob(owner, VALID_JOB_ID_1);

      const snap = getFlowStoreSnapshot();
      expect(snap.records.length).toBe(2);

      const oauthRecord = snap.records.find((r) => r.id === oauthHandle!.id)!;
      const emailRecord = snap.records.find((r) => r.id === emailHandle!.id)!;

      // Whitelisted safe fields for OAuth:
      expect(Object.keys(oauthRecord).sort()).toEqual([
        "createdAt",
        "id",
        "kind",
        "owner",
        "signal",
        "type",
      ]);
      expect((oauthRecord as Record<string, unknown>).token).toBeUndefined();
      expect((oauthRecord as Record<string, unknown>).password).toBeUndefined();
      expect((oauthRecord as Record<string, unknown>).callbackUrl).toBeUndefined();
      expect((oauthRecord as Record<string, unknown>).url).toBeUndefined();
      expect((oauthRecord as Record<string, unknown>).result).toBeUndefined();

      // Whitelisted safe fields for Email:
      expect(Object.keys(emailRecord).sort()).toEqual([
        "createdAt",
        "id",
        "jobId",
        "kind",
        "owner",
        "signal",
        "type",
      ]);
      expect(emailRecord.jobId).toBe(VALID_JOB_ID_1);
      expect((emailRecord as Record<string, unknown>).token).toBeUndefined();
      expect((emailRecord as Record<string, unknown>).password).toBeUndefined();
    });
  });
});
