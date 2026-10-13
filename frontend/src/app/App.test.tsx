import { AUTH_STORAGE_KEY, setSessionToken } from "@/auth/session";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
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
it("unknown hashes fall back to overview", () => {
  expect(routeFromHash("#/does-not-exist")).toBe("overview");
  expect(routeFromHash("#manage")).toBe("overview");
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
