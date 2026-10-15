import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  setSessionToken,
  __setSessionValidationStatus,
  getSessionSnapshot,
  getSessionValidationSnapshot,
  type SessionValidationSnapshot,
} from "@/auth/session";
import {
  __commitPanelChannel,
  capturePanelScope,
  type PanelScope,
} from "@/domain/panel";
import { manualResult } from "./model";
import {
  AgQuotaEvidence,
  type AgQuotaEvidenceReceipt,
} from "./AgQuotaEvidence";

function setupVerifiedContext(mode: "antigravity" | "geminicli" = "antigravity") {
  __commitPanelChannel(mode);
  setSessionToken("synthetic-test-token", false);
  const session = getSessionSnapshot();
  const scope = capturePanelScope(session.sessionEpoch);
  const validation = getSessionValidationSnapshot();
  return { mode, scope, session, validation };
}

function createReceipt(
  optionsOrOverrides?: Partial<AgQuotaEvidenceReceipt> & {
    context?: { scope: PanelScope; validation: SessionValidationSnapshot };
  }
): AgQuotaEvidenceReceipt {
  const { context: ctxOverride, ...overrides } = optionsOrOverrides ?? {};
  const effectiveContext = ctxOverride ?? (
    overrides.scope && overrides.validation
      ? { scope: overrides.scope, validation: overrides.validation }
      : setupVerifiedContext("antigravity")
  );

  return Object.freeze({
    source: "response",
    filename: "account.json",
    scope: effectiveContext.scope,
    validation: effectiveContext.validation,
    result: manualResult({
      success: true,
      quota_groups: {
        "gemini-shared": { blockedUnknown: true, restricted: true },
        "claude-gpt-shared": { cooldownUntil: 1780000000 },
      },
      quota_group_states: {
        "gemini-shared": { state: "blocked_unknown", revision: 1 },
      },
      model_access_families: {
        "claude-opus-5-5": { state: "supported", checked_at: 1770000000 },
        "claude-opus-4-6": { state: "supported", checked_at: 1770000000 },
      },
      models: {
        "claude-opus-5-5-low": { remaining: 0.8 },
      },
    }),
    ...overrides,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("Group 1: Evidence, Provenance, Unknowns, Catalog & GCLI display", () => {
  it("GCLI mode renders null and makes 0 fetch calls", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const context = setupVerifiedContext("geminicli");
    const receipt = createReceipt({ context });

    const { container } = render(
      <AgQuotaEvidence
        mode="geminicli"
        scope={context.scope}
        filename="account.json"
        receipt={receipt}
      />
    );

    expect(container.firstChild).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("receipt === null renders placeholder and makes 0 fetch calls", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const context = setupVerifiedContext("antigravity");

    render(
      <AgQuotaEvidence
        mode="antigravity"
        scope={context.scope}
        filename="account.json"
        receipt={null}
      />
    );

    expect(screen.getByText("未获取额度信息")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("provenance display distinguishes response vs saved evidence, and saved is display-only", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const context = setupVerifiedContext("antigravity");
    const liveReceipt = createReceipt({ context, source: "response" });
    const { unmount } = render(
      <AgQuotaEvidence
        mode="antigravity"
        scope={context.scope}
        filename="account.json"
        receipt={liveReceipt}
      />
    );

    expect(screen.getByText("来源：当前响应")).toBeInTheDocument();
    expect(screen.getByTestId("release-quota-btn-gemini-shared")).toBeInTheDocument();
    unmount();

    const savedContext = setupVerifiedContext("antigravity");
    const savedReceipt = createReceipt({ context: savedContext, source: "saved" });
    render(
      <AgQuotaEvidence
        mode="antigravity"
        scope={savedContext.scope}
        filename="account.json"
        receipt={savedReceipt}
      />
    );

    expect(screen.getByText("来源：已保存状态")).toBeInTheDocument();
    expect(screen.getByText("（仅供参考展示，不可用于解除拦截）")).toBeInTheDocument();
    expect(screen.queryByTestId("release-quota-btn-gemini-shared")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("unions known groups with genuine additional canonical group and projects states", () => {
    vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
    const now = Date.now() / 1000;
    const cooldownDeadline = now + 7200;

    const receipt = createReceipt({
      result: manualResult({
        success: true,
        quota_groups: {
          "gemini-shared": { blockedUnknown: true, restricted: true },
          "claude-gpt-shared": { cooldownUntil: cooldownDeadline },
          "custom-tier-group": { restricted: false },
        },
        quota_group_states: {
          "gemini-shared": { state: "blocked_unknown", revision: 1 },
          "claude-gpt-shared": { state: "manual_override", revision: 2 },
        },
      }),
    });

    render(
      <AgQuotaEvidence
        mode="antigravity"
        scope={receipt.scope}
        filename="account.json"
        receipt={receipt}
      />
    );

    expect(screen.getByText(/Gemini：受限，恢复时间未知/)).toBeInTheDocument();
    expect(screen.getByText(/Claude \/ GPT：.*人工解除异常拦截，计时冷却仍有效/)).toBeInTheDocument();
    expect(screen.getByText(/custom-tier-group：未受限/)).toBeInTheDocument();
  });

  it("handles invalid/conflicting quota states and malformed fields safely", () => {
    const receipt = createReceipt({
      result: manualResult({
        success: true,
        quota_state_invalid: true,
        quota_groups: {
          "gemini-shared": { cooldownUntil: -999 },
          "claude-gpt-shared": { blockedUnknown: true, restricted: "invalid" as unknown as boolean },
        },
        quota_group_states: {
          "gemini-shared": { state: "blocked_unknown", revision: 0 },
        },
      }),
    });

    render(
      <AgQuotaEvidence
        mode="antigravity"
        scope={receipt.scope}
        filename="account.json"
        receipt={receipt}
      />
    );

    expect(screen.getByText(/Gemini：状态异常，受限/)).toBeInTheDocument();
    expect(screen.getByText(/Claude \/ GPT：状态异常，受限/)).toBeInTheDocument();
    expect(screen.queryByTestId("release-quota-btn-gemini-shared")).not.toBeInTheDocument();
    expect(screen.queryByTestId("release-quota-btn-claude-gpt-shared")).not.toBeInTheDocument();
  });

  it("empty object in quota_groups displays unknown and does not treat missing evidence as unrestricted", () => {
    const receipt = createReceipt({
      result: manualResult({
        success: true,
        quota_groups: {
          "gemini-shared": {},
        },
      }),
    });

    render(
      <AgQuotaEvidence
        mode="antigravity"
        scope={receipt.scope}
        filename="account.json"
        receipt={receipt}
      />
    );

    expect(screen.getByText(/Gemini：状态不可用/)).toBeInTheDocument();
    expect(screen.queryByText(/未受限/)).not.toBeInTheDocument();
    expect(screen.queryByTestId("release-quota-btn-gemini-shared")).not.toBeInTheDocument();
  });

  it("displays Opus 5.5 and 4.6 with fresh, expired, future checks and independent timestamps", () => {
    vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
    const now = Date.now() / 1000;

    const freshChecked = now - 3600;
    const lastAttempt = now - 1800;
    const nextCheck = now + 7200;
    const blockedUntil = now + 14400;

    const expiredChecked = now - 50000;

    const receipt = createReceipt({
      result: manualResult({
        success: true,
        model_access_families: {
          "claude-opus-5-5": {
            state: "supported",
            checked_at: freshChecked,
            last_attempt_at: lastAttempt,
            next_check_at: nextCheck,
            blocked_until: blockedUntil,
            reason: "directory_timeout",
          },
          "claude-opus-4-6": {
            state: "supported",
            checked_at: expiredChecked,
            reason: "generation_404",
          },
        },
        models: {
          "claude-opus-5-5-high": { remaining: 1.0 },
        },
      }),
    });

    render(
      <AgQuotaEvidence
        mode="antigravity"
        scope={receipt.scope}
        filename="account.json"
        receipt={receipt}
      />
    );

    expect(screen.getByText("Opus 5.5：")).toBeInTheDocument();
    expect(screen.getByText("目录支持")).toBeInTheDocument();
    expect(screen.getByText(/原因：目录查询超时/)).toBeInTheDocument();

    expect(screen.getByText("Opus 4.6：")).toBeInTheDocument();
    expect(screen.getByText("待确认")).toBeInTheDocument();
    expect(screen.getByText(/原因：模型生成不可用 \(404\)/)).toBeInTheDocument();
  });

  it("hides raw secret reasons/errors from being rendered into the DOM", () => {
    vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
    const now = Date.now() / 1000;

    const receipt = createReceipt({
      result: manualResult({
        success: true,
        model_access_families: {
          "claude-opus-5-5": {
            state: "unavailable",
            checked_at: now - 1000,
            reason: "RAW_SECRET_CANARY_REASON_LEAK",
          },
        },
      }),
    });

    const { container } = render(
      <AgQuotaEvidence
        mode="antigravity"
        scope={receipt.scope}
        filename="account.json"
        receipt={receipt}
      />
    );

    expect(screen.getByText("暂不可用")).toBeInTheDocument();
    expect(container).not.toHaveTextContent("RAW_SECRET_CANARY_REASON_LEAK");
  });

  it("shows Opus 5.5 catalog-missing for verified owner while preserving independent timestamps and known reason", () => {
    vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
    const now = Date.now() / 1000;
    const context = setupVerifiedContext("antigravity");

    const receipt = createReceipt({
      context,
      result: manualResult({
        success: true,
        models: {
          "gemini-2.5-pro": { remaining: 0.9 },
          "claude-3-7-sonnet": { remaining: 0.8 },
        },
        model_access_families: {
          "claude-opus-5-5": {
            state: "supported",
            checked_at: now - 100,
            reason: "directory_missing",
          },
          "claude-opus-4-6": {
            state: "supported",
            checked_at: now - 100,
          },
        },
      }),
    });

    render(
      <AgQuotaEvidence
        mode="antigravity"
        scope={context.scope}
        filename="account.json"
        receipt={receipt}
      />
    );

    expect(screen.getByText("目录未提供 5.5 模型")).toBeInTheDocument();
    expect(screen.getByText("目录支持")).toBeInTheDocument();
    expect(screen.getByText(/原因：模型未在目录中提供/)).toBeInTheDocument();
  });

  it("does not apply catalog-missing rule if evidence is saved or owner is unverified", () => {
    const context = setupVerifiedContext("antigravity");
    const receipt = createReceipt({
      context,
      source: "saved",
      result: manualResult({
        success: true,
        models: {
          "gemini-2.5-pro": { remaining: 0.9 },
        },
        model_access_families: {
          "claude-opus-5-5": { state: "supported", checked_at: Date.now() / 1000 - 100 },
        },
      }),
    });

    render(
      <AgQuotaEvidence
        mode="antigravity"
        scope={context.scope}
        filename="account.json"
        receipt={receipt}
      />
    );

    expect(screen.queryByText("目录未提供 5.5 模型")).not.toBeInTheDocument();
  });

  it("inherited model_access_families container remains unknown and does not show directory support", () => {
    vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
    const now = Date.now() / 1000;

    const inheritedData = Object.create(
      {
        model_access_families: {
          "claude-opus-5-5": {
            state: "supported",
            checked_at: now - 3600,
          },
          "claude-opus-4-6": {
            state: "supported",
            checked_at: now - 3600,
          },
        },
      },
      {
        success: {
          value: true,
          enumerable: true,
        },
        models: {
          value: {
            "claude-opus-5-5-low": { remaining: 1.0 },
          },
          enumerable: true,
        },
      }
    );

    const receipt = createReceipt({
      result: manualResult(inheritedData),
    });

    render(
      <AgQuotaEvidence
        mode="antigravity"
        scope={receipt.scope}
        filename="account.json"
        receipt={receipt}
      />
    );

    expect(screen.queryByText("目录支持")).not.toBeInTheDocument();
    expect(screen.queryByText("暂不可用")).not.toBeInTheDocument();
    const unknowns = screen.getAllByText("待确认");
    expect(unknowns.length).toBeGreaterThanOrEqual(2);
  });

  it("inherited family entry state with own valid checked_at remains unknown", () => {
    vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
    const now = Date.now() / 1000;

    const entryProto = { state: "supported" };
    const entry55 = Object.create(entryProto);
    entry55.checked_at = now - 3600;

    const entry46 = Object.create(entryProto);
    entry46.checked_at = now - 3600;

    const receipt = createReceipt({
      result: manualResult({
        success: true,
        models: {
          "claude-opus-5-5-low": { remaining: 1.0 },
        },
        model_access_families: {
          "claude-opus-5-5": entry55,
          "claude-opus-4-6": entry46,
        },
      }),
    });

    render(
      <AgQuotaEvidence
        mode="antigravity"
        scope={receipt.scope}
        filename="account.json"
        receipt={receipt}
      />
    );

    expect(screen.queryByText("目录支持")).not.toBeInTheDocument();
    const unknowns = screen.getAllByText("待确认");
    expect(unknowns.length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/检查时间：/).length).toBe(2);
  });

  it("valid own state controls show support or unavailable, while invalid state remains unknown", () => {
    vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
    const now = Date.now() / 1000;

    const receipt = createReceipt({
      result: manualResult({
        success: true,
        models: {
          "claude-opus-5-5-low": { remaining: 1.0 },
        },
        model_access_families: {
          "claude-opus-5-5": {
            state: "supported",
            checked_at: now - 3600,
          },
          "claude-opus-4-6": {
            state: "unavailable",
            checked_at: now - 3600,
          },
        },
      }),
    });

    const { rerender } = render(
      <AgQuotaEvidence
        mode="antigravity"
        scope={receipt.scope}
        filename="account.json"
        receipt={receipt}
      />
    );

    expect(screen.getByText("目录支持")).toBeInTheDocument();
    expect(screen.getByText("暂不可用")).toBeInTheDocument();

    const invalidStateReceipt = createReceipt({
      result: manualResult({
        success: true,
        models: {
          "claude-opus-5-5-low": { remaining: 1.0 },
        },
        model_access_families: {
          "claude-opus-5-5": {
            state: "unexpected_status_value",
            checked_at: now - 3600,
          },
          "claude-opus-4-6": {
            state: 12345,
            checked_at: now - 3600,
          },
        },
      }),
    });

    rerender(
      <AgQuotaEvidence
        mode="antigravity"
        scope={invalidStateReceipt.scope}
        filename="account.json"
        receipt={invalidStateReceipt}
      />
    );

    expect(screen.queryByText("目录支持")).not.toBeInTheDocument();
    expect(screen.queryByText("暂不可用")).not.toBeInTheDocument();
    const unknowns = screen.getAllByText("待确认");
    expect(unknowns.length).toBeGreaterThanOrEqual(2);
  });

  it("renders verifiedReply and state writeback safely without echoing canary keys", () => {
    const receipt = createReceipt({
      result: manualResult({
        success: true,
        verified_reply: true,
        state_update: {
          quota: { status: "applied" },
          model_access: { status: "pending" },
          TOP_SECRET_CANARY_NAME: { status: "applied" },
        },
      }),
    });

    const { container } = render(
      <AgQuotaEvidence
        mode="antigravity"
        scope={receipt.scope}
        filename="account.json"
        receipt={receipt}
      />
    );

    expect(screen.getByText("固定回复校验：通过")).toBeInTheDocument();
    expect(screen.getByText(/quota：已更新/)).toBeInTheDocument();
    expect(screen.getByText(/model_access：写回结果尚未确认/)).toBeInTheDocument();
    expect(screen.getByText(/其他状态写回：已更新/)).toBeInTheDocument();
    expect(container).not.toHaveTextContent("TOP_SECRET_CANARY_NAME");
  });

  it("mode switch from antigravity to geminicli renders null and aborts work", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const context = setupVerifiedContext("antigravity");
    const receipt = createReceipt({ context });

    const { rerender, container } = render(
      <AgQuotaEvidence
        mode="antigravity"
        scope={context.scope}
        filename="account.json"
        receipt={receipt}
      />
    );
    expect(screen.getByText("额度保护与目录支持")).toBeInTheDocument();

    const gcliScope = capturePanelScope(context.session.sessionEpoch);
    rerender(
      <AgQuotaEvidence
        mode="geminicli"
        scope={gcliScope}
        filename="account.json"
        receipt={receipt}
      />
    );

    expect(container.firstChild).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });
});

type ClickHandler = (event?: unknown) => unknown;

type FiberNode = {
  return?: unknown;
  memoizedProps?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readDynamicProperty(target: unknown, key: string): unknown {
  if (isRecord(target) && key in target) {
    return target[key];
  }
  return undefined;
}

function captureElementClickHandler(element: Element): () => Promise<void> | void {
  const propNames = Object.getOwnPropertyNames(element);
  const fiberKey = propNames.find((key) => key.startsWith("__reactFiber$"));

  if (fiberKey) {
    const fiberProp = readDynamicProperty(element, fiberKey);
    let current: FiberNode | null = isRecord(fiberProp) ? (fiberProp as FiberNode) : null;

    let candidateHandler: ClickHandler | null = null;
    while (current) {
      if (isRecord(current.memoizedProps) && "onClick" in current.memoizedProps) {
        const fn = current.memoizedProps.onClick;
        if (typeof fn === "function") {
          candidateHandler = fn as ClickHandler;
        }
      }
      current = isRecord(current.return) ? (current.return as FiberNode) : null;
    }

    if (candidateHandler) {
      const handler = candidateHandler;
      return () => {
        const res = handler({
          defaultPrevented: true,
          preventDefault: () => {},
          stopPropagation: () => {},
        });
        if (res instanceof Promise) {
          return res as Promise<void>;
        }
      };
    }
  }

  const propsKey = propNames.find((key) => key.startsWith("__reactProps$"));
  if (propsKey) {
    const props = readDynamicProperty(element, propsKey);
    if (isRecord(props) && typeof props.onClick === "function") {
      const handler = props.onClick as ClickHandler;
      return () => {
        const res = handler({
          defaultPrevented: true,
          preventDefault: () => {},
          stopPropagation: () => {},
        });
        if (res instanceof Promise) {
          return res as Promise<void>;
        }
      };
    }
  }

  throw new Error("Could not find click handler on element");
}


describe("Group 2: Release Lifecycle with Real Core, Session & Adapter", () => {
  it("Cancel in confirmation dialog executes 0 fetch calls and leaves ticket unconsumed", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const receipt = createReceipt();

    render(
      <AgQuotaEvidence
        mode="antigravity"
        scope={receipt.scope}
        filename="account.json"
        receipt={receipt}
      />
    );

    const releaseBtn = screen.getByTestId("release-quota-btn-gemini-shared");
    fireEvent.click(releaseBtn);

    expect(screen.getByText("确认解除异常拦截")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(0);

    const cancelBtn = screen.getByTestId("cancel-release-btn");
    fireEvent.click(cancelBtn);

    await waitFor(() => {
      expect(screen.queryByText("确认解除异常拦截")).not.toBeInTheDocument();
    });

    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(screen.getByTestId("release-quota-btn-gemini-shared")).toBeInTheDocument();
  });

  it("Confirm executes exactly 1 POST to creds/action, consumes ticket, preserves cooldown and calls onRefresh", async () => {
    const receipt = createReceipt();

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          quota_group_states: {
            "gemini-shared": { state: "manual_override", revision: 2 },
            "claude-gpt-shared": { state: "blocked_unknown", revision: 1 },
          },
          model_cooldowns: {
            "claude-3-7-sonnet": 1780000000,
          },
          quota_groups: {
            "gemini-shared": { cooldownUntil: 1780000000 },
          },
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const onRefreshMock = vi.fn();

    render(
      <AgQuotaEvidence
        mode="antigravity"
        scope={receipt.scope}
        filename="account.json"
        receipt={receipt}
        onRefresh={onRefreshMock}
      />
    );

    fireEvent.click(screen.getByTestId("release-quota-btn-gemini-shared"));
    fireEvent.click(screen.getByTestId("confirm-release-btn"));

    await waitFor(() => {
      expect(screen.getByText("异常拦截已解除，计时冷却仍有效。")).toBeInTheDocument();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0];
    expect(calledUrl.toString()).toBe("http://localhost:3000/creds/action?mode=antigravity");
    expect(calledInit.method).toBe("POST");
    expect(JSON.parse(calledInit.body as string)).toEqual({
      filename: "account.json",
      action: "release_quota_group",
      group: "gemini-shared",
    });

    expect(onRefreshMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("release-quota-btn-gemini-shared")).not.toBeInTheDocument();
  });

  it("retained old confirm/cancel handlers cannot confirm or cancel a newer actor", async () => {
    const context = setupVerifiedContext("antigravity");
    const receipt = createReceipt({ context });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AgQuotaEvidence
        mode="antigravity"
        scope={context.scope}
        filename="account.json"
        receipt={receipt}
      />
    );

    // Open confirm dialog (creates actor 1)
    fireEvent.click(screen.getByTestId("release-quota-btn-gemini-shared"));
    expect(screen.getByText("确认解除异常拦截")).toBeInTheDocument();

    // Capture the actual click handlers for actor 1
    const oldConfirmHandler = captureElementClickHandler(screen.getByTestId("confirm-release-btn"));
    const oldCancelHandler = captureElementClickHandler(screen.getByTestId("cancel-release-btn"));

    // Cancel closes dialog and retires actor 1
    fireEvent.click(screen.getByTestId("cancel-release-btn"));
    await waitFor(() => {
      expect(screen.queryByText("确认解除异常拦截")).not.toBeInTheDocument();
    });

    // Invoking the old confirm handler while closed does nothing because actor 1 is retired
    await oldConfirmHandler();
    expect(fetchMock).toHaveBeenCalledTimes(0);

    // Reopen confirmation dialog (creates a genuinely new actor 2)
    fireEvent.click(screen.getByTestId("release-quota-btn-gemini-shared"));
    expect(screen.getByText("确认解除异常拦截")).toBeInTheDocument();

    // Invoking the retained old cancel handler cannot cancel the new actor 2
    oldCancelHandler();
    expect(screen.getByText("确认解除异常拦截")).toBeInTheDocument();

    // Invoking the retained old confirm handler while actor 2 is active does not send any request
    await oldConfirmHandler();
    expect(fetchMock).toHaveBeenCalledTimes(0);

    // Confirm the new dialog with the current confirm button
    const currentConfirmBtn = screen.getByTestId("confirm-release-btn");
    fireEvent.click(currentConfirmBtn);

    await waitFor(() => {
      expect(screen.getByText("异常拦截已解除，计时冷却仍有效。")).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("remounting with same receipt preserves consumed ticket and rejects duplicate release", async () => {
    const receipt = createReceipt();

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { unmount } = render(
      <AgQuotaEvidence
        mode="antigravity"
        scope={receipt.scope}
        filename="account.json"
        receipt={receipt}
      />
    );

    fireEvent.click(screen.getByTestId("release-quota-btn-gemini-shared"));
    fireEvent.click(screen.getByTestId("confirm-release-btn"));

    await waitFor(() => {
      expect(screen.getByText("异常拦截已解除，计时冷却仍有效。")).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    unmount();

    render(
      <AgQuotaEvidence
        mode="antigravity"
        scope={receipt.scope}
        filename="account.json"
        receipt={receipt}
      />
    );

    expect(screen.getByText("已提交解除申请")).toBeInTheDocument();
    expect(screen.queryByTestId("release-quota-btn-gemini-shared")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const freshReceipt = createReceipt({ filename: "account.json" });
    render(
      <AgQuotaEvidence
        mode="antigravity"
        scope={freshReceipt.scope}
        filename="account.json"
        receipt={freshReceipt}
      />
    );

    expect(screen.getByTestId("release-quota-btn-gemini-shared")).toBeInTheDocument();
  });

  it("unconsumed receipt A->B->A retires receipt A and prevents revival", () => {
    const context = setupVerifiedContext("antigravity");
    const receiptA = createReceipt({ context });
    const receiptB = createReceipt({
      context,
      result: manualResult({
        success: true,
        quota_groups: {
          "gemini-shared": { restricted: false },
        },
      }),
    });

    const { rerender } = render(
      <AgQuotaEvidence
        mode="antigravity"
        scope={context.scope}
        filename="account.json"
        receipt={receiptA}
      />
    );
    expect(screen.getByTestId("release-quota-btn-gemini-shared")).toBeInTheDocument();

    // Switch receipt to B (loss of A retires A's tickets)
    rerender(
      <AgQuotaEvidence
        mode="antigravity"
        scope={context.scope}
        filename="account.json"
        receipt={receiptB}
      />
    );
    expect(screen.queryByTestId("release-quota-btn-gemini-shared")).not.toBeInTheDocument();

    // Switch back to receipt A (A->B->A)
    rerender(
      <AgQuotaEvidence
        mode="antigravity"
        scope={context.scope}
        filename="account.json"
        receipt={receiptA}
      />
    );
    // Receipt A was retired and eligibility cannot revive
    expect(screen.queryByTestId("release-quota-btn-gemini-shared")).not.toBeInTheDocument();
  });

  it("unconsumed remount retires receipt and prevents revival", () => {
    const context = setupVerifiedContext("antigravity");
    const receipt = createReceipt({ context });

    const { unmount } = render(
      <AgQuotaEvidence
        mode="antigravity"
        scope={context.scope}
        filename="account.json"
        receipt={receipt}
      />
    );
    expect(screen.getByTestId("release-quota-btn-gemini-shared")).toBeInTheDocument();

    // Unmount before dispatch
    unmount();

    // Remount with same receipt
    render(
      <AgQuotaEvidence
        mode="antigravity"
        scope={context.scope}
        filename="account.json"
        receipt={receipt}
      />
    );
    // Unconsumed remount does not revive eligibility
    expect(screen.queryByTestId("release-quota-btn-gemini-shared")).not.toBeInTheDocument();
  });

  it("failed release leaves ticket consumed without retry button", async () => {
    const receipt = createReceipt();

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: "conflict" }), { status: 409 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const onRefreshMock = vi.fn();

    render(
      <AgQuotaEvidence
        mode="antigravity"
        scope={receipt.scope}
        filename="account.json"
        receipt={receipt}
        onRefresh={onRefreshMock}
      />
    );

    fireEvent.click(screen.getByTestId("release-quota-btn-gemini-shared"));
    fireEvent.click(screen.getByTestId("confirm-release-btn"));

    await waitFor(() => {
      expect(screen.getByText("操作未完成，请重试。")).toBeInTheDocument();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onRefreshMock).toHaveBeenCalledTimes(0);
    expect(screen.queryByTestId("release-quota-btn-gemini-shared")).not.toBeInTheDocument();
  });

  it("channel ABA aborts in-flight request and leaves deferred resolution inert", async () => {
    const context = setupVerifiedContext("antigravity");
    const receipt = createReceipt({ context });

    let resolveFetch!: (val: Response) => void;
    const deferredFetch = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    );
    vi.stubGlobal("fetch", deferredFetch);

    const onRefreshMock = vi.fn();

    render(
      <AgQuotaEvidence
        mode="antigravity"
        scope={context.scope}
        filename="account.json"
        receipt={receipt}
        onRefresh={onRefreshMock}
      />
    );

    fireEvent.click(screen.getByTestId("release-quota-btn-gemini-shared"));
    fireEvent.click(screen.getByTestId("confirm-release-btn"));

    expect(deferredFetch).toHaveBeenCalledTimes(1);

    // Channel ABA: change channel and switch back
    __commitPanelChannel("geminicli");
    __commitPanelChannel("antigravity");

    resolveFetch(new Response(JSON.stringify({ success: true }), { status: 200 }));
    await new Promise((r) => setTimeout(r, 20));

    expect(onRefreshMock).toHaveBeenCalledTimes(0);
  });

  it("same-Scope validation ABA aborts in-flight request and leaves deferred resolution inert", async () => {
    const receipt = createReceipt();

    let resolveFetch!: (val: Response) => void;
    const deferredFetch = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    );
    vi.stubGlobal("fetch", deferredFetch);

    const onRefreshMock = vi.fn();

    render(
      <AgQuotaEvidence
        mode="antigravity"
        scope={receipt.scope}
        filename="account.json"
        receipt={receipt}
        onRefresh={onRefreshMock}
      />
    );

    fireEvent.click(screen.getByTestId("release-quota-btn-gemini-shared"));
    fireEvent.click(screen.getByTestId("confirm-release-btn"));

    expect(deferredFetch).toHaveBeenCalledTimes(1);

    const session = getSessionSnapshot();
    __setSessionValidationStatus(session.sessionEpoch, "unavailable");
    __setSessionValidationStatus(session.sessionEpoch, "verified");

    resolveFetch(new Response(JSON.stringify({ success: true }), { status: 200 }));

    await new Promise((r) => setTimeout(r, 20));

    expect(onRefreshMock).toHaveBeenCalledTimes(0);
  });

  it("stale UI outcome from prior release does not leak to a new receipt or owner", async () => {
    const context1 = setupVerifiedContext("antigravity");
    const receipt1 = createReceipt({ context: context1 });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(
      <AgQuotaEvidence
        mode="antigravity"
        scope={context1.scope}
        filename="account.json"
        receipt={receipt1}
      />
    );

    fireEvent.click(screen.getByTestId("release-quota-btn-gemini-shared"));
    fireEvent.click(screen.getByTestId("confirm-release-btn"));

    await waitFor(() => {
      expect(screen.getByText("异常拦截已解除，计时冷却仍有效。")).toBeInTheDocument();
    });

    const context2 = setupVerifiedContext("antigravity");
    const receipt2 = createReceipt({
      context: context2,
      result: manualResult({
        success: true,
        quota_groups: {
          "gemini-shared": { restricted: false },
        },
      }),
    });

    rerender(
      <AgQuotaEvidence
        mode="antigravity"
        scope={context2.scope}
        filename="account.json"
        receipt={receipt2}
      />
    );

    expect(screen.queryByText("异常拦截已解除，计时冷却仍有效。")).not.toBeInTheDocument();
  });

  it("raw canary payloads from transport are never exposed in DOM", async () => {
    const receipt = createReceipt();

    const canaryPayload = {
      success: true,
      canary_secret_token: "CANARY_TOKEN_TOP_SECRET",
      canary_error_message: "CANARY_ERROR_PRIVATE_LEAK",
      quota_group_states: {
        "gemini-shared": { state: "manual_override", revision: 1 },
      },
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(canaryPayload), { status: 200 })
      )
    );

    const { container } = render(
      <AgQuotaEvidence
        mode="antigravity"
        scope={receipt.scope}
        filename="account.json"
        receipt={receipt}
      />
    );

    fireEvent.click(screen.getByTestId("release-quota-btn-gemini-shared"));
    fireEvent.click(screen.getByTestId("confirm-release-btn"));

    await waitFor(() => {
      expect(screen.getByText("异常拦截已解除，计时冷却仍有效。")).toBeInTheDocument();
    });

    expect(container).not.toHaveTextContent("CANARY_TOKEN_TOP_SECRET");
    expect(container).not.toHaveTextContent("CANARY_ERROR_PRIVATE_LEAK");
  });
});
