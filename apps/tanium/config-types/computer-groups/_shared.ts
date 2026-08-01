// Shared helpers for the Tanium Computer Groups config type (deploy + rollback + drift).
//
// Tanium computer-group shapes follow the REST v2 API (/api/v2/groups,
// /api/v2/groups/{id}, /api/v2/groups/by-name/{name}). A filter-based group is a
// `{ name, text }` object where `text` is a Tanium filter expression
// (e.g. `Operating System contains Windows`). Responses are typically wrapped in a
// `{ data: ... }` envelope. Verify the structured `filters` spec against a live Tanium.

/** One Tanium computer group, as returned (usually inside `{ data: {...} }`) by /api/v2/groups. */
export interface TaniumGroup {
  id?: number | string
  name?: string
  /** The plain-text filter expression that selects endpoints for this group. */
  text?: string
  type?: number | string
  deleted_flag?: boolean | number
  /** Structured filter spec — shape unverified against a live Tanium; treated opaquely. */
  filters?: unknown
  [key: string]: unknown
}

/** The body POST/PUT /api/v2/groups accepts for a filter-based group. */
export interface TaniumGroupBody {
  name: string
  text?: string
  filters?: unknown
}

/** Unwrap a Tanium REST response that may wrap its payload in a `{ data: ... }` envelope. */
export function unwrapData(body: unknown): unknown {
  if (body && typeof body === 'object' && 'data' in (body as Record<string, unknown>)) {
    return (body as { data: unknown }).data
  }
  return body
}

/** Coerce a Tanium groups-list response into a flat array of groups (unwrapping `{ data: [...] }`). */
export function groupsFromList(list: unknown): TaniumGroup[] {
  const data = unwrapData(list)
  if (Array.isArray(data)) return data as TaniumGroup[]
  // Some builds return `{ data: { groups: [...] } }`.
  if (data && typeof data === 'object' && Array.isArray((data as { groups?: unknown }).groups)) {
    return (data as { groups: TaniumGroup[] }).groups
  }
  return []
}

/** Unwrap a single-group response (`{ data: {...} }` or a bare group). */
export function groupFromResponse(body: unknown): TaniumGroup | null {
  const data = unwrapData(body)
  if (data && typeof data === 'object' && !Array.isArray(data)) return data as TaniumGroup
  return null
}

/** Find a live group by name (case-insensitive — the stable identity for upsert and drift). */
export function findGroup(groups: TaniumGroup[], name: string): TaniumGroup | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return groups.find((g) => String(g.name ?? '').trim().toLowerCase() === n) ?? null
}

/**
 * Parse the optional structured-filter JSON field. Empty → `{}` (no structured
 * filter). Invalid JSON → an error the validator/deploy can surface. Non-object
 * roots are rejected (a filter spec is an object or an array of clauses).
 */
export function parseFilterJson(raw: unknown): { value?: unknown; error?: string } {
  const s = String(raw ?? '').trim()
  if (!s) return { value: undefined }
  try {
    const parsed = JSON.parse(s)
    if (parsed === null || (typeof parsed !== 'object' && !Array.isArray(parsed))) {
      return { error: 'Structured filter must be a JSON object or array.' }
    }
    return { value: parsed }
  } catch (e) {
    return { error: `Structured filter is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}` }
  }
}

/**
 * Build the Tanium group body from canvas fields. `filterText` maps to `text` (the
 * plain-text filter expression, the verified path); an optional `filterJson`
 * supplies a structured `filters` spec. At least one of the two should be present
 * (enforced by validate.ts).
 */
export function buildGroupBody(fields: Record<string, unknown>): TaniumGroupBody {
  const body: TaniumGroupBody = { name: String(fields.name ?? '').trim() }
  const text = String(fields.filterText ?? '').trim()
  if (text) body.text = text
  const parsed = parseFilterJson(fields.filterJson)
  if (parsed.value !== undefined) body.filters = parsed.value
  return body
}
