// Network helpers for the Roles config type's permission grants. Kept out of
// _shared.ts so _shared stays pure and unit-testable; these wrap
// lib/datadogApi against /api/v2/permissions and
// /api/v2/roles/{role_id}/permissions.
//
//   GET    /api/v2/permissions                    list every permission Datadog defines
//   GET    /api/v2/roles/{role_id}/permissions     list a role's current grants
//   POST   /api/v2/roles/{role_id}/permissions     grant one permission (body: {data:{id,type:"permissions"}})
//   DELETE /api/v2/roles/{role_id}/permissions     revoke one permission (same body, as a DELETE body)
//
// Verified against https://docs.datadoghq.com/api/latest/roles/.
//
// ADDITIVE-ONLY BY DESIGN: this app GRANTS every declared permission but
// never revokes an undeclared one. Datadog's create-role reference
// documents that "the following read permissions are automatically added to
// every new role, even if they are not included in the request: Dashboards
// Read, Notebooks Read, Monitors Read, APM Read, Vulnerability Management
// Read, RUM Apps Read, Incidents Read, SLOs Read, CI Visibility Read, CD
// Visibility Read" — a full grant/revoke sync (the pattern this app uses for
// Auth0 roles) would fight that baseline set on every deploy: either the
// revoke is rejected (breaking the deploy) or it succeeds and silently
// strips baseline UI read-access Datadog itself considers a role's floor.
// Revoking a permission from a role is left to the Datadog UI directly.

import { datadogErrorMessage, parseJson, type DatadogClient } from '../../lib/datadogApi'
import type { PermissionRef } from './_shared'

interface PermissionResource {
  id?: string
  attributes?: { name?: string; name_aliases?: string[] }
}

const PERMISSIONS_PATH = '/api/v2/permissions'
const rolePermissionsPath = (roleId: string) => `/api/v2/roles/${encodeURIComponent(roleId)}/permissions`

/** List every permission Datadog defines, for resolving a declared permission NAME to its id. */
export async function listAllPermissions(client: DatadogClient): Promise<PermissionRef[]> {
  const res = await client.request('GET', PERMISSIONS_PATH)
  if (!res.ok) throw new Error(`Failed to list permissions: ${datadogErrorMessage(res)}`)
  const parsed = parseJson<{ data?: PermissionResource[] }>(res.body)
  const data = Array.isArray(parsed?.data) ? parsed!.data : []
  return data
    .filter((p): p is PermissionResource & { id: string; attributes: { name: string } } => !!p.id && !!p.attributes?.name)
    .map((p) => ({ id: p.id, name: p.attributes.name, aliases: Array.isArray(p.attributes.name_aliases) ? p.attributes.name_aliases : [] }))
}

/** List a role's current permission grants (ids only). */
export async function listRolePermissionIds(client: DatadogClient, roleId: string): Promise<string[]> {
  const res = await client.request('GET', rolePermissionsPath(roleId))
  if (!res.ok) throw new Error(`Failed to list permissions for role ${roleId}: ${datadogErrorMessage(res)}`)
  const parsed = parseJson<{ data?: Array<{ id?: string }> }>(res.body)
  const data = Array.isArray(parsed?.data) ? parsed!.data : []
  return data.map((p) => p.id).filter((id): id is string => !!id)
}

/** Grant one permission to a role. */
export async function grantPermission(client: DatadogClient, roleId: string, permissionId: string): Promise<void> {
  const res = await client.request('POST', rolePermissionsPath(roleId), { body: { data: { id: permissionId, type: 'permissions' } } })
  if (!res.ok) throw new Error(`Failed to grant permission ${permissionId} to role ${roleId}: ${datadogErrorMessage(res)}`)
}

/** Revoke one permission from a role. Only ever called by rollback, to undo a grant THIS app made. */
export async function revokePermission(client: DatadogClient, roleId: string, permissionId: string): Promise<void> {
  const res = await client.request('DELETE', rolePermissionsPath(roleId), { body: { data: { id: permissionId, type: 'permissions' } } })
  if (!res.ok) throw new Error(`Failed to revoke permission ${permissionId} from role ${roleId}: ${datadogErrorMessage(res)}`)
}

/**
 * Grant every declared permission a role doesn't already have. NEVER revokes
 * anything (see the header comment) — an undeclared permission already on
 * the role (a Datadog baseline default, or one added by a human in the UI)
 * is left untouched. Returns the ids actually granted (for rollback) and the
 * pre-deploy snapshot (for reference).
 */
export async function grantMissingPermissions(
  client: DatadogClient,
  roleId: string,
  desiredIds: string[],
): Promise<{ granted: string[]; currentBefore: string[] }> {
  const currentBefore = await listRolePermissionIds(client, roleId)
  const before = new Set(currentBefore)
  const granted: string[] = []
  for (const id of desiredIds) {
    if (!before.has(id)) {
      await grantPermission(client, roleId, id)
      granted.push(id)
    }
  }
  return { granted, currentBefore }
}
