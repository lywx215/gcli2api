import { useMemo } from 'react'
import { useReactTable, getCoreRowModel, flexRender, type ColumnDef } from '@tanstack/react-table'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Card, CardContent } from '@/components/ui/card'
import { credentialStatus, familyStatus, quotaText, text, type Credential } from './model'
export function CredentialTable({ rows, selected, toggle, open, disabled }: { rows: Credential[]; selected: Set<string>; toggle: (names: string[], checked: boolean) => void; open: (filename: string) => void; disabled?: boolean }) {
  const columns = useMemo<ColumnDef<Credential>[]>(() => [
    { id: 'select', header: () => <Checkbox aria-label="选择当前页" disabled={disabled || !rows.length} checked={rows.length > 0 && rows.every(r => selected.has(r.filename)) ? true : rows.some(r => selected.has(r.filename)) ? 'indeterminate' : false} onCheckedChange={value => toggle(rows.map(r => r.filename), value === true)} />, cell: ({ row }) => <Checkbox aria-label={`选择 ${row.original.filename}`} disabled={disabled} checked={selected.has(row.original.filename)} onCheckedChange={v => toggle([row.original.filename], v === true)} /> },
    { accessorKey: 'filename', header: '凭证', cell: ({ row }) => <div className="max-w-60"><Button className="max-w-full justify-start px-0" variant="link" onClick={() => open(row.original.filename)}><span className="truncate">{row.original.filename}</span></Button><div className="truncate text-xs text-muted-foreground">{text(row.original.user_email, '邮箱未保存')}</div></div> },
    { id: 'status', header: '状态 / 等级', cell: ({ row }) => <div className="text-xs">{credentialStatus(row.original)}<div className="text-muted-foreground">{text(row.original.tier)}</div></div> },
    { id: 'quota', header: '额度与权限', cell: ({ row }) => <div className="max-w-72 whitespace-normal text-xs">Gemini：{quotaText(row.original, 'gemini-shared')}<br />Claude / GPT：{quotaText(row.original, 'claude-gpt-shared')}<br />Opus 5.5：{familyStatus(row.original.model_access_families, 'claude-opus-5-5')}</div> },
    { id: 'remark', header: '备注', cell: ({ row }) => <span className="inline-block max-w-40 truncate">{text(row.original.remark, '不可用') || '—'}</span> },
    { id: 'detail', header: '操作', cell: ({ row }) => <Button variant="outline" size="sm" onClick={() => open(row.original.filename)}>详情与操作</Button> },
  ], [rows, selected, toggle, open, disabled])
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel(), getRowId: row => row.filename, manualPagination: true, enableSorting: false })
  return <>
    <div className="hidden overflow-hidden rounded-xl border md:block"><Table><TableHeader>{table.getHeaderGroups().map(group => <TableRow key={group.id}>{group.headers.map(header => <TableHead key={header.id}>{flexRender(header.column.columnDef.header, header.getContext())}</TableHead>)}</TableRow>)}</TableHeader><TableBody>{table.getRowModel().rows.map(row => <TableRow key={row.id} data-state={selected.has(row.id) ? 'selected' : undefined}>{row.getVisibleCells().map(cell => <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>)}</TableRow>)}</TableBody></Table></div>
    <div className="grid gap-3 md:hidden">{rows.map(row => <Card key={row.filename}><CardContent className="grid gap-3 pt-4"><div className="flex min-w-0 items-center gap-3"><Checkbox aria-label={`移动选择 ${row.filename}`} disabled={disabled} checked={selected.has(row.filename)} onCheckedChange={v => toggle([row.filename], v === true)} /><div className="min-w-0"><p className="truncate font-medium">{row.filename}</p><p className="truncate text-xs text-muted-foreground">{text(row.user_email, '邮箱未保存')}</p></div></div><p className="text-sm">{credentialStatus(row)} · {text(row.tier)}</p><p className="text-xs">Gemini：{quotaText(row, 'gemini-shared')}<br />Claude / GPT：{quotaText(row, 'claude-gpt-shared')}</p><p className="truncate text-sm">备注：{text(row.remark, '不可用') || '—'}</p><Button variant="outline" onClick={() => open(row.filename)}>详情与操作</Button></CardContent></Card>)}</div>
  </>
}
