// Shared helpers for the Keycloak Default Roles config type (deploy + rollback + drift).
//
// Every realm (Keycloak 13+) has a special composite REALM ROLE — referenced
// from the realm itself as RealmRepresentation.defaultRole — that is granted to
// every new user. This config type reconciles that role's composite children
// (both realm roles and client roles) to an authoritative declared set via the
// role-by-id composites endpoints:
//   GET    /admin/realms/{realm}                               → .defaultRole.id
//   GET    /admin/realms/{realm}/roles-by-id/{id}/composites    → current children
//   POST   /admin/realms/{realm}/roles-by-id/{id}/composites    → add children
//   DELETE /admin/realms/{realm}/roles-by-id/{id}/composites    → remove children
//
// A client-role composite's `containerId` is the CLIENT's internal UUID, not
// the realm — resolved back to a human clientId via GET /clients/{containerId}
// so the declared and live shapes can be compared as { [clientId]: roleName[] }.
//
// Config types never import each other's _shared.ts in this codebase, so the
// composite reconciliation below is self-contained — it generalizes
// groups/_shared.ts's reconcileRealmRoles to also handle client-role composites
// addressed by (clientId, roleName) instead of just a realm role name.
//
// Verified against the official Keycloak Admin REST API
// (www.keycloak.org/docs-api/latest/rest-api — "Roles (by ID)" and "Realms").

import { parseJsonField, readStringArray, stringSetsEqual } from '../../lib/fields'
import { parseJson } from '../../lib/keycloakApi'
import type { KeycloakAdminClient } from '../../lib/keycloakApi'
import { resolveClientByClientId } from '../../lib/clients'

/** The realm representation slice this config type reads (GET /admin/realms/{realm}). */
export interface KeycloakRealmRep {
  id?: string
  realm?: string
  defaultRole?: { id?: string; name?: string; [key: string]: unknown }
  [key: string]: unknown
}

/** A composite-role reference as returned by the roles-by-id composites endpoints. */
export interface KeycloakCompositeRoleRef {
  id?: string
  name?: string
  clientRole?: boolean
  containerId?: string
  [key: string]: unknown
}

/** The declared/live shape this config type compares: realm role names + a clientId→role-names map. */
export interface DefaultRolesProjection {
  realmRoles: string[]
  clientRoles: Record<string, string[]>
}

// --- Canvas field parsing (pure, network-free) --------------------------------

/** True when `value` is a plain object whose every property is a non-empty-string array. */
export function isClientRoleMapShape(value: unknown): value is Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.entries(value as Record<string, unknown>).every(
    ([key, v]) =>
      key.trim().length > 0 && Array.isArray(v) && v.every((s) => typeof s === 'string' && s.trim().length > 0),
  )
}

/** Normalize a raw client-role map: trim keys/names, drop blanks, de-dupe names per client. */
export function normalizeClientRoleMap(map: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [clientId, names] of Object.entries(map)) {
    const key = clientId.trim()
    if (!key) continue
    const deduped = [...new Set(names.map((n) => n.trim()).filter(Boolean))]
    if (deduped.length > 0) out[key] = deduped
  }
  return out
}

/**
 * Read the `clientRoles` JSON-textarea field. Returns {} on blank, invalid JSON
 * or the wrong shape — validate.ts is what surfaces those as errors; deploy and
 * drift only ever see an already-validated canvas, but stay defensive here.
 */
export function readClientRolesField(fields: Record<string, unknown>): Record<string, string[]> {
  const parsed = parseJsonField(fields.clientRoles)
  if (!parsed.ok || parsed.value === undefined || !isClientRoleMapShape(parsed.value)) return {}
  return normalizeClientRoleMap(parsed.value)
}

/** Project the canvas item's fields into the comparable { realmRoles, clientRoles } shape. */
export function projectFromFields(fields: Record<string, unknown>): DefaultRolesProjection {
  return {
    realmRoles: readStringArray(fields.realmRoles),
    clientRoles: readClientRolesField(fields),
  }
}

