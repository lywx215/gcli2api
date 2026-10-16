import { render, screen, fireEvent, act, within } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { LegacyModelQuota } from "./LegacyModelQuota";
import {
  getSessionSnapshot,
  getSessionValidationSnapshot,
  setSessionToken,
  invalidateSession,
  __setSessionValidationStatus,
} from "@/auth/session";
import {
  capturePanelScope,
  isPanelScopeCurrent,
  __commitPanelChannel,
  type PanelScope,
} from "@/domain/panel";

describe("LegacyModelQuota regression group 1: display, identity, remaining, reset, and explicit test callback", () => {
  const dummyScope: PanelScope = Object.freeze({
    mode: "antigravity",
    channelEpoch: 0,
    sessionEpoch: 0,
  });

  const dummyIsCurrent = () => true;

  it("renders only own model-map entries and ignores prototype properties", () => {
    const protoObj = {
      polluted_model: {
        displayName: "Polluted Model",
        remaining: 0.5,
      },
    };
    const ownModels = Object.create(protoObj) as Record<string, unknown>;
    ownModels.valid_model = {
      displayName: "Valid Model",
      rawModelId: "valid-model-id",
      remaining: 0.8,
      testModel: "valid-model-id",
    };

    render(
      <LegacyModelQuota
        models={ownModels}
        mode="antigravity"
        busy={false}
        scope={dummyScope}
        isCurrent={dummyIsCurrent}
        onTestModel={vi.fn()}
      />
    );

    expect(screen.getByText("Valid Model")).toBeInTheDocument();
    expect(screen.queryByText("Polluted Model")).not.toBeInTheDocument();
  });

  it("ignores inherited inner model fields so prototype properties cannot create quota, reset time, target, or badges", () => {
    const protoModel = {
      remaining: 0.95,
      quotaInfoPresent: true,
      remainingPresent: true,
      remainingValid: true,
      resetTimeRaw: "2026-10-13T00:30:00Z",
      visible: false,
      testModel: "inherited-target",
      public: true,
      availability: "available",
      badge: "Pro",
    };
    const inheritedModel = Object.create(protoModel);
    inheritedModel.displayName = "Model With Inherited Inner Fields";

    const models: Record<string, unknown> = {
      inherited_key: inheritedModel,
    };

    render(
      <LegacyModelQuota
        models={models}
        mode="antigravity"
        busy={false}
        scope={dummyScope}
        isCurrent={dummyIsCurrent}
        onTestModel={vi.fn()}
      />
    );

    // Visible because inherited visible:false is ignored (only own visible===false hides)
    expect(screen.getByText("Model With Inherited Inner Fields")).toBeInTheDocument();
    // Remaining is unknown because inherited remaining is ignored
    expect(screen.getByText("未知")).toBeInTheDocument();
    // Recovery time unknown because inherited resetTimeRaw is ignored
    expect(screen.getByText("恢复时间：恢复时间未知")).toBeInTheDocument();
    // Test button disabled because inherited testModel is ignored
    expect(screen.getByRole("button", { name: "测试 Model With Inherited Inner Fields" })).toBeDisabled();
    // AG badges not rendered because inherited public/availability/badge are ignored
    expect(screen.queryByText("公开")).not.toBeInTheDocument();
    expect(screen.queryByText("可用")).not.toBeInTheDocument();
    expect(screen.queryByText("Pro")).not.toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "剩余额度未知" })).not.toHaveAttribute("aria-valuenow");
  });

  it("hides models when visible===false, but not when visible is omitted, true, or string", () => {
    const models: Record<string, unknown> = {
      hidden_model: {
        displayName: "Hidden Model",
        visible: false,
        remaining: 0.5,
      },
      omitted_visible: {
        displayName: "Omitted Visible Model",
        remaining: 0.5,
      },
      string_visible: {
        displayName: "String Visible Model",
        visible: "false",
        remaining: 0.5,
      },
      explicit_true: {
        displayName: "Explicit True Model",
        visible: true,
        remaining: 0.5,
      },
    };

    render(
      <LegacyModelQuota
        models={models}
        mode="antigravity"
        busy={false}
        scope={dummyScope}
        isCurrent={dummyIsCurrent}
        onTestModel={vi.fn()}
      />
    );

    expect(screen.queryByText("Hidden Model")).not.toBeInTheDocument();
    expect(screen.getByText("Omitted Visible Model")).toBeInTheDocument();
    expect(screen.getByText("String Visible Model")).toBeInTheDocument();
    expect(screen.getByText("Explicit True Model")).toBeInTheDocument();
  });

  it("preserves raw map key and rawModelId with accessible friendly/raw label toggle", () => {
    const models: Record<string, unknown> = {
      "model-key-1": {
        displayName: "Friendly Claude 3.5",
        rawModelId: "claude-3-5-sonnet-raw",
        remaining: 0.6,
        testModel: "claude-3-5-sonnet-raw",
      },
    };

    render(
      <LegacyModelQuota
        models={models}
        mode="antigravity"
        busy={false}
        scope={dummyScope}
        isCurrent={dummyIsCurrent}
        onTestModel={vi.fn()}
      />
    );

    // Initial state: friendly name displayed as main title, raw ID as secondary
    const toggleButton = screen.getByRole("button", { name: "切换为原始标识" });
    expect(toggleButton).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("Friendly Claude 3.5")).toBeInTheDocument();
    expect(screen.getByText("claude-3-5-sonnet-raw")).toBeInTheDocument();

    // Toggle to raw identifier
    fireEvent.click(toggleButton);
    expect(toggleButton).toHaveAttribute("aria-pressed", "true");
    expect(toggleButton).toHaveTextContent("显示友好名称");

    // Raw model ID is now main title, friendly name is secondary
    const titleHeader = screen.getByRole("heading", { level: 4, name: "claude-3-5-sonnet-raw" });
    expect(titleHeader).toBeInTheDocument();
    expect(screen.getByText("Friendly Claude 3.5")).toBeInTheDocument();

    // Toggle back to friendly name
    fireEvent.click(toggleButton);
    expect(toggleButton).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("heading", { level: 4, name: "Friendly Claude 3.5" })).toBeInTheDocument();
  });

  it("groups AG models by public/available/compatible with stable sorting", () => {
    const models: Record<string, unknown> = {
      "z-compatible": {
        displayName: "Compatible Z",
        availability: "compatible",
        public: false,
        remaining: 0.5,
      },
      "a-public": {
        displayName: "Public A",
        public: true,
        remaining: 0.8,
      },
      "b-available": {
        displayName: "Available B",
        availability: "available",
        public: false,
        remaining: 0.7,
      },
      "a-compatible": {
        displayName: "Compatible A",
        availability: "compatible",
        public: false,
        remaining: 0.4,
      },
      "other-model": {
        displayName: "Other Model",
        remaining: 0.2,
      },
    };

    render(
      <LegacyModelQuota
        models={models}
        mode="antigravity"
        busy={false}
        scope={dummyScope}
        isCurrent={dummyIsCurrent}
        onTestModel={vi.fn()}
      />
    );

    // Check AG group headers
    expect(screen.getByRole("region", { name: "公开模型" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "可用模型" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "兼容模型" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "其他模型" })).toBeInTheDocument();

    // Within "兼容模型", "a-compatible" must appear before "z-compatible" (stable key sort)
    const compatibleRegion = screen.getByRole("region", { name: "兼容模型" });
    const textContent = compatibleRegion.textContent || "";
    const indexA = textContent.indexOf("Compatible A");
    const indexZ = textContent.indexOf("Compatible Z");
    expect(indexA).toBeGreaterThan(-1);
    expect(indexZ).toBeGreaterThan(-1);
    expect(indexA).toBeLessThan(indexZ);
  });

  it("does not fabricate AG catalog metadata in GCLI mode", () => {
    const models: Record<string, unknown> = {
      "gemini-2.5-pro": {
        displayName: "Gemini 2.5 Pro",
        public: true,
        availability: "available",
        remaining: 0.9,
      },
      "gemini-2.5-flash": {
        displayName: "Gemini 2.5 Flash",
        availability: "compatible",
        remaining: 0.8,
      },
    };

    const gcliScope: PanelScope = Object.freeze({
      mode: "geminicli",
      channelEpoch: 0,
      sessionEpoch: 0,
    });

    render(
      <LegacyModelQuota
        models={models}
        mode="geminicli"
        busy={false}
        scope={gcliScope}
        isCurrent={dummyIsCurrent}
        onTestModel={vi.fn()}
      />
    );

    // No AG group regions should exist
    expect(screen.queryByRole("region", { name: "公开模型" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "可用模型" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "兼容模型" })).not.toBeInTheDocument();

    // Both cards should be rendered
    expect(screen.getByText("Gemini 2.5 Pro")).toBeInTheDocument();
    expect(screen.getByText("Gemini 2.5 Flash")).toBeInTheDocument();
  });

  it("handles known finite remaining fractions, tiny-positive, near-one, and unknown fallbacks", () => {
    const models: Record<string, unknown> = {
      zero: { remaining: 0 },
      full: { remaining: 1 },
      fraction: { remaining: 0.43 },
      tiny: { remaining: 0.00001 },
      near_one: { remaining: 0.99999 },
      negative: { remaining: -0.1 },
      overfull: { remaining: 1.1 },
      nan: { remaining: NaN },
      str: { remaining: "0.5" },
      missing: {},
      flag_quota_info_false: { remaining: 0.8, quotaInfoPresent: false },
      flag_remaining_present_false: { remaining: 0.8, remainingPresent: false },
      flag_remaining_valid_false: { remaining: 0.8, remainingValid: false },
    };

    render(
      <LegacyModelQuota
        models={models}
        mode="antigravity"
        busy={false}
        scope={dummyScope}
        isCurrent={dummyIsCurrent}
        onTestModel={vi.fn()}
      />
    );

    expect(screen.getByText("0%")).toBeInTheDocument();
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(screen.getByText("43%")).toBeInTheDocument();
    expect(screen.getByText("<0.01%")).toBeInTheDocument();
    expect(screen.getByText(">99.99%")).toBeInTheDocument();

    // Unknown items: negative, overfull, nan, str, missing, flag_quota_info_false, flag_remaining_present_false, flag_remaining_valid_false
    const unknownElements = screen.getAllByText("未知");
    expect(unknownElements.length).toBe(8);

    // Unknown progressbar must not have aria-valuenow
    const unknownBars = screen.getAllByRole("progressbar", { name: "剩余额度未知" });
    expect(unknownBars.length).toBe(8);
    for (const bar of unknownBars) {
      expect(bar).not.toHaveAttribute("aria-valuenow");
    }

    // Known progressbar has aria-valuenow
    const fullBar = screen.getByRole("progressbar", { name: "剩余额度 100%" });
    expect(fullBar).toHaveAttribute("aria-valuenow", "100");
  });

  it("enforces warm-gray card styling with 14px radius, 15/16px padding, and 6px meter", () => {
    const models: Record<string, unknown> = {
      model_a: {
        displayName: "Model A",
        remaining: 0.75,
      },
    };

    render(
      <LegacyModelQuota
        models={models}
        mode="antigravity"
        busy={false}
        scope={dummyScope}
        isCurrent={dummyIsCurrent}
        onTestModel={vi.fn()}
      />
    );

    const card = screen.getByRole("article", { name: "模型 Model A" });
    expect(card.className).toContain("rounded-[14px]");
    expect(card.className).toContain("p-4");

    const meter = screen.getByRole("progressbar", { name: "剩余额度 75%" });
    expect(meter.className).toContain("h-[6px]");
    const fill = meter.firstElementChild as HTMLElement;
    expect(fill).toHaveStyle({ backgroundColor: "rgb(16, 185, 129)" }); // #10b981
  });

  it("formats valid zoned resetTimeRaw into Beijing time and rejects rolling or invalid dates", () => {
    const models: Record<string, unknown> = {
      utc_valid: {
        displayName: "UTC Valid",
        resetTimeRaw: "2026-10-13T00:30:00Z",
      },
      offset_valid: {
        displayName: "Offset Valid",
        resetTimeRaw: "2026-10-13T08:30:00+08:00",
      },
      rolling_model: {
        displayName: "Rolling Model",
        rolling168h: true,
        resetTimeRaw: "2026-10-20T00:30:00Z",
      },
      invalid_day: {
        displayName: "Invalid Day",
        resetTimeRaw: "2026-02-30T00:30:00Z",
      },
      invalid_offset: {
        displayName: "Invalid Offset",
        resetTimeRaw: "2026-10-13T00:30:00+24:00",
      },
      without_zone: {
        displayName: "Without Zone",
        resetTimeRaw: "2026-10-13T00:30:00",
      },
      legacy_display_only: {
        displayName: "Legacy Display Only",
        resetTime: "SYNTHETIC_LEGACY_RAW_TEXT",
      },
    };

    const { container } = render(
      <LegacyModelQuota
        models={models}
        mode="antigravity"
        busy={false}
        scope={dummyScope}
        isCurrent={dummyIsCurrent}
        onTestModel={vi.fn()}
      />
    );

    // Test365: Both UTC and +08 valid cards produce the equivalent Beijing time display
    const utcCard = screen.getByRole("article", { name: "模型 UTC Valid" });
    expect(within(utcCard).getByText("恢复时间：2026/10/13 08:30:00（北京时间）")).toBeInTheDocument();

    const offsetCard = screen.getByRole("article", { name: "模型 Offset Valid" });
    expect(within(offsetCard).getByText("恢复时间：2026/10/13 08:30:00（北京时间）")).toBeInTheDocument();

    expect(screen.getAllByText("恢复时间：2026/10/13 08:30:00（北京时间）")).toHaveLength(2);
    expect(screen.getByText("恢复时间：恢复时间未知（上游滚动 168h）")).toBeInTheDocument();
    expect(container).not.toHaveTextContent("SYNTHETIC_LEGACY_RAW_TEXT");
  });

  it("handles testModel click with exact target, and safe disable rules without auto calls", () => {
    const onTestModelAg = vi.fn();
    const agModels: Record<string, unknown> = {
      model_with_test_model: {
        displayName: "With Test Model",
        testModel: "exact-target-id",
      },
      model_empty_target: {
        displayName: "Empty Target",
        testModel: "",
      },
      model_null_target: {
        displayName: "Null Target AG",
        testModel: null,
      },
      model_undefined_target: {
        displayName: "Undefined Target AG",
        testModel: undefined,
      },
      model_missing_target: {
        displayName: "Missing Target AG",
      },
    };

    render(
      <LegacyModelQuota
        models={agModels}
        mode="antigravity"
        busy={false}
        scope={dummyScope}
        isCurrent={dummyIsCurrent}
        onTestModel={onTestModelAg}
      />
    );

    // No automatic call on render
    expect(onTestModelAg).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();

    // Valid target in AG can be clicked
    const validBtn = screen.getByRole("button", { name: "测试 With Test Model" });
    expect(validBtn).not.toBeDisabled();
    fireEvent.click(validBtn);
    expect(onTestModelAg).toHaveBeenCalledTimes(1);
    expect(onTestModelAg).toHaveBeenCalledWith("exact-target-id");

    // Empty testModel disables safely
    const emptyBtn = screen.getByRole("button", { name: "测试 Empty Target" });
    expect(emptyBtn).toBeDisabled();

    // Present null testModel disables safely
    const nullBtn = screen.getByRole("button", { name: "测试 Null Target AG" });
    expect(nullBtn).toBeDisabled();

    // Present undefined testModel disables safely
    const undefinedBtn = screen.getByRole("button", { name: "测试 Undefined Target AG" });
    expect(undefinedBtn).toBeDisabled();

    // Missing AG target disables safely
    const missingAgBtn = screen.getByRole("button", { name: "测试 Missing Target AG" });
    expect(missingAgBtn).toBeDisabled();
  });

  it("allows older GCLI missing testModel to fall back to nonempty raw map key, while present null or undefined disables safely", () => {
    const onTestModelGcli = vi.fn();
    const gcliModels: Record<string, unknown> = {
      "gemini-1.5-pro": {
        displayName: "Gemini 1.5 Pro",
        // testModel is omitted/absent
      },
      "gemini-null-target": {
        displayName: "Gemini Null Target",
        testModel: null,
      },
      "gemini-undefined-target": {
        displayName: "Gemini Undefined Target",
        testModel: undefined,
      },
      "gemini-empty-target": {
        displayName: "Gemini Empty Target",
        testModel: "",
      },
    };
    const gcliScope: PanelScope = Object.freeze({
      mode: "geminicli",
      channelEpoch: 0,
      sessionEpoch: 0,
    });

    render(
      <LegacyModelQuota
        models={gcliModels}
        mode="geminicli"
        busy={false}
        scope={gcliScope}
        isCurrent={dummyIsCurrent}
        onTestModel={onTestModelGcli}
      />
    );

    // 1. Absent target falls back to raw map key
    const testBtn = screen.getByRole("button", { name: "测试 Gemini 1.5 Pro" });
    expect(testBtn).not.toBeDisabled();
    fireEvent.click(testBtn);
    expect(onTestModelGcli).toHaveBeenCalledTimes(1);
    expect(onTestModelGcli).toHaveBeenCalledWith("gemini-1.5-pro");

    // 2. Present null target disables safely (does NOT fall back to raw map key)
    const nullBtn = screen.getByRole("button", { name: "测试 Gemini Null Target" });
    expect(nullBtn).toBeDisabled();

    // 3. Present undefined target disables safely (does NOT fall back to raw map key)
    const undefinedBtn = screen.getByRole("button", { name: "测试 Gemini Undefined Target" });
    expect(undefinedBtn).toBeDisabled();

    // 4. Present empty target disables safely
    const emptyBtn = screen.getByRole("button", { name: "测试 Gemini Empty Target" });
    expect(emptyBtn).toBeDisabled();
  });

  it("disables test button when busy, scope mode mismatch, or not current", () => {
    const onTest = vi.fn();
    const models: Record<string, unknown> = {
      model_1: {
        displayName: "Model 1",
        testModel: "target-1",
      },
    };

    // 1. busy === true
    const { rerender } = render(
      <LegacyModelQuota
        models={models}
        mode="antigravity"
        busy={true}
        scope={dummyScope}
        isCurrent={dummyIsCurrent}
        onTestModel={onTest}
      />
    );
    expect(screen.getByRole("button", { name: "测试 Model 1" })).toBeDisabled();

    // 2. scope.mode !== mode
    const mismatchedScope: PanelScope = Object.freeze({
      mode: "geminicli",
      channelEpoch: 0,
      sessionEpoch: 0,
    });
    rerender(
      <LegacyModelQuota
        models={models}
        mode="antigravity"
        busy={false}
        scope={mismatchedScope}
        isCurrent={dummyIsCurrent}
        onTestModel={onTest}
      />
    );
    expect(screen.getByRole("button", { name: "测试 Model 1" })).toBeDisabled();

    // 3. !isCurrent()
    rerender(
      <LegacyModelQuota
        models={models}
        mode="antigravity"
        busy={false}
        scope={dummyScope}
        isCurrent={() => false}
        onTestModel={onTest}
      />
    );
    expect(screen.getByRole("button", { name: "测试 Model 1" })).toBeDisabled();
    expect(onTest).not.toHaveBeenCalled();
  });
});

