import type { DetailTrigger } from './focus'
import type { PanelMode } from '@/domain/panel'
import { useEffect, useMemo, useRef, useState } from 'react'
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
    if (!Number.isFinite(ms) || Number.isNaN(new Date(ms).getTime()) || ms > 8640000000000000) {
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

function formatRemainingTime(deadlineMs: number, now: number): string {
  const diffMs = deadlineMs - now
  if (diffMs <= 0) {
    return '已重置'
  }
  const totalSeconds = Math.ceil(diffMs / 1000)
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  let timeStr = ''
  if (days > 0) {
    timeStr += `${days}天`
  }
  if (days > 0 || hours > 0) {
    timeStr += `${hours}小时`
  }
  if (days > 0 || hours > 0 || minutes > 0) {
    timeStr += `${minutes}分`
  }
  timeStr += `${seconds}秒`
  return `剩余 ${timeStr}`
}

function renderGcliCooldowns(raw: unknown, now: number) {
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
  const activeEntries = parsed.entries.filter(([_, deadline]) => deadline > 0 && deadline * 1000 > now)
  if (activeEntries.length === 0) {
    return (
      <div>
        <Badge variant="outline" className="whitespace-normal">
          模型冷却：无
        </Badge>
      </div>
    )
  }
  return activeEntries.map(([model, deadline]) => (
    <div key={model} className="flex flex-col gap-0.5">
      <Badge variant="warning" className="whitespace-normal">
        {model}：冷却至 {formatCooldownDeadline(deadline)}
      </Badge>
      <span className="text-xs text-muted-foreground">
        {formatRemainingTime(deadline * 1000, now)}
      </span>
    </div>
  ))
}

function renderAgGroupQuota(row: Credential, group: string, label: string, now: number) {
  const p = (row.quota_groups && typeof row.quota_groups === 'object' && !Array.isArray(row.quota_groups))
    ? (row.quota_groups as Record<string, unknown>)[group]
    : null
  const rawCooldownUntil = (p && typeof p === 'object' && !Array.isArray(p))
    ? (p as Record<string, unknown>).cooldownUntil
    : null
  const until = (typeof rawCooldownUntil === 'number' && Number.isFinite(rawCooldownUntil) && rawCooldownUntil > 0)
    ? rawCooldownUntil
    : null
  const hasFutureCooldown = until !== null && until * 1000 > now && !Number.isNaN(new Date(until * 1000).getTime()) && until * 1000 <= 8640000000000000

  return (
    <div>
      <QuotaStateBadge data={row} group={group} label={label} />
      {hasFutureCooldown && (
        <div className="text-xs text-muted-foreground">
          {formatRemainingTime(until * 1000, now)}
        </div>
      )}
    </div>
  )
}

interface GcliDiagnostics {
  tierDetectedAt: string | null
  quarantineReason: string | null
  probeStage: string | null
  nextProbeAt: string | null
  lastHealthCheckAt: string | null
  healthCheckStartedAt: string | null
  healthStateVersion: string | null
}

function parseGcliDiagnostics(row: Credential): GcliDiagnostics {
  const parseDate = (key: string): string | null => {
    if (!Object.prototype.hasOwnProperty.call(row, key)) return null
    const val = (row as Record<string, unknown>)[key]
    if (typeof val !== 'number' || !Number.isFinite(val) || val <= 0) return null
    const ms = val * 1000
    if (!Number.isFinite(ms) || Number.isNaN(new Date(ms).getTime()) || ms > 8640000000000000) return null
    return new Date(ms).toLocaleString()
  }

  const parseNonNegInt = (key: string): string | null => {
    if (!Object.prototype.hasOwnProperty.call(row, key)) return null
    const val = (row as Record<string, unknown>)[key]
    if (typeof val !== 'number' || !Number.isInteger(val) || val < 0) return null
    return String(val)
  }

  const parseQuarantineReason = (): string | null => {
    if (!Object.prototype.hasOwnProperty.call(row, 'quarantine_reason')) return null
    const val = (row as Record<string, unknown>).quarantine_reason
    if (val === null || val === undefined) return null
    if (val === 'risk_control_429') return '风控拦截 (429)'
    return '未知原因'
  }

  return {
    tierDetectedAt: parseDate('tier_detected_at'),
    quarantineReason: parseQuarantineReason(),
    probeStage: parseNonNegInt('probe_stage'),
    nextProbeAt: parseDate('next_probe_at'),
    lastHealthCheckAt: parseDate('last_health_check_at'),
    healthCheckStartedAt: parseDate('health_check_started_at'),
    healthStateVersion: parseNonNegInt('health_state_version'),
  }
}

function renderGcliDiagnostics(row: Credential) {
  const diag = parseGcliDiagnostics(row)
  return (
    <details className="mt-1 text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none">诊断信息</summary>
      <div className="grid gap-0.5 pt-1 text-[11px]">
        <div>探测阶段：{diag.probeStage ?? '—'}</div>
        <div>健康状态版本：{diag.healthStateVersion ?? '—'}</div>
        <div>隔离原因：{diag.quarantineReason ?? '—'}</div>
        <div>层级检测时间：{diag.tierDetectedAt ?? '—'}</div>
        <div>上次健康检查：{diag.lastHealthCheckAt ?? '—'}</div>
        <div>健康检查开始：{diag.healthCheckStartedAt ?? '—'}</div>
        <div>下次探测时间：{diag.nextProbeAt ?? '—'}</div>
      </div>
    </details>
  )
}

function hasFutureDeadlines(rows: Credential[], mode: PanelMode, currentNow: number): boolean {
  if (mode === 'geminicli') {
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const parsed = parseModelCooldowns(row.model_cooldowns)
      if (parsed.status === 'valid') {
        for (const [_, deadline] of parsed.entries) {
          if (deadline > 0 && deadline * 1000 > currentNow) {
            return true
          }
        }
      }
    }
  } else {
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const groups = row.quota_groups
      if (groups && typeof groups === 'object' && !Array.isArray(groups)) {
        for (const grp of Object.values(groups as Record<string, unknown>)) {
          if (grp && typeof grp === 'object' && !Array.isArray(grp)) {
            const until = (grp as Record<string, unknown>).cooldownUntil
            if (typeof until === 'number' && Number.isFinite(until) && until > 0 && until * 1000 > currentNow) {
              const ms = until * 1000
              if (!Number.isNaN(new Date(ms).getTime()) && ms <= 8640000000000000) {
                return true
              }
            }
          }
        }
      }
    }
  }
  return false
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
  const [now, setNow] = useState(() => Date.now())
  const nowRef = useRef(now)
  nowRef.current = now
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }

    const runTick = () => {
      timerRef.current = null
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return

      const nowTick = Date.now()
      setNow(nowTick)

      if (hasFutureDeadlines(rows, mode, nowTick)) {
        timerRef.current = setTimeout(runTick, 1000)
      }
    }

    const handleVisibilityChange = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        if (timerRef.current !== null) {
          clearTimeout(timerRef.current)
          timerRef.current = null
        }
      } else if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        const nowVisible = Date.now()
        setNow(nowVisible)
        if (hasFutureDeadlines(rows, mode, nowVisible)) {
          if (timerRef.current !== null) {
            clearTimeout(timerRef.current)
            timerRef.current = null
          }
          timerRef.current = setTimeout(runTick, 1000)
        }
      }
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange)
    }

    const isDocVisible = typeof document === 'undefined' || document.visibilityState !== 'hidden'
    if (isDocVisible) {
      const setupNow = Date.now()
      setNow(setupNow)
      if (hasFutureDeadlines(rows, mode, setupNow)) {
        timerRef.current = setTimeout(runTick, 1000)
      }
    }

    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange)
      }
    }
  }, [rows, mode])

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
                {renderGcliDiagnostics(row.original)}
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
              {renderGcliCooldowns(row.original.model_cooldowns, nowRef.current)}
            </>
          ) : (
            <>
              {renderAgGroupQuota(row.original, 'gemini-shared', 'Gemini', nowRef.current)}
              {renderAgGroupQuota(row.original, 'claude-gpt-shared', 'Claude / GPT', nowRef.current)}
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
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            variant="outline"
            size="xs"
            data-credential-filename={row.original.filename}
            data-credential-trigger="desktop-detail"
            onClick={() => open(row.original.filename, 'desktop-detail')}
          >
            详情与操作
          </Button>
          <Button
            variant="outline"
            size="xs"
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
      <div data-testid="desktop-branch" className="hidden overflow-x-auto rounded-lg border bg-card md:block shadow-sm">
        <Table>
          <TableHeader className="bg-secondary">
            {table.getHeaderGroups().map(group => (
              <TableRow key={group.id}>
                {group.headers.map(header => (
                  <TableHead className="text-[12px]" key={header.id}>
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
      <div data-testid="mobile-branch" className="grid gap-2.5 md:hidden">
        {rows.map(row => (
          <Card
            key={row.filename}
            data-state={selected.has(row.filename) ? 'selected' : undefined}
            className="rounded-lg data-[state=selected]:border-input data-[state=selected]:bg-secondary"
          >
            <CardContent className="grid gap-2 p-3">
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
                <>
                  <p className="text-xs text-muted-foreground">
                    原始：{formatSafeRawTier(row.tier_raw_id, row.tier_raw_name)}
                  </p>
                  {renderGcliDiagnostics(row)}
                </>
              )}
              {mode === 'geminicli' ? (
                <div className="grid gap-1 text-[13px]">
                  <div>
                    <Badge variant="outline" className="whitespace-normal">
                      Preview: {getGcliPreviewLabel(row.preview)}
                    </Badge>
                  </div>
                  {renderGcliCooldowns(row.model_cooldowns, now)}
                </div>
              ) : (
                <div className="grid gap-1 text-[13px]">
                  {renderAgGroupQuota(row, 'gemini-shared', 'Gemini', now)}
                  {renderAgGroupQuota(row, 'claude-gpt-shared', 'Claude / GPT', now)}
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