/** Two clientId→role-names maps are equal (order-insensitive within each client's list). */
export function clientRoleMapsEqual(a: Record<string, string[]>, b: Record<string, string[]>): boolean {
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  return ak.every((k) => b[k] !== undefined && stringSetsEqual(a[k] ?? [], b[k] ?? []))
}

// --- Realm + default-role resolution (network) --------------------------------

/** Fetch the live realm representation (GET /admin/realms/{realm}). */
export async function fetchRealmRep(admin: KeycloakAdminClient): Promise<KeycloakRealmRep | null> {
  const res = await admin.get('')
  if (!res.ok) return null
  return parseJson<KeycloakRealmRep>(res.body)
}

/** Resolve the realm's default composite role id, or an error when the realm has none (pre-13). */
export async function resolveDefaultRoleId(admin: KeycloakAdminClient): Promise<{ id: string } | { error: string }> {
  const realm = await fetchRealmRep(admin)
  const id = realm?.defaultRole?.id
  if (!id) {
    return {
      error:
        "This realm has no default composite role (RealmRepresentation.defaultRole) — default roles require Keycloak 13+.",
    }
  }
  return { id }
}

/** Read the default role's current composite children. */
export async function fetchComposites(
  admin: KeycloakAdminClient,
  defaultRoleId: string,
): Promise<KeycloakCompositeRoleRef[]> {
  const res = await admin.get(`/roles-by-id/${encodeURIComponent(defaultRoleId)}/composites`)
  if (!res.ok) return []
  return parseJson<KeycloakCompositeRoleRef[]>(res.body) ?? []
}

/** Resolve a client's internal UUID back to its human clientId (GET /clients/{uuid}). Best-effort. */
async function resolveClientIdByUuid(admin: KeycloakAdminClient, uuid: string): Promise<string | null> {
  const res = await admin.get(`/clients/${encodeURIComponent(uuid)}`)
  if (!res.ok) return null
  const client = parseJson<{ clientId?: string }>(res.body)
  const clientId = client?.clientId ? String(client.clientId).trim() : ''
  return clientId || null
}

/** Resolve every distinct client-role containerId in `composites` to its clientId, once each. */
async function buildClientIdCache(
  admin: KeycloakAdminClient,
  composites: KeycloakCompositeRoleRef[],
): Promise<Map<string, string | null>> {
  const cache = new Map<string, string | null>()
  for (const ref of composites) {
    if (!ref.clientRole) continue
    const containerId = String(ref.containerId ?? '').trim()
    if (!containerId || cache.has(containerId)) continue
    cache.set(containerId, await resolveClientIdByUuid(admin, containerId))
  }
  return cache
}

function projectWithClientIdCache(
  composites: KeycloakCompositeRoleRef[],
  clientIdCache: Map<string, string | null>,
): DefaultRolesProjection {
  const realmRoles: string[] = []
  const clientRoles: Record<string, string[]> = {}

  for (const ref of composites) {
    const name = String(ref.name ?? '').trim()
    if (!name) continue

    if (!ref.clientRole) {
      realmRoles.push(name)
      continue
    }

    const containerId = String(ref.containerId ?? '').trim()
    const clientId = containerId ? clientIdCache.get(containerId) : null
    if (!clientId) continue
    if (!clientRoles[clientId]) clientRoles[clientId] = []
    clientRoles[clientId].push(name)
  }

  return { realmRoles, clientRoles }
}

/**
 * Project the live composite list into the same { realmRoles, clientRoles }
 * shape declared on the canvas, resolving each client-role composite's
 * containerId (client UUID) back to its human clientId.
 */
export async function projectLiveComposites(
  admin: KeycloakAdminClient,
  composites: KeycloakCompositeRoleRef[],
): Promise<DefaultRolesProjection> {
  const clientIdCache = await buildClientIdCache(admin, composites)
  return projectWithClientIdCache(composites, clientIdCache)
}

// --- Composite reconciliation (network; shared by deploy + rollback) ---------

/** Resolve a realm role name to its {id, name} ref, or null when it does not exist. */
async function resolveRealmRoleRef(
  admin: KeycloakAdminClient,
  name: string,
): Promise<KeycloakCompositeRoleRef | null> {
  const res = await admin.get(`/roles/${encodeURIComponent(name)}`)
  if (!res.ok) return null
  const role = parseJson<{ id?: string; name?: string }>(res.body)
  return role?.name ? { id: role.id, name: role.name } : null
}

