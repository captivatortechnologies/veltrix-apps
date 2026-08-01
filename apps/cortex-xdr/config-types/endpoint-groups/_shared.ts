// Shared helpers for the Cortex XDR Endpoint Groups config type
// (deploy + rollback + drift).
//
// READ is real: Cortex XDR documents POST /endpoints/get_endpoint_groups/ (it is
// this app's connectivity/health probe), so drift, identity matching and rollback
// snapshots can read live groups. WRITE is NOT: the Cortex XDR public API does
// NOT document a create/update/delete endpoint-group operation (confirmed against
// the Response Action reference + PANW LIVEcommunity). The create/delete paths
// below are therefore BEST-EFFORT and FLAGGED — deploy attempts them so the type
// works the moment a tenant/version exposes them, but they are unverified and may
// 404. Do not treat them as confirmed.
//
// VERIFY every endpoint path, request/response shape and enum value against a live
// Cortex XDR tenant.

// --- Cortex XDR endpoint-group endpoints -------------------------------------
// All POST under /public_api/v1. The client prepends the base + /public_api/v1.
export const ENDPOINT_GROUP_ENDPOINTS = {
  /** REAL — list endpoint groups. Body: { request_data: {} }. Also the health probe. */
  list: '/endpoints/get_endpoint_groups/',
  /** FLAGGED — no confirmed public create endpoint. Body: { request_data: { <group> } }. VERIFY. */
  create: '/endpoints/create_endpoint_group/',
  /** FLAGGED — no confirmed public delete endpoint. Body: { request_data: { name } }. VERIFY. */
  delete: '/endpoints/delete_endpoint_group/',
} as const

/** Accepted group types (VERIFY the exact accepted values against live Cortex XDR). */
export const GROUP_TYPES = new Set(['static', 'dynamic'])

/**
 * One Cortex XDR endpoint group. Field names are FLAGGED — VERIFY against live
 * Cortex XDR (the get_endpoint_groups response shape is unverified).
 */
export interface CortexEndpointGroup {
  name?: string
  description?: string
  group_type?: string
  /** Membership criteria for dynamic groups — an opaque JSON object. VERIFY the field name. */
  filter?: unknown
  [key: string]: unknown
}

/** Trim + lowercase a group name so two that differ only in case still match. */
export function normalizeName(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

/**
 * Cortex get_endpoint_groups returns its payload on `reply`; the exact shape is
 * FLAGGED. Accept either a bare array on `reply`, or `{ reply: { groups: [] } }` /
 * `{ reply: { endpoint_groups: [] } }`. VERIFY the real shape against live Cortex XDR.
 */
export function groupsFromReply(reply: unknown): CortexEndpointGroup[] {
  if (Array.isArray(reply)) return reply as CortexEndpointGroup[]
  if (reply && typeof reply === 'object') {
    const obj = reply as Record<string, unknown>
    const inner = obj.groups ?? obj.endpoint_groups ?? obj.data
    if (Array.isArray(inner)) return inner as CortexEndpointGroup[]
  }
  return []
}

/** Find a live group by its (normalized) name. */
export function findGroupByName(groups: CortexEndpointGroup[], name: string): CortexEndpointGroup | null {
  const target = normalizeName(name)
  if (!target) return null
  return groups.find((g) => normalizeName(g.name ?? (g as Record<string, unknown>).group_name) === target) ?? null
}

/** Parse an optional JSON filter string. Returns null on blank; throws on invalid JSON. */
export function parseFilterJson(value: unknown): unknown {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  return JSON.parse(raw)
}

/** True when a filter string is blank or parses as JSON. */
export function isValidFilterJson(value: unknown): boolean {
  const raw = String(value ?? '').trim()
  if (!raw) return true
  try {
    JSON.parse(raw)
    return true
  } catch {
    return false
  }
}

/** Build the Cortex endpoint-group body from canvas fields. Omits empty optionals. */
export function buildEndpointGroupBody(fields: Record<string, unknown>): CortexEndpointGroup {
  const group: CortexEndpointGroup = {
    name: String(fields.name ?? '').trim(),
    group_type: String(fields.group_type ?? '').trim().toLowerCase(),
  }
  const description = String(fields.description ?? '').trim()
  if (description) group.description = description
  const filter = parseFilterJson(fields.filter)
  if (filter !== null) group.filter = filter
  return group
}
