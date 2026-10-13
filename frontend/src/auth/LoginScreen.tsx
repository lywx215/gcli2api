import { useState, type FormEvent } from "react";
import { useAuth } from "./AuthProvider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
export function LoginScreen() {
  const { login } = useAuth();
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true); setError("");
    const value = password; setPassword("");
    try { await login(value); }
    catch (error) { if (!(error instanceof DOMException && error.name === "AbortError")) setError("登录未完成，请检查密码或连接后重试。"); }
    finally { setPending(false); }
  }
  return <main className="grid min-h-svh place-items-center bg-background text-foreground p-4">
    <Card className="w-full max-w-sm">
      <CardHeader><p className="mb-3 text-xs font-medium tracking-widest text-muted-foreground">GCLI2API</p><CardTitle className="text-2xl leading-7">登录节点控制台</CardTitle><CardDescription>使用当前节点的控制面板密码。</CardDescription></CardHeader>
      <CardContent><form onSubmit={submit} className="space-y-5">
        <div className="space-y-2"><Label htmlFor="panel-password">面板密码</Label><Input id="panel-password" type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} aria-invalid={!!error} aria-describedby={error ? "login-error" : undefined} disabled={pending} /></div>
        {error && <p id="login-error" role="alert" className="rounded-md bg-destructive-bg px-3 py-2 text-xs leading-5 text-destructive">{error}</p>}
        <Button type="submit" className="w-full" disabled={pending || !password}>{pending ? "正在登录…" : "登录"}</Button>
        {import.meta.env.DEV && import.meta.env.VITE_UI_FIXTURES === "true" && <p className="text-xs text-muted-foreground">合成预览模式，可使用任意非空测试密码。</p>}
      </form></CardContent>
    </Card>
  </main>;
}
