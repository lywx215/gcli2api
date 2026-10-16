import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import { ApiError, requestJson } from "@/api/client";
import { readSafeConfig } from "@/api/config";
import {
  getSessionSnapshot,
  getSessionValidationSnapshot,
  setSessionToken,
  subscribeSession,
  subscribeSessionValidation,
  syncSessionFromStorage,
  registerSessionCleanup,
  __setSessionValidationStatus,
  type SessionValidationStatus,
} from "./session";

type Auth = {
  token: string | null;
  authenticated: boolean;
  sessionEpoch: number;
  validationStatus: SessionValidationStatus;
  retryValidation(): void;
  login(password: string): Promise<void>;
  logout(): void;
};

const AuthContext = createContext<Auth | null>(null);

type ActiveProbe = {
  epoch: number;
  attempt: number;
  controller: AbortController;
  promise: Promise<void>;
  subscribers: number;
};

let activeProbe: ActiveProbe | null = null;

function abortActiveProbe(): void {
  if (activeProbe) {
    const probeToAbort = activeProbe;
    activeProbe = null;
    probeToAbort.controller.abort();
  }
}

// Session transitions automatically abort any in-flight probe
registerSessionCleanup(abortActiveProbe);

export function AuthProvider({ children }: { children: ReactNode }) {
  const session = useSyncExternalStore(subscribeSession, getSessionSnapshot);
  const validation = useSyncExternalStore(subscribeSessionValidation, getSessionValidationSnapshot);
  const loginAttempt = useRef(0);
  const probeAttempt = useRef(0);

  useEffect(() => {
    window.addEventListener("storage", syncSessionFromStorage);
    return () => {
      window.removeEventListener("storage", syncSessionFromStorage);
      loginAttempt.current++;
    };
  }, []);

  const authenticated = Boolean(
    session.token !== null &&
    validation.sessionEpoch === session.sessionEpoch &&
    validation.status === "verified"
  );

  useEffect(() => {
    if (session.token === null || validation.status !== "pending") {
      return;
    }
    const epoch = session.sessionEpoch;
    const attempt = probeAttempt.current;

    let probe: ActiveProbe;

    if (
      activeProbe &&
      activeProbe.epoch === epoch &&
      activeProbe.attempt === attempt &&
      !activeProbe.controller.signal.aborted
    ) {
      activeProbe.subscribers++;
      probe = activeProbe;
    } else {
      abortActiveProbe();
      const controller = new AbortController();
      const probeRecord: ActiveProbe = {
        epoch,
        attempt,
        controller,
        promise: Promise.resolve(),
        subscribers: 1,
      };
      probe = probeRecord;
      activeProbe = probeRecord;

      const probePromise = (async () => {
        try {
          await readSafeConfig(controller.signal);
          if (controller.signal.aborted) return;
          const current = getSessionSnapshot();
          if (
            !controller.signal.aborted &&
            activeProbe === probeRecord &&
            probeRecord.subscribers > 0 &&
            probeRecord.epoch === epoch &&
            probeRecord.attempt === attempt &&
            current.sessionEpoch === epoch &&
            current.token !== null
          ) {
            __setSessionValidationStatus(epoch, "verified");
          }
        } catch (err: unknown) {
          if (controller.signal.aborted) return;
          if ((err as { name?: string })?.name === "AbortError") return;
          const current = getSessionSnapshot();
          if (
            !controller.signal.aborted &&
            activeProbe === probeRecord &&
            probeRecord.subscribers > 0 &&
            probeRecord.epoch === epoch &&
            probeRecord.attempt === attempt &&
            current.sessionEpoch === epoch &&
            current.token !== null
          ) {
            __setSessionValidationStatus(epoch, "unavailable");
          }
        } finally {
          if (activeProbe === probeRecord) {
            activeProbe = null;
          }
        }
      })();

      probeRecord.promise = probePromise;
    }

    return () => {
      probe.subscribers--;
      if (probe.subscribers <= 0) {
        queueMicrotask(() => {
          if (probe.subscribers <= 0) {
            probe.controller.abort();
            if (activeProbe === probe) {
              activeProbe = null;
            }
          }
        });
      }
    };
  }, [session.token, session.sessionEpoch, validation.status]);

  const retryValidation = useCallback(() => {
    const currentSession = getSessionSnapshot();
    const currentValidation = getSessionValidationSnapshot();
    if (currentSession.token !== null && currentValidation.status === "unavailable") {
      abortActiveProbe();
      probeAttempt.current++;
      __setSessionValidationStatus(currentSession.sessionEpoch, "pending");
    }
  }, []);

  const login = useCallback(async (password: string) => {
    const attempt = ++loginAttempt.current;
    const epoch = getSessionSnapshot().sessionEpoch;
    abortActiveProbe();
    try {
      const result = await requestJson<{ token?: unknown; success?: unknown }>("auth/login", {
        method: "POST",
        body: { password },
      });
      if (attempt !== loginAttempt.current || epoch !== getSessionSnapshot().sessionEpoch) {
        throw new DOMException("登录已取消。", "AbortError");
      }
      if (result?.success === false || typeof result?.token !== "string" || !result.token) {
        throw new ApiError(200, null, "登录响应无效，请重新登录。");
      }
      setSessionToken(result.token);
    } catch (err: unknown) {
      if (attempt === loginAttempt.current) {
        const currentSession = getSessionSnapshot();
        const currentValidation = getSessionValidationSnapshot();
        if (
          currentSession.sessionEpoch === epoch &&
          currentSession.token !== null &&
          currentValidation.sessionEpoch === epoch &&
          currentValidation.status === "pending"
        ) {
          __setSessionValidationStatus(epoch, "unavailable");
        }
      }
      throw err;
    }
  }, []);

  const logout = useCallback(() => {
    loginAttempt.current++;
    abortActiveProbe();
    setSessionToken(null);
  }, []);

  const value = useMemo<Auth>(
    () => ({
      token: session.token,
      authenticated,
      sessionEpoch: session.sessionEpoch,
      validationStatus: validation.status,
      retryValidation,
      login,
      logout,
    }),
    [session.token, session.sessionEpoch, authenticated, validation.status, retryValidation, login, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): Auth {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth 必须位于 AuthProvider 内。");
  return context;
}
