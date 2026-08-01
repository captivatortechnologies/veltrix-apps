// Shared helpers for the Sumo Logic Field Extraction Rules config type
// (deploy + rollback + drift + validate).
//
// FER shapes follow the Field Extraction Rules Management API. A rule is a flat
// record { id?, name, scope, parseExpression, enabled }. The list endpoint returns
// them inside a `{ data: [...] }` envelope.
//   API: https://www.sumologic.com/help/docs/api/field-extraction-rules/
//   Fields verified against the SumoLogic terraform provider model
//   (sumologic/sumologic_extraction_rule.go): name, scope, parseExpression, enabled.

/** One Sumo Logic Field Extraction Rule. */
export interface ExtractionRule {
  id?: string
  /** Human-readable rule name — the stable identity used to upsert. */
  name: string
  /** Where the rule runs, e.g. `_sourceCategory=prod/nginx` (the pre-`|` search). */
  scope: string
  /** The parse expression describing the fields to extract. */
  parseExpression: string
  /** Whether the rule is active. */
  enabled: boolean
  [key: string]: unknown
}

/** The `{ data: [...] }` envelope returned by GET /extractionRules. */
export interface ExtractionRuleList {
  data?: ExtractionRule[]
  /** Pagination continuation token, when the endpoint pages. Verify against a live Sumo Logic. */
  next?: string | null
}

/**
 * `enabled` may arrive from the canvas as a boolean (checkbox) or as an
 * 'enabled'/'disabled' string, or from Sumo as a boolean / 1|0 / '1'|'0' —
 * normalize to a boolean. Defaults to true when unset.
 */
export function normalizeEnabled(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  if (s === 'disabled' || s === 'false' || s === '0' || s === 'no') return false
  if (s === '') return true
  return true
}

/** Unwrap the `{ data: [...] }` list envelope into a flat array of rules. */
export function rulesFromList(list: unknown): ExtractionRule[] {
  if (Array.isArray(list)) return list as ExtractionRule[]
  const data = (list as ExtractionRuleList | null | undefined)?.data
  return Array.isArray(data) ? data : []
}

/** Find a live rule by name (case-insensitive, trimmed) — the FER identity. */
export function findRule(rules: ExtractionRule[], name: string): ExtractionRule | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return rules.find((r) => String(r.name ?? '').trim().toLowerCase() === n) ?? null
}

/**
 * Build the FER request body from canvas fields. `id` is intentionally omitted —
 * the Management API rejects `id` in the body on update (it lives in the path).
 */
export function buildRuleBody(fields: Record<string, unknown>): ExtractionRule {
  return {
    name: String(fields.name ?? '').trim(),
    scope: String(fields.scope ?? '').trim(),
    parseExpression: String(fields.parseExpression ?? '').trim(),
    enabled: normalizeEnabled(fields.enabled),
  }
}
