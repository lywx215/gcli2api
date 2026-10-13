import { fileURLToPath, URL } from "node:url";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.UI_PROXY_TARGET || "http://127.0.0.1:7861";
  return {
    base: "./",
    plugins: [react(), tailwindcss()],
    resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
    server: {
      host: "127.0.0.1",
      proxy: Object.fromEntries([
        ...["/auth", "/creds", "/config", "/version", "/model-routing"].map(path => [path, { target }]),
        ["/logs", { target, ws: true }],
      ]),
    },
    test: { environment: "jsdom", setupFiles: ["./src/app/test-setup.ts"], restoreMocks: true, unstubEnvs: true, unstubGlobals: true, environmentOptions: { jsdom: { url: "http://localhost:3000/ui/" } } },
    build: { outDir: "../ui-dist", emptyOutDir: true, manifest: true, sourcemap: false },
  };
});
