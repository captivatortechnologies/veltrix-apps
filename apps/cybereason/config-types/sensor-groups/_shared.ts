// Shared helpers for the Cybereason Sensor Groups config type
// (validate + deploy + rollback + drift + tests).
//
// A sensor group's authoring identity is its `name` (unique per tenant);
// Cybereason assigns a GUID `id` on create (returned as `groupId`) which the
// PUT/DELETE endpoints key on. Deploy reads the live groups, matches the declared
// name to a live group, and PUTs by id when it exists or POSTs a new group.
//
// CONFIRMED against two public Cybereason clients (forensic-security/cybereason
// Python SDK sensors.py; tobor88 PoshCybereason): GET/POST /rest/groups,
// PUT/DELETE /rest/groups/{id}. FLAGGED — the inner shape of `groupAssignRule`
// (the dynamic auto-assignment rule) is passed through as opaque JSON; VERIFY it
// and the response shape against a live Cybereason tenant.

export const GROUP_ENDPOINTS = {
  /** CONFIRMED — list all sensor groups. */
  list: '/rest/groups',
  /** CONFIRMED — create a group. Body { name, description?, policyId?, groupAssignRule? } → { groupId }. */
  create: '/rest/groups',
  /** CONFIRMED — update a group (full object) by GUID. */
  update: (id: string) => `/rest/groups/${encodeURIComponent(id)}`,
  /** CONFIRMED — delete a group, reassigning its sensors to `assignToGroupId`. */
  remove: (id: string, assignToGroupId: string) =>
    `/rest/groups/${encodeURIComponent(id)}?assignToGroupId=${encodeURIComponent(assignToGroupId)}`,
} as const

/** Cybereason's built-in "Unassigned Group" GUID — the default reassignment target on delete. */
export const UNASSIGNED_GROUP_ID = '00000000-0000-0000-0000-000000000000'

/** A Cybereason sensor group as authored / read back. `groupAssignRule` is opaque (FLAGGED). */
export interface CybereasonGroup {
  id?: string
  groupId?: string
  name?: string
  description?: string
  policyId?: string
  groupAssignRule?: unknown
  [key: string]: unknown
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Does `value` look like a GUID (Cybereason policy / group id shape)? */
export function isGuid(value: unknown): boolean {
  return GUID_RE.test(String(value ?? '').trim())
}

/** Trim + lowercase a group name so two that differ only in case still match. */
export function normalizeName(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

/** The GUID that keys the PUT/DELETE endpoints — `id`, falling back to `groupId`. */
export function groupId(group: CybereasonGroup): string {
  return String(group.id ?? group.groupId ?? '').trim()
}

/** True when a string is blank or parses as JSON. */
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

/** Parse an optional JSON blob. Returns null on blank; throws on invalid JSON. */
export function parseJson(value: unknown): unknown {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  return JSON.parse(raw)
}

/**
 * Parse the /rest/groups response into group rows. GET /rest/groups answers with a
 * JSON array; tolerate a wrapped { groups | data | items: [] } too. Returns [] on
 * anything unparseable so a read failure never raises false drift.
 */
export function groupsFromResponse(body: string): CybereasonGroup[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return []
  }
  if (Array.isArray(parsed)) return parsed as CybereasonGroup[]
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>
    const inner = obj.groups ?? obj.data ?? obj.items
    if (Array.isArray(inner)) return inner as CybereasonGroup[]
  }
  return []
}

/** Find a live group by its (normalized) name. */
export function findGroupByName(groups: CybereasonGroup[], name: string): CybereasonGroup | null {
  const target = normalizeName(name)
  if (!target) return null
  return groups.find((g) => normalizeName(g.name) === target) ?? null
}

/** The created group's GUID from a POST /rest/groups response ({ groupId } or { id }). */
export function createdGroupId(body: string): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    return String(parsed?.groupId ?? parsed?.id ?? '').trim()
  } catch {
    return ''
  }
}

/**
 * Build the group body from canvas fields. Blank optionals are omitted so a PUT
 * (full replace) never force-clears a description / policy the author left blank.
 * `groupAssignRule` is parsed from JSON and passed through opaquely (FLAGGED).
 */
export function buildGroupBody(fields: Record<string, unknown>): CybereasonGroup {
  const group: CybereasonGroup = { name: String(fields.name ?? '').trim() }
  const description = String(fields.description ?? '').trim()
  if (description) group.description = description
  const policyId = String(fields.policyId ?? '').trim()
  if (policyId) group.policyId = policyId
  const rule = parseJson(fields.groupAssignRule)
  if (rule !== null) group.groupAssignRule = rule
  return group
}
