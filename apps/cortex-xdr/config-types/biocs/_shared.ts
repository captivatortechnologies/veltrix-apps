// Shared helpers for the Cortex XDR Behavioral Indicators of Compromise (BIOC)
// config type (deploy + rollback + drift).
//
// CONFIRMED public write path (re-verified 2026-08 against the "Cortex Platform"
// docs, BIOCs tag: /public_api/v1/bioc/get, /bioc/insert, /bioc/delete). Same
// get/insert/delete-by-filter shape as Threat Indicators (IOCs) — insert upserts
// by `rule_id` (present = update an existing rule, absent = create a new one), so
// this type reconciles by NAME: list -> match a live rule by name -> insert with
// its rule_id to update, or without one to create. Delete targets a name filter.
//
// VERIFY every endpoint path, request/response field name and enum value against
// a live Cortex XDR tenant — the published enum lists are themselves truncated in
// the source docs (BIOC `type` shows 12+ MITRE-style categories and is not
// confirmed exhaustive).

// --- Cortex XDR BIOC endpoints (VERIFY against live Cortex XDR) --------------
// All are POST under /public_api/v1. The client prepends the base + /public_api/v1.
export const BIOC_ENDPOINTS = {
  /** List/search BIOCs. Body: { request_data: { filters?, search_from?, search_to? } }. */
  get: '/bioc/get/',
  /** Upsert BIOCs (array form). Body: { request_data: [ <bioc>, … ] }. rule_id present = update. */
  insert: '/bioc/insert/',
  /** Delete BIOCs matching a filter. Body: { request_data: { filters: [...] } }. */
  delete: '/bioc/delete/',
} as const

/** Documented BIOC categories (VERIFY — the source enum is not confirmed exhaustive). */
export const BIOC_TYPES = new Set([
  'OTHER',
  'PERSISTENCE',
  'EVASION',
  'TAMPERING',
  'FILE_TYPE_OBFUSCATION',
  'PRIVILEGE_ESCALATION',
  'CREDENTIAL_ACCESS',
  'LATERAL_MOVEMENT',
  'EXECUTION',
  'COLLECTION',
  'EXFILTRATION',
  'INFILTRATION',
])
/** BIOC severities — CONFIRMED distinct from the IOC severity set (no CRITICAL tier here). VERIFY. */
export const BIOC_SEVERITIES = new Set(['SEV_010_INFO', 'SEV_020_LOW', 'SEV_030_MEDIUM', 'SEV_040_HIGH'])
export const BIOC_STATUSES = new Set(['enabled', 'disabled'])

/** One Cortex XDR BIOC rule, as sent to /bioc/insert and (approximately) read back from /bioc/get. */
export interface CortexBioc {
  rule_id?: number
  name?: string
  type?: string
  severity?: string
  comment?: string
  status?: string
  is_xql?: boolean
  /** Opaque behavioral-match criteria (an XQL-like filter tree). VERIFY the shape. */
  indicator?: unknown
  mitre_tactic_id_and_name?: string[]
  mitre_technique_id_and_name?: string[]
  [key: string]: unknown
}

/** Trim + lowercase a rule name so two that differ only in case still match. */
export function normalizeName(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

/**
 * /bioc/get wraps its payload as { reply: { objects: [...], objects_count } }.
 * Accept that shape, a bare `objects` array, or a bare array — VERIFY the real
 * shape against live Cortex XDR.
 */
export function biocsFromReply(reply: unknown): CortexBioc[] {
  if (Array.isArray(reply)) return reply as CortexBioc[]
  if (reply && typeof reply === 'object') {
    const inner = (reply as Record<string, unknown>).objects
    if (Array.isArray(inner)) return inner as CortexBioc[]
  }
  return []
}

/** Find a live BIOC by its (normalized) name. */
export function findBioc(rules: CortexBioc[], name: string): CortexBioc | null {
  const target = normalizeName(name)
  if (!target) return null
  return rules.find((r) => normalizeName(r.name) === target) ?? null
}

/** Parse the optional indicator/filter JSON blob. Returns undefined on blank; throws on invalid JSON. */
export function parseIndicatorJson(value: unknown): unknown {
  const raw = String(value ?? '').trim()
  if (!raw) return undefined
  return JSON.parse(raw)
}

/** True when a JSON blob field is blank or parses as valid JSON. */
export function isValidJson(value: unknown): boolean {
  const raw = String(value ?? '').trim()
  if (!raw) return true
  try {
    JSON.parse(raw)
    return true
  } catch {
    return false
  }
}

/** Build the Cortex XDR BIOC body from canvas fields. `rule_id` is added by the caller on update. */
export function buildBiocFields(fields: Record<string, unknown>): CortexBioc {
  const bioc: CortexBioc = {
    name: String(fields.name ?? '').trim(),
    type: String(fields.type ?? '').trim(),
    severity: String(fields.severity ?? '').trim(),
    status: String(fields.status ?? '').trim().toLowerCase() || 'enabled',
  }
  const comment = String(fields.comment ?? '').trim()
  if (comment) bioc.comment = comment
  if (fields.is_xql !== undefined && fields.is_xql !== '') bioc.is_xql = fields.is_xql === true || fields.is_xql === 'true'
  const indicator = parseIndicatorJson(fields.indicator)
  if (indicator !== undefined) bioc.indicator = indicator
  const tactics = Array.isArray(fields.mitre_tactic_id_and_name)
    ? (fields.mitre_tactic_id_and_name as unknown[]).map((v) => String(v).trim()).filter(Boolean)
    : []
  if (tactics.length) bioc.mitre_tactic_id_and_name = tactics
  const techniques = Array.isArray(fields.mitre_technique_id_and_name)
    ? (fields.mitre_technique_id_and_name as unknown[]).map((v) => String(v).trim()).filter(Boolean)
    : []
  if (techniques.length) bioc.mitre_technique_id_and_name = techniques
  return bioc
}
