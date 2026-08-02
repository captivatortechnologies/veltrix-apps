// Network helpers for the role permissions sub-resource of the Auth0 Roles config
// type. Kept out of _shared.ts so _shared stays pure and unit-testable; these
// wrap lib/auth0Api against /api/v2/roles/{id}/permissions.
//
//   GET    /api/v2/roles/{id}/permissions   list grants (paginated)
//   POST   /api/v2/roles/{id}/permissions   associate grants
//   DELETE /api/v2/roles/{id}/permissions   remove grants
//
// Verified against the official Auth0 Management API v2 (Roles → permissions).

import { getJson, sendJson } from '../../lib/auth0Api'
import { diffPermissions, normalizePermissions, type Auth0Permission } from './_shared'

/** Read every permission grant on a role (paginated, best-effort). */
export async function getRolePermissions(base: string, roleId: string, token: string): Promise<Auth0Permission[]> {
  const perPage = 100
  const all: Auth0Permission[] = []
  for (let page = 0; page < 50; page++) {
    const url = `${base}/roles/${encodeURIComponent(roleId)}/permissions?per_page=${perPage}&page=${page}`
    const batch = await getJson<Auth0Permission[]>(url, token)
    if (!Array.isArray(batch) || batch.length === 0) break
    all.push(...batch)
    if (batch.length < perPage) break
  }
  return normalizePermissions(all)
}

/** Associate permission grants with a role (POST). No-op when the list is empty. */
export async function addRolePermissions(base: string, roleId: string, token: string, permissions: Auth0Permission[]): Promise<void> {
  if (permissions.length === 0) return
  await sendJson('POST', `${base}/roles/${encodeURIComponent(roleId)}/permissions`, token, { permissions })
}

/** Remove permission grants from a role (DELETE with body). No-op when the list is empty. */
export async function removeRolePermissions(base: string, roleId: string, token: string, permissions: Auth0Permission[]): Promise<void> {
  if (permissions.length === 0) return
  await sendJson('DELETE', `${base}/roles/${encodeURIComponent(roleId)}/permissions`, token, { permissions })
}

/**
 * Reconcile a role's live permission grants to `desired`: read current, add the
 * missing grants and remove the extra ones. Returns the counts applied.
 */
export async function reconcileRolePermissions(
  base: string,
  roleId: string,
  token: string,
  desired: Auth0Permission[],
): Promise<{ added: number; removed: number }> {
  const current = await getRolePermissions(base, roleId, token)
  const { toAdd, toRemove } = diffPermissions(desired, current)
  await addRolePermissions(base, roleId, token, toAdd)
  await removeRolePermissions(base, roleId, token, toRemove)
  return { added: toAdd.length, removed: toRemove.length }
}