/** Resolve a client role (by human clientId + role name) to its {id, name} ref, or null. */
async function resolveClientRoleRef(
  admin: KeycloakAdminClient,
  clientId: string,
  roleName: string,
): Promise<KeycloakCompositeRoleRef | null> {
  const client = await resolveClientByClientId(admin, clientId)
  if (!client?.id) return null
  const res = await admin.get(`/clients/${encodeURIComponent(client.id)}/roles/${encodeURIComponent(roleName)}`)
  if (!res.ok) return null
  const role = parseJson<{ id?: string; name?: string }>(res.body)
  return role?.name ? { id: role.id, name: role.name } : null
}

export interface ReconcileDefaultRoleCompositesResult {
  /** The prior composite state, projected — captured by deploy() for rollback. */
  prior: DefaultRolesProjection
  added: number
  removed: number
}

/**
 * Reconcile the default role's composite children to `desired` (authoritative):
 * add the realm/client roles that are missing, remove the ones no longer
 * declared. A declared realm role, client or client role that does not exist is
 * an error. Returns the prior composite state (projected) so a deploy can
 * record it for rollback; a rollback calls this again with the prior state as
 * `desired` to reconcile back toward it.
 */
export async function reconcileDefaultRoleComposites(
  admin: KeycloakAdminClient,
  defaultRoleId: string,
  desired: DefaultRolesProjection,
): Promise<ReconcileDefaultRoleCompositesResult> {
  const current = await fetchComposites(admin, defaultRoleId)
  const clientIdCache = await buildClientIdCache(admin, current)
  const prior = projectWithClientIdCache(current, clientIdCache)

  const toAdd: KeycloakCompositeRoleRef[] = []
  const toRemove: KeycloakCompositeRoleRef[] = []

  // Realm-role composites.
  const desiredRealmSet = new Set(desired.realmRoles)
  for (const name of desired.realmRoles) {
    if (!prior.realmRoles.includes(name)) {
      const ref = await resolveRealmRoleRef(admin, name)
      if (!ref) throw new Error(`realm role "${name}" not found — create it first (see the Realm Roles config type)`)
      toAdd.push(ref)
    }
  }
  for (const ref of current) {
    if (!ref.clientRole && ref.name && !desiredRealmSet.has(String(ref.name).trim())) {
      toRemove.push({ id: ref.id, name: ref.name })
    }
  }

  // Client-role composites.
  for (const [clientId, names] of Object.entries(desired.clientRoles)) {
    const priorNames = prior.clientRoles[clientId] ?? []
    for (const name of names) {
      if (!priorNames.includes(name)) {
        const ref = await resolveClientRoleRef(admin, clientId, name)
        if (!ref) {
          throw new Error(`client role "${name}" on client "${clientId}" not found — the client and role must already exist`)
        }
        toAdd.push(ref)
      }
    }
  }
  for (const ref of current) {
    if (!ref.clientRole || !ref.name) continue
    const containerId = String(ref.containerId ?? '').trim()
    const clientId = containerId ? clientIdCache.get(containerId) : null
    const name = String(ref.name).trim()
    const stillDesired = clientId ? (desired.clientRoles[clientId] ?? []).includes(name) : false
    if (!stillDesired) toRemove.push({ id: ref.id, name: ref.name })
  }

  if (toAdd.length > 0) {
    const res = await admin.post(
      `/roles-by-id/${encodeURIComponent(defaultRoleId)}/composites`,
      toAdd.map((r) => ({ id: r.id, name: r.name })),
    )
    if (!res.ok) throw new Error(`add default-role composites → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  }
  if (toRemove.length > 0) {
    const res = await admin.request(
      'DELETE',
      `/roles-by-id/${encodeURIComponent(defaultRoleId)}/composites`,
      toRemove.map((r) => ({ id: r.id, name: r.name })),
    )
    if (!res.ok) throw new Error(`remove default-role composites → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  }

  return { prior, added: toAdd.length, removed: toRemove.length }
}
