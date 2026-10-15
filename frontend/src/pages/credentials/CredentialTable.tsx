import type { DetailTrigger } from './focus'
import type { PanelMode } from '@/domain/panel'
import { useMemo } from 'react'
import { useReactTable, getCoreRowModel, flexRender, type ColumnDef } from '@tanstack/react-table'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { CredentialStateBadge, QuotaStateBadge } from './StatusBadges'
import { familyStatus, text, type Credential } from './model'

export interface CredentialTableProps {
  rows: Credential[]
  selected: Set<string>
  toggle: (names: string[], checked: boolean) => void
  open: (filename: string, trigger: DetailTrigger) => void
  disabled?: boolean
  openQuota?: (filename: string, trigger: DetailTrigger) => void
  quotaCapabilityEnabled?: boolean
  mode?: PanelMode
}

const GCLI_HEALTH_LABELS: Record<string, string> = {
  healthy: '正常',
  checking: '检查中',
  risk_quarantined: '风险隔离',
  manual_review: '人工复核',
}

function getGcliHealthLabel(healthStatus: unknown): string {
  if (typeof healthStatus === 'string' && Object.prototype.hasOwnProperty.call(GCLI_HEALTH_LABELS, healthStatus)) {
    return GCLI_HEALTH_LABELS[healthStatus]
  }
  return '未知'
}

function getGcliHealthVariant(label: string): 'success' | 'info' | 'warning' | 'destructive' | 'secondary' {
  switch (label) {
    case '正常':
      return 'success'
    case '检查中':
      return 'info'
    case '风险隔离':
      return 'warning'
    case '人工复核':
      return 'destructive'
    default:
      return 'secondary'
  }
}

function getGcliPreviewLabel(preview: unknown): string {
  if (preview === true) return 'true'
  if (preview === false) return 'false'
  return '未知'
}

function formatSafeTier(tier: unknown): string {
  if (typeof tier === 'string' && tier.trim().length > 0) {
    return tier.trim()
  }
  return '未知'
}

function formatSafeRawTier(rawId: unknown, rawName: unknown): string {
  const safeId = typeof rawId === 'string' && rawId.trim().length > 0 ? rawId.trim() : null
  const safeName = typeof rawName === 'string' && rawName.trim().length > 0 ? rawName.trim() : null
  if (safeId && safeName) {
    return `${safeName} (${safeId})`
  }
  if (safeName) {
    return safeName
  }
  if (safeId) {
    return safeId
  }
  return '未知'
}

function parseModelCooldowns(raw: unknown): { status: 'unknown' } | { status: 'valid'; entries: [string, number][] } {
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { status: 'unknown' }
  }
  const entries: [string, number][] = []
  for (const [model, deadline] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof deadline !== 'number' || !Number.isFinite(deadline) || deadline < 0) {
      return { status: 'unknown' }
    }
    const ms = deadline * 1000
    if (!Number.isFinite(ms) || Number.isNaN(new Date(ms).getTime())) {
      return { status: 'unknown' }
    }
    entries.push([model, deadline])
  }
  return { status: 'valid', entries }
}

function formatCooldownDeadline(deadline: number): string {
  const ms = deadline * 1000
  const date = new Date(ms)
  if (!Number.isFinite(ms) || Number.isNaN(date.getTime())) {
    return '未知'
  }
  return date.toLocaleString()
}

function renderGcliCooldowns(raw: unknown) {
  const parsed = parseModelCooldowns(raw)
  if (parsed.status === 'unknown') {
    return (
      <div>
        <Badge variant="secondary" className="whitespace-normal">
          模型冷却：未知
        </Badge>
      </div>
    )
  }
  if (parsed.entries.length === 0) {
    return (
      <div>
        <Badge variant="outline" className="whitespace-normal">
          模型冷却：无
        </Badge>
      </div>
    )
  }
  return parsed.entries.map(([model, deadline]) => (
    <div key={model}>
      <Badge variant="warning" className="whitespace-normal">
        {model}：冷却至 {formatCooldownDeadline(deadline)}
      </Badge>
    </div>
  ))
}

