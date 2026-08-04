import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildDatadogClient, datadogErrorMessage, parseJson, type DatadogClient } from '../../lib/datadogApi'
import { buildRoleBody, extractRoleSpecs, resolvePermissionIds, roleKey, toCreatePayload, toUpdatePayload, type RoleResource } from './_shared'
import { grantMissingPermissions, listAllPermissions } from './permissions'

/**
 * Deploy Roles via GET/POST/PATCH/DELETE /api/v2/roles[/{role_id}] plus the
 * permissions relationship sub-resource:
 *   https://docs.datadoghq.com/api/latest/roles/
 *
 * Identity is the role NAME (case-insensitive). Live roles are listed,
 * matched by name, and:
 *   - a match is UPDATED (PATCH, name only); its prior name is captured for
 *     rollback first.
 *   - no match is CREATED (POST, bare — name only); the id is recorded so
 *     rollback can delete it.
 * Either way, every declared permission the role doesn't already have is
 * then GRANTED (ADDITIVE ONLY — never revokes an undeclared permission; see
 * permissions.ts for why). The ids actually granted are recorded so rollback
 * can revoke exactly those and nothing else. Declared permission NAMES are
 * resolved to Datadog's opaque permission ids via GET /api/v2/permissions;
 * an unrecognized name fails the whole deploy with a clear error rather than
 * being silently dropped.
 */
export interface RoleRollbackEntry {
  key: string
  label: string
  existed: boolean
  id: string
  priorName?: string
  /** Permission ids THIS deploy granted — rollback revokes exactly these. */
  grantedPermissionIds: string[]
}

const ROLES_PATH = '/api/v2/roles'
const PAGE_SIZE = 100
const MAX_PAGES = 50

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildDatadogClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractRoleSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: RoleRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const [existingRoles, allPermissions] = await Promise.all([listRoles(client), listAllPermissions(client)])
    const byKey = new Map(existingRoles.filter((r) => r.attributes?.name).map((r) => [roleKey(r.attributes!.name as string), r]))

    for (const spec of specs) {
      const label = spec.name
      const key = roleKey(spec.name)

      const { ids: desiredIds, unknown } = resolvePermissionIds(allPermissions, spec.permissionNames)
      if (unknown.length > 0) {
        throw new Error(
          `Role "${label}": unrecognized permission name(s): ${unknown.join(', ')} — check GET /api/v2/permissions for valid names`,
        )
      }

      const live = byKey.get(key)
      let roleId: string

      if (live && live.id) {
        roleId = live.id
        const priorName = live.attributes?.name ?? label
        const res = await client.request('PATCH', `${ROLES_PATH}/${encodeURIComponent(roleId)}`, {
          body: toUpdatePayload(roleId, buildRoleBody(spec)),
        })
        if (!res.ok) throw new Error(`Failed to update role "${label}": ${datadogErrorMessage(res)}`)

        const { granted } = await grantMissingPermissions(client, roleId, desiredIds)
        rollbackState.push({ key, label, existed: true, id: roleId, priorName, grantedPermissionIds: granted })
      } else {
        const res = await client.request('POST', ROLES_PATH, { body: toCreatePayload(buildRoleBody(spec)) })
        if (!res.ok) throw new Error(`Failed to create role "${label}": ${datadogErrorMessage(res)}`)
        const created = parseJson<{ data?: RoleResource }>(res.body)
        const id = created?.data?.id
        if (!id) throw new Error(`Role "${label}" was created but Datadog returned no id`)
        roleId = id
        createdIds.push(id)

        const { granted } = await grantMissingPermissions(client, roleId, desiredIds)
        rollbackState.push({ key, label, existed: false, id: roleId, grantedPermissionIds: granted })
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Role(s) to ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedRoles: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Role deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedRoles: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers (shared with rollback / healthCheck / driftDetect) --------------

export async function listRoles(client: DatadogClient): Promise<RoleResource[]> {
  const all: RoleResource[] = []
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await client.request('GET', ROLES_PATH, { query: { 'page[size]': PAGE_SIZE, 'page[number]': page } })
    if (!res.ok) throw new Error(`Failed to list Roles: ${datadogErrorMessage(res)}`)
    const parsed = parseJson<{ data?: RoleResource[] }>(res.body)
    const batch = Array.isArray(parsed?.data) ? (parsed?.data as RoleResource[]) : []
    if (batch.length === 0) break
    all.push(...batch)
    if (batch.length < PAGE_SIZE) break
  }
  return all
}
