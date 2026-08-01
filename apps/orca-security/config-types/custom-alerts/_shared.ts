// Shared helpers for the Orca Custom Alerts config type (deploy + rollback + drift).
//
// Orca custom-alert shapes follow the Orca REST API /api/sonar/rules surface
// (the same shapes Orca's Terraform provider CustomAlert struct writes):
//   POST   /api/sonar/rules          create; returns { data: { rule_id, ... } }
//   GET    /api/sonar/rules/{id}      read;   returns { data: { ... } }
//   PUT    /api/sonar/rules/{id}      update
//   DELETE /api/sonar/rules/{id}      delete
// Verify field names/score range against a live Orca tenant.

/** Valid Orca alert categories (mirror config-types/custom-alerts/canvas.yaml). */
export const CATEGORIES = new Set<string>([
  'Access control',
  'Authentication',
  'Best practices',
  'Data at risk',
  'Data protection',
  'IAM misconfigurations',
  'Lateral movement',
  'Logging and monitoring',
  'Malicious activity',
  'Malware',
  'Neglected assets',
  'Network misconfigurations',
  'Source code vulnerabilities',
  'Suspicious activity',
  'System integrity',
  'Vendor services misconfigurations',
  'Vulnerabilities',
  'Workload misconfigurations',
])

export const MIN_SCORE = 1
export const MAX_SCORE = 10

/** One Orca custom alert (the `data` payload of /api/sonar/rules responses). */
export interface OrcaAlert {
  rule_id?: string
  name?: string
  details?: string
  category?: string
  orca_score?: number
  context_score?: boolean
  rule?: string
  rule_type?: string
  enabled?: boolean
  [key: string]: unknown
}

/** The envelope Orca wraps single objects in: { data: {...} }. */
export interface OrcaDataEnvelope<T> {
  data?: T
}

/** Coerce a canvas value (boolean, 'true'/'false', 1/0) to a boolean, default true. */
export function normalizeBool(value: unknown, fallback = true): boolean {
  if (typeof value === 'boolean') return value
  if (value === undefined || value === null || value === '') return fallback
  const s = String(value).trim().toLowerCase()
  if (s === 'false' || s === '0' || s === 'no' || s === 'disabled' || s === 'off') return false
  if (s === 'true' || s === '1' || s === 'yes' || s === 'enabled' || s === 'on') return true
  return fallback
}

/** Coerce a canvas value to a finite score, clamped to [MIN_SCORE, MAX_SCORE]. */
export function normalizeScore(value: unknown, fallback = 5): number {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim())
  if (!Number.isFinite(n)) return fallback
  return Math.min(MAX_SCORE, Math.max(MIN_SCORE, n))
}

/** Build the Orca alert body from canvas fields (POST/PUT payload). */
export function buildAlertBody(fields: Record<string, unknown>): OrcaAlert {
  return {
    name: String(fields.name ?? '').trim(),
    details: String(fields.description ?? '').trim(),
    category: String(fields.category ?? '').trim(),
    orca_score: normalizeScore(fields.orcaScore),
    context_score: normalizeBool(fields.contextScore, true),
    enabled: normalizeBool(fields.enabled, true),
    rule: String(fields.rule ?? '').trim(),
  }
}

/** Unwrap a `{ data: {...} }` envelope, returning null when absent. */
export function alertFromEnvelope(payload: unknown): OrcaAlert | null {
  if (!payload || typeof payload !== 'object') return null
  const data = (payload as OrcaDataEnvelope<OrcaAlert>).data
  return data && typeof data === 'object' ? data : null
}

/**
 * One entry recorded per canvas item in rollbackData.previous — carries the
 * rule id this app assigned so the NEXT deploy can update (or rename) the same
 * rule, and rollback can restore the prior body or delete a rule we created.
 */
export interface AlertRollbackEntry {
  itemId: string
  name: string
  ruleId: string | null
  existed: boolean
  prior: OrcaAlert | null
}

/** The shape deploy writes and rollback/drift read from rollbackData. */
export interface AlertRollbackData {
  previous?: AlertRollbackEntry[]
}

/**
 * Recover the rule id a prior deploy assigned to a canvas item. Matches by the
 * stable canvas item id first (survives a rename), then by name.
 */
export function priorRuleId(
  previous: AlertRollbackEntry[] | undefined,
  itemId: string,
  name: string,
): string | null {
  if (!previous || previous.length === 0) return null
  const byId = itemId ? previous.find((p) => p.itemId && p.itemId === itemId) : undefined
  if (byId?.ruleId) return byId.ruleId
  const n = name.trim()
  const byName = n ? previous.find((p) => (p.name ?? '').trim() === n) : undefined
  return byName?.ruleId ?? null
}
