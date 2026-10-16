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
  return <main className="grid min-h-svh place-items-center bg-background text-foreground p-3.5">
    <Card className="w-full max-w-sm p-5 shadow-card">
      <CardHeader className="p-0 pb-3">
        <p className="mb-1 text-[11px] font-medium tracking-widest text-muted-foreground">GCLI2API</p>
        <CardTitle className="text-xl leading-6 font-semibold">登录节点控制台</CardTitle>
        <CardDescription className="text-xs text-muted-foreground">使用当前节点的控制面板密码。</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <form onSubmit={submit} className="space-y-3.5">
          <div className="space-y-1.5">
            <Label htmlFor="panel-password" className="text-xs font-medium">面板密码</Label>
            <Input
              id="panel-password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={event => setPassword(event.target.value)}
              aria-invalid={!!error}
              aria-describedby={error ? "login-error" : undefined}
              disabled={pending}
              className="h-[34px] px-2.5 py-1 text-base md:text-sm"
            />
          </div>
          {error && <p id="login-error" role="alert" className="rounded-md bg-destructive-bg px-2.5 py-1.5 text-xs text-destructive">{error}</p>}
          <Button type="submit" className="h-[34px] w-full text-sm font-medium" disabled={pending || !password}>
            {pending ? "正在登录…" : "登录"}
          </Button>
          {import.meta.env.DEV && import.meta.env.VITE_UI_FIXTURES === "true" && <p className="text-[11px] text-muted-foreground">合成预览模式，可使用任意非空测试密码。</p>}
        </form>
      </CardContent>
    </Card>
  </main>;
}