interface ReactPropsHolder {
  readonly onClick?: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isReactPropsHolder(value: unknown): value is ReactPropsHolder {
  if (!isRecord(value)) return false;
  if (!("onClick" in value)) return false;
  return typeof value["onClick"] === "function" || value["onClick"] === undefined;
}

function getElementOnClick(element: HTMLElement): (() => void) | undefined {
  const target: unknown = element;
  if (!isRecord(target)) return undefined;

  const propsKey = Object.keys(target).find((k) => k.startsWith("__reactProps$"));
  const fiberKey = propsKey ? undefined : Object.keys(target).find((k) => k.startsWith("__reactFiber$"));
  const propKey = propsKey ?? fiberKey;
  if (!propKey) return undefined;

  let rawHolder: unknown = target[propKey];
  if (propKey.startsWith("__reactFiber$") && isRecord(rawHolder)) {
    rawHolder = rawHolder["memoizedProps"] ?? rawHolder["pendingProps"] ?? rawHolder;
  }

  if (isReactPropsHolder(rawHolder)) {
    const candidate = rawHolder.onClick;
    if (typeof candidate === "function") {
      return candidate;
    }
  }
  return undefined;
}


describe("LegacyModelQuota regression group 2: real Core/session validation, channel ABA, expiry-once, coalescing, and busy deferral", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setSessionToken("test-session-token");
    __commitPanelChannel("antigravity");
    const snapshot = getSessionSnapshot();
    __setSessionValidationStatus(snapshot.sessionEpoch, "verified");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires expiry readback exactly once per deadline, coalesces cards, and prevents fresh allowance on callback change", () => {
    const baseTime = 1770000000000;
    vi.setSystemTime(baseTime);

    const sessionEpoch = getSessionSnapshot().sessionEpoch;
    const scope = capturePanelScope(sessionEpoch);
    const capturedValidation = getSessionValidationSnapshot();
    const isCurrent = () =>
      getSessionValidationSnapshot() === capturedValidation &&
      capturedValidation.status === "verified" &&
      isPanelScopeCurrent(scope, getSessionSnapshot().sessionEpoch);

    const onExpiry = vi.fn();
    const futureDateStr = new Date(baseTime + 5000).toISOString();

    // Two cards with the exact same future deadline (should coalesce)
    const models: Record<string, unknown> = {
      card_a: {
        displayName: "Card A",
        resetTimeRaw: futureDateStr,
      },
      card_b: {
        displayName: "Card B",
        resetTimeRaw: futureDateStr,
      },
    };

    const { rerender } = render(
      <LegacyModelQuota
        models={models}
        mode="antigravity"
        busy={false}
        scope={scope}
        isCurrent={isCurrent}
        onTestModel={vi.fn()}
        onExpiryReadback={onExpiry}
      />
    );

    // Before deadline
    act(() => {
      vi.advanceTimersByTime(4999);
    });
    expect(onExpiry).not.toHaveBeenCalled();

    // Exactly at deadline: fires once (coalesced)
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onExpiry).toHaveBeenCalledTimes(1);

