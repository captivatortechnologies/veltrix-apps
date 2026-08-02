// =============================================================================
// Shared types + helpers for the Datadog Security Monitoring Suppressions
// config type.
//
// A suppression rule silences signals from matching detection rules (e.g. to
// quiet known-noisy staging environments) WITHOUT disabling the underlying
// rule. Verified against the official Datadog API docs:
//
//   List:   GET    /api/v2/security_monitoring/configuration/suppressions
//           https://docs.datadoghq.com/api/latest/security-monitoring/get-all-suppression-rules/
//           JSON:API envelope: { "data": [{ "id", "type": "suppressions",
//           "attributes": {...} }], "meta": { "page": {...} } }.
//           Query params: query, sort, page[size], page[number].
//   Get:    GET    /api/v2/security_monitoring/configuration/suppressions/{suppression_id}
//           https://docs.datadoghq.com/api/latest/security-monitoring/get-a-suppression-rule/
//           { "data": { "id", "type": "suppressions", "attributes": {...} } }
//           attributes include: name, description, enabled, rule_query,
//           suppression_query, data_exclusion_query, start_date,
//           expiration_date, tags, creation_date, creator{handle,name},
//           update_date, updater{handle,name}, version, editable.
//   Create: POST   /api/v2/security_monitoring/configuration/suppressions
//           https://docs.datadoghq.com/api/latest/security-monitoring/create-a-suppression-rule/
//           body: { "data": { "type": "suppressions", "attributes": {
//           name, enabled, rule_query, description?, suppression_query?,
//           data_exclusion_query?, start_date?, expiration_date?, tags? } } }
//   Update: PATCH  /api/v2/security_monitoring/configuration/suppressions/{suppression_id}
//           https://docs.datadoghq.com/api/latest/security-monitoring/update-a-suppression-rule/
//           "Supports partial updates" — this app always sends every managed
//           attribute on every deploy (name/description/enabled/rule_query/
//           suppression_query/data_exclusion_query/start_date/
//           expiration_date/tags), so each deploy fully replaces the declared
//           state regardless. No optimistic-concurrency `version` field is
//           documented as REQUIRED on write (unlike Security Monitoring
//           Rules) — the `version` the read models is reported back but is
//           not sent on write.
//   Delete: DELETE /api/v2/security_monitoring/configuration/suppressions/{suppression_id}
//           https://docs.datadoghq.com/api/latest/security-monitoring/delete-a-suppression-rule/
//           204 No Content.
//
// CORRECTION vs the wave-2 kickoff: the verified path is
// `/api/v2/security_monitoring/configuration/suppressions` — a `configuration/`
// segment is present that was not in the original ask.
//
// PROTECTED: a matched live suppression whose `attributes.editable === false`
// is never modified (mirrors this app's log-pipelines is_read_only
// protection) — the deploy fails loudly rather than silently skip or
// overwrite it.
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

export const MAX_NAME_LENGTH = 255

/** A suppression's `attributes` — the JSON:API resource body. */
export interface SuppressionAttributes {
  name?: string
  description?: string
  enabled?: boolean
  rule_query?: string
  suppression_query?: string
  data_exclusion_query?: string
  start_date?: number | null
  expiration_date?: number | null
  tags?: string[]
  editable?: boolean
  version?: number
  [key: string]: unknown
}

/** A suppression as returned by the API: the JSON:API resource `{ id, type, attributes }`. */
export interface SuppressionResource {
  id?: string
  type?: string
  attributes?: SuppressionAttributes
}

/** The managed subset of a suppression's attributes — fully declared on every deploy. */
export interface SuppressionBody {
  name: string
  description: string
  enabled: boolean
  rule_query: string
  suppression_query: string
  data_exclusion_query: string
  tags: string[]
  start_date?: number
  expiration_date?: number
}

export interface SuppressionSpec {
  name: string
  description: string
  enabled: boolean
  ruleQuery: string
  suppressionQuery: string
  dataExclusionQuery: string
  tags: string[]
  startDateRaw: string
  expirationDateRaw: string
}

