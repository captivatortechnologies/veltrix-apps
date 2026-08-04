// =============================================================================
// Shared types + helpers for the Datadog Security Filters config type.
//
// A security filter EXCLUDES logs from security analysis entirely — distinct
// from a Suppression (config-types/security-monitoring-suppressions), which
// still analyzes matching logs but silences the resulting signal.
//
// Verified against the official Datadog API docs (a JSON:API resource):
//   Create: POST  /api/v2/security_monitoring/configuration/security_filters
//           https://docs.datadoghq.com/api/latest/security-monitoring/create-a-security-filter/
//           body: { "data": { "type": "security_filters", "attributes": {
//           name, query, is_enabled, filtered_data_type: "logs",
//           exclusion_filters: [{ name, query }] } } }
//   Update: PATCH /api/v2/security_monitoring/configuration/security_filters/{id}
//           https://docs.datadoghq.com/api/latest/security-monitoring/update-a-security-filter/
//           Partial update; the id is a PATH parameter only (NOT included in
//           the request body's `data`, unlike Suppressions). The update
//           attributes list includes `version` — an optimistic-concurrency
//           token, handled the same way as Security Monitoring Rules: this
//           app re-reads the live filter immediately before every update to
//           capture its current version and includes it in the PATCH body.
//   Delete: DELETE /api/v2/security_monitoring/configuration/security_filters/{id}
//           https://docs.datadoghq.com/api/latest/security-monitoring/delete-a-security-filter/
//           204 No Content.
//   List:   GET /api/v2/security_monitoring/configuration/security_filters
//           (same base path; JSON:API `{ "data": [...] }`, by analogy with
//           the confirmed Suppressions list shape at the sibling
//           `configuration/` resource family).
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

export const MAX_NAME_LENGTH = 255

/** The only documented `filtered_data_type` value. */
export const FILTERED_DATA_TYPES = ['logs'] as const

export interface SecurityFilterAttributes {
  name?: string
  query?: string
  is_enabled?: boolean
  filtered_data_type?: string
  exclusion_filters?: Array<{ name?: string; query?: string }>
  version?: number
  is_builtin?: boolean
  [key: string]: unknown
}

export interface SecurityFilterResource {
  id?: string
  type?: string
  attributes?: SecurityFilterAttributes
}

/** The managed subset of a security filter's attributes — fully declared on every deploy. */
export interface SecurityFilterBody {
  name: string
  query: string
  is_enabled: boolean
  filtered_data_type: string
  exclusion_filters: Array<{ name: string; query: string }>
  version?: number
}

export interface SecurityFilterSpec {
  name: string
  query: string
  isEnabled: boolean
  filteredDataType: string
  exclusionFiltersRaw: string
}

export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

export function extractSecurityFilterSpec(fields: Record<string, unknown>): SecurityFilterSpec {
  const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
  return {
    name: str(fields.name),
    query: str(fields.query),
    isEnabled: readBool(fields.is_enabled, true),
    filteredDataType: str(fields.filtered_data_type) || 'logs',
    exclusionFiltersRaw: typeof fields.exclusion_filters === 'string' ? fields.exclusion_filters.trim() : '',
  }
}

export function extractSecurityFilterSpecs(canvas: CanvasSnapshot): SecurityFilterSpec[] {
  const items = (canvas.items ?? canvas.sections ?? []) as Array<{ fields?: Record<string, unknown> }>
  return items.map((item) => extractSecurityFilterSpec(item.fields ?? {}))
}

export function securityFilterKey(name: string): string {
  return name.trim().toLowerCase()
}

export function findSecurityFilterByName(filters: SecurityFilterResource[], name: string): SecurityFilterResource | null {
  const key = securityFilterKey(name)
  if (!key) return null
  return filters.find((f) => typeof f.attributes?.name === 'string' && securityFilterKey(f.attributes.name) === key) ?? null
}

export interface ParsedJson<T> {
  value: T | undefined
  ok: boolean
}

export function parseJsonArray(raw: string): ParsedJson<unknown[]> {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return { value: undefined, ok: true }
  try {
    const parsed = JSON.parse(trimmed)
    if (!Array.isArray(parsed)) return { value: undefined, ok: false }
    return { value: parsed, ok: true }
  } catch {
    return { value: undefined, ok: false }
  }
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeExclusionFilters(raw: unknown[]): Array<{ name: string; query: string }> {
  return raw
    .filter(isJsonObject)
    .map((f) => ({ name: typeof f.name === 'string' ? f.name : '', query: typeof f.query === 'string' ? f.query : '' }))
}

export function buildSecurityFilterBody(spec: SecurityFilterSpec, exclusionFilters: unknown[], version?: number): SecurityFilterBody {
  const body: SecurityFilterBody = {
    name: spec.name,
    query: spec.query,
    is_enabled: spec.isEnabled,
    filtered_data_type: spec.filteredDataType,
    exclusion_filters: normalizeExclusionFilters(exclusionFilters),
  }
  if (version !== undefined) body.version = version
  return body
}

/** Rebuild a SecurityFilterBody from captured LIVE attributes (rollback restore path). */
export function attributesToBody(attrs: SecurityFilterAttributes, version?: number): SecurityFilterBody {
  const body: SecurityFilterBody = {
    name: String(attrs.name ?? ''),
    query: String(attrs.query ?? ''),
    is_enabled: attrs.is_enabled ?? true,
    filtered_data_type: String(attrs.filtered_data_type ?? 'logs'),
    exclusion_filters: Array.isArray(attrs.exclusion_filters)
      ? normalizeExclusionFilters(attrs.exclusion_filters)
      : [],
  }
  if (version !== undefined) body.version = version
  return body
}

/** The JSON:API request envelope. No `id` in the body — update matches by the URL path param. */
export function toPayload(body: SecurityFilterBody): { data: { type: 'security_filters'; attributes: SecurityFilterBody } } {
  return { data: { type: 'security_filters', attributes: body } }
}
