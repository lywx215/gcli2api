import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "@/app/App";
import { getServiceBase } from "@/api/client";
import "@/styles/globals.css";
const root = createRoot(document.getElementById("root")!);
try {
  getServiceBase();
  root.render(<StrictMode><App /></StrictMode>);
} catch {
  root.render(<main className="mx-auto max-w-lg space-y-3 p-6" role="alert"><h1 className="text-lg font-semibold">控制台未能初始化</h1><p>服务地址缺失或无效。请重新加载或联系管理员检查部署配置。</p></main>);
}