export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

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

/** Parse a millisecond-epoch field: '' -> undefined; otherwise a finite number, or NaN when malformed. */
export function parseEpochMs(raw: string): number | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : NaN
}

export function extractSuppressionSpec(fields: Record<string, unknown>): SuppressionSpec {
  const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
  const num = (value: unknown): string => (typeof value === 'number' ? String(value) : str(value))
  return {
    name: str(fields.name),
    description: str(fields.description),
    enabled: readBool(fields.enabled, true),
    ruleQuery: str(fields.rule_query),
    suppressionQuery: str(fields.suppression_query),
    dataExclusionQuery: str(fields.data_exclusion_query),
    tags: readStringArray(fields.tags),
    startDateRaw: num(fields.start_date),
    expirationDateRaw: num(fields.expiration_date),
  }
}

export function extractSuppressionSpecs(canvas: CanvasSnapshot): SuppressionSpec[] {
  const items = (canvas.items ?? canvas.sections ?? []) as Array<{ fields?: Record<string, unknown> }>
  return items.map((item) => extractSuppressionSpec(item.fields ?? {}))
}

export function suppressionKey(name: string): string {
  return name.trim().toLowerCase()
}

export function findSuppressionByName(rules: SuppressionResource[], name: string): SuppressionResource | null {
  const key = suppressionKey(name)
  if (!key) return null
  return rules.find((r) => typeof r.attributes?.name === 'string' && suppressionKey(r.attributes.name) === key) ?? null
}

/** True when a live suppression is protected from edits (e.g. by RBAC/ownership) — PROTECTED. */
export function isNonEditableSuppression(resource: SuppressionResource | null | undefined): boolean {
  return resource?.attributes?.editable === false
}

export function buildSuppressionBody(spec: SuppressionSpec, startDate: number | undefined, expirationDate: number | undefined): SuppressionBody {
  const body: SuppressionBody = {
    name: spec.name,
    description: spec.description,
    enabled: spec.enabled,
    rule_query: spec.ruleQuery,
    suppression_query: spec.suppressionQuery,
    data_exclusion_query: spec.dataExclusionQuery,
    tags: spec.tags,
  }
  if (startDate !== undefined) body.start_date = startDate
  if (expirationDate !== undefined) body.expiration_date = expirationDate
  return body
}

/** Rebuild a SuppressionBody from captured LIVE attributes (rollback restore path). */
export function attributesToBody(attrs: SuppressionAttributes): SuppressionBody {
  const body: SuppressionBody = {
    name: String(attrs.name ?? ''),
    description: String(attrs.description ?? ''),
    enabled: attrs.enabled ?? true,
    rule_query: String(attrs.rule_query ?? ''),
    suppression_query: String(attrs.suppression_query ?? ''),
    data_exclusion_query: String(attrs.data_exclusion_query ?? ''),
    tags: Array.isArray(attrs.tags) ? attrs.tags : [],
  }
  if (typeof attrs.start_date === 'number') body.start_date = attrs.start_date
  if (typeof attrs.expiration_date === 'number') body.expiration_date = attrs.expiration_date
  return body
}

/** The JSON:API request envelope for create (`POST`) — no `id`. */
export function toCreatePayload(body: SuppressionBody): { data: { type: 'suppressions'; attributes: SuppressionBody } } {
  return { data: { type: 'suppressions', attributes: body } }
}

/** The JSON:API request envelope for update (`PATCH`) — includes the `id`. */
export function toUpdatePayload(
  id: string,
  body: SuppressionBody,
): { data: { id: string; type: 'suppressions'; attributes: SuppressionBody } } {
  return { data: { id, type: 'suppressions', attributes: body } }
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Case-sensitive set-equality for two tag lists (order-insensitive). */
export function sameTagSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const setA = new Set(a)
  return b.every((t) => setA.has(t))
}
