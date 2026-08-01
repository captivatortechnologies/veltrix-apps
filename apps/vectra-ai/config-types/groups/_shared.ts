// Shared helpers for the Vectra Groups config type (deploy + rollback + drift).
//
// Group shapes follow the Vectra Detect v2.x REST API (/api/v2.5/groups), as
// exercised by Vectra's official client `vectra_api_tools` (VectraClientV2):
//   list:   GET    /groups            → DRF envelope { count, results: [ {group} ] }
//   get:    GET    /groups/{id}
//   create: POST   /groups            body { name, description, type, members }
//   update: PATCH  /groups/{id}       body { name, description, members }  (type immutable)
//   delete: DELETE /groups/{id}
//
// FLAG (verify against a live Vectra):
//   - The official v2 create_group validates type ∈ {host, domain, ip}. "account"
//     groups exist in the product (O365/AWS/Entra account detections) but are NOT
//     in that validation list — account-group creation is UNVERIFIED here.
//   - `type` is set at create time only; the v2 PATCH body carries name/description/
//     members. Changing a group's type requires recreating it.
//   - Dynamic regex membership (a group's `rules`) has no documented object shape in
//     the official v2 client, so this config type manages STATIC `members` only.
//   - On read-back, `members` may be EXPANDED into objects ({ id, name, ... }) rather
//     than bare ids/strings; normalizeMembers() collapses them for write/rollback.

/**
 * Group types offered by the canvas select. host / domain / ip are confirmed by the
 * official v2 create_group validation; "account" is FLAGGED — verify your Vectra
 * accepts account-group creation over the v2 API before relying on it.
 */
export const GROUP_TYPES = new Set(['host', 'domain', 'ip', 'account'])

/** Types whose members are numeric Vectra host IDs (others carry string members). */
const NUMERIC_MEMBER_TYPES = new Set(['host'])

/** One Vectra group as returned by the /groups API. */
export interface VectraGroup {
  id?: number | string
  name?: string
  description?: string
  type?: string
  members?: Array<number | string | Record<string, unknown>>
  [key: string]: unknown
}

/** Split a comma/whitespace-separated field into a trimmed, de-duplicated list. */
export function parseList(value: unknown): string[] {
  const seen = new Set<string>()
  return String(value ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !seen.has(s) && (seen.add(s), true))
}

/**
 * Collapse a group's members into the shape the write API expects. Read-back
 * members may be expanded objects — take their id (host groups) or name/uid — while
 * host members are coerced to numeric ids and everything else stays a string.
 */
export function normalizeMembers(members: unknown, type: string): Array<number | string> {
  const list = Array.isArray(members) ? members : parseList(members)
  const values = list.map((m) => {
    if (m && typeof m === 'object') {
      const o = m as Record<string, unknown>
      return (o.id ?? o.uid ?? o.name ?? '') as number | string
    }
    return m as number | string
  })
  if (NUMERIC_MEMBER_TYPES.has(type)) {
    return values.map((v) => Number(v)).filter((n) => Number.isFinite(n))
  }
  return values.map((v) => String(v).trim()).filter((s) => s.length > 0)
}

/** Unwrap the Vectra DRF list envelope `{ results: [...] }` into a flat array. */
export function groupsFromList(list: unknown): VectraGroup[] {
  if (Array.isArray(list)) return list as VectraGroup[]
  if (list && typeof list === 'object' && Array.isArray((list as { results?: unknown }).results)) {
    return (list as { results: VectraGroup[] }).results
  }
  return []
}

/** Find a live group by its name (the stable identity used for upsert/drift). */
export function findGroup(groups: VectraGroup[], name: string): VectraGroup | null {
  const n = name.trim()
  if (!n) return null
  return groups.find((g) => String(g.name ?? '').trim() === n) ?? null
}

/**
 * Build the create (POST) body from canvas fields: name, description, type and the
 * normalized static members. `type` is included only here — the v2 update path omits
 * it (a group's type is immutable). See the FLAG block above.
 */
export function buildGroupBody(fields: Record<string, unknown>): VectraGroup {
  const type = String(fields.type ?? '').trim()
  return {
    name: String(fields.name ?? '').trim(),
    description: String(fields.description ?? '').trim(),
    type,
    members: normalizeMembers(fields.members, type),
  }
}

/** Build the update (PATCH) body: name/description/members only (type is immutable). */
export function buildGroupUpdateBody(fields: Record<string, unknown>): VectraGroup {
  const type = String(fields.type ?? '').trim()
  return {
    name: String(fields.name ?? '').trim(),
    description: String(fields.description ?? '').trim(),
    members: normalizeMembers(fields.members, type),
  }
}
