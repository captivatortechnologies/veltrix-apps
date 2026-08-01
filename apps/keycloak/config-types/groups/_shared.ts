// Shared helpers for the Keycloak Groups config type (deploy + rollback + drift).
//
// Groups follow the Keycloak Admin REST API GroupRepresentation
// (/admin/realms/{realm}/groups). This config type manages TOP-LEVEL groups only —
// the group NAME is the identity and, for a top-level group, its path is derived
// (`/{name}`). Sub-groups (POST /groups/{id}/children) are deferred to a later wave.
//
// Two Keycloak facts shape the helpers below:
//   - attributes are a Map<String, List<String>>. The canvas keyvalue control emits
//     a Map<String,String>, so each value is wrapped as a single-element list. This
//     config type therefore manages single-valued attributes.
//   - realmRoles on GroupRepresentation are NOT persisted by create/update; realm
//     role mappings live behind the dedicated role-mappings endpoint
//     (POST/GET/DELETE /admin/realms/{realm}/groups/{id}/role-mappings/realm), so
//     they are reconciled separately after the group body is written.
//
// Verified against the official Keycloak Admin REST API
// (www.keycloak.org/docs-api/latest/rest-api — "Groups" and "Role Mapper").

import { readKeyValueMap, readString, readStringArray } from '../../lib/fields'
import { parseJson } from '../../lib/keycloakApi'
import type { KeycloakAdminClient } from '../../lib/keycloakApi'

/** A Keycloak group as returned by GET /admin/realms/{realm}/groups. */
export interface KeycloakGroupRep {
  /** Internal UUID — the {id} path segment for GET/PUT/DELETE .../groups/{id}. */
  id?: string
  /** The group name — this config type's identity (top-level groups only). */
  name?: string
  /** Derived server-side for a top-level group (`/{name}`); never authored here. */
  path?: string
  attributes?: Record<string, string[]>
  realmRoles?: string[]
  subGroups?: KeycloakGroupRep[]
  [key: string]: unknown
}

/** A realm role reference as returned by the role-mappings and roles endpoints. */
export interface KeycloakRoleRef {
  id?: string
  name?: string
  [key: string]: unknown
}

/** The top-level group path Keycloak derives from a name. */
export function topLevelPath(name: string): string {
  return `/${name}`
}

/** Find a top-level group by its exact name (the stable identity). */
export function findGroupByName(groups: KeycloakGroupRep[], name: string): KeycloakGroupRep | null {
  const target = name.trim()
  if (!target) return null
  return groups.find((g) => String(g.name ?? '').trim() === target) ?? null
}

/** Wrap a flat keyvalue map into Keycloak's Map<String, List<String>> shape. */
export function attributesFromKeyValue(map: Record<string, string>): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [key, value] of Object.entries(map)) out[key] = [value]
  return out
}

/** Flatten Keycloak's Map<String, List<String>> attributes to a first-value map. */
export function singleValuedAttributes(attrs: Record<string, string[]> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!attrs) return out
  for (const [key, list] of Object.entries(attrs)) {
    if (Array.isArray(list) && list.length > 0) out[key] = String(list[0])
  }
  return out
}

/**
 * Build the GroupRepresentation body from canvas fields. `base` (the existing live
 * group, when updating) is spread first so Keycloak-managed fields we do not author
 * (subGroups, access, …) survive an update. realmRoles are handled separately by
 * the role-mappings reconciler, so they are not written into this body.
 */
export function buildGroupRep(fields: Record<string, unknown>, base?: KeycloakGroupRep): KeycloakGroupRep {
  const rep: KeycloakGroupRep = {
    ...(base ?? {}),
    name: readString(fields.name),
    attributes: attributesFromKeyValue(readKeyValueMap(fields.attributes)),
  }
  return rep
}

/** The fields this config type declares, projected for drift comparison. */
export interface GroupProjection {
  attributes: Record<string, string>
  realmRoles: string[]
}

export function projectFromFields(fields: Record<string, unknown>): GroupProjection {
  return {
    attributes: readKeyValueMap(fields.attributes),
    realmRoles: readStringArray(fields.realmRoles),
  }
}

export function projectAttributesFromLive(group: KeycloakGroupRep): Record<string, string> {
  return singleValuedAttributes(group.attributes)
}

// --- Realm role-mapping reconciliation (network) -----------------------------
// Shared by deploy (apply desired state) and rollback (restore prior state).

/** Read the realm role NAMES currently mapped to a group. Best-effort ([] on error). */
export async function fetchGroupRealmRoleNames(admin: KeycloakAdminClient, groupId: string): Promise<string[]> {
  const res = await admin.get(`/groups/${encodeURIComponent(groupId)}/role-mappings/realm`)
  if (!res.ok) return []
  const roles = parseJson<KeycloakRoleRef[]>(res.body) ?? []
  return roles.map((r) => String(r.name ?? '').trim()).filter(Boolean)
}

/** Resolve a realm role name to its {id, name} ref, or null when it does not exist. */
async function resolveRealmRole(admin: KeycloakAdminClient, name: string): Promise<KeycloakRoleRef | null> {
  const res = await admin.get(`/roles/${encodeURIComponent(name)}`)
  if (!res.ok) return null
  const role = parseJson<KeycloakRoleRef>(res.body)
  return role && role.name ? { id: role.id, name: role.name } : null
}

/**
 * Reconcile a group's realm role mappings to exactly `desired` (authoritative
 * desired-state): add the roles that are missing, remove the ones no longer
 * declared. A declared role that does not exist in the realm is an error — create
 * it first (see the realm-roles config type). Returns the prior set of role names
 * so a deploy can record it for rollback.
 */
export async function reconcileRealmRoles(
  admin: KeycloakAdminClient,
  groupId: string,
  desired: string[],
): Promise<{ priorNames: string[]; added: string[]; removed: string[] }> {
  const currentRes = await admin.get(`/groups/${encodeURIComponent(groupId)}/role-mappings/realm`)
  const current: KeycloakRoleRef[] = currentRes.ok ? parseJson<KeycloakRoleRef[]>(currentRes.body) ?? [] : []
  const currentNames = current.map((r) => String(r.name ?? '').trim()).filter(Boolean)
  const desiredSet = new Set(desired)
  const currentSet = new Set(currentNames)

  const toAddNames = desired.filter((n) => !currentSet.has(n))
  const toRemove = current.filter((r) => r.name && !desiredSet.has(String(r.name).trim()))

  if (toAddNames.length > 0) {
    const refs: KeycloakRoleRef[] = []
    for (const name of toAddNames) {
      const ref = await resolveRealmRole(admin, name)
      if (!ref) {
        throw new Error(`realm role "${name}" not found — create it first (see the realm-roles config type)`)
      }
      refs.push(ref)
    }
    const res = await admin.post(`/groups/${encodeURIComponent(groupId)}/role-mappings/realm`, refs)
    if (!res.ok) throw new Error(`add realm roles → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  }

  if (toRemove.length > 0) {
    const res = await admin.request(
      'DELETE',
      `/groups/${encodeURIComponent(groupId)}/role-mappings/realm`,
      toRemove.map((r) => ({ id: r.id, name: r.name })),
    )
    if (!res.ok) throw new Error(`remove realm roles → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  }

  return {
    priorNames: currentNames,
    added: toAddNames,
    removed: toRemove.map((r) => String(r.name ?? '').trim()).filter(Boolean),
  }
}