    // Advance clock further: does not fire again
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(onExpiry).toHaveBeenCalledTimes(1);

    // Rerender with a fresh callback reference: does NOT grant a fresh allowance
    const freshExpiryCallback = vi.fn();
    rerender(
      <LegacyModelQuota
        models={models}
        mode="antigravity"
        busy={false}
        scope={scope}
        isCurrent={isCurrent}
        onTestModel={vi.fn()}
        onExpiryReadback={freshExpiryCallback}
      />
    );

    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(freshExpiryCallback).not.toHaveBeenCalled();
    expect(onExpiry).toHaveBeenCalledTimes(1);
  });

  it("schedules distinct future deadlines sequentially without parent rerender while preserving at most one timer", () => {
    const baseTime = 1770000000000;
    vi.setSystemTime(baseTime);

    const sessionEpoch = getSessionSnapshot().sessionEpoch;
    const scope = capturePanelScope(sessionEpoch);
    const capturedValidation = getSessionValidationSnapshot();
    const isCurrent = () =>
      getSessionValidationSnapshot() === capturedValidation &&
      capturedValidation.status === "verified" &&
      isPanelScopeCurrent(scope, getSessionSnapshot().sessionEpoch);

    const onExpiry = vi.fn();
    const deadline1 = new Date(baseTime + 2000).toISOString();
    const deadline2 = new Date(baseTime + 5000).toISOString();

    const models: Record<string, unknown> = {
      card_early: {
        displayName: "Card Early",
        resetTimeRaw: deadline1,
      },
      card_later: {
        displayName: "Card Later",
        resetTimeRaw: deadline2,
      },
    };

    render(
      <LegacyModelQuota
        models={models}
        mode="antigravity"
        busy={false}
        scope={scope}
        isCurrent={isCurrent}
        onTestModel={vi.fn()}
        onExpiryReadback={onExpiry}
      />
    );

    // Before deadline 1
    act(() => {
      vi.advanceTimersByTime(1999);
    });
    expect(onExpiry).not.toHaveBeenCalled();

    // At deadline 1: fires first time
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onExpiry).toHaveBeenCalledTimes(1);

    // Advance clock toward deadline 2 without any parent rerender
    act(() => {
      vi.advanceTimersByTime(2999);
    });
    expect(onExpiry).toHaveBeenCalledTimes(1);

    // At deadline 2: fires second time
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onExpiry).toHaveBeenCalledTimes(2);

    // Advance clock further: does not fire again
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(onExpiry).toHaveBeenCalledTimes(2);
  });

  it("defers expiry readback once while busy and executes upon clearing; no retry on rejection", async () => {
    const baseTime = 1770000000000;
    vi.setSystemTime(baseTime);

    const sessionEpoch = getSessionSnapshot().sessionEpoch;
    const scope = capturePanelScope(sessionEpoch);
    const capturedValidation = getSessionValidationSnapshot();
    const isCurrent = () =>
      getSessionValidationSnapshot() === capturedValidation &&
      capturedValidation.status === "verified" &&
      isPanelScopeCurrent(scope, getSessionSnapshot().sessionEpoch);

    const rejectingReadback = vi.fn().mockRejectedValue(new Error("readback network error"));
    const futureDateStr = new Date(baseTime + 3000).toISOString();

    const models: Record<string, unknown> = {
      card_busy: {
        displayName: "Card Busy",
        resetTimeRaw: futureDateStr,
      },
    };

    const { rerender } = render(
      <LegacyModelQuota
        models={models}
        mode="antigravity"
        busy={true}
        scope={scope}
        isCurrent={isCurrent}
        onTestModel={vi.fn()}
        onExpiryReadback={rejectingReadback}
      />
    );

    // Deadline expires while busy
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(rejectingReadback).not.toHaveBeenCalled();

    // Busy becomes false
    rerender(
      <LegacyModelQuota
        models={models}
        mode="antigravity"
        busy={false}
        scope={scope}
        isCurrent={isCurrent}
        onTestModel={vi.fn()}
        onExpiryReadback={rejectingReadback}
      />
    );

    // Deferred readback executes once
    expect(rejectingReadback).toHaveBeenCalledTimes(1);

    // No retry after rejection
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(rejectingReadback).toHaveBeenCalledTimes(1);
  });

  it("discards deferred busy readback and prevents old captured handlers from running when a new same-scope owner becomes active", () => {
    const baseTime = 1770000000000;
    vi.setSystemTime(baseTime);

    const sessionEpoch = getSessionSnapshot().sessionEpoch;
    const scope = capturePanelScope(sessionEpoch);

    // Owner 1 validation identity
    const validation1 = getSessionValidationSnapshot();
    const isCurrent1 = () =>
      getSessionValidationSnapshot() === validation1 &&
      validation1.status === "verified" &&
      isPanelScopeCurrent(scope, getSessionSnapshot().sessionEpoch);

    const onExpiry1 = vi.fn();
    const onTest1 = vi.fn();
    const futureDateStr = new Date(baseTime + 3000).toISOString();

    const models: Record<string, unknown> = {
      card_1: {
        displayName: "Card 1",
        testModel: "target-1",
        resetTimeRaw: futureDateStr,
      },
    };

    // 1. Render Owner 1 while busy
    const { rerender } = render(
      <LegacyModelQuota
        models={models}
        mode="antigravity"
        busy={true}
        scope={scope}
        isCurrent={isCurrent1}
        onTestModel={onTest1}
        onExpiryReadback={onExpiry1}
      />
    );

    // Retain the actual old click handler from Owner 1
    const oldBtn = screen.getByRole("button", { name: "测试 Card 1" });
    const oldOnClick = getElementOnClick(oldBtn);
    expect(typeof oldOnClick).toBe("function");

    // Advance clock to deadline while busy: readback is deferred for Owner 1
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(onExpiry1).not.toHaveBeenCalled();

    // 2. Validation snapshot transitions: pending -> verified with new validationSnapshot identity
    __setSessionValidationStatus(sessionEpoch, "pending");
    __setSessionValidationStatus(sessionEpoch, "verified");
    const validation2 = getSessionValidationSnapshot();
    expect(validation2).not.toBe(validation1);

    // Owner 1 is now stale
    expect(isCurrent1()).toBe(false);

    // Owner 2 has the same scope but new validation identity
    const onExpiry2 = vi.fn();
    const onTest2 = vi.fn();
    const isCurrent2 = () =>
      getSessionValidationSnapshot() === validation2 &&
      validation2.status === "verified" &&
      isPanelScopeCurrent(scope, getSessionSnapshot().sessionEpoch);

    expect(isCurrent2()).toBe(true);

    // 3. Parent rerenders with Owner 2 and busy becomes false
    rerender(
      <LegacyModelQuota
        models={models}
        mode="antigravity"
        busy={false}
        scope={scope}
        isCurrent={isCurrent2}
        onTestModel={onTest2}
        onExpiryReadback={onExpiry2}
      />
    );

    // Old deferred work from Owner 1 must be discarded and NOT rebound
    expect(onExpiry1).not.toHaveBeenCalled();
    expect(onExpiry2).not.toHaveBeenCalled();

    // Advance clock further: no deferred callback fired
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onExpiry1).not.toHaveBeenCalled();
    expect(onExpiry2).not.toHaveBeenCalled();

    // 4. Executing retained old click handler while Owner 2 is active must NOT invoke Owner 1 or Owner 2
    oldOnClick?.();
    expect(onTest1).not.toHaveBeenCalled();
    expect(onTest2).not.toHaveBeenCalled();

    // 5. Fresh Owner 2 can execute test click
    const freshBtn = screen.getByRole("button", { name: "测试 Card 1" });
    expect(freshBtn).not.toBeDisabled();
    fireEvent.click(freshBtn);
    expect(onTest2).toHaveBeenCalledTimes(1);
    expect(onTest2).toHaveBeenCalledWith("target-1");
    expect(onTest1).not.toHaveBeenCalled();
  });

  it("discards timer and clicks on channel ABA and prevents stale captured handlers from using fresh owner", () => {
    const baseTime = 1770000000000;
    vi.setSystemTime(baseTime);

    // 1. Initial owner A: antigravity epoch 0
    const sessionEpoch = getSessionSnapshot().sessionEpoch;
    const scopeA = capturePanelScope(sessionEpoch);
    const capturedValidationA = getSessionValidationSnapshot();
    const isCurrentA = () =>
      getSessionValidationSnapshot() === capturedValidationA &&
      capturedValidationA.status === "verified" &&
      isPanelScopeCurrent(scopeA, getSessionSnapshot().sessionEpoch);

    const onExpiryA = vi.fn();
    const onTestA = vi.fn();
    const futureDateStr = new Date(baseTime + 4000).toISOString();

    const models: Record<string, unknown> = {
      card_aba: {
        displayName: "Card ABA",
        testModel: "target-aba",
        resetTimeRaw: futureDateStr,
      },
    };

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const { rerender } = render(
      <LegacyModelQuota
        models={models}
        mode="antigravity"
        busy={false}
        scope={scopeA}
        isCurrent={isCurrentA}
        onTestModel={onTestA}
        onExpiryReadback={onExpiryA}
      />
    );

    // Retain actual old click handler and timer callback from Owner A
    const oldBtnA = screen.getByRole("button", { name: "测试 Card ABA" });
    const oldOnClickA = getElementOnClick(oldBtnA);
    expect(typeof oldOnClickA).toBe("function");

    const timerCallA = setTimeoutSpy.mock.calls[0]?.[0];
    const capturedTimerA = typeof timerCallA === "function" ? (timerCallA as () => void) : null;
    expect(capturedTimerA).not.toBeNull();

    // 2. ABA switch: antigravity -> geminicli -> antigravity (channelEpoch increments)
    __commitPanelChannel("geminicli");
    __commitPanelChannel("antigravity");
    // scopeA is now stale because channelEpoch changed from 0 to 2
    expect(isCurrentA()).toBe(false);

    // 3. Fresh Owner C with current scope operates normally
    const scopeC = capturePanelScope(sessionEpoch);
    const capturedValidationC = getSessionValidationSnapshot();
    const isCurrentC = () =>
      getSessionValidationSnapshot() === capturedValidationC &&
      capturedValidationC.status === "verified" &&
      isPanelScopeCurrent(scopeC, getSessionSnapshot().sessionEpoch);

    const onTestC = vi.fn();
    const onExpiryC = vi.fn();
    rerender(
      <LegacyModelQuota
        models={models}
        mode="antigravity"
        busy={false}
        scope={scopeC}
        isCurrent={isCurrentC}
        onTestModel={onTestC}
        onExpiryReadback={onExpiryC}
      />
    );

    expect(isCurrentC()).toBe(true);

    // 4. While fresh Owner C is active and valid, invoke retained old click handler from Owner A
    oldOnClickA?.();
    expect(onTestA).not.toHaveBeenCalled();
    expect(onTestC).not.toHaveBeenCalled();

    // 5. While fresh Owner C is active and valid, invoke retained old timer callback from Owner A
    act(() => {
      capturedTimerA?.();
    });
    expect(onExpiryA).not.toHaveBeenCalled();
    expect(onExpiryC).not.toHaveBeenCalled();

    // 6. Fresh Owner C actions still work
    const freshButton = screen.getByRole("button", { name: "测试 Card ABA" });
    expect(freshButton).not.toBeDisabled();
    fireEvent.click(freshButton);
    expect(onTestC).toHaveBeenCalledTimes(1);
    expect(onTestC).toHaveBeenCalledWith("target-aba");
    expect(onTestA).not.toHaveBeenCalled();

    // Advance clock to deadline: Owner C's timer fires exactly once
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(onExpiryC).toHaveBeenCalledTimes(1);
    expect(onExpiryA).not.toHaveBeenCalled();

    // Advance further: no duplicate calls
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(onExpiryC).toHaveBeenCalledTimes(1);
    expect(onExpiryA).not.toHaveBeenCalled();

    setTimeoutSpy.mockRestore();
  });

  it("discards timer and interactions on real validation snapshot ABA", () => {
    const baseTime = 1770000000000;
    vi.setSystemTime(baseTime);

    const sessionEpoch = getSessionSnapshot().sessionEpoch;
    const scope = capturePanelScope(sessionEpoch);

    // Snapshot A
    const capturedValidationA = getSessionValidationSnapshot();
    const isCurrentA = () =>
      getSessionValidationSnapshot() === capturedValidationA &&
      capturedValidationA.status === "verified" &&
      isPanelScopeCurrent(scope, getSessionSnapshot().sessionEpoch);

    const onExpiryA = vi.fn();
    const onTestA = vi.fn();
    const futureDateStr = new Date(baseTime + 4000).toISOString();

    const models: Record<string, unknown> = {
      card_val_aba: {
        displayName: "Card Validation ABA",
        testModel: "target-val-aba",
        resetTimeRaw: futureDateStr,
      },
    };

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const { rerender } = render(
      <LegacyModelQuota
        models={models}
        mode="antigravity"
        busy={false}
        scope={scope}
        isCurrent={isCurrentA}
        onTestModel={onTestA}
        onExpiryReadback={onExpiryA}
      />
    );

    // Retain actual old click handler and timer callback from Snapshot A
    const oldBtnA = screen.getByRole("button", { name: "测试 Card Validation ABA" });
    const oldOnClickA = getElementOnClick(oldBtnA);
    expect(typeof oldOnClickA).toBe("function");

    const timerCallA = setTimeoutSpy.mock.calls[0]?.[0];
    const capturedTimerA = typeof timerCallA === "function" ? (timerCallA as () => void) : null;
    expect(capturedTimerA).not.toBeNull();

    // Real validation status ABA: verified -> unavailable -> verified
    __setSessionValidationStatus(sessionEpoch, "unavailable");
    __setSessionValidationStatus(sessionEpoch, "verified");

    // Even though status is "verified" again, validation snapshot identity is new (ABA)
    expect(getSessionValidationSnapshot()).not.toBe(capturedValidationA);
    expect(isCurrentA()).toBe(false);

    // Fresh Owner C with current validation snapshot operates normally
    const capturedValidationC = getSessionValidationSnapshot();
    const isCurrentC = () =>
      getSessionValidationSnapshot() === capturedValidationC &&
      capturedValidationC.status === "verified" &&
      isPanelScopeCurrent(scope, getSessionSnapshot().sessionEpoch);

    const onTestC = vi.fn();
    const onExpiryC = vi.fn();
    rerender(
      <LegacyModelQuota
        models={models}
        mode="antigravity"
        busy={false}
        scope={scope}
        isCurrent={isCurrentC}
        onTestModel={onTestC}
        onExpiryReadback={onExpiryC}
      />
    );

    expect(isCurrentC()).toBe(true);

    // While fresh Owner C is active and valid, invoke retained old click handler from Owner A
    oldOnClickA?.();
    expect(onTestA).not.toHaveBeenCalled();
    expect(onTestC).not.toHaveBeenCalled();

    // While fresh Owner C is active and valid, invoke retained old timer callback from Owner A
    act(() => {
      capturedTimerA?.();
    });
    expect(onExpiryA).not.toHaveBeenCalled();
    expect(onExpiryC).not.toHaveBeenCalled();

    // Fresh Owner C interactions operate normally
    const freshBtn = screen.getByRole("button", { name: "测试 Card Validation ABA" });
    expect(freshBtn).not.toBeDisabled();
    fireEvent.click(freshBtn);
    expect(onTestC).toHaveBeenCalledTimes(1);
    expect(onTestC).toHaveBeenCalledWith("target-val-aba");
    expect(onTestA).not.toHaveBeenCalled();

    // Advance clock to deadline: Owner C's timer fires exactly once
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(onExpiryC).toHaveBeenCalledTimes(1);
    expect(onExpiryA).not.toHaveBeenCalled();

    // Advance further: no extra calls
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(onExpiryC).toHaveBeenCalledTimes(1);
    expect(onExpiryA).not.toHaveBeenCalled();

    setTimeoutSpy.mockRestore();
  });

  it("discards timers and interactions upon real session invalidation and cleans up on unmount", () => {
    const baseTime = 1770000000000;
    vi.setSystemTime(baseTime);

    const sessionEpoch = getSessionSnapshot().sessionEpoch;
    const scope = capturePanelScope(sessionEpoch);
    const capturedValidation = getSessionValidationSnapshot();
    const isCurrent = () =>
      getSessionValidationSnapshot() === capturedValidation &&
      capturedValidation.status === "verified" &&
      isPanelScopeCurrent(scope, getSessionSnapshot().sessionEpoch);

    const onExpiry = vi.fn();
    const onTest = vi.fn();
    const futureDateStr = new Date(baseTime + 5000).toISOString();

    const models: Record<string, unknown> = {
      card_session: {
        displayName: "Card Session",
        testModel: "target-session",
        resetTimeRaw: futureDateStr,
      },
    };

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const { unmount } = render(
      <LegacyModelQuota
        models={models}
        mode="antigravity"
        busy={false}
        scope={scope}
        isCurrent={isCurrent}
        onTestModel={onTest}
        onExpiryReadback={onExpiry}
      />
    );

    // Retain actual old click handler and timer callback before invalidation
    const oldBtn = screen.getByRole("button", { name: "测试 Card Session" });
    const oldOnClick = getElementOnClick(oldBtn);
    expect(typeof oldOnClick).toBe("function");

    const timerCall = setTimeoutSpy.mock.calls[0]?.[0];
    const capturedTimer = typeof timerCall === "function" ? (timerCall as () => void) : null;
    expect(capturedTimer).not.toBeNull();

    // 1. Invalidate session via actual Core session invalidation
    invalidateSession(sessionEpoch);

    // Verify session was actually invalidated in Core
    expect(getSessionSnapshot().token).toBeNull();
    expect(getSessionSnapshot().sessionEpoch).toBe(sessionEpoch + 1);
    expect(isCurrent()).toBe(false);

    // Invoke retained old click handler after session invalidation
    oldOnClick?.();
    expect(onTest).not.toHaveBeenCalled();

    // Invoke retained old timer callback after session invalidation
    act(() => {
      capturedTimer?.();
    });
    expect(onExpiry).not.toHaveBeenCalled();

    // 2. Deadline arrives after session invalidation
    act(() => {
      vi.advanceTimersByTime(5000);
    });

    // Timer must NOT fire
    expect(onExpiry).not.toHaveBeenCalled();

    // Test button click must NOT invoke handler
    const testBtn = screen.getByRole("button", { name: "测试 Card Session" });
    fireEvent.click(testBtn);
    expect(onTest).not.toHaveBeenCalled();

    // 3. Unmount clears any remaining local timer
    unmount();
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(onExpiry).not.toHaveBeenCalled();

    setTimeoutSpy.mockRestore();
  });
});
