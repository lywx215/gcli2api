import { AUTH_STORAGE_KEY, setSessionToken } from "@/auth/session";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { routeFromHash } from "./routes";
it("logs in using only fixtures, navigates six real lazy pages, and logs out", async () => {
  vi.stubEnv("DEV", true); vi.stubEnv("VITE_UI_FIXTURES", "true");
  const user = userEvent.setup(); render(<App />);
  await user.type(screen.getByLabelText("面板密码"), "synthetic-preview");
  await user.click(screen.getByRole("button", { name: "登录" }));
  await within(screen.getByRole("main")).findByRole("heading", { level: 1, name: "概览" });
  expect(screen.getByRole("link", { name: "模型路由" })).toHaveAttribute("href", "#/model-routing");
  for (const [id, name, title] of [["credentials", "凭证", "Antigravity 凭证"], ["import", "添加凭证", "导入凭证"], ["settings", "设置", "设置"], ["logs", "日志", "日志"], ["model-routing", "模型路由", "模型路由"], ["overview", "概览", "概览"]]) {
    await user.click(screen.getByRole("link", { name }));
    await waitFor(() => expect(screen.getByRole("link", { name })).toHaveAttribute("aria-current", "page"));
    expect(location.hash).toBe(`#/${id}`);
    await within(screen.getByRole("main")).findByRole("heading", { level: 1, name: title });
  }
  await user.click(screen.getByRole("button", { name: "退出登录" }));
  expect(screen.getByLabelText("面板密码")).toHaveValue("");
  expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
});
it("shows safe login failures without echoing the payload", async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json({ detail: "synthetic-private-detail" }, { status: 401 }));
  render(<App />);
  fireEvent.change(screen.getByLabelText("面板密码"), { target: { value: "synthetic" } });
  fireEvent.click(screen.getByRole("button", { name: "登录" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("登录未完成");
  expect(screen.queryByText("synthetic-private-detail")).not.toBeInTheDocument();
  expect(screen.getByLabelText("面板密码")).toHaveValue("");
});
it("unknown hashes fall back to overview while legacy aliases map to credentials", () => {
  expect(routeFromHash("#/does-not-exist")).toBe("overview");
  expect(routeFromHash("#manage")).toBe("credentials");
  expect(routeFromHash("#/manage")).toBe("credentials");
  expect(routeFromHash("#antigravity-manage")).toBe("credentials");
  expect(routeFromHash("#/antigravity-manage")).toBe("credentials");
});

it("closes the portalled navigation on cross-tab logout and leaves login operable", async () => {
  vi.stubEnv("DEV", true); vi.stubEnv("VITE_UI_FIXTURES", "true");
  setSessionToken("synthetic-before-logout");
  const user = userEvent.setup(); render(<App />);
  await user.click(screen.getByRole("button", { name: "打开导航" }));
  expect(screen.getByRole("dialog", { name: "节点导航" })).toBeInTheDocument();
  localStorage.removeItem(AUTH_STORAGE_KEY);
  act(() => window.dispatchEvent(new StorageEvent("storage", { key: AUTH_STORAGE_KEY, newValue: null, storageArea: localStorage })));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(document.querySelector('[data-radix-focus-guard]')).toBeNull();
  await user.type(screen.getByLabelText("面板密码"), "synthetic-again");
  await user.click(screen.getByRole("button", { name: "登录" }));
  await screen.findByRole("button", { name: "退出登录" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
});

it("invalid production service metadata gives a safe boundary instead of a blank authenticated shell", async () => {
  vi.stubEnv("DEV", false);
  document.head.innerHTML = '<meta name="gcli-service-base" content="https://other.example.invalid/">';
  setSessionToken("synthetic-session");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  render(<App />);
  expect(await screen.findByRole("alert")).toHaveTextContent("页面暂时无法加载");
  expect(screen.getByRole("button", { name: "刷新页面" })).toBeInTheDocument();
  expect(screen.queryByText("synthetic-session")).not.toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
});

describe("GCLI overview lifecycle and observation", () => {
  afterEach(() => {
    vi.doUnmock("@/pages/overview");
    vi.doUnmock("@/pages/credentials");
    vi.doUnmock("@/pages/import");
    vi.resetModules();
    vi.restoreAllMocks();
    window.location.hash = "";
  });

  it("mounts GCLI overview when discovery and lazy rendering share one import under observation spies", async () => {
    vi.resetModules();
    window.location.hash = "#/overview?channel=geminicli";

    const actualOverview = await vi.importActual<typeof import("@/pages/overview")>("@/pages/overview");
    // overviewModuleEvaluationSpy tracks mock factory / module evaluation count in Vitest's module registry.
    // Vitest evaluates the mock factory once per module cache lifetime, while internal loader deduplication caches the promise.
    const overviewModuleEvaluationSpy = vi.fn();
    const overviewRenderSpy = vi.fn((...args: any[]) => (actualOverview.default as any)(...args));

    vi.doMock("@/pages/overview", () => {
      overviewModuleEvaluationSpy();
      return {
        ...actualOverview,
        default: overviewRenderSpy,
        supportedPanelModes: actualOverview.supportedPanelModes,
      };
    });

    const { default: ScopedApp } = await import("./App");
    const { setSessionToken: scopedSetSessionToken } = await import("@/auth/session");
    const { getPanelChannelSnapshot } = await import("@/domain/panel");

    render(<ScopedApp />);

    // Assert zero pre-verification module evaluation, transport, and hidden shell
    expect(overviewModuleEvaluationSpy).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByLabelText("面板密码")).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();

    // Verify session in GCLI mode wrapped in act
    act(() => {
      scopedSetSessionToken("synthetic-verified-gcli", false);
    });

    // Wait for real page evidence rather than premature shell heading
    const overviewRegion = await screen.findByRole("region", { name: "Gemini CLI 概览" });
    expect(overviewRegion).toBeInTheDocument();
    expect(within(overviewRegion).getByRole("heading", { level: 1, name: "概览" })).toBeInTheDocument();

    // Real default wrapper spy plus real channel state agree
    expect(overviewRenderSpy).toHaveBeenCalled();
    expect(getPanelChannelSnapshot().mode).toBe("geminicli");

    // Discovery and lazy rendering share one single import / module evaluation
    expect(overviewModuleEvaluationSpy).toHaveBeenCalledTimes(1);
  });

  it("defers overview resolution across logout without obsolete-owner mount, then reuses module cache for fresh verified owner", async () => {
    vi.resetModules();
    window.location.hash = "#/overview?channel=geminicli";

    const actualOverview = await vi.importActual<typeof import("@/pages/overview")>("@/pages/overview");
    const overviewModuleEvaluationSpy = vi.fn();
    const overviewRenderSpy = vi.fn((...args: any[]) => (actualOverview.default as any)(...args));

    let importFactoryResolve!: () => void;
    const importFactoryCalled = new Promise<void>((resolve) => {
      importFactoryResolve = resolve;
    });

    let resolveOverviewDeferred!: (mod: typeof actualOverview) => void;
    const overviewPromise = new Promise<typeof actualOverview>((resolve) => {
      resolveOverviewDeferred = resolve;
    });

    vi.doMock("@/pages/overview", () => {
      overviewModuleEvaluationSpy();
      importFactoryResolve();
      return overviewPromise;
    });

    const { default: ScopedApp } = await import("./App");
    const { setSessionToken: scopedSetSessionToken, getSessionSnapshot: scopedGetSessionSnapshot } = await import("@/auth/session");

    // Start with verified owner 1 wrapped in act
    act(() => {
      scopedSetSessionToken("synthetic-verified-owner1", false);
    });
    const { rerender } = render(<ScopedApp />);

    // Explicit lifecycle barrier: await deferred import factory before asserting it has been called
    await importFactoryCalled;
    expect(overviewModuleEvaluationSpy).toHaveBeenCalledTimes(1);
    expect(overviewRenderSpy).not.toHaveBeenCalled();
    expect(screen.getByRole("status", { name: "正在加载页面" })).toBeInTheDocument();

    // Defer resolution across logout wrapped in act
    act(() => {
      scopedSetSessionToken(null, false);
    });
    await screen.findByLabelText("面板密码");
    expect(scopedGetSessionSnapshot().token).toBeNull();

    // Resolve deferred module while user is anonymous and flush deferred imports
    resolveOverviewDeferred({
      ...actualOverview,
      default: overviewRenderSpy,
      supportedPanelModes: actualOverview.supportedPanelModes,
    });
    await act(async () => {
      await overviewPromise;
    });

    // Separate anonymous rerender
    await act(async () => {
      rerender(<ScopedApp />);
    });

    // Zero obsolete-owner mount assertion preserved strictly
    expect(overviewRenderSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Gemini CLI 概览" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("面板密码")).toBeInTheDocument();

    // Fresh verified owner arrives and reuses module cache
    act(() => {
      scopedSetSessionToken("synthetic-verified-owner2", false);
    });
    const freshOverviewRegion = await screen.findByRole("region", { name: "Gemini CLI 概览" });
    expect(freshOverviewRegion).toBeInTheDocument();
    expect(within(freshOverviewRegion).getByRole("heading", { level: 1, name: "概览" })).toBeInTheDocument();
    expect(overviewRenderSpy).toHaveBeenCalled();
    expect(overviewModuleEvaluationSpy).toHaveBeenCalledTimes(1);
  });
});

describe("GCLI negative parameter handling and placeholder boundaries", () => {
  afterEach(() => {
    vi.doUnmock("@/pages/overview");
    vi.doUnmock("@/pages/credentials");
    vi.doUnmock("@/pages/import");
    vi.resetModules();
    vi.restoreAllMocks();
    window.location.hash = "";
  });

  it("keeps overview unsupported when supportedPanelModes is missing or malformed while loader counts remain zero", async () => {
    vi.resetModules();
    window.location.hash = "#/overview?channel=geminicli";

    const actualOverview = await vi.importActual<typeof import("@/pages/overview")>("@/pages/overview");
    const overviewRenderSpy = vi.fn((...args: any[]) => (actualOverview.default as any)(...args));
    // Spies track module evaluations (mock factory invocations)
    const credentialLoaderSpy = vi.fn();
    const importLoaderSpy = vi.fn();

    vi.doMock("@/pages/credentials", () => {
      credentialLoaderSpy();
      return { default: () => <div data-testid="credentials-page">Credentials</div> };
    });
    vi.doMock("@/pages/import", () => {
      importLoaderSpy();
      return { default: () => <div data-testid="import-page">Import</div> };
    });

    // 1. Missing declaration: supportedPanelModes is undefined
    vi.doMock("@/pages/overview", () => ({
      ...actualOverview,
      default: overviewRenderSpy,
      supportedPanelModes: undefined,
    }));

    const { default: ScopedAppMissing } = await import("./App");
    const { setSessionToken: scopedSetSessionToken } = await import("@/auth/session");

    act(() => {
      scopedSetSessionToken("synthetic-verified-missing", false);
    });
    const { unmount: unmountMissing } = render(<ScopedAppMissing />);

    await screen.findByRole("region", { name: "当前渠道暂不支持" });
    expect(screen.getByRole("heading", { level: 1, name: "当前渠道暂未支持" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "前往旧版管理面板" })).toHaveAttribute(
      "href",
      expect.stringContaining("#manage")
    );
    expect(overviewRenderSpy).not.toHaveBeenCalled();
    expect(credentialLoaderSpy).not.toHaveBeenCalled();
    expect(importLoaderSpy).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    unmountMissing();

    // 2. Non-array declaration: supportedPanelModes is a non-array string
    vi.resetModules();
    vi.doMock("@/pages/credentials", () => {
      credentialLoaderSpy();
      return { default: () => <div data-testid="credentials-page">Credentials</div> };
    });
    vi.doMock("@/pages/import", () => {
      importLoaderSpy();
      return { default: () => <div data-testid="import-page">Import</div> };
    });
    vi.doMock("@/pages/overview", () => ({
      ...actualOverview,
      default: overviewRenderSpy,
      supportedPanelModes: "geminicli",
    }));

    const { default: ScopedAppNonArray } = await import("./App");
    const { setSessionToken: scopedSetSessionToken2 } = await import("@/auth/session");

    act(() => {
      scopedSetSessionToken2("synthetic-verified-nonarray", false);
    });
    const { unmount: unmountNonArray } = render(<ScopedAppNonArray />);

    await screen.findByRole("region", { name: "当前渠道暂不支持" });
    expect(screen.getByRole("heading", { level: 1, name: "当前渠道暂未支持" })).toBeInTheDocument();
    expect(overviewRenderSpy).not.toHaveBeenCalled();
    expect(credentialLoaderSpy).not.toHaveBeenCalled();
    expect(importLoaderSpy).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    unmountNonArray();

    // 3. Malformed array: contains both geminicli and an invalid entry
    vi.resetModules();
    vi.doMock("@/pages/credentials", () => {
      credentialLoaderSpy();
      return { default: () => <div data-testid="credentials-page">Credentials</div> };
    });
    vi.doMock("@/pages/import", () => {
      importLoaderSpy();
      return { default: () => <div data-testid="import-page">Import</div> };
    });
    vi.doMock("@/pages/overview", () => ({
      ...actualOverview,
      default: overviewRenderSpy,
      supportedPanelModes: ["geminicli", "not-a-valid-mode"],
    }));

    const { default: ScopedAppMixed } = await import("./App");
    const { setSessionToken: scopedSetSessionToken3 } = await import("@/auth/session");

    act(() => {
      scopedSetSessionToken3("synthetic-verified-mixed", false);
    });
    render(<ScopedAppMixed />);

    await screen.findByRole("region", { name: "当前渠道暂不支持" });
    expect(screen.getByRole("heading", { level: 1, name: "当前渠道暂未支持" })).toBeInTheDocument();
    expect(overviewRenderSpy).not.toHaveBeenCalled();
    expect(credentialLoaderSpy).not.toHaveBeenCalled();
    expect(importLoaderSpy).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maintains zero import page loads for GCLI placeholder while retaining auth hidden inert semantics", async () => {
    vi.resetModules();
    window.location.hash = "#/import?channel=geminicli";

    // Spies track module evaluations (mock factory invocations)
    const credentialLoaderSpy = vi.fn();
    const importLoaderSpy = vi.fn();

    vi.doMock("@/pages/credentials", () => {
      credentialLoaderSpy();
      return { default: () => <div data-testid="credentials-page">Credentials</div> };
    });
    vi.doMock("@/pages/import", () => {
      importLoaderSpy();
      return { default: () => <div data-testid="import-page">Import</div> };
    });

    const { default: ScopedApp } = await import("./App");
    const { setSessionToken: scopedSetSessionToken } = await import("@/auth/session");

    render(<ScopedApp />);

    // Zero pre-verification loads and transport
    expect(credentialLoaderSpy).not.toHaveBeenCalled();
    expect(importLoaderSpy).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByLabelText("面板密码")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "当前渠道暂不支持" })).not.toBeInTheDocument();

    // Authenticate in GCLI mode wrapped in act
    act(() => {
      scopedSetSessionToken("synthetic-verified-gcli", false);
    });

    // GCLI placeholder for import rendered without loading import page
    await screen.findByRole("region", { name: "当前渠道暂不支持" });
    expect(screen.getByRole("heading", { level: 1, name: "当前渠道暂未支持" })).toBeInTheDocument();
    expect(credentialLoaderSpy).not.toHaveBeenCalled();
    expect(importLoaderSpy).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();

    // Logout and verify auth/hidden/inert semantics retained
    act(() => {
      scopedSetSessionToken(null, false);
    });
    await screen.findByLabelText("面板密码");

    const hiddenInertShell = document.querySelector("div[hidden][inert]");
    expect(hiddenInertShell).toBeInTheDocument();
    expect(hiddenInertShell).toHaveAttribute("hidden");
    expect(hiddenInertShell).toHaveAttribute("inert");

    expect(credentialLoaderSpy).not.toHaveBeenCalled();
    expect(importLoaderSpy).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("GCLI credentials lifecycle and activation", () => {
  afterEach(() => {
    vi.doUnmock("@/pages/overview");
    vi.doUnmock("@/pages/credentials");
    vi.doUnmock("@/pages/import");
    vi.resetModules();
    vi.restoreAllMocks();
    window.location.hash = "";
  });

  it("mounts GCLI credentials when discovery and lazy rendering share one import under observation spies", async () => {
    vi.resetModules();
    window.location.hash = "#/credentials?channel=geminicli";

    const actualCredentials = await vi.importActual<typeof import("@/pages/credentials")>("@/pages/credentials");
    const credentialsModuleEvaluationSpy = vi.fn();
    const credentialsRenderSpy = vi.fn((...args: any[]) => (actualCredentials.default as any)(...args));

    vi.doMock("@/pages/credentials", () => {
      credentialsModuleEvaluationSpy();
      return {
        ...actualCredentials,
        default: credentialsRenderSpy,
        supportedPanelModes: actualCredentials.supportedPanelModes,
      };
    });

    const { default: ScopedApp } = await import("./App");
    const { setSessionToken: scopedSetSessionToken } = await import("@/auth/session");
    const { getPanelChannelSnapshot } = await import("@/domain/panel");

    render(<ScopedApp />);

    // Zero pre-verification module evaluation, transport, and ready
    expect(credentialsModuleEvaluationSpy).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByLabelText("面板密码")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1, name: "Gemini CLI 凭证" })).not.toBeInTheDocument();

    // Verify session in GCLI mode wrapped in act
    act(() => {
      scopedSetSessionToken("synthetic-verified-gcli", false);
    });

    // Real page evidence: heading in Gemini CLI mode
    const heading = await screen.findByRole("heading", { level: 1, name: "Gemini CLI 凭证" });
    expect(heading).toBeInTheDocument();

    // Real default wrapper spy plus real channel state agree
    expect(credentialsRenderSpy).toHaveBeenCalled();
    expect(getPanelChannelSnapshot().mode).toBe("geminicli");

    // Discovery and lazy rendering share one single import / module evaluation
    expect(credentialsModuleEvaluationSpy).toHaveBeenCalledTimes(1);
  });

  it("defers credentials resolution across logout without obsolete-owner mount, then reuses module cache for fresh verified owner", async () => {
    vi.resetModules();
    window.location.hash = "#/credentials?channel=geminicli";

    const actualCredentials = await vi.importActual<typeof import("@/pages/credentials")>("@/pages/credentials");
    const credentialsModuleEvaluationSpy = vi.fn();
    const credentialsRenderSpy = vi.fn((...args: any[]) => (actualCredentials.default as any)(...args));

    let importFactoryResolve!: () => void;
    const importFactoryCalled = new Promise<void>((resolve) => {
      importFactoryResolve = resolve;
    });

    let resolveCredentialsDeferred!: (mod: typeof actualCredentials) => void;
    const credentialsPromise = new Promise<typeof actualCredentials>((resolve) => {
      resolveCredentialsDeferred = resolve;
    });

    vi.doMock("@/pages/credentials", () => {
      credentialsModuleEvaluationSpy();
      importFactoryResolve();
      return credentialsPromise;
    });

    const { default: ScopedApp } = await import("./App");
    const { setSessionToken: scopedSetSessionToken, getSessionSnapshot: scopedGetSessionSnapshot } = await import("@/auth/session");

    // Start with verified owner 1
    act(() => {
      scopedSetSessionToken("synthetic-verified-owner1", false);
    });
    const { rerender } = render(<ScopedApp />);

    // Explicit lifecycle barrier: await deferred import factory before asserting it has been called
    await importFactoryCalled;
    expect(credentialsModuleEvaluationSpy).toHaveBeenCalledTimes(1);
    expect(credentialsRenderSpy).not.toHaveBeenCalled();
    expect(screen.getByRole("status", { name: "正在加载页面" })).toBeInTheDocument();

    // Defer resolution across logout
    act(() => {
      scopedSetSessionToken(null, false);
    });
    await screen.findByLabelText("面板密码");
    expect(scopedGetSessionSnapshot().token).toBeNull();

    // Resolve deferred module while anonymous
    resolveCredentialsDeferred({
      ...actualCredentials,
      default: credentialsRenderSpy,
      supportedPanelModes: actualCredentials.supportedPanelModes,
    });
    await act(async () => {
      await credentialsPromise;
    });

    await act(async () => {
      rerender(<ScopedApp />);
    });

    // Zero obsolete-owner mount
    expect(credentialsRenderSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { level: 1, name: "Gemini CLI 凭证" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("面板密码")).toBeInTheDocument();

    // Fresh verified owner arrives and reuses module cache
    act(() => {
      scopedSetSessionToken("synthetic-verified-owner2", false);
    });
    const freshHeading = await screen.findByRole("heading", { level: 1, name: "Gemini CLI 凭证" });
    expect(freshHeading).toBeInTheDocument();
    expect(credentialsRenderSpy).toHaveBeenCalled();
    expect(credentialsModuleEvaluationSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps credentials unsupported when supportedPanelModes is missing or malformed while loader counts remain zero for other pages", async () => {
    vi.resetModules();
    window.location.hash = "#/credentials?channel=geminicli";

    const actualCredentials = await vi.importActual<typeof import("@/pages/credentials")>("@/pages/credentials");
    const credentialsRenderSpy = vi.fn((...args: any[]) => (actualCredentials.default as any)(...args));
    const importLoaderSpy = vi.fn();

    vi.doMock("@/pages/import", () => {
      importLoaderSpy();
      return { default: () => <div data-testid="import-page">Import</div> };
    });

    // 1. Missing declaration: supportedPanelModes is undefined
    vi.doMock("@/pages/credentials", () => ({
      ...actualCredentials,
      default: credentialsRenderSpy,
      supportedPanelModes: undefined,
    }));

    const { default: ScopedAppMissing } = await import("./App");
    const { setSessionToken: scopedSetSessionToken } = await import("@/auth/session");

    act(() => {
      scopedSetSessionToken("synthetic-verified-missing", false);
    });
    const { unmount: unmountMissing } = render(<ScopedAppMissing />);

    await screen.findByRole("region", { name: "当前渠道暂不支持" });
    expect(screen.getByRole("heading", { level: 1, name: "当前渠道暂未支持" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "前往旧版管理面板" })).toHaveAttribute(
      "href",
      expect.stringContaining("#manage")
    );
    expect(credentialsRenderSpy).not.toHaveBeenCalled();
    expect(importLoaderSpy).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    unmountMissing();

    // 2. Non-array declaration: supportedPanelModes is a non-array string
    vi.resetModules();
    vi.doMock("@/pages/import", () => {
      importLoaderSpy();
      return { default: () => <div data-testid="import-page">Import</div> };
    });
    vi.doMock("@/pages/credentials", () => ({
      ...actualCredentials,
      default: credentialsRenderSpy,
      supportedPanelModes: "geminicli",
    }));

    const { default: ScopedAppNonArray } = await import("./App");
    const { setSessionToken: scopedSetSessionToken2 } = await import("@/auth/session");

    act(() => {
      scopedSetSessionToken2("synthetic-verified-nonarray", false);
    });
    const { unmount: unmountNonArray } = render(<ScopedAppNonArray />);

    await screen.findByRole("region", { name: "当前渠道暂不支持" });
    expect(screen.getByRole("heading", { level: 1, name: "当前渠道暂未支持" })).toBeInTheDocument();
    expect(credentialsRenderSpy).not.toHaveBeenCalled();
    expect(importLoaderSpy).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    unmountNonArray();

    // 3. Malformed array: contains an invalid entry
    vi.resetModules();
    vi.doMock("@/pages/import", () => {
      importLoaderSpy();
      return { default: () => <div data-testid="import-page">Import</div> };
    });
    vi.doMock("@/pages/credentials", () => ({
      ...actualCredentials,
      default: credentialsRenderSpy,
      supportedPanelModes: ["geminicli", "not-a-valid-mode"],
    }));

    const { default: ScopedAppMixed } = await import("./App");
    const { setSessionToken: scopedSetSessionToken3 } = await import("@/auth/session");

    act(() => {
      scopedSetSessionToken3("synthetic-verified-mixed", false);
    });
    render(<ScopedAppMixed />);

    await screen.findByRole("region", { name: "当前渠道暂不支持" });
    expect(screen.getByRole("heading", { level: 1, name: "当前渠道暂未支持" })).toBeInTheDocument();
    expect(credentialsRenderSpy).not.toHaveBeenCalled();
    expect(importLoaderSpy).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("legacy startup aliases #manage and #antigravity-manage canonicalize and render real verified credentials", async () => {
    // 1. #manage canonicalizes to credentials+geminicli
    vi.resetModules();
    window.location.hash = "#manage";

    const { default: ScopedApp1 } = await import("./App");
    const { setSessionToken: scopedSetSessionToken1 } = await import("@/auth/session");

    render(<ScopedApp1 />);

    // Zero pre-verification loads
    expect(screen.getByLabelText("面板密码")).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();

    act(() => {
      scopedSetSessionToken1("synthetic-verified-manage", false);
    });

    const gcliHeading = await screen.findByRole("heading", { level: 1, name: "Gemini CLI 凭证" });
    expect(gcliHeading).toBeInTheDocument();
    expect(window.location.hash).toBe("#/credentials?channel=geminicli");

    // 2. #antigravity-manage canonicalizes to credentials+antigravity
    vi.resetModules();
    window.location.hash = "#antigravity-manage";

    const { default: ScopedApp2 } = await import("./App");
    const { setSessionToken: scopedSetSessionToken2 } = await import("@/auth/session");

    render(<ScopedApp2 />);

    act(() => {
      scopedSetSessionToken2("synthetic-verified-ag", false);
    });

    const agHeading = await screen.findByRole("heading", { level: 1, name: "Antigravity 凭证" });
    expect(agHeading).toBeInTheDocument();
    expect(window.location.hash).toBe("#/credentials");
  });
});

