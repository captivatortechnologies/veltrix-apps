// Shared helpers for the Vectra Triage Rules config type (deploy + rollback + drift).
//
// Rule shapes follow the Vectra Detect v2.5 REST API (/api/v2.5/rules):
//   list:   GET    /rules            → DRF envelope { count, results: [ {rule} ] }
//   get:    GET    /rules/{id}
//   create: POST   /rules            with the rule body
//   update: PUT    /rules/{id}       with the rule body
//   delete: DELETE /rules/{id}?restore_detections=true
// Verify field names + the detection_category/detection enums against a live Vectra.

/**
 * Detection categories offered by the canvas select. VERIFY the exact strings +
 * casing against your Vectra — only "LATERAL MOVEMENT" is confirmed from Vectra's
 * official API example. Used by validate.ts to reject unknown categories.
 */
export const DETECTION_CATEGORIES = new Set([
  'COMMAND & CONTROL',
  'BOTNET',
  'RECONNAISSANCE',
  'LATERAL MOVEMENT',
  'EXFILTRATION',
  'INFO',
])

/** One Vectra triage rule as returned by the /rules API. */
export interface VectraRule {
  id?: number | string
  description?: string
  detection_category?: string
  detection?: string
  triage_category?: string
  is_whitelist?: boolean
  all_hosts?: boolean
  host?: Array<number | string>
  ip?: string[]
  remote1_ip?: string[]
  remote1_proto?: string[]
  priority?: boolean | number
  [key: string]: unknown
}

/** Coerce a canvas/Vectra value that may be a boolean, 1|0 or 'true'/'false' string. */
export function normalizeBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true
  return false
}

/** Split a comma/whitespace-separated field into a trimmed, de-duplicated list. */
export function parseList(value: unknown): string[] {
  const seen = new Set<string>()
  return String(value ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !seen.has(s) && (seen.add(s), true))
}

/** Parse a comma-separated list of numeric host IDs (non-numeric entries dropped). */
export function parseHostIds(value: unknown): number[] {
  return parseList(value)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n))
}

/** Unwrap the Vectra DRF list envelope `{ results: [...] }` into a flat array. */
export function rulesFromList(list: unknown): VectraRule[] {
  if (Array.isArray(list)) return list as VectraRule[]
  if (list && typeof list === 'object' && Array.isArray((list as { results?: unknown }).results)) {
    return (list as { results: VectraRule[] }).results
  }
  return []
}

/** Find a live rule by its description (the stable identity used for upsert/drift). */
export function findRule(rules: VectraRule[], description: string): VectraRule | null {
  const d = description.trim()
  if (!d) return null
  return rules.find((r) => String(r.description ?? '').trim() === d) ?? null
}

/**
 * Build the Vectra rule body from canvas fields. Whitelist rules omit
 * triage_category; scope/condition arrays are included only when non-empty so the
 * request stays close to what a Vectra operator would send by hand.
 */
export function buildRuleBody(fields: Record<string, unknown>): VectraRule {
  const isWhitelist = normalizeBool(fields.is_whitelist)
  const body: VectraRule = {
    description: String(fields.description ?? '').trim(),
    detection_category: String(fields.detection_category ?? '').trim(),
    detection: String(fields.detection ?? '').trim(),
    is_whitelist: isWhitelist,
    all_hosts: normalizeBool(fields.all_hosts),
    priority: normalizeBool(fields.priority),
  }

  if (!isWhitelist) {
    body.triage_category = String(fields.triage_category ?? '').trim()
  }

  const host = parseHostIds(fields.host)
  if (host.length) body.host = host
  const ip = parseList(fields.ip)
  if (ip.length) body.ip = ip
  const remote1_ip = parseList(fields.remote1_ip)
  if (remote1_ip.length) body.remote1_ip = remote1_ip
  const remote1_proto = parseList(fields.remote1_proto)
  if (remote1_proto.length) body.remote1_proto = remote1_proto

  return body
}
