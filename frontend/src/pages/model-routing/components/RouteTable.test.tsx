import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Issue } from "../types";
import { RouteTable, type RouteTableProps } from "./RouteTable";

const row = (channel = "antigravity", name = "synthetic-alpha") => ({ channel, public_name: name, upstream_name: "synthetic-upstream", enabled: true });
const props = (routes: unknown[], overrides: Partial<RouteTableProps> = {}): RouteTableProps => ({ routes, channel: "antigravity", issues: [], disabled: false, onChange: vi.fn(), onRemove: vi.fn(), ...overrides });
const layout = (container: HTMLElement, value: string) => within(container.querySelector<HTMLElement>(`[data-layout="${value}"]`)!);
const issue = (overrides: Partial<Issue> = {}): Issue => ({ channel: "antigravity", row: 0, field: "public_name", reason: "DUPLICATE_PUBLIC_NAME", related_rows: [], ...overrides });

describe("model routing table presentation", () => {
  it("uses full-table row numbers and exact indexes in both responsive layouts", () => {
    const p = props([null, row(), row("geminicli", "synthetic-cli"), row("antigravity", "synthetic-next"), { channel: "other" }]);
    const { container } = render(<RouteTable {...p} />);
    for (const variant of ["desktop", "mobile"]) {
      const view = layout(container, variant);
      expect(view.getByLabelText("第 2 行公开名称")).toHaveValue("synthetic-alpha");
      expect(view.getByLabelText("第 4 行公开名称")).toHaveValue("synthetic-next");
      expect(view.queryByLabelText("第 1 行公开名称")).not.toBeInTheDocument();
      expect(view.queryByLabelText("第 3 行公开名称")).not.toBeInTheDocument();
    }
    const desktop = layout(container, "desktop");
    fireEvent.change(desktop.getByLabelText("第 4 行公开名称"), { target: { value: "synthetic-edited" } });
    expect(p.onChange).toHaveBeenCalledWith(3, { public_name: "synthetic-edited" });
    fireEvent.click(desktop.getByRole("button", { name: "删除第 2 行路由" }));
    expect(p.onRemove).toHaveBeenCalledWith(1);
    const ids = Array.from(container.querySelectorAll("[id]")).map(element => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("marks the primary and related rows across channels and attaches safe diagnostics", () => {
    const routes = [null, row(), row("geminicli")];
    const issues = [issue({ row: 1, related_rows: [2], field: "upstream_name", reason: "PROTECTED_ENTRY_CAPTURE" })];
    const p = props(routes, { issues });
    const { container, rerender } = render(<RouteTable {...p} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Antigravity：1 · Gemini CLI：1 · 全局：0");
    for (const [channel, number] of [["antigravity", 2], ["geminicli", 3]] as const) {
      rerender(<RouteTable {...p} channel={channel} />);
      for (const variant of ["desktop", "mobile"]) {
        const view = layout(container, variant);
        const upstream = view.getByLabelText(`第 ${number} 行目标名称`);
        expect(upstream).toHaveAttribute("aria-invalid", "true");
        expect(upstream).toHaveAccessibleDescription(expect.stringContaining("路由会改变受保护模型入口"));
        expect(upstream).toHaveAccessibleDescription(expect.stringContaining("第 2 行、第 3 行"));
        expect(view.getByLabelText(`第 ${number} 行公开名称`)).toHaveAttribute("aria-invalid", "false");
      }
    }
  });

  it("keeps non-text and non-boolean historical values until an explicit edit", () => {
    const raw = { channel: "antigravity", public_name: 27, upstream_name: { synthetic: "object" }, enabled: "false", legacy: true };
    const before = JSON.stringify(raw);
    const p = props([raw]);
    const { container } = render(<RouteTable {...p} />);
    const desktop = layout(container, "desktop");
    const publicName = desktop.getByLabelText("第 1 行公开名称");
    const upstream = desktop.getByLabelText("第 1 行目标名称");
    expect(publicName).toHaveValue("27");
    expect(publicName).toHaveAttribute("readonly");
    expect(upstream).toHaveValue('{"synthetic":"object"}');
    expect(upstream).toHaveAttribute("readonly");
    expect(desktop.getByRole("switch", { name: "第 1 行启用路由" })).not.toBeChecked();
    expect(desktop.getByText(/本行包含 1 个未识别字段/)).toHaveTextContent("请删除此行后重新添加");
    expect(p.onChange).not.toHaveBeenCalled();
    expect(JSON.stringify(raw)).toBe(before);
    fireEvent.change(publicName, { target: { value: "automatic-conversion" } });
    expect(p.onChange).not.toHaveBeenCalled();
    fireEvent.click(desktop.getByRole("button", { name: "第 1 行公开名称编辑为文本" }));
    expect(p.onChange).toHaveBeenLastCalledWith(0, { public_name: "" });
    fireEvent.click(desktop.getByRole("switch", { name: "第 1 行启用路由" }));
    expect(p.onChange).toHaveBeenLastCalledWith(0, { enabled: true });
    expect(JSON.stringify(raw)).toBe(before);
  });

  it("shows missing required values without defaulting enabled to true", () => {
    const p = props([{ channel: "antigravity" }]);
    const { container } = render(<RouteTable {...p} />);
    const desktop = layout(container, "desktop");
    expect(desktop.getByLabelText("第 1 行公开名称")).toHaveValue("未提供");
    expect(desktop.getByRole("switch", { name: "第 1 行启用路由" })).not.toBeChecked();
    expect(desktop.getByRole("switch", { name: "第 1 行启用路由" })).toHaveAttribute("aria-invalid", "true");
    expect(desktop.getByRole("switch", { name: "第 1 行启用路由" })).toHaveAccessibleDescription(expect.stringContaining("未提供启用状态"));
    expect(p.onChange).not.toHaveBeenCalled();
  });

  it("disables text edits, repair buttons, switches and deletion while busy", () => {
    const p = props([{ ...row(), public_name: false }], { disabled: true });
    const { container } = render(<RouteTable {...p} />);
    for (const variant of ["desktop", "mobile"]) {
      const view = layout(container, variant);
      for (const control of [...view.getAllByRole("textbox"), ...view.getAllByRole("button"), ...view.getAllByRole("switch")]) expect(control).toBeDisabled();
    }
    expect(p.onChange).not.toHaveBeenCalled();
    expect(p.onRemove).not.toHaveBeenCalled();
  });

  it("marks every field for a row-wide issue and uses a safe global fallback", () => {
    const p = props([row()], { issues: [issue({ field: null, reason: "UNKNOWN_FIELD" }), issue({ channel: null, row: null, field: null, reason: "unsafe-server-detail" })] });
    const { container } = render(<RouteTable {...p} />);
    const desktop = layout(container, "desktop");
    for (const label of ["第 1 行公开名称", "第 1 行目标名称", "第 1 行启用路由"]) expect(desktop.getByLabelText(label)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("完整路由表共有 2 个校验问题");
    expect(screen.getByRole("alert")).toHaveTextContent("全局：1");
    expect(screen.getByRole("alert")).toHaveTextContent("配置未通过服务端校验");
    expect(container).not.toHaveTextContent("unsafe-server-detail");
  });

  it("focuses the visible layout after validation and stays usable with a keyboard", async () => {
    const user = userEvent.setup();
    const p = props([row(), row("geminicli")]);
    const { container, rerender } = render(<RouteTable {...p} />);
    const desktop = container.querySelector<HTMLElement>('[data-layout="desktop"]')!;
    const mobile = container.querySelector<HTMLElement>('[data-layout="mobile"]')!;
    desktop.style.display = "none";
    rerender(<RouteTable {...p} focusRequest={{ row: 0, field: "upstream_name", nonce: 1 }} />);
    expect(within(mobile).getByLabelText("第 1 行目标名称")).toHaveFocus();
    await user.tab();
    expect(within(mobile).getByRole("switch", { name: "第 1 行启用路由" })).toHaveFocus();
    await user.keyboard(" ");
    expect(p.onChange).toHaveBeenLastCalledWith(0, { enabled: false });
    desktop.style.display = "block";
    mobile.style.visibility = "hidden";
    rerender(<RouteTable {...p} focusRequest={{ row: 0, field: "public_name", nonce: 2 }} />);
    expect(within(desktop).getByLabelText("第 1 行公开名称")).toHaveFocus();
  });

  it("waits for a requested row's channel before moving focus", () => {
    const p = props([row(), row("geminicli")]);
    const { container, rerender } = render(<RouteTable {...p} focusRequest={{ row: 1, field: "enabled", nonce: 1 }} />);
    expect(document.activeElement).toBe(document.body);
    rerender(<RouteTable {...p} channel="geminicli" focusRequest={{ row: 1, field: "enabled", nonce: 1 }} />);
    expect(layout(container, "desktop").getByRole("switch", { name: "第 2 行启用路由" })).toHaveFocus();
  });
});
