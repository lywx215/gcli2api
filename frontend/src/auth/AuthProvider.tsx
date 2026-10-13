import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import { ApiError, requestJson } from "@/api/client";
import { getSessionSnapshot, setSessionToken, subscribeSession, syncSessionFromStorage } from "./session";
type Auth = { token: string | null; authenticated: boolean; sessionEpoch: number; login(password: string): Promise<void>; logout(): void };
const AuthContext = createContext<Auth | null>(null);
export function AuthProvider({ children }: { children: ReactNode }) {
  const session = useSyncExternalStore(subscribeSession, getSessionSnapshot);
  const loginAttempt = useRef(0);
  useEffect(() => {
    window.addEventListener("storage", syncSessionFromStorage);
    return () => { window.removeEventListener("storage", syncSessionFromStorage); loginAttempt.current++; };
  }, []);
  const login = useCallback(async (password: string) => {
    const attempt = ++loginAttempt.current;
    const epoch = getSessionSnapshot().sessionEpoch;
    const result = await requestJson<{ token?: unknown; success?: unknown }>("auth/login", { method: "POST", body: { password } });
    if (attempt !== loginAttempt.current || epoch !== getSessionSnapshot().sessionEpoch) throw new DOMException("登录已取消。", "AbortError");
    if (result?.success === false || typeof result?.token !== "string" || !result.token) throw new ApiError(200, null, "登录响应无效，请重新登录。");
    setSessionToken(result.token);
  }, []);
  const logout = useCallback(() => { loginAttempt.current++; setSessionToken(null); }, []);
  const value = useMemo(() => ({ ...session, authenticated: session.token !== null, login, logout }), [session, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth 必须位于 AuthProvider 内。");
  return context;
}
