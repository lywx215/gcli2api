import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor, cleanup } from "@testing-library/react";
import { setSessionToken, getSessionSnapshot, __setSessionValidationStatus } from "@/auth/session";
import { __commitPanelChannel, getPanelChannelSnapshot } from "@/domain/panel";
import { AuthProvider } from "@/auth/AuthProvider";
import { ApiError, requestJson } from "@/api/client";
import { getSavedPasswords } from "../api";
import { SavedPasswordsDialog } from "./SavedPasswordsDialog";

type RetainedConfirmHandler = React.MouseEventHandler<HTMLButtonElement>;

function getRetainedConfirmHandler(holder: { current: RetainedConfirmHandler | null }): RetainedConfirmHandler {
  const handler = holder.current;
  if (typeof handler !== "function") {
    throw new Error("Retained confirmation callback was not captured");
  }
  return handler;
}

let capturedConfirmOnClick: React.MouseEventHandler<HTMLButtonElement> | undefined;
let captureConfirmButton = false;

vi.mock("@/components/ui/button", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/button")>();
  const ObservedButton = React.forwardRef<HTMLButtonElement, React.ComponentProps<typeof actual.Button>>(
    (props, ref) => {
      if (captureConfirmButton && props.children === "确认查看") {
        capturedConfirmOnClick = props.onClick;
      }
      return <actual.Button ref={ref} {...props} />;
    }
  );
  ObservedButton.displayName = "ObservedButton";
  return {
    ...actual,
    Button: ObservedButton,
  };
});

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    requestJson: vi.fn(),
  };
});

const mockRequestJson = vi.mocked(requestJson);

const trackedDeferredResolvers = new Set<() => void>();

function createTrackedDeferred<T = unknown>(defaultValue: T = {} as T) {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolvePromise = res;
  });
  const settle = () => {
    trackedDeferredResolvers.delete(settle);
    resolvePromise(defaultValue);
  };
  trackedDeferredResolvers.add(settle);
  const resolve = (val: T) => {
    trackedDeferredResolvers.delete(settle);
    resolvePromise(val);
  };
  return { promise, resolve, settle };
}

