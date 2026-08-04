// Shared helpers for the Orca Alert Exceptions config type (deploy + rollback +
// drift).
//
// A "system sonar alert" is one of Orca's BUILT-IN catalog alerts. It cannot be
// created or deleted — only its enabled/disabled state can be toggled
// (VERIFIED against terraform-provider-orcasecurity api_client/system_sonar_alert.go):
//   GET  /api/sonar/rules/{rule_id}          read;  returns { data: { rule_id, rule_type, name, category, score, enabled, ... } }
//   PUT  /api/sonar/rules/status/{rule_id}   write; body { rule_id, rule_type, enabled, custom: false }
//                                             returns { version, rule_id, enabled, status } — NOT wrapped in a `data` envelope.
//
// Because a system alert already exists in Orca's catalog, identity here is
// the CALLER-SUPPLIED rule_id (copied from the Orca Alert Catalog UI/API), not
// a server-assigned id — a genuinely different reconciliation shape from every
// other config type in this app. rollbackData only needs to remember the PRIOR
// enabled value so rollback can restore it; there is no "delete" branch because
// a system alert can never be removed by this app.

import type { OrcaClient } from '../../lib/orcaApi'

/** The `data` payload of GET /api/sonar/rules/{rule_id} for a built-in alert. */
export interface OrcaSystemAlert {
  rule_id?: string
  rule_type?: string
  name?: string
  category?: string
  score?: number
  enabled?: boolean
  [key: string]: unknown
}

/** The plain (non-enveloped) response body of PUT /api/sonar/rules/status/{id}. */
export interface OrcaSystemAlertStatusResponse {
  version?: string
  rule_id?: string
  enabled?: boolean
  status?: string
}

/** One entry recorded per canvas item in rollbackData.previous. */
export interface AlertExceptionRollbackEntry {
  itemId: string
  ruleId: string
  /** The enabled state read live immediately before this deploy applied its own value. */
  priorEnabled: boolean
}

/** The shape deploy writes and rollback/drift read from rollbackData. */
export interface AlertExceptionRollbackData {
  previous?: AlertExceptionRollbackEntry[]
}

/** Coerce a canvas value (boolean, 'true'/'false', 1/0) to a boolean, default true. */
export function normalizeEnabled(value: unknown, fallback = true): boolean {
  if (typeof value === 'boolean') return value
  if (value === undefined || value === null || value === '') return fallback
  const s = String(value).trim().toLowerCase()
  if (s === 'false' || s === '0' || s === 'no' || s === 'disabled' || s === 'off') return false
  if (s === 'true' || s === '1' || s === 'yes' || s === 'enabled' || s === 'on') return true
  return fallback
}

/** GET the live built-in alert by rule_id, or null when it cannot be read. */
export async function readSystemAlert(client: OrcaClient, ruleId: string): Promise<OrcaSystemAlert | null> {
  const res = await client.request<{ data?: OrcaSystemAlert }>('GET', `/api/sonar/rules/${encodeURIComponent(ruleId)}`)
  if (res.error || !res.data) return null
  return res.data.data ?? null
}

/** PUT the enabled/disabled state for a built-in alert. Not wrapped in a `data` envelope. */
export async function setSystemAlertEnabled(
  client: OrcaClient,
  ruleId: string,
  ruleType: string,
  enabled: boolean,
): Promise<{ ok: boolean; error: string | null }> {
  const res = await client.request<OrcaSystemAlertStatusResponse>(
    'PUT',
    `/api/sonar/rules/status/${encodeURIComponent(ruleId)}`,
    { rule_id: ruleId, rule_type: ruleType, enabled, custom: false },
  )
  return { ok: res.ok, error: res.error }
}
