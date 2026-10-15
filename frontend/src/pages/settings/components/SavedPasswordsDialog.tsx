import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/auth/AuthProvider";
import {
  getSessionSnapshot,
  getSessionValidationSnapshot,
  registerSessionCleanup,
  subscribeSession,
  subscribeSessionValidation,
  type SessionValidationSnapshot,
} from "@/auth/session";
import {
  getPanelChannelSnapshot,
  registerChannelCleanup,
  subscribePanelChannel,
  type PanelMode,
} from "@/domain/panel";
import { ApiError } from "@/api/client";
import { getSavedPasswords } from "../api";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type PasswordsState = {
  api_password?: string;
  panel_password?: string;
  password?: string;
} | null;

const PASSWORD_FIELDS = [
  { key: "api_password", label: "API 密码 (api_password)" },
  { key: "panel_password", label: "面板密码 (panel_password)" },
  { key: "password", label: "通用密码 (password)" },
] as const;

function getSafeErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 501) {
      return "当前环境不支持读取已保存密码";
    }
    if (error.status === 401) {
      return "登录已失效，请重新登录";
    }
    if (error.status === 403) {
      return "无权访问已保存密码";
    }
  }
  return "读取已保存密码失败，请稍后重试";
}

export function SavedPasswordsDialog({ disabled = false }: { disabled?: boolean }) {
  const auth = useAuth();
  const [open, setOpen] = useState(false);
  const [passwords, setPasswords] = useState<PasswordsState>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const isMountedRef = useRef(true);
  const isOpenRef = useRef(false);
  const disabledRef = useRef(disabled);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const activeControllerRef = useRef<AbortController | null>(null);

  const openingCounter = useRef(0);
  const currentOpeningIdRef = useRef(0);
  const consumedOpeningIdRef = useRef<number | null>(null);
  const revokedOpeningIdsRef = useRef<Set<number>>(new Set());

  const attemptCounter = useRef(0);
  const currentAttemptIdRef = useRef(0);

  const capturedSessionEpochRef = useRef<number | null>(null);
  const capturedValidationRef = useRef<SessionValidationSnapshot | null>(null);
  const capturedChannelEpochRef = useRef<number | null>(null);
  const capturedChannelModeRef = useRef<PanelMode | null>(null);

  disabledRef.current = disabled;
  isOpenRef.current = open;

  const invalidateAndClear = useCallback(() => {
    if (activeControllerRef.current) {
      const c = activeControllerRef.current;
      activeControllerRef.current = null;
      c.abort();
    }

    if (currentOpeningIdRef.current) {
      revokedOpeningIdsRef.current.add(currentOpeningIdRef.current);
    }

    currentAttemptIdRef.current = ++attemptCounter.current;
    currentOpeningIdRef.current = ++openingCounter.current;
    consumedOpeningIdRef.current = null;

    capturedSessionEpochRef.current = null;
    capturedValidationRef.current = null;
    capturedChannelEpochRef.current = null;
    capturedChannelModeRef.current = null;

    setPasswords(null);
    setStatus("idle");
    setErrorMessage(null);
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      isOpenRef.current = false;
      invalidateAndClear();
    };
  }, [invalidateAndClear]);

  useEffect(() => {
    disabledRef.current = disabled;
    if (disabled) {
      isOpenRef.current = false;
      invalidateAndClear();
      setOpen(false);
    }
  }, [disabled, invalidateAndClear]);

  useEffect(() => {
    const handleSessionChange = () => {
      if (isMountedRef.current && isOpenRef.current) {
        invalidateAndClear();
      }
    };

    const handleValidationChange = () => {
      if (isMountedRef.current && isOpenRef.current) {
        const curValidation = getSessionValidationSnapshot();
        if (
          curValidation.status !== "verified" ||
          curValidation !== capturedValidationRef.current
        ) {
          invalidateAndClear();
        }
      }
    };

    const handleChannelChange = () => {
      if (isMountedRef.current && isOpenRef.current) {
        invalidateAndClear();
      }
    };

    const unSubSession = subscribeSession(handleSessionChange);
    const unSubValidation = subscribeSessionValidation(handleValidationChange);
    const unSubChannel = subscribePanelChannel(handleChannelChange);
    const unCleanSession = registerSessionCleanup(handleSessionChange);
    const unCleanChannel = registerChannelCleanup(handleChannelChange);

    return () => {
      unSubSession();
      unSubValidation();
      unSubChannel();
      unCleanSession();
      unCleanChannel();
    };
  }, [invalidateAndClear]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!isMountedRef.current) {
      return;
    }
    if (disabled && nextOpen) {
      return;
    }
    invalidateAndClear();
    if (nextOpen) {
      const nextOpeningId = ++openingCounter.current;
      currentOpeningIdRef.current = nextOpeningId;
      consumedOpeningIdRef.current = null;
      isOpenRef.current = true;
      setOpen(true);
    } else {
      isOpenRef.current = false;
      setOpen(false);
    }
  };

  const handleConfirm = async (boundOpeningId: number) => {
    if (!isMountedRef.current || !isOpenRef.current || disabledRef.current) {
      return;
    }
    if (
      !boundOpeningId ||
      boundOpeningId !== currentOpeningIdRef.current ||
      revokedOpeningIdsRef.current.has(boundOpeningId) ||
      consumedOpeningIdRef.current === boundOpeningId
    ) {
      return;
    }
    consumedOpeningIdRef.current = boundOpeningId;

    const currentSession = getSessionSnapshot();
    const currentValidation = getSessionValidationSnapshot();
    const currentChannel = getPanelChannelSnapshot();

    if (
      currentSession.token === null ||
      currentValidation.status !== "verified" ||
      currentValidation.sessionEpoch !== currentSession.sessionEpoch
    ) {
      setStatus("error");
      setErrorMessage("登录已失效，请重新登录");
      return;
    }

    const sessionEpoch = currentSession.sessionEpoch;
    const validationSnapshot = currentValidation;
    const channelEpoch = currentChannel.channelEpoch;
    const channelMode = currentChannel.mode;

    capturedSessionEpochRef.current = sessionEpoch;
    capturedValidationRef.current = validationSnapshot;
    capturedChannelEpochRef.current = channelEpoch;
    capturedChannelModeRef.current = channelMode;

    if (activeControllerRef.current) {
      const prev = activeControllerRef.current;
      activeControllerRef.current = null;
      prev.abort();
    }

    const attemptId = ++attemptCounter.current;
    currentAttemptIdRef.current = attemptId;
    const controller = new AbortController();
    activeControllerRef.current = controller;

    setStatus("loading");
    setErrorMessage(null);

    try {
      const result = await getSavedPasswords(controller.signal);

      if (
        !isMountedRef.current ||
        !isOpenRef.current ||
        disabledRef.current ||
        controller.signal.aborted ||
        currentOpeningIdRef.current !== boundOpeningId ||
        currentAttemptIdRef.current !== attemptId ||
        revokedOpeningIdsRef.current.has(boundOpeningId)
      ) {
        return;
      }

      const postSession = getSessionSnapshot();
      const postValidation = getSessionValidationSnapshot();
      const postChannel = getPanelChannelSnapshot();

      if (
        postSession.sessionEpoch !== sessionEpoch ||
        postSession.token === null ||
        postValidation !== validationSnapshot ||
        postValidation.status !== "verified" ||
        postValidation.sessionEpoch !== sessionEpoch ||
        postChannel.channelEpoch !== channelEpoch ||
        postChannel.mode !== channelMode
      ) {
        return;
      }

      setPasswords(result);
      setStatus("success");
    } catch (err: unknown) {
      if (
        !isMountedRef.current ||
        !isOpenRef.current ||
        disabledRef.current ||
        controller.signal.aborted ||
        currentOpeningIdRef.current !== boundOpeningId ||
        currentAttemptIdRef.current !== attemptId ||
        revokedOpeningIdsRef.current.has(boundOpeningId)
      ) {
        return;
      }

      const postSession = getSessionSnapshot();
      const postValidation = getSessionValidationSnapshot();
      const postChannel = getPanelChannelSnapshot();

      if (
        postSession.sessionEpoch !== sessionEpoch ||
        postSession.token === null ||
        postValidation !== validationSnapshot ||
        postValidation.status !== "verified" ||
        postValidation.sessionEpoch !== sessionEpoch ||
        postChannel.channelEpoch !== channelEpoch ||
        postChannel.mode !== channelMode
      ) {
        return;
      }

      if (
        (typeof DOMException !== "undefined" && err instanceof DOMException && err.name === "AbortError") ||
        (err instanceof Error && err.name === "AbortError")
      ) {
        return;
      }

      setStatus("error");
      setErrorMessage(getSafeErrorMessage(err));
    } finally {
      if (activeControllerRef.current === controller) {
        activeControllerRef.current = null;
      }
    }
  };

  const currentSession = getSessionSnapshot();
  const currentValidation = getSessionValidationSnapshot();
  const currentChannel = getPanelChannelSnapshot();

  const isEnvironmentValid =
    !disabled &&
    open &&
    auth.authenticated &&
    currentSession.token !== null &&
    capturedSessionEpochRef.current !== null &&
    currentSession.sessionEpoch === capturedSessionEpochRef.current &&
    currentValidation === capturedValidationRef.current &&
    currentValidation.status === "verified" &&
    currentValidation.sessionEpoch === capturedSessionEpochRef.current &&
    capturedChannelEpochRef.current !== null &&
    currentChannel.channelEpoch === capturedChannelEpochRef.current &&
    currentChannel.mode === capturedChannelModeRef.current;

  const effectivePasswords = isEnvironmentValid ? passwords : null;

  const renderedOpeningId = currentOpeningIdRef.current;
  const isRevoked = revokedOpeningIdsRef.current.has(renderedOpeningId);
  const hasConsumed = consumedOpeningIdRef.current === renderedOpeningId;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          ref={triggerRef}
          variant="outline"
          disabled={disabled}
        >
          查看已保存密码
        </Button>
      </DialogTrigger>
      <DialogContent
        onCloseAutoFocus={(e) => {
          if (!triggerRef.current || !document.contains(triggerRef.current)) {
            e.preventDefault();
          } else {
            triggerRef.current.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>查看已保存密码</DialogTitle>
          <DialogDescription>
            确认后将从服务端读取当前已保存的密码明文。请确保周围环境安全，并在使用完毕后及时关闭。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {status === "loading" && (
            <div role="status" className="text-sm text-muted-foreground">
              正在读取已保存密码...
            </div>
          )}

          {status === "error" && errorMessage && (
            <div role="alert" className="text-sm text-destructive">
              {errorMessage}
            </div>
          )}

          {effectivePasswords !== null && (
            <div className="space-y-3">
              {PASSWORD_FIELDS.map(({ key, label }) => {
                const hasKey = Object.prototype.hasOwnProperty.call(effectivePasswords, key);
                const rawVal = hasKey ? effectivePasswords[key as keyof typeof effectivePasswords] : undefined;
                const isAbsent = rawVal === undefined;
                const isEmptyString = rawVal === "";
                const displayValue = isAbsent || isEmptyString ? "" : rawVal;
                const placeholder = isAbsent ? "未提供/未知" : isEmptyString ? "空字符串" : "";

                return (
                  <div key={key} className="space-y-1">
                    <div className="flex items-center justify-between">
                      <label htmlFor={`saved-password-${key}`} className="text-sm font-medium">
                        {label}
                      </label>
                      {isAbsent && (
                        <span className="text-xs text-muted-foreground">未提供/未知</span>
                      )}
                      {isEmptyString && (
                        <span className="text-xs text-muted-foreground">空字符串</span>
                      )}
                    </div>
                    <Input
                      id={`saved-password-${key}`}
                      type="text"
                      readOnly
                      tabIndex={0}
                      value={displayValue}
                      placeholder={placeholder}
                      className="font-mono text-sm"
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <DialogFooter className="flex flex-row justify-end space-x-2">
          {effectivePasswords === null && (
            <>
              <Button
                variant="outline"
                onClick={() => handleOpenChange(false)}
              >
                {status === "error" ? "关闭" : "取消"}
              </Button>
              <Button
                onClick={() => handleConfirm(renderedOpeningId)}
                disabled={disabled || hasConsumed || isRevoked || status === "loading" || status === "error"}
              >
                确认查看
              </Button>
            </>
          )}
          {effectivePasswords !== null && (
            <Button
              variant="outline"
              onClick={() => handleOpenChange(false)}
            >
              关闭
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
