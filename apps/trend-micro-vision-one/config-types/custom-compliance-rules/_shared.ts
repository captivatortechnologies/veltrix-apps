// Shared helpers for the Trend Vision One Cloud Risk Management Custom Rules
// config type — organization-wide custom compliance/detection rules evaluated
// against connected cloud accounts — deploy + rollback + drift.
//
// Endpoint paths + body shapes are CONFIRMED against the official Trend
// `vision-one-mcp-server` Go client (trendmicro/vision-one-mcp-server,
// internal/v1client/cloudposture.go): list is
// `GET beta/cloudPosture/customRules`, create is
// `POST beta/cloudPosture/customRules`, update is
// `PATCH beta/cloudPosture/customRules/{id}` and delete is
// `DELETE beta/cloudPosture/customRules/{id}`. These hang off the BETA api
// prefix, not v3.0 — see lib/visionOneApi.ts `getBeta`/`postBeta`/`patchBeta`/
// `delBeta`. Reconciled by NAME (list, match by name, update or create) — the
// same shape Cisco Meraki's group-policies config type uses, since the rule id
// is server-assigned. VERIFY the list-response envelope against a live Vision
// One tenant; the `beta` prefix signals this surface may still change shape.

export const CUSTOM_RULE_ENDPOINTS = {
  /** List custom rules. GET; returns { items: [...], nextLink } (assumed — VERIFY). */
  list: '/cloudPosture/customRules',
  /** Create a custom rule. POST; body is the full CustomRuleInput. CONFIRMED. */
  create: '/cloudPosture/customRules',
} as const

/** Per-rule path used for update (PATCH) and delete (DELETE). CONFIRMED. */
export function customRuleItemPath(id: string): string {
  return `/cloudPosture/customRules/${encodeURIComponent(id)}`
}

/** Accepted rule categories. CONFIRMED (vision-one-mcp-server tool enum). */
export const RULE_CATEGORIES = new Set([
  'security',
  'cost-optimisation',
  'reliability',
  'performance-efficiency',
  'operational-excellence',
  'sustainability',
])
/** Accepted risk levels. CONFIRMED (vision-one-mcp-server tool enum). */
export const RISK_LEVELS = new Set(['LOW', 'MEDIUM', 'HIGH', 'VERY_HIGH', 'EXTREME'])
/** Accepted cloud providers. CONFIRMED (vision-one-mcp-server tool enum). */
export const PROVIDERS = new Set(['aws', 'azure', 'gcp', 'oci', 'alibabaCloud'])

/**
 * A Cloud Risk Management custom rule as read back from the list endpoint. Field
 * names are per the confirmed Go client request/response shapes — VERIFY the
 * exact list envelope against a live Vision One tenant.
 */
export interface CustomRule {
  id?: string
  name?: string
  description?: string
  categories?: string[]
  riskLevel?: string
  provider?: string
  resolutionReferenceLink?: string
  remediationNote?: string
  enabled?: boolean
  service?: string
  resourceType?: string
  attributes?: unknown[]
  eventRules?: unknown[]
  [key: string]: unknown
}

/** Trim + lowercase a rule name so two that differ only in case still match. */
export function normalizeName(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

/**
 * Vision One list responses carry rules on `items` (with a `nextLink` for
 * pagination), matching every other list in this app. Accept either that shape
 * or a bare array. VERIFY against live Vision One.
 */
export function rulesFromResponse(json: unknown): CustomRule[] {
  if (Array.isArray(json)) return json as CustomRule[]
  if (json && typeof json === 'object') {
    const items = (json as Record<string, unknown>).items
    if (Array.isArray(items)) return items as CustomRule[]
  }
  return []
}

/** Find a live rule by its (normalized) name — the config-as-code identity. */
export function findRuleByName(rules: CustomRule[], name: string): CustomRule | null {
  const target = normalizeName(name)
  if (!target) return null
  return rules.find((r) => normalizeName(r.name) === target) ?? null
}

/** Parse a multiselect / comma-or-newline-separated field into a de-duplicated string array. */
export function readStringArray(value: unknown): string[] {
  const raw: string[] = Array.isArray(value)
    ? value.map((v) => (typeof v === 'string' ? v : String(v ?? '')))
    : typeof value === 'string'
      ? value.split(/[\n,]+/)
      : []
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    const trimmed = entry.trim()
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed)
      out.push(trimmed)
    }
  }
  return out
}

/** Parse a JSON-array canvas field. Blank parses to an empty array (caller enforces "required"). */
export function parseJsonArray(raw: unknown, label: string): { value: unknown[] | null; error: string | null } {
  const text = String(raw ?? '').trim()
  if (!text) return { value: [], error: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { value: null, error: `${label} is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}` }
  }
  if (!Array.isArray(parsed)) return { value: null, error: `${label} must be a JSON array.` }
  return { value: parsed, error: null }
}

/** The parsed canvas fields for one custom rule, before its JSON array fields are parsed. */
export interface CustomRuleFields {
  name: string
  description: string
  categories: string[]
  riskLevel: string
  provider: string
  resolutionReferenceLink: string
  remediationNote: string
  enabled: boolean
  service: string
  resourceType: string
  attributesRaw: unknown
  eventRulesRaw: unknown
}

/** A checkbox field defaults to `true` unless explicitly set to a false-like value. */
function readEnabled(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value.trim().toLowerCase() !== 'false'
  return value !== false
}

export function extractCustomRuleFields(fields: Record<string, unknown>): CustomRuleFields {
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : String(v ?? '').trim())
  return {
    name: str(fields.name),
    description: str(fields.description),
    categories: readStringArray(fields.categories),
    riskLevel: str(fields.riskLevel),
    provider: str(fields.provider),
    resolutionReferenceLink: str(fields.resolutionReferenceLink),
    remediationNote: str(fields.remediationNote),
    enabled: readEnabled(fields.enabled),
    service: str(fields.service),
    resourceType: str(fields.resourceType),
    attributesRaw: fields.attributes,
    eventRulesRaw: fields.eventRules,
  }
}

/** Build the create/update request body from parsed fields + parsed JSON arrays. */
export function buildCustomRuleBody(
  fields: CustomRuleFields,
  attributes: unknown[],
  eventRules: unknown[],
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: fields.name,
    description: fields.description,
    categories: fields.categories,
    riskLevel: fields.riskLevel,
    provider: fields.provider,
    enabled: fields.enabled,
    service: fields.service,
    resourceType: fields.resourceType,
    attributes,
    eventRules,
  }
  if (fields.resolutionReferenceLink) body.resolutionReferenceLink = fields.resolutionReferenceLink
  if (fields.remediationNote) body.remediationNote = fields.remediationNote
  return body
}

/** Read the created rule id from a create response body, when the API returns one. */
export function ruleIdFromResponse(json: unknown): string | null {
  if (json && typeof json === 'object') {
    const id = (json as Record<string, unknown>).id
    if (typeof id === 'string' && id.trim()) return id.trim()
  }
  return null
}

/** Strip the server-assigned `id` before sending a captured prior rule body back on rollback. */
export function stripRuleId(rule: CustomRule): Record<string, unknown> {
  const { id: _id, ...rest } = rule
  return rest
}
