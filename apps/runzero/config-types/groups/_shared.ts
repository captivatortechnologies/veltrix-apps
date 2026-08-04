// Shared helpers for the runZero Groups config type (deploy + rollback + drift + validate).
//
// A runZero Group bundles a default role plus per-organization role overrides that apply to every
// member user — runZero's closest analogue to a "role" resource (there is no separate role CRUD
// endpoint; roles are always assigned via a Group or directly on a User). The console API models it
// as (verified against runZeroInc/runzero-api runzero-api.yml — Group / GroupPost / GroupPut):
//   List:    GET  /account/groups           → array of Group
//   Create:  POST /account/groups           body GroupPost → Group
//   Update:  PUT  /account/groups           body GroupPut (full object, id inside) → Group
//   Get:     GET  /account/groups/{id}
//   Delete:  DELETE /account/groups/{id}
//
// NOTE ON VERBS: create is POST; UPDATE is PUT on the COLLECTION with the full object (the id
// travels in the body), not PUT /{id} — the same shape already used by scan-templates.
//
// FLAG (scope): groups are ACCOUNT-scoped resources — they live under /account, NOT /org. This
// config type requires the connection to carry an ACCOUNT-scoped runZero API key (the same flag as
// scan-templates); an Organization key gets 401/403 here.
//
// FLAG (destructive rollback): a rollback that undoes a CREATE deletes the group, and with it every
// member's access derived from it. This mirrors the rollback shape already used elsewhere in this
// app (delete what was created).
//
// ROLE VOCABULARY: see the Users config type's _shared.ts header — the exact wire-value vocabulary
// for org_default_role/org_roles is not independently re-verified beyond the spec's own "admin" /
// "viewer" examples, so role values are free text with a soft validate warning, not a hard enum.

/** Role values seen in the spec's own examples — used only for a soft, non-blocking validate hint. */
export const KNOWN_ROLE_HINTS = ['admin', 'user', 'viewer', 'annotator', 'billing'] as const

/** One runZero Group as returned by GET /account/groups (subset of the fields we use). */
export interface RunzeroGroup {
  id?: string
  name?: string
  description?: string
  role_summary?: string
  org_default_role?: string
  org_roles?: Record<string, string>
  expires_at?: number
  user_count?: number
  [key: string]: unknown
}

/** The GroupPost request body for POST (create). */
export interface RunzeroGroupPost {
  name: string
  description: string
  org_default_role: string
  org_roles: Record<string, string>
  expires_at?: number
}

/** The GroupPut request body for PUT (update) — the full object, id embedded. */
export interface RunzeroGroupPut extends RunzeroGroupPost {
  id: string
}

/** One entry in deploy's rollbackData.previous — what deploy did to a single group. */
export interface GroupRollbackEntry {
  name: string
  groupId: string | null
  existed: boolean
  prior: RunzeroGroup | null
}

/** Trim any value to a string. */
export function text(value: unknown): string {
  return String(value ?? '').trim()
}

function coerceScalar(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  return String(value).trim()
}

/** Read a canvas `keyvalue` field (organization id → role name) into a flat string map. */
export function readOrgRoles(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === 'object') {
        const rec = item as Record<string, unknown>
        const key = text(rec.key ?? rec.name)
        if (key) out[key] = coerceScalar(rec.value)
      }
    }
    return out
  }
  if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const k = key.trim()
      if (k) out[k] = coerceScalar(v)
    }
    return out
  }
  if (typeof value === 'string' && value.trim()) {
    for (const line of value.split(/[\r\n,]+/)) {
      const eq = line.indexOf('=')
      if (eq > 0) {
        const k = line.slice(0, eq).trim()
        if (k) out[k] = line.slice(eq + 1).trim()
      }
    }
  }
  return out
}

/** True when two org-roles maps describe the same set of key→value pairs. */
export function orgRolesEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  return ak.every((k) => a[k] === b[k])
}

/**
 * Parse an `expiresAt` canvas value into epoch seconds. Accepts a bare integer (already epoch
 * seconds) or an ISO 8601 date/date-time string. Returns undefined on blank/unparseable input —
 * the field is then omitted from the request, leaving the group non-expiring.
 */
export function parseExpiresAt(raw: unknown): number | undefined {
  const s = text(raw)
  if (!s) return undefined
  if (/^\d+$/.test(s)) return Number(s)
  const ms = Date.parse(s)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined
}

/** Find a live group by name (case-insensitive — the stable identity for upsert/drift). */
export function findGroup(groups: RunzeroGroup[], name: string): RunzeroGroup | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return groups.find((g) => text(g.name).toLowerCase() === n) ?? null
}

/** Build the GroupPost create body from canvas fields. */
export function buildGroupPost(fields: Record<string, unknown>): RunzeroGroupPost {
  const expiresAt = parseExpiresAt(fields.expiresAt)
  return {
    name: text(fields.name),
    description: text(fields.description),
    org_default_role: text(fields.orgDefaultRole),
    org_roles: readOrgRoles(fields.orgRoles),
    ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
  }
}

/** Build the GroupPut update body (full object, id embedded) from canvas fields. */
export function buildGroupPut(id: string, fields: Record<string, unknown>): RunzeroGroupPut {
  return { id, ...buildGroupPost(fields) }
}

/** Build a GroupPut body that restores a prior recorded Group (rollback). */
export function buildGroupPutFromPrior(id: string, prior: RunzeroGroup): RunzeroGroupPut {
  return {
    id,
    name: text(prior.name),
    description: text(prior.description),
    org_default_role: text(prior.org_default_role),
    org_roles: prior.org_roles ?? {},
    ...(prior.expires_at !== undefined ? { expires_at: prior.expires_at } : {}),
  }
}
