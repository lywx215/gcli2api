import { Badge } from '@/components/ui/badge'
import { credentialStatus, quotaState, quotaText, type Credential, type RecordValue } from './model'

export function CredentialStateBadge({ row }: { row: Credential }) {
  const variant = row.permanent_disabled === true ? 'destructive'
    : row.disabled === true ? 'warning'
    : row.disabled === false && row.permanent_disabled === false ? 'success' : 'info'
  return <Badge variant={variant} className="max-w-full whitespace-normal">{credentialStatus(row)}</Badge>
}

export function QuotaStateBadge({ data, group, label }: { data: RecordValue; group: string; label: string }) {
  const state = quotaState(data, group)
  const variant = state.invalid ? 'destructive' : state.restricted === true ? 'warning' : state.known ? 'success' : 'info'
  return <Badge variant={variant} className="max-w-full whitespace-normal">{label}：{quotaText(data, group)}</Badge>
}
