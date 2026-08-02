// Shared helpers for the authentik Groups config type (deploy + rollback +
// drift). Shapes follow the authentik Core API `Group` / `GroupRequest` /
// `PatchedGroupRequest` schemas — see lib/authentikApi.ts for citations.
//
// IDENTITY: a group's API path key is a server-assigned UUID (`group_uuid`,
// `/core/groups/{group_uuid}/`), NOT its name — so, like OAuth2/OpenID
// Providers, this config type upserts by NAME (list `?name=` → match →
// PATCH/POST) via the shared `findByName` helper in lib/authentikApi.ts.
//
// Group MEMBERSHIP (`users`) and RBAC `roles` are real, writable fields on
// `GroupRequest` but are NOT authored here — both are omitted from every
// request body, so this config type never touches whatever membership/roles
// another admin (or a future config type) has set.
//
// SCHEMA NOTE: the live field is `parents` (an array — authentik groups can
// have multiple parents). This config type authors a single optional parent
// for v0.2.0, sent as a one-element `parents` array.

/** UUID matcher for the parent-group pk field. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** An authentik Group as returned by the Core API (fields this config type reads). */
export interface AuthentikGroup {
  pk?: string
  name?: string
  is_superuser?: boolean
  parents?: string[]
  attributes?: Record<string, unknown>
  [key: string]: unknown
}

/** The subset of Group fields this config type authors. */
export interface ManagedGroupFields {
  name: string
  isSuperuser: boolean
  parent: string
  attributes: Record<string, string>
}

/** Coerce a canvas checkbox / API boolean value, tolerant of string forms from either side. */
export function normalizeBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value
  if (value == null) return fallback
  const s = String(value).trim().toLowerCase()
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false
  return fallback
}

function coerceScalar(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value == null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

/**
 * Read a `keyvalue` field into a plain string map. Tolerates the shapes the
 * canvas control (or an imported config) can emit: an object (`{ k: v }`), an
 * array of `{ key|name, value }` pairs, or a newline/comma-separated "k=v"
 * string. Blank keys are dropped; later entries win on a key collision.
 */
export function readAttributes(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === 'object') {
        const rec = item as Record<string, unknown>
        const key = String(rec.key ?? rec.name ?? '').trim()
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
      const idx = line.indexOf('=')
      if (idx > 0) {
        const k = line.slice(0, idx).trim()
        if (k) out[k] = line.slice(idx + 1).trim()
      }
    }
  }
  return out
}

/** Two string maps are equal when they hold the same keys and values. */
export function sameAttributes(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  return ak.every((k) => b[k] === a[k])
}

/** Read the managed fields out of one canvas item's flat `fields` record. */
export function readManagedFields(fields: Record<string, unknown>): ManagedGroupFields {
  return {
    name: String(fields.name ?? '').trim(),
    isSuperuser: normalizeBool(fields.is_superuser, false),
    parent: String(fields.parent ?? '').trim(),
    attributes: readAttributes(fields.attributes),
  }
}

/**
 * The managed-field projection shared by create (POST) and update (PATCH).
 * `parents` is only included when a parent is declared, so a PATCH leaves an
 * existing parent set by another admin untouched rather than clearing it.
 */
function buildManagedBody(managed: ManagedGroupFields): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: managed.name,
    is_superuser: managed.isSuperuser,
    attributes: managed.attributes,
  }
  if (managed.parent) body.parents = [managed.parent]
  return body
}

export function buildCreateBody(fields: Record<string, unknown>): Record<string, unknown> {
  return buildManagedBody(readManagedFields(fields))
}

export function buildPatchBody(fields: Record<string, unknown>): Record<string, unknown> {
  return buildManagedBody(readManagedFields(fields))
}

/** Build a PATCH body directly from a captured `ManagedGroupFields` snapshot (rollback restore). */
export function managedFieldsToPatchBody(managed: ManagedGroupFields): Record<string, unknown> {
  return buildManagedBody(managed)
}

/** Snapshot the managed fields off a LIVE group, for rollback restore / drift comparison. */
export function snapshotManagedFields(group: AuthentikGroup): ManagedGroupFields {
  const parents = Array.isArray(group.parents) ? group.parents : []
  const attrsSource = group.attributes && typeof group.attributes === 'object' ? group.attributes : {}
  const attributes: Record<string, string> = {}
  for (const [k, v] of Object.entries(attrsSource)) attributes[k] = coerceScalar(v)
  return {
    name: String(group.name ?? '').trim(),
    isSuperuser: normalizeBool(group.is_superuser, false),
    parent: parents.length > 0 ? String(parents[0]) : '',
    attributes,
  }
}

/**
 * True when the two managed-field snapshots are equal. `parent` is only
 * compared when OUR declared spec set one — left blank means we deliberately
 * don't manage the parent relationship (see buildManagedBody), so a live
 * parent there is not drift.
 */
export function sameManagedFields(expected: ManagedGroupFields, actual: ManagedGroupFields): boolean {
  if (expected.name !== actual.name) return false
  if (expected.isSuperuser !== actual.isSuperuser) return false
  if (expected.parent && expected.parent !== actual.parent) return false
  if (!sameAttributes(expected.attributes, actual.attributes)) return false
  return true
}
