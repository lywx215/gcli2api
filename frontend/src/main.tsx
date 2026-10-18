import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { getServiceBase } from "@/api/client";
import { maybeRedirectLegacyStartup } from "@/app/legacyEntry";
import "@/styles/globals.css";

const container = document.getElementById("root");
if (container) {
  let root: ReturnType<typeof createRoot> | null = null;
  const renderInitError = () => {
    if (!root) {
      root = createRoot(container);
    }
    root.render(
      <main className="mx-auto max-w-lg space-y-3 p-6" role="alert">
        <h1 className="text-lg font-semibold">控制台未能初始化</h1>
        <p>服务地址缺失或无效。请重新加载或联系管理员检查部署配置。</p>
      </main>
    );
  };

  try {
    getServiceBase();
    if (!maybeRedirectLegacyStartup()) {
      const appRoot = createRoot(container);
      root = appRoot;
      import("@/app/App")
        .then(({ default: App }) => {
          appRoot.render(
            <StrictMode>
              <App />
            </StrictMode>
          );
        })
        .catch(() => {
          renderInitError();
        });
    }
  } catch {
    renderInitError();
  }
}
