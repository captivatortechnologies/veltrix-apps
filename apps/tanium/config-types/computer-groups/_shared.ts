// Shared helpers for the Tanium Computer Groups config type (deploy + rollback + drift).
//
// Tanium computer-group shapes follow the REST v2 API. Two distinct AUTHORING
// modes are confirmed by Tanium's public integrations (Cortex XSOAR Tanium_v2
// `tn-create-filter-based-group` / `tn-create-manual-group`), both landing in the
// SAME `/api/v2/groups` collection for read/update/delete:
//
//   filter (dynamic) — POST /api/v2/groups            { name, text, filters? }
//     `text` is a Tanium filter expression, e.g. `Operating System contains Windows`.
//   manual (static)  — POST /api/v2/computer_groups    { name, computer_specs }
//     `computer_specs` is an array of `{ computer_name }` / `{ ip_address }` entries —
//     an explicit, non-dynamic membership list.
//
// Both then read/update/delete via the SAME `groups` collection:
//   GET    /api/v2/groups/by-name/{name}, /api/v2/groups/{id}, /api/v2/groups
//   PUT    /api/v2/groups/{id}      (in-place update — VERIFY, see below)
//   DELETE /api/v2/groups/{id}      (confirmed: `tn-delete-group`)
//
// Responses are typically wrapped in a `{ data: ... }` envelope.
//
// VERIFY AGAINST A LIVE TANIUM: PUT /api/v2/groups/{id} as an in-place update
// (for EITHER creation mode) is a REST v2 convention not exercised by Tanium's
// public integrations (which delete + recreate). The structured `filters` spec
// shape is likewise unconfirmed — treated opaquely.

import { strList } from '../../lib/canvasValues'

/** One `{ computer_name }` or `{ ip_address }` entry in a manual group's membership list. */
export interface TaniumComputerSpec {
  computer_name?: string
  ip_address?: string
}

/** One Tanium computer group, as returned (usually inside `{ data: {...} }`) by /api/v2/groups. */
export interface TaniumGroup {
  id?: number | string
  name?: string
  /** The plain-text filter expression that selects endpoints for this group (filter mode). */
  text?: string
  type?: number | string
  deleted_flag?: boolean | number
  /** Structured filter spec — shape unverified against a live Tanium; treated opaquely. */
  filters?: unknown
  /** Explicit membership list (manual mode) — present instead of `text`/`filters`. */
  computer_specs?: TaniumComputerSpec[]
  [key: string]: unknown
}

/** The body POST/PUT /api/v2/groups (filter mode) or /api/v2/computer_groups (manual mode) accepts. */
export interface TaniumGroupBody {
  name: string
  text?: string
  filters?: unknown
  computer_specs?: TaniumComputerSpec[]
}

/** The two group-authoring modes this config type supports. */
export type GroupMode = 'filter' | 'manual'

/** Read the canvas `mode` field, defaulting to `filter` (the original, backward-compatible mode). */
export function groupModeOf(fields: Record<string, unknown>): GroupMode {
  return String(fields.mode ?? '').trim() === 'manual' ? 'manual' : 'filter'
}

/** The REST v2 CREATE resource for a group's mode — both read/update/delete via `groups`. */
export function createResourceFor(mode: GroupMode): 'groups' | 'computer_groups' {
  return mode === 'manual' ? 'computer_groups' : 'groups'
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
 * Build the manual-mode `computer_specs` list from the canvas `computerNames` /
 * `ipAddresses` tag fields — `{ computer_name }` entries first, then `{ ip_address }`
 * (matches the confirmed `tn-create-manual-group` body shape).
 */
export function computerSpecsOf(fields: Record<string, unknown>): TaniumComputerSpec[] {
  return [
    ...strList(fields.computerNames).map((computer_name) => ({ computer_name })),
    ...strList(fields.ipAddresses).map((ip_address) => ({ ip_address })),
  ]
}

/**
 * Build the Tanium group create/update body from canvas fields, branching on
 * `mode`:
 *   filter (default) — `filterText` maps to `text` (the plain-text filter
 *     expression, the verified path); an optional `filterJson` supplies a
 *     structured `filters` spec. At least one of the two should be present
 *     (enforced by validate.ts).
 *   manual — `computerNames` / `ipAddresses` map to `computer_specs`. At least
 *     one entry should be present (enforced by validate.ts).
 */
export function buildGroupBody(fields: Record<string, unknown>): TaniumGroupBody {
  const body: TaniumGroupBody = { name: String(fields.name ?? '').trim() }
  if (groupModeOf(fields) === 'manual') {
    body.computer_specs = computerSpecsOf(fields)
    return body
  }
  const text = String(fields.filterText ?? '').trim()
  if (text) body.text = text
  const parsed = parseFilterJson(fields.filterJson)
  if (parsed.value !== undefined) body.filters = parsed.value
  return body
}

/**
 * Rebuild a create/update body from a captured prior group, for rollback. Detects
 * the prior group's mode from its shape: a non-empty `computer_specs` list means
 * manual; otherwise filter (text/filters, possibly both empty for an edge-case group).
 */
export function restoreGroupBody(prior: TaniumGroup): TaniumGroupBody {
  const name = String(prior.name ?? '').trim()
  if (Array.isArray(prior.computer_specs) && prior.computer_specs.length > 0) {
    return { name, computer_specs: prior.computer_specs }
  }
  const body: TaniumGroupBody = { name }
  if (prior.text) body.text = prior.text
  if (prior.filters !== undefined) body.filters = prior.filters
  return body
}
