// Shared helpers for the Sysdig Secure Posture Controls config type
// (validate + deploy + rollback + drift).
//
// Control shape follows the Sysdig Secure /api/cspm/v1/policy/controls API
// (confirmed against terraform-provider-sysdig's v2 client + resource docs).
// There is no list/search-by-name endpoint for controls, so the by-name
// upsert pattern the rest of this app uses does not apply here — see
// deploy.ts, which carries the external id via rollbackData instead.

import type { SysdigPostureControl } from '../../lib/sysdigApi'

/** Case-sensitive severity values Sysdig accepts for a posture control. */
export const SEVERITIES = new Set(['High', 'Medium', 'Low'])

export interface PostureControlFields {
  name?: unknown
  description?: unknown
  resourceKind?: unknown
  severity?: unknown
  enabled?: unknown
  rego?: unknown
  remediationDetails?: unknown
}

export function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === undefined || value === null || value === '') return fallback
  const s = String(value).trim().toLowerCase()
  if (s === 'false' || s === '0' || s === 'no') return false
  if (s === 'true' || s === '1' || s === 'yes') return true
  return fallback
}

/** Build the Sysdig posture-control body from canvas fields. `id` set updates in place. */
export function buildControlBody(fields: PostureControlFields, id?: string): SysdigPostureControl {
  return {
    ...(id ? { id } : {}),
    name: String(fields.name ?? '').trim(),
    description: String(fields.description ?? '').trim(),
    resourceKind: String(fields.resourceKind ?? '').trim(),
    severity: String(fields.severity ?? 'Medium').trim(),
    rego: String(fields.rego ?? '').trim(),
    remediationDetails: String(fields.remediationDetails ?? '').trim(),
  }
}