export function CredentialTable({
  rows,
  selected,
  toggle,
  open,
  disabled,
  openQuota,
  quotaCapabilityEnabled = false,
  mode = 'antigravity',
}: CredentialTableProps) {
  const columns = useMemo<ColumnDef<Credential>[]>(() => [
    {
      id: 'select',
      header: () => (
        <Checkbox
          aria-label="选择当前页"
          disabled={disabled || !rows.length}
          checked={
            rows.length > 0 && rows.every(r => selected.has(r.filename))
              ? true
              : rows.some(r => selected.has(r.filename))
                ? 'indeterminate'
                : false
          }
          onCheckedChange={value => toggle(rows.map(r => r.filename), value === true)}
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          aria-label={`选择 ${row.original.filename}`}
          disabled={disabled}
          checked={selected.has(row.original.filename)}
          onCheckedChange={v => toggle([row.original.filename], v === true)}
        />
      ),
    },
    {
      accessorKey: 'filename',
      header: '凭证',
      cell: ({ row }) => (
        <div className="max-w-60">
          <Button
            className="max-w-full justify-start px-0 font-medium text-foreground hover:text-primary"
            variant="link"
            data-credential-filename={row.original.filename}
            data-credential-trigger="desktop-name"
            onClick={() => open(row.original.filename, 'desktop-name')}
          >
            <span className="truncate">{row.original.filename}</span>
          </Button>
          <div className="truncate text-[13px] text-muted-foreground">{text(row.original.user_email, '邮箱未保存')}</div>
        </div>
      ),
    },
    {
      id: 'status',
      header: '状态 / 等级',
      cell: ({ row }) => (
        <div className="grid gap-1 text-[13px]">
          <div className="flex flex-wrap items-center gap-1.5">
            <CredentialStateBadge row={row.original} />
            {mode === 'geminicli' && (
              <Badge
                variant={getGcliHealthVariant(getGcliHealthLabel(row.original.health_status))}
                className="max-w-full whitespace-normal"
              >
                {getGcliHealthLabel(row.original.health_status)}
              </Badge>
            )}
          </div>
          <div className="text-muted-foreground">
            {mode === 'geminicli' ? (
              <>
                <div>{formatSafeTier(row.original.tier)}</div>
                <div className="text-xs">原始：{formatSafeRawTier(row.original.tier_raw_id, row.original.tier_raw_name)}</div>
              </>
            ) : (
              text(row.original.tier)
            )}
          </div>
        </div>
      ),
    },
    {
      id: 'quota',
      header: '额度与权限',
      cell: ({ row }) => (
        <div className="grid max-w-72 gap-1 whitespace-normal text-[13px]">
          {mode === 'geminicli' ? (
            <>
              <div>
                <Badge variant="outline" className="whitespace-normal">
                  Preview: {getGcliPreviewLabel(row.original.preview)}
                </Badge>
              </div>
              {renderGcliCooldowns(row.original.model_cooldowns)}
            </>
          ) : (
            <>
              <div><QuotaStateBadge data={row.original} group="gemini-shared" label="Gemini" /></div>
              <div><QuotaStateBadge data={row.original} group="claude-gpt-shared" label="Claude / GPT" /></div>
              <div><Badge variant="info" className="whitespace-normal">Opus 5.5：{familyStatus(row.original.model_access_families, 'claude-opus-5-5')}</Badge></div>
            </>
          )}
        </div>
      ),
    },
    {
      id: 'remark',
      header: '备注',
      cell: ({ row }) => (
        <span className="inline-block max-w-40 truncate text-[13px] text-muted-foreground">
          {text(row.original.remark, '不可用') || '—'}
        </span>
      ),
    },
    {
      id: 'detail',
      header: '操作',
      cell: ({ row }) => (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            data-credential-filename={row.original.filename}
            data-credential-trigger="desktop-detail"
            onClick={() => open(row.original.filename, 'desktop-detail')}
          >
            详情与操作
          </Button>
          <Button
            variant="outline"
            size="sm"
            data-credential-filename={row.original.filename}
            data-credential-trigger="desktop-quota"
            disabled={disabled || !quotaCapabilityEnabled || !openQuota}
            title={!quotaCapabilityEnabled ? '当前服务未启用额度查询能力' : undefined}
            onClick={() => openQuota?.(row.original.filename, 'desktop-quota')}
          >
            查看额度
          </Button>
        </div>
      ),
    },
  ], [rows, selected, toggle, open, disabled, openQuota, quotaCapabilityEnabled, mode])

  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: row => row.filename,
    manualPagination: true,
    enableSorting: false,
  })

  return (
    <>
      <div data-testid="desktop-branch" className="hidden overflow-hidden rounded-xl border bg-card md:block">
        <Table>
          <TableHeader className="bg-secondary">
            {table.getHeaderGroups().map(group => (
              <TableRow key={group.id}>
                {group.headers.map(header => (
                  <TableHead className="text-[13px]" key={header.id}>
                    {flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.map(row => (
              <TableRow
                className="hover:bg-hover data-[state=selected]:bg-selected"
                key={row.id}
                data-state={selected.has(row.id) ? 'selected' : undefined}
              >
                {row.getVisibleCells().map(cell => (
                  <TableCell key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div data-testid="mobile-branch" className="grid gap-3 md:hidden">
        {rows.map(row => (
          <Card
            key={row.filename}
            data-state={selected.has(row.filename) ? 'selected' : undefined}
            className="rounded-xl data-[state=selected]:border-input data-[state=selected]:bg-secondary"
          >
            <CardContent className="grid gap-3 pt-4">
              <div className="flex min-w-0 items-center gap-3">
                <Checkbox
                  aria-label={`移动选择 ${row.filename}`}
                  disabled={disabled}
                  checked={selected.has(row.filename)}
                  onCheckedChange={v => toggle([row.filename], v === true)}
                />
                <div className="min-w-0">
                  <p className="truncate text-[18px] font-semibold" title={row.filename}>
                    {row.filename}
                  </p>
                  <p className="truncate text-[13px] text-muted-foreground">
                    {text(row.user_email, '邮箱未保存')}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <CredentialStateBadge row={row} />
                {mode === 'geminicli' && (
                  <Badge
                    variant={getGcliHealthVariant(getGcliHealthLabel(row.health_status))}
                    className="max-w-full whitespace-normal"
                  >
                    {getGcliHealthLabel(row.health_status)}
                  </Badge>
                )}
                <span className="text-[13px] text-muted-foreground">
                  {mode === 'geminicli' ? formatSafeTier(row.tier) : text(row.tier)}
                </span>
              </div>
              {mode === 'geminicli' && (
                <p className="text-xs text-muted-foreground">
                  原始：{formatSafeRawTier(row.tier_raw_id, row.tier_raw_name)}
                </p>
              )}
              {mode === 'geminicli' ? (
                <div className="grid gap-1 text-[13px]">
                  <div>
                    <Badge variant="outline" className="whitespace-normal">
                      Preview: {getGcliPreviewLabel(row.preview)}
                    </Badge>
                  </div>
                  {renderGcliCooldowns(row.model_cooldowns)}
                </div>
              ) : (
                <div className="grid gap-1 text-[13px]">
                  <div>
                    <QuotaStateBadge data={row} group="gemini-shared" label="Gemini" />
                  </div>
                  <div>
                    <QuotaStateBadge data={row} group="claude-gpt-shared" label="Claude / GPT" />
                  </div>
                </div>
              )}
              <p className="truncate text-[13px] text-muted-foreground">
                备注：{text(row.remark, '不可用') || '—'}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  data-credential-filename={row.filename}
                  data-credential-trigger="mobile-detail"
                  onClick={() => open(row.filename, 'mobile-detail')}
                >
                  详情与操作
                </Button>
                <Button
                  variant="outline"
                  data-credential-filename={row.filename}
                  data-credential-trigger="mobile-quota"
                  disabled={disabled || !quotaCapabilityEnabled || !openQuota}
                  title={!quotaCapabilityEnabled ? '当前服务未启用额度查询能力' : undefined}
                  onClick={() => openQuota?.(row.filename, 'mobile-quota')}
                >
                  查看额度
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  )
}
