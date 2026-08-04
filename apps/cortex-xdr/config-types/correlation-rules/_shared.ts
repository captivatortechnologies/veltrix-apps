// Shared helpers for the Cortex XDR Correlation Rules config type (deploy +
// rollback + drift).
//
// CONFIRMED public write path (re-verified 2026-08 against the "Cortex Platform"
// docs, Correlation Rules tag: /public_api/v1/correlations/get, /correlations/insert,
// /correlations/delete). Same get/insert/delete-by-filter, upsert-by-rule_id shape
// as BIOCs and Threat Indicators — this type reconciles by NAME: list -> match a
// live rule by name -> insert with its rule_id to update, or without one to
// create. Delete targets a name filter.
//
// A correlation rule runs an XQL query on a schedule (or in real time) and raises
// an alert when it matches — this is Cortex XDR's SIEM-style correlation-search
// surface, distinct from BIOC (single-event behavioral match).
//
// VERIFY every endpoint path, request/response field name and enum value against
// a live Cortex XDR tenant.

// --- Cortex XDR correlation-rule endpoints (VERIFY against live Cortex XDR) --
// All are POST under /public_api/v1. The client prepends the base + /public_api/v1.
export const CORRELATION_ENDPOINTS = {
  /** List/search correlation rules. Body: { request_data: { filters?, search_from?, search_to? } }. */
  get: '/correlations/get/',
  /** Upsert correlation rules (array form). Body: { request_data: [ <rule>, … ] }. rule_id present = update. */
  insert: '/correlations/insert/',
  /** Delete correlation rules matching a filter. Body: { request_data: { filters: [...] } }. */
  delete: '/correlations/delete/',
} as const

/** Same 4-tier severity scale as BIOC (no CRITICAL tier). VERIFY. */
export const CORRELATION_SEVERITIES = new Set(['SEV_010_INFO', 'SEV_020_LOW', 'SEV_030_MEDIUM', 'SEV_040_HIGH'])
export const EXECUTION_MODES = new Set(['SCHEDULED', 'REAL_TIME'])
export const DRILLDOWN_TIMEFRAMES = new Set(['QUERY', 'ALERT'])
export const MAPPING_STRATEGIES = new Set(['AUTO', 'CUSTOM'])

/** One Cortex XDR correlation rule, as sent to /correlations/insert. */
export interface CortexCorrelationRule {
  rule_id?: number
  name?: string
  severity?: string
  xql_query?: string
  is_enabled?: boolean
  description?: string
  alert_name?: string
  alert_category?: string
  alert_description?: string
  execution_mode?: string
  search_window?: string
  simple_schedule?: string
  timezone?: string
  crontab?: string
  suppression_enabled?: boolean
  suppression_duration?: string
  suppression_fields?: string[]
  dataset?: string
  drilldown_query_timeframe?: string
  mapping_strategy?: string
  [key: string]: unknown
}

/** Trim + lowercase a rule name so two that differ only in case still match. */
export function normalizeName(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

/**
 * /correlations/get wraps its payload as { reply: { objects: [...], objects_count } }.
 * Accept that shape, a bare `objects` array, or a bare array — VERIFY the real
 * shape against live Cortex XDR.
 */
export function correlationRulesFromReply(reply: unknown): CortexCorrelationRule[] {
  if (Array.isArray(reply)) return reply as CortexCorrelationRule[]
  if (reply && typeof reply === 'object') {
    const inner = (reply as Record<string, unknown>).objects
    if (Array.isArray(inner)) return inner as CortexCorrelationRule[]
  }
  return []
}

/** Find a live correlation rule by its (normalized) name. */
export function findCorrelationRule(rules: CortexCorrelationRule[], name: string): CortexCorrelationRule | null {
  const target = normalizeName(name)
  if (!target) return null
  return rules.find((r) => normalizeName(r.name) === target) ?? null
}

/** Build the Cortex XDR correlation-rule body from canvas fields. `rule_id` is added by the caller on update. */
export function buildCorrelationRuleFields(fields: Record<string, unknown>): CortexCorrelationRule {
  const rule: CortexCorrelationRule = {
    name: String(fields.name ?? '').trim(),
    severity: String(fields.severity ?? '').trim(),
    xql_query: String(fields.xql_query ?? '').trim(),
    is_enabled: fields.is_enabled === false || fields.is_enabled === 'false' ? false : true,
    execution_mode: String(fields.execution_mode ?? '').trim() || 'SCHEDULED',
  }

  const optionalStrings: Array<keyof CortexCorrelationRule> = [
    'description',
    'alert_name',
    'alert_category',
    'alert_description',
    'search_window',
    'simple_schedule',
    'timezone',
    'crontab',
    'suppression_duration',
    'dataset',
    'drilldown_query_timeframe',
    'mapping_strategy',
  ]
  for (const key of optionalStrings) {
    const value = String(fields[key as string] ?? '').trim()
    if (value) (rule as Record<string, unknown>)[key as string] = value
  }

  if (fields.suppression_enabled !== undefined && fields.suppression_enabled !== '') {
    rule.suppression_enabled = fields.suppression_enabled === true || fields.suppression_enabled === 'true'
  }
  const suppressionFields = Array.isArray(fields.suppression_fields)
    ? (fields.suppression_fields as unknown[]).map((v) => String(v).trim()).filter(Boolean)
    : []
  if (suppressionFields.length) rule.suppression_fields = suppressionFields

  return rule
}