describe("SavedPasswordsDialog", () => {
  beforeEach(() => {
    mockRequestJson.mockReset();
    mockRequestJson.mockImplementation(() => Promise.reject(new Error("Unexpected requestJson call")));
    vi.unstubAllEnvs();
    captureConfirmButton = false;
    capturedConfirmOnClick = undefined;
    setSessionToken("test-panel-session-token");
    __commitPanelChannel("antigravity");
  });

  afterEach(() => {
    captureConfirmButton = false;
    capturedConfirmOnClick = undefined;
    vi.unstubAllEnvs();
    setSessionToken(null);
    for (const settle of trackedDeferredResolvers) {
      try {
        settle();
      } catch {
        // ignore
      }
    }
    trackedDeferredResolvers.clear();
    mockRequestJson.mockReset();
    cleanup();
  });

  // Group 1: Visible confirmation requirement, zero transport on mount/open, canary passwords, absent vs empty string
  it("group 1: requires explicit visible confirmation before transport, fetches canary passwords, and displays absent vs empty string distinctly", async () => {
    mockRequestJson.mockResolvedValueOnce({
      config: {
        api_password: "canary-api-secret-101",
        panel_password: "", // explicit empty string
        // password is absent (undefined)
      },
    });

    const { unmount } = render(
      <AuthProvider>
        <SavedPasswordsDialog />
      </AuthProvider>
    );

    try {
      // 1. On mount: zero password transport
      expect(mockRequestJson).not.toHaveBeenCalled();

      // 2. Open dialog via visible entry button
      const entryButton = screen.getByRole("button", { name: "查看已保存密码" });
      entryButton.focus();
      expect(document.activeElement).toBe(entryButton);
      fireEvent.click(entryButton);

      // 3. Opening is not consent: zero password transport on open
      expect(mockRequestJson).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.getByText(/确认后将从服务端读取当前已保存的密码明文/)).toBeInTheDocument();
      expect(screen.queryByLabelText(/API 密码/)).not.toBeInTheDocument();

      // 4. Confirmation button is visible
      const confirmButton = screen.getByRole("button", { name: "确认查看" });
      expect(confirmButton).toBeInTheDocument();

      // 5. Explicit separate confirmation click triggers transport
      await act(async () => {
        fireEvent.click(confirmButton);
      });

      expect(mockRequestJson).toHaveBeenCalledTimes(1);
      expect(mockRequestJson).toHaveBeenCalledWith("config/get", {
        method: "GET",
        query: { include_secrets: true },
        signal: expect.any(AbortSignal),
      });

      // 6. Display canary passwords distinctly
      // api_password: plain-text readOnly selectable input with canary value
      const apiInput = screen.getByLabelText(/API 密码/) as HTMLInputElement;
      expect(apiInput).toBeInTheDocument();
      expect(apiInput.value).toBe("canary-api-secret-101");
      expect(apiInput.readOnly).toBe(true);

      // panel_password: explicit empty string means 空字符串 and remains an actual empty value
      const panelInput = screen.getByLabelText(/面板密码/) as HTMLInputElement;
      expect(panelInput).toBeInTheDocument();
      expect(panelInput.value).toBe("");
      expect(panelInput.placeholder).toBe("空字符串");
      expect(screen.getByText("空字符串")).toBeInTheDocument();

      // password: absent means 未提供/未知
      const serverInput = screen.getByLabelText(/通用密码/) as HTMLInputElement;
      expect(serverInput).toBeInTheDocument();
      expect(serverInput.value).toBe("");
      expect(serverInput.placeholder).toBe("未提供/未知");
      expect(screen.getByText("未提供/未知")).toBeInTheDocument();

      // Secrets must not be in title or data attributes
      expect(apiInput.getAttribute("title")).toBeNull();
      expect(apiInput.dataset.value).toBeUndefined();
      expect(apiInput.dataset.password).toBeUndefined();

      // 7. Focus returns to the actual trigger upon ordinary controlled close
      const closeButton = screen.getByRole("button", { name: "关闭" });
      fireEvent.click(closeButton);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      await waitFor(() => {
        expect(document.activeElement).toBe(entryButton);
      });
    } finally {
      unmount();
    }
  });

  // Group 2: One request per opening, synchronous confirmation ref guard, no retries on error
  it("group 2: enforces one request per opening with synchronous ref guard, displays safe Chinese error on failure without retries in same opening, and allows fresh confirmation after close/reopen", async () => {
    // Canary payload & message to verify safe adapter stripping
    const canaryErrorPayload = { canary_secret: "CANARY_INVENTED_SECRET_PAYLOAD" };
    const canaryErrorMessage = "Invented backend error carrying CANARY_INVENTED_MESSAGE";
    mockRequestJson.mockRejectedValueOnce(new ApiError(500, canaryErrorPayload, canaryErrorMessage));

    const { unmount } = render(
      <AuthProvider>
        <SavedPasswordsDialog />
      </AuthProvider>
    );

    try {
      // Initial trigger button focus
      const entryButton = screen.getByRole("button", { name: "查看已保存密码" });
      entryButton.focus();
      expect(document.activeElement).toBe(entryButton);

      // Open dialog
      fireEvent.click(entryButton);
      const confirmButton = screen.getByRole("button", { name: "确认查看" });

      // Rapidly click confirm multiple times synchronously
      await act(async () => {
        fireEvent.click(confirmButton);
        fireEvent.click(confirmButton);
        fireEvent.click(confirmButton);
      });

      // Local ref guard ensures exactly one request was made
      expect(mockRequestJson).toHaveBeenCalledTimes(1);

      // Fixed safe Chinese error rendered without error details
      expect(screen.getByRole("alert")).toHaveTextContent("读取已保存密码失败，请稍后重试");

      // Absence of canary: raw error payload and error message are never rendered
      expect(screen.queryByText(/CANARY_INVENTED_SECRET_PAYLOAD/)).not.toBeInTheDocument();
      expect(screen.queryByText(/CANARY_INVENTED_MESSAGE/)).not.toBeInTheDocument();

      // Attempting to click confirm again in the same opening does nothing
      await act(async () => {
        fireEvent.click(confirmButton);
      });
      expect(mockRequestJson).toHaveBeenCalledTimes(1);

      // Close the dialog on error via ordinary controlled close
      const closeButton = screen.getByRole("button", { name: "关闭" });
      fireEvent.click(closeButton);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

      // Focus returns to the actual trigger upon controlled close
      await waitFor(() => {
        expect(document.activeElement).toBe(entryButton);
      });

      // Reopen creates a fresh opening that requires and allows a new confirmation
      mockRequestJson.mockResolvedValueOnce({
        config: { api_password: "canary-api-secret-202" },
      });

      fireEvent.click(entryButton);
      const newConfirmButton = screen.getByRole("button", { name: "确认查看" });
      expect(newConfirmButton).not.toBeDisabled();

      await act(async () => {
        fireEvent.click(newConfirmButton);
      });

      expect(mockRequestJson).toHaveBeenCalledTimes(2);
      expect(screen.getByDisplayValue("canary-api-secret-202")).toBeInTheDocument();
    } finally {
      unmount();
    }
  });

  // Group 3: Plaintext cleanup & abort on close, cancel, unmount, and disabled becoming true
  it("group 3: clears plaintext and aborts in-flight request on close/cancel, and clears and disables when disabled prop becomes true", async () => {
    mockRequestJson.mockResolvedValueOnce({
      config: {
        api_password: "canary-secret-close-test",
      },
    });

    const { rerender, unmount } = render(
      <AuthProvider>
        <SavedPasswordsDialog />
      </AuthProvider>
    );

    const hangingDeferred = createTrackedDeferred({
      config: { api_password: "settled-deferred-group3-secret" },
    });

    try {
      // 1. Open and load canary passwords
      fireEvent.click(screen.getByRole("button", { name: "查看已保存密码" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "确认查看" }));
      });
      expect(screen.getByDisplayValue("canary-secret-close-test")).toBeInTheDocument();

      // 2. Close dialog: plaintext must be cleared and opening revoked
      fireEvent.click(screen.getByRole("button", { name: "关闭" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

      // 3. Reopen: dialog must start completely empty (not showing previous passwords)
      fireEvent.click(screen.getByRole("button", { name: "查看已保存密码" }));
      expect(screen.queryByDisplayValue("canary-secret-close-test")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "确认查看" })).toBeInTheDocument();

      // 4. Test in-flight abort on close with settled deferred promise:
      let capturedSignal: AbortSignal | undefined;
      mockRequestJson.mockImplementationOnce((_path, options) => {
        capturedSignal = options?.signal;
        return hangingDeferred.promise;
      });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "确认查看" }));
      });
      expect(capturedSignal).toBeDefined();
      expect(capturedSignal?.aborted).toBe(false);

      // Cancel / close while in-flight
      fireEvent.click(screen.getByRole("button", { name: "取消" }));
      expect(capturedSignal?.aborted).toBe(true);

      // Settle the deferred promise to guarantee clean settlement
      await act(async () => {
        hangingDeferred.resolve({
          config: { api_password: "settled-deferred-group3-secret" },
        });
      });

      // 5. Test disabled becoming true clears plaintext and closes dialog
      mockRequestJson.mockResolvedValueOnce({
        config: { api_password: "canary-secret-disabled-test" },
      });

      fireEvent.click(screen.getByRole("button", { name: "查看已保存密码" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "确认查看" }));
      });
      expect(screen.getByDisplayValue("canary-secret-disabled-test")).toBeInTheDocument();

      // Rerender with disabled={true}
      rerender(
        <AuthProvider>
          <SavedPasswordsDialog disabled={true} />
        </AuthProvider>
      );

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.queryByDisplayValue("canary-secret-disabled-test")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "查看已保存密码" })).toBeDisabled();
    } finally {
      hangingDeferred.settle();
      unmount();
    }
  });

  // Group 4: Stale owner & synchronous invalidation on session epoch change, validation ABA, and Core channel change (A->B->A)
  it("group 4: synchronously clears plaintext on session epoch change, validation object ABA change, and Core channel change, and rejects stale owner consent", async () => {
    const { unmount } = render(
      <AuthProvider>
        <SavedPasswordsDialog />
      </AuthProvider>
    );

    try {
      // Subcase A: Session epoch change clears plaintext
      mockRequestJson.mockResolvedValueOnce({
        config: { api_password: "canary-pass-session-test" },
      });

      fireEvent.click(screen.getByRole("button", { name: "查看已保存密码" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "确认查看" }));
      });
      expect(screen.getByDisplayValue("canary-pass-session-test")).toBeInTheDocument();

      // Token change triggers session epoch change synchronously
      act(() => {
        setSessionToken("new-test-token-epoch-change");
      });

      // Plaintext is immediately cleared and gated
      expect(screen.queryByDisplayValue("canary-pass-session-test")).not.toBeInTheDocument();

      // Close and reopen for Subcase B
      fireEvent.click(screen.getByRole("button", { name: /关闭|取消/ }));

      // Subcase B: Validation object ABA clears plaintext
      mockRequestJson.mockResolvedValueOnce({
        config: { api_password: "canary-pass-aba-test" },
      });

      fireEvent.click(screen.getByRole("button", { name: "查看已保存密码" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "确认查看" }));
      });
      expect(screen.getByDisplayValue("canary-pass-aba-test")).toBeInTheDocument();

      const currentEpoch = getSessionSnapshot().sessionEpoch;
      act(() => {
        // ABA: verified -> pending -> verified with a new object identity
        __setSessionValidationStatus(currentEpoch, "pending");
        __setSessionValidationStatus(currentEpoch, "verified");
      });

      expect(screen.queryByDisplayValue("canary-pass-aba-test")).not.toBeInTheDocument();

      // Close and reopen for Subcase C
      fireEvent.click(screen.getByRole("button", { name: /关闭|取消/ }));

      // Subcase C: Core channel change clears plaintext and A->B->A preserves invalidation
      // Channel is initially A ("antigravity")
      expect(getPanelChannelSnapshot().mode).toBe("antigravity");

      mockRequestJson.mockResolvedValueOnce({
        config: { api_password: "canary-pass-channel-test" },
      });

      fireEvent.click(screen.getByRole("button", { name: "查看已保存密码" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "确认查看" }));
      });
      expect(screen.getByDisplayValue("canary-pass-channel-test")).toBeInTheDocument();

      // A -> B: switch channel to "geminicli"
      act(() => {
        __commitPanelChannel("geminicli");
      });
      expect(getPanelChannelSnapshot().mode).toBe("geminicli");
      expect(screen.queryByDisplayValue("canary-pass-channel-test")).not.toBeInTheDocument();

      // B -> A: switch channel back to "antigravity"
      act(() => {
        __commitPanelChannel("antigravity");
      });
      expect(getPanelChannelSnapshot().mode).toBe("antigravity");

      // Returning to initial mode A must NOT revive old consent or old value
      expect(screen.queryByDisplayValue("canary-pass-channel-test")).not.toBeInTheDocument();

      // Close opening before Subcase D
      fireEvent.click(screen.getByRole("button", { name: /关闭|取消/ }));

      // Subcase D: Real retained unconfirmed callback across close/reopen
      // Capture actual confirm onClick from opening A with the existing Button observation wrapper; store in local constant
      captureConfirmButton = true;
      capturedConfirmOnClick = undefined;

      fireEvent.click(screen.getByRole("button", { name: "查看已保存密码" }));
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      const retainedOnClickA: { current: RetainedConfirmHandler | null } = { current: null };
      retainedOnClickA.current = capturedConfirmOnClick ?? null;
      expect(typeof retainedOnClickA.current).toBe("function");

      // Stop capture before close
      captureConfirmButton = false;
      capturedConfirmOnClick = undefined;

      // Close opening A
      fireEvent.click(screen.getByRole("button", { name: "取消" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

      // Open fresh opening B
      fireEvent.click(screen.getByRole("button", { name: "查看已保存密码" }));
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      const confirmButtonB = screen.getByRole("button", { name: "确认查看" });
      expect(confirmButtonB).not.toBeDisabled();

      mockRequestJson.mockClear();

      // Invoke retained A callback in act (not detached DOM event)
      const handlerA = getRetainedConfirmHandler(retainedOnClickA);
      await act(async () => {
        handlerA({} as React.MouseEvent<HTMLButtonElement>);
      });

      // Assert zero extra request, B remains open/unconsumed/confirm enabled
      expect(mockRequestJson).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(confirmButtonB).not.toBeDisabled();

      // Confirm B and assert exactly one genuine adapter call and fresh canary result
      mockRequestJson.mockResolvedValueOnce({
        config: { api_password: "canary-reopen-b-secret" },
      });

      await act(async () => {
        fireEvent.click(confirmButtonB);
      });

      expect(mockRequestJson).toHaveBeenCalledTimes(1);
      expect(screen.getByDisplayValue("canary-reopen-b-secret")).toBeInTheDocument();

      // Close opening B before Subcase E
      fireEvent.click(screen.getByRole("button", { name: "关闭" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

      // Subcase E: Real retained callback across full Core channel ABA
      // Capture actual unconfirmed opening A callback
      captureConfirmButton = true;
      capturedConfirmOnClick = undefined;

      fireEvent.click(screen.getByRole("button", { name: "查看已保存密码" }));
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      const retainedOnClickChannelA: { current: RetainedConfirmHandler | null } = { current: null };
      retainedOnClickChannelA.current = capturedConfirmOnClick ?? null;
      expect(typeof retainedOnClickChannelA.current).toBe("function");

      // Stop capture
      captureConfirmButton = false;
      capturedConfirmOnClick = undefined;

      // Commit antigravity -> geminicli -> antigravity through real Core
      act(() => {
        __commitPanelChannel("geminicli");
      });
      act(() => {
        __commitPanelChannel("antigravity");
      });

      // Close and reopen a fresh opening
      fireEvent.click(screen.getByRole("button", { name: "取消" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "查看已保存密码" }));
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      const freshConfirmBtn = screen.getByRole("button", { name: "确认查看" });
      expect(freshConfirmBtn).not.toBeDisabled();

      const activeElementBeforeOldCall = document.activeElement;
      mockRequestJson.mockClear();

      // Invoke old callback
      const handlerChannelA = getRetainedConfirmHandler(retainedOnClickChannelA);
      await act(async () => {
        handlerChannelA({} as React.MouseEvent<HTMLButtonElement>);
      });

      // Assert zero secret request, no fresh UI or focus mutation, no fresh ticket consumption
      expect(mockRequestJson).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(activeElementBeforeOldCall);
      expect(freshConfirmBtn).not.toBeDisabled();
      expect(screen.queryByDisplayValue("canary-reopen-b-secret")).not.toBeInTheDocument();
      expect(screen.queryByDisplayValue(/canary/)).not.toBeInTheDocument();

      // Fresh confirm still succeeds once
      mockRequestJson.mockResolvedValueOnce({
        config: { api_password: "canary-aba-channel-fresh-secret" },
      });

      await act(async () => {
        fireEvent.click(freshConfirmBtn);
      });

      expect(mockRequestJson).toHaveBeenCalledTimes(1);
      expect(screen.getByDisplayValue("canary-aba-channel-fresh-secret")).toBeInTheDocument();

      // Close dialog
      fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    } finally {
      captureConfirmButton = false;
      capturedConfirmOnClick = undefined;
      unmount();
    }
  });

  // Retained-handler after unmount test with observation wrapper
  it("retained-handler after unmount: rejects retained confirmation callback after component unmount and genuine new session with zero secret transport", async () => {
    // Enable observation capture only for this subcase
    captureConfirmButton = true;
    capturedConfirmOnClick = undefined;

    const { unmount } = render(
      <AuthProvider>
        <SavedPasswordsDialog />
      </AuthProvider>
    );

    const fetchSpy = vi.spyOn(globalThis, "fetch");

    try {
      // Open dialog to render confirmation button and capture its actual onClick
      const entryButton = screen.getByRole("button", { name: "查看已保存密码" });
      fireEvent.click(entryButton);
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(capturedConfirmOnClick).toBeDefined();

      const retainedOnClick: { current: RetainedConfirmHandler | null } = { current: null };
      retainedOnClick.current = capturedConfirmOnClick ?? null;

      // Disable capture outside this subcase setup
      captureConfirmButton = false;
      capturedConfirmOnClick = undefined;

      // Unmount the component: synchronous teardown invalidates opening, marks not mounted/open, aborts controller
      unmount();

      // Establish a genuine new verified session
      setSessionToken("genuine-new-verified-token-post-unmount");

      mockRequestJson.mockClear();
      fetchSpy.mockClear();

      // Invoke the captured real confirmation callback after unmount
      await act(async () => {
        retainedOnClick.current?.({} as React.MouseEvent<HTMLButtonElement>);
      });

      // Zero secret transport: handleConfirm mounted/open/opening ticket entrance guard aborts immediately
      expect(mockRequestJson).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      captureConfirmButton = false;
      capturedConfirmOnClick = undefined;
      fetchSpy.mockRestore();
    }
  });

  // Group 5: Late settlement with deferred transport deliberately ignoring abort, Fixture 501 unsupported error
  it("group 5: isolates deferred transport that deliberately ignores abort so late settlement cannot expose secrets or repaint, and handles fixture 501 error without fallback", async () => {
    // Subcase A: Deferred transport that deliberately ignores abort
    const deferredA = createTrackedDeferred({
      config: {
        api_password: "canary-late-leak-attempt",
      },
    });

    mockRequestJson.mockImplementationOnce(() => deferredA.promise);

    const renderA = render(
      <AuthProvider>
        <SavedPasswordsDialog />
      </AuthProvider>
    );

    try {
      // Open dialog (opening 1)
      fireEvent.click(screen.getByRole("button", { name: "查看已保存密码" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "确认查看" }));
      });
      expect(mockRequestJson).toHaveBeenCalledTimes(1);

      // Close dialog (opening 1 is aborted and dismissed)
      fireEvent.click(screen.getByRole("button", { name: "取消" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

      // Open dialog (opening 2)
      fireEvent.click(screen.getByRole("button", { name: "查看已保存密码" }));
      expect(screen.getByRole("button", { name: "确认查看" })).toBeInTheDocument();

      // Now settle the deferred promise in act, resolving with canary secrets
      await act(async () => {
        deferredA.resolve({
          config: {
            api_password: "canary-late-leak-attempt",
          },
        });
      });

      // Late settlement must NOT expose secrets in opening 2 or repaint fresh state
      expect(screen.queryByDisplayValue("canary-late-leak-attempt")).not.toBeInTheDocument();
      // Opening 2 remains fresh and unconfirmed
      expect(screen.getByRole("button", { name: "确认查看" })).toBeInTheDocument();

      // Close opening 2
      fireEvent.click(screen.getByRole("button", { name: "取消" }));
    } finally {
      deferredA.settle();
      renderA.unmount();
    }

    // Subcase A2: Pending-request unmount/abort then late resolve
    let unmountSignal: AbortSignal | undefined;
    const deferredA2 = createTrackedDeferred({
      config: { api_password: "canary-late-unmount-secret" },
    });

    mockRequestJson.mockImplementationOnce((_path, options) => {
      unmountSignal = options?.signal;
      return deferredA2.promise;
    });

    const pendingUnmountRender = render(
      <AuthProvider>
        <SavedPasswordsDialog />
      </AuthProvider>
    );
    let pendingUnmounted = false;

    try {
      fireEvent.click(screen.getByRole("button", { name: "查看已保存密码" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "确认查看" }));
      });
      expect(unmountSignal?.aborted).toBe(false);

      // Unmount while request is in flight
      pendingUnmountRender.unmount();
      pendingUnmounted = true;
      expect(unmountSignal?.aborted).toBe(true);

      // Late resolve the unmounted request
      await act(async () => {
        deferredA2.resolve({
          config: { api_password: "canary-late-unmount-secret" },
        });
      });
    } finally {
      deferredA2.settle();
      if (!pendingUnmounted) {
        pendingUnmountRender.unmount();
      }
    }

    // Subcase A3: Old-request finally after a fresh opening has succeeded
    const deferredA3 = createTrackedDeferred({
      config: { api_password: "old-request-leaked-canary" },
    });

    mockRequestJson.mockImplementationOnce(() => deferredA3.promise);

    const renderA3 = render(
      <AuthProvider>
        <SavedPasswordsDialog />
      </AuthProvider>
    );

    try {
      // Opening 1
      fireEvent.click(screen.getByRole("button", { name: "查看已保存密码" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "确认查看" }));
      });

      // Close opening 1 while request is still pending
      fireEvent.click(screen.getByRole("button", { name: "取消" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

      // Opening 2: prepare fresh successful response
      mockRequestJson.mockResolvedValueOnce({
        config: { api_password: "fresh-opening-success-canary" },
      });

      fireEvent.click(screen.getByRole("button", { name: "查看已保存密码" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "确认查看" }));
      });

      // Fresh opening succeeded and displays fresh secret
      expect(screen.getByDisplayValue("fresh-opening-success-canary")).toBeInTheDocument();
      const callsBeforeLateSettle = mockRequestJson.mock.calls.length;

      // Late resolve old request from opening 1 (its finally runs)
      await act(async () => {
        deferredA3.resolve({
          config: { api_password: "old-request-leaked-canary" },
        });
      });

      // Verify:
      // 1. No leaked old value
      expect(screen.queryByDisplayValue("old-request-leaked-canary")).not.toBeInTheDocument();
      // 2. No fresh-state clearing
      expect(screen.getByDisplayValue("fresh-opening-success-canary")).toBeInTheDocument();
      // 3. No extra request
      expect(mockRequestJson.mock.calls.length).toBe(callsBeforeLateSettle);

      // Close opening 2
      fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    } finally {
      deferredA3.settle();
      renderA3.unmount();
    }

    // Subcase B: Real fixture 501 unsupported error via VITE_UI_FIXTURES under genuine verified session
    vi.stubEnv("VITE_UI_FIXTURES", "true");
    setSessionToken("genuine-verified-session-fixture-test");

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    mockRequestJson.mockClear();
    fetchSpy.mockClear();

    const renderB = render(
      <AuthProvider>
        <SavedPasswordsDialog />
      </AuthProvider>
    );

    try {
      // Open alone: zero calls
      fireEvent.click(screen.getByRole("button", { name: "查看已保存密码" }));
      expect(mockRequestJson).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog")).toBeInTheDocument();

      // Confirm shows the fixed unsupported status
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "确认查看" }));
      });

      expect(screen.getByRole("alert")).toHaveTextContent("当前环境不支持读取已保存密码");
      // requestJson and fetch remain zero, no fallback
      expect(mockRequestJson).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      renderB.unmount();
      vi.unstubAllEnvs();
      fetchSpy.mockRestore();
      mockRequestJson.mockClear();
      setSessionToken(null);
    }
  });

  // Focused subcase verifying real getSavedPasswords adapter under real session/Core
  it("getSavedPasswords adapter: rejects unverified session with 401, returns parsed passwords on genuine verified session", async () => {
    // 1. Unverified / anonymous session rejects with 401
    setSessionToken(null);
    const controller1 = new AbortController();
    await expect(getSavedPasswords(controller1.signal)).rejects.toMatchObject({ status: 401 });

    // 2. Genuine verified session allows getSavedPasswords to proceed and return parsed passwords
    setSessionToken("adapter-test-verified-token");
    mockRequestJson.mockResolvedValueOnce({
      config: {
        api_password: "adapter-direct-api-secret",
        panel_password: "adapter-direct-panel-secret",
      },
    });

    const controller2 = new AbortController();
    const result = await getSavedPasswords(controller2.signal);
    expect(result).toEqual({
      api_password: "adapter-direct-api-secret",
      panel_password: "adapter-direct-panel-secret",
    });
    expect(mockRequestJson).toHaveBeenCalledWith("config/get", {
      method: "GET",
      query: { include_secrets: true },
      signal: controller2.signal,
    });
  });
});
