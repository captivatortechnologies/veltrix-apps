// =============================================================================
// Shared displayName -> id maps and id-aware value resolution for the Phase-2
// batch-1 config types (directory-role-assignments, pim-role-eligibility,
// pim-role-management-policies, administrative-units).
//
// Mirrors the id-aware resolver pattern conditional-access-policies
// established: a live picker stores a Graph object id directly, so a value
// that already looks like one passes straight through with NO Graph call; a
// hand-typed display name (the pre-picker convention, still valid for a
// canvas saved before a field's picker existed) falls back to a live
// displayName -> id map built once per deploy/drift run.
//
// This is a DELIBERATE, separate copy of the same small mechanics
// conditional-access-policies/deploy.ts already has (buildGroupNameToId,
// buildUserNameToId, resolveTargets, ...) rather than an import from that
// sibling config type: config types in this app are independently deployed
// pipelines, and reaching into another config type's deploy.ts would couple
// their release/maintenance together for no real benefit. See the Phase-2
// batch-1 report for this call-out.
// =============================================================================

import type { GraphClient } from '../../lib/graph'

/** A Graph object id — the shape every live picker in this batch stores as a field's value. */
export const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

export function isGuid(v: string): boolean {
  return GUID_RE.test(v)
}

/** Build a case-insensitive displayName -> id map from a simple `{id, displayName}` Graph collection. */
async function nameToIdMap(client: GraphClient, path: string): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const listed = await client.getAll<{ id?: string; displayName?: string }>(path)
  if (listed.ok) {
    for (const r of listed.items) {
      if (r.id && r.displayName) map.set(r.displayName.toLowerCase(), r.id)
    }
  }
  return map
}

/** roleManagement/directory/roleDefinitions displayName -> id (built-in roles' id IS their roleTemplateId). */
export function buildRoleNameToId(client: GraphClient): Promise<Map<string, string>> {
  return nameToIdMap(client, '/roleManagement/directory/roleDefinitions?$select=id,displayName')
}

/** groups displayName -> id (the object id principalId / AU membership expects). */
export function buildGroupNameToId(client: GraphClient): Promise<Map<string, string>> {
  return nameToIdMap(client, '/groups?$select=id,displayName')
}

/** servicePrincipals displayName -> id (object id, NOT appId — see entraOptions.ts header). */
export function buildServicePrincipalNameToId(client: GraphClient): Promise<Map<string, string>> {
  return nameToIdMap(client, '/servicePrincipals?$select=id,displayName')
}

/** devices displayName -> id (an administrative unit's third member kind, alongside users/groups). */
export function buildDeviceNameToId(client: GraphClient): Promise<Map<string, string>> {
  return nameToIdMap(client, '/devices?$select=id,displayName')
}

/** directory/administrativeUnits displayName -> id (for the "/administrativeUnits/{id}" directoryScopeId pattern). */
export function buildAdministrativeUnitNameToId(client: GraphClient): Promise<Map<string, string>> {
  return nameToIdMap(client, '/directory/administrativeUnits?$select=id,displayName')
}

/**
 * applications displayName -> OBJECT id (Graph's `id`, never `appId`) — for
 * the "/{application-objectID}" directoryScopeId pattern. See
 * config-types/lib/directoryScope.ts and the entraOptions.ts header for why
 * this is a distinct id space from the `applications` picker source.
 */
export function buildApplicationObjectNameToId(client: GraphClient): Promise<Map<string, string>> {
  return nameToIdMap(client, '/applications?$select=id,displayName')
}

/** Build a case-insensitive user displayName/UPN -> id map from the live directory. */
export async function buildUserNameToId(client: GraphClient): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const listed = await client.getAll<{ id?: string; displayName?: string; userPrincipalName?: string }>(
    '/users?$select=id,displayName,userPrincipalName'
  )
  if (listed.ok) {
    for (const u of listed.items) {
      if (!u.id) continue
      if (u.displayName) map.set(u.displayName.toLowerCase(), u.id)
      if (u.userPrincipalName) map.set(u.userPrincipalName.toLowerCase(), u.id)
    }
  }
  return map
}

/**
 * Single-value GUID-or-name resolve: a picker-selected id passes straight
 * through (no Graph lookup); a hand-typed display name resolves via the live
 * map; an empty value is "unset" (not missing) so callers can distinguish
 * "not provided" from "provided but unresolvable".
 */
export function resolveRef(value: string, nameToId: Map<string, string>): { id: string; missing: boolean } {
  const v = (value ?? '').trim()
  if (!v) return { id: '', missing: false }
  if (isGuid(v)) return { id: v, missing: false }
  const id = nameToId.get(v.toLowerCase())
  return id ? { id, missing: false } : { id: '', missing: true }
}

/** Batch form of resolveRef, for a multiselect field against a single map. */
export function resolveRefs(values: string[], nameToId: Map<string, string>): { ids: string[]; missing: string[] } {
  const ids: string[] = []
  const missing: string[] = []
  for (const v of values) {
    const r = resolveRef(v, nameToId)
    if (r.missing) missing.push(v)
    else if (r.id) ids.push(r.id)
  }
  return { ids, missing }
}

/**
 * Single-value GUID-or-name resolve across SEVERAL maps, tried in the given
 * order (first match wins) — for a field whose picker merges more than one
 * Graph collection (e.g. "directoryPrincipals" = users + groups + service
 * principals). A name that collides across kinds resolves to whichever map
 * is checked first; pick the entry from the live picker to avoid the
 * ambiguity entirely (its value is always the correct, unambiguous id).
 */
export function resolveAcrossMaps(value: string, maps: Array<Map<string, string>>): { id: string; missing: boolean } {
  const v = (value ?? '').trim()
  if (!v) return { id: '', missing: false }
  if (isGuid(v)) return { id: v, missing: false }
  const lower = v.toLowerCase()
  for (const m of maps) {
    const id = m.get(lower)
    if (id) return { id, missing: false }
  }
  return { id: '', missing: true }
}

/** Batch form of resolveAcrossMaps, for a multiselect field. */
export function resolveAcrossMapsMany(
  values: string[],
  maps: Array<Map<string, string>>
): { ids: string[]; missing: string[] } {
  const ids: string[] = []
  const missing: string[] = []
  for (const v of values) {
    const r = resolveAcrossMaps(v, maps)
    if (r.missing) missing.push(v)
    else if (r.id) ids.push(r.id)
  }
  return { ids, missing }
}
