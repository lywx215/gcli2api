import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import App from "./App";
import { routeFromHash } from "./routes";
it("logs in using only fixtures, navigates lazy placeholders, and logs out", async () => {
  vi.stubEnv("DEV", true); vi.stubEnv("VITE_UI_FIXTURES", "true");
  const user = userEvent.setup(); render(<App />);
  await user.type(screen.getByLabelText("面板密码"), "synthetic-preview");
  await user.click(screen.getByRole("button", { name: "登录" }));
  await screen.findByText("此页面正在接入。当前仅提供新版导航与登录，可从侧栏访问现有控制面板。");
  expect(screen.getByRole("link", { name: "模型路由" })).toHaveAttribute("href", "http://localhost:3000/model-routing");
  for (const [id, name] of [["credentials", "凭证"], ["import", "添加凭证"], ["settings", "设置"], ["logs", "日志"], ["overview", "概览"]]) {
    await user.click(screen.getByRole("link", { name }));
    await waitFor(() => expect(screen.getByRole("link", { name })).toHaveAttribute("aria-current", "page"));
    expect(location.hash).toBe(`#/${id}`);
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
