import { useEffect, useId } from "react";
import { Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { affectedRows, display, fieldInvalid, issueText, object, rowChannel, type Issue, type RoutingChannel } from "../types";

export type RouteTableFocusRequest = { row: number; field?: string; nonce: number };
export type RouteTableProps = {
  routes: unknown[];
  channel: RoutingChannel;
  issues: Issue[];
  disabled: boolean;
  onChange: (index: number, patch: Record<string, unknown>) => void;
  onRemove: (index: number) => void;
  focusRequest?: RouteTableFocusRequest;
};

const labels = { public_name: "公开名称", upstream_name: "目标名称", enabled: "启用路由" };
const knownFields = new Set(["channel", "public_name", "upstream_name", "enabled"]);
type EditableField = keyof typeof labels;
type Layout = "desktop" | "mobile";

function visible(element: HTMLElement) {
  for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
    const style = window.getComputedStyle(ancestor);
    if (ancestor.hidden || ancestor.getAttribute("aria-hidden") === "true" || style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
  }
  return true;
}

function rawWarning(row: Record<string, unknown>, field: EditableField) {
  if (!Object.hasOwn(row, field)) return field === "enabled" ? "未提供启用状态；切换开关后会写入布尔值。" : "未提供此名称；点击编辑后可填写文本。";
  if (field === "enabled") return typeof row.enabled === "boolean" ? null : "启用状态不是布尔值，现有值已保留；切换开关后替换为布尔值。";
  return typeof row[field] === "string" ? null : "此名称不是文本，现有值已保留；点击编辑后可替换为文本。";
}

export function RouteTable({ routes, channel, issues, disabled, onChange, onRemove, focusRequest }: RouteTableProps) {
  const prefix = useId();
  const activeRows = routes.flatMap((value, index) => object(value) && rowChannel(value) === channel ? [{ row: value, index }] : []);
  const idFor = (layout: Layout, index: number, field: string) => `${prefix}-${layout}-${index}-${field}`;

  useEffect(() => {
    if (!focusRequest || disabled) return;
    const field = Object.hasOwn(labels, focusRequest.field ?? "") ? focusRequest.field! : "public_name";
    const candidates = (["desktop", "mobile"] as const).map(layout => document.getElementById(`${prefix}-${layout}-${focusRequest.row}-${field}`));
    candidates.find((element): element is HTMLElement => element instanceof HTMLElement && visible(element))?.focus();
  }, [channel, disabled, focusRequest?.row, focusRequest?.field, focusRequest?.nonce, prefix]);

  const issuesForRow = (index: number) => issues.filter(issue => affectedRows(issue).includes(index));
  const countForChannel = (value: RoutingChannel) => issues.filter(issue => affectedRows(issue).some(index => rowChannel(routes[index]) === value) || (affectedRows(issue).length === 0 && issue.channel === value)).length;
  const globalCount = issues.filter(issue => affectedRows(issue).length === 0 ? issue.channel !== "antigravity" && issue.channel !== "geminicli" : affectedRows(issue).some(index => rowChannel(routes[index]) === null)).length;

  function diagnostics(row: Record<string, unknown>, index: number, layout: Layout) {
    const unknownCount = Object.keys(row).filter(field => !knownFields.has(field)).length;
    const rowIssues = issuesForRow(index);
    if (!unknownCount && rowIssues.length === 0) return null;
    return <div id={idFor(layout, index, "diagnostics")} className="space-y-1 text-sm text-destructive">
      {unknownCount > 0 && <p>本行包含 {unknownCount} 个未识别字段，现有数据已保留。请删除此行后重新添加。</p>}
      {rowIssues.map((issue, issueIndex) => <p key={issueIndex}>{issueText(issue)}{issue.related_rows.length > 0 && <span> 关联行：{affectedRows(issue).map(value => `第 ${value + 1} 行`).join("、")}。</span>}</p>)}
    </div>;
  }

  function describedBy(row: Record<string, unknown>, index: number, field: EditableField, layout: Layout) {
    const ids = [];
    if (rawWarning(row, field)) ids.push(idFor(layout, index, `${field}-warning`));
    if (issuesForRow(index).length || Object.keys(row).some(key => !knownFields.has(key))) ids.push(idFor(layout, index, "diagnostics"));
    return ids.length > 0 ? ids.join(" ") : undefined;
  }

  function nameField(row: Record<string, unknown>, index: number, field: "public_name" | "upstream_name", layout: Layout) {
    const id = idFor(layout, index, field);
    const warning = rawWarning(row, field);
    const validType = typeof row[field] === "string";
    return <div className="min-w-0 space-y-1.5">
      {layout === "mobile" && <label htmlFor={id} className="text-sm font-medium">{labels[field]}</label>}
      <Input id={id} aria-label={`第 ${index + 1} 行${labels[field]}`} aria-invalid={!validType || fieldInvalid(issues, index, field)} aria-describedby={describedBy(row, index, field, layout)} value={validType ? row[field] as string : Object.hasOwn(row, field) ? display(row[field]) : "未提供"} readOnly={!validType} disabled={disabled} onChange={event => { if (validType) onChange(index, { [field]: event.target.value }); }} autoComplete="off" />
      {warning && <p id={idFor(layout, index, `${field}-warning`)} className="break-words text-xs text-destructive">{warning}</p>}
      {!validType && <Button type="button" size="sm" variant="outline" aria-label={`第 ${index + 1} 行${labels[field]}编辑为文本`} disabled={disabled} onClick={() => onChange(index, { [field]: "" })}>编辑为文本</Button>}
    </div>;
  }

  function enabledField(row: Record<string, unknown>, index: number, layout: Layout) {
    const warning = rawWarning(row, "enabled");
    return <div className="space-y-1.5">
      <Switch id={idFor(layout, index, "enabled")} checked={row.enabled === true} disabled={disabled} aria-label={`第 ${index + 1} 行启用路由`} aria-invalid={Boolean(warning) || fieldInvalid(issues, index, "enabled")} aria-describedby={describedBy(row, index, "enabled", layout)} onCheckedChange={enabled => onChange(index, { enabled })} />
      {warning && <p id={idFor(layout, index, "enabled-warning")} className="break-words text-xs text-destructive">{warning}{Object.hasOwn(row, "enabled") && <span className="block">现有值：{display(row.enabled)}</span>}</p>}
    </div>;
  }

  function removeButton(index: number, mobile: boolean) {
    return <Button type="button" variant="ghost" size={mobile ? "sm" : "icon"} aria-label={`删除第 ${index + 1} 行路由`} disabled={disabled} onClick={() => onRemove(index)}><Trash2 className={mobile ? "mr-2 size-4" : "size-4"} />{mobile && "删除"}</Button>;
  }

  return <div className="space-y-5">
    {issues.length > 0 && <div role="alert" className="space-y-1 rounded-md border border-destructive/40 p-3 text-sm text-destructive">
      <p>完整路由表共有 {issues.length} 个校验问题，两个渠道的草稿均已保留。</p>
      <p>Antigravity：{countForChannel("antigravity")} · Gemini CLI：{countForChannel("geminicli")} · 全局：{globalCount}</p>
      {issues.filter(issue => affectedRows(issue).length === 0).map((issue, index) => <p key={index}>{issueText(issue)}</p>)}
    </div>}
    {activeRows.length === 0 ? <div className="rounded-md border border-dashed p-8 text-center"><p className="font-medium">该渠道暂无路由</p><p className="mt-2 text-sm text-muted-foreground">使用“新增路由”添加一条路由。</p></div> : <>
      <div data-layout="desktop" className="hidden md:block"><Table><TableHeader><TableRow><TableHead className="w-20 whitespace-nowrap">行号</TableHead><TableHead>公开名称</TableHead><TableHead>目标名称</TableHead><TableHead className="w-36">启用</TableHead><TableHead className="w-16">操作</TableHead></TableRow></TableHeader><TableBody>{activeRows.map(({ row, index }) => <TableRow key={index}><TableCell className="whitespace-nowrap text-muted-foreground">第 {index + 1} 行</TableCell><TableCell className="min-w-0 space-y-2">{nameField(row, index, "public_name", "desktop")}{diagnostics(row, index, "desktop")}</TableCell><TableCell className="min-w-0">{nameField(row, index, "upstream_name", "desktop")}</TableCell><TableCell>{enabledField(row, index, "desktop")}</TableCell><TableCell>{removeButton(index, false)}</TableCell></TableRow>)}</TableBody></Table></div>
      <div data-layout="mobile" className="space-y-4 md:hidden">{activeRows.map(({ row, index }) => <div key={index} className="space-y-4 rounded-md border p-4"><div className="flex items-center justify-between"><Badge variant="outline">第 {index + 1} 行</Badge>{removeButton(index, true)}</div>{nameField(row, index, "public_name", "mobile")}{nameField(row, index, "upstream_name", "mobile")}<div className="flex items-start justify-between gap-4"><label htmlFor={idFor("mobile", index, "enabled")} className="shrink-0 text-sm">启用此路由</label>{enabledField(row, index, "mobile")}</div>{diagnostics(row, index, "mobile")}</div>)}</div>
    </>}
  </div>;
}
