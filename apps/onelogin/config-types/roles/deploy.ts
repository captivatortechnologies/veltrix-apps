import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOneLoginClient, parseJson, oneLoginErrorMessage, type OneLoginClient } from '../../lib/oneLogin'
import { extractRoleSpecs, type LiveRole } from './validate'

export interface RoleRollbackEntry {
  name: string
  existed: boolean
  id?: number
  /** App ids assigned to the role before this deploy (for a full-replace restore). */
  priorAppIds?: number[]
}

/**
 * Deploy OneLogin roles via the Roles API.
 *
 * ONE item = ONE role, matched on NAME (OneLogin has no upsert):
 *   - list GET  /api/2/roles            (client.getAll, Link-header paginated)
 *   - PUT       /api/2/roles/{id}       - update (OneLogin's Update Role only
 *     accepts `name`; nothing else changes through this call)
 *   - POST      /api/2/roles            - create a missing one (capture the new id)
 * then reconciles the role's assigned apps via the dedicated, FULL-REPLACE
 * endpoint:
 *   - PUT /api/2/roles/{id}/apps  body: [appId, appId, ...] (bare array)
 * always sent for an EXISTING role (even an empty array, to converge a
 * cleared assignment) - only skipped for a brand-new role with no apps
 * declared, since a fresh role starts with none assigned anyway.
 *
 * Never deletes a role absent from this canvas - rollback only reverts what
 * THIS deploy created or changed.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOneLoginClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, domain } = built

  const specs = extractRoleSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: RoleRollbackEntry[] = []
  const createdIds: number[] = []
  const deployed: string[] = []

  try {
    const roles = await listRoles(client)

    for (const spec of specs) {
      const existing = roles.find((r) => r.name === spec.name) ?? null
      let roleId: number

      if (existing?.id) {
        roleId = existing.id
        const priorAppIds = await getRoleApps(client, roleId)
        rollbackState.push({ name: spec.name, existed: true, id: roleId, priorAppIds })

        const res = await client.request('PUT', `/api/2/roles/${roleId}`, { body: { name: spec.name } })
        if (!res.ok) {
          throw new Error(`Failed to update role "${spec.name}": ${oneLoginErrorMessage(res)}`)
        }
        await setRoleApps(client, roleId, spec.appIds, spec.name)
      } else {
        const res = await client.request('POST', '/api/2/roles', { body: { name: spec.name } })
        if (!res.ok) {
          throw new Error(`Failed to create role "${spec.name}": ${oneLoginErrorMessage(res)}`)
        }
        const created = parseJson<LiveRole>(res.body)
        if (!created?.id) {
          throw new Error(`Role "${spec.name}" was created but the API returned no id`)
        }
        roleId = created.id
        createdIds.push(roleId)
        rollbackState.push({ name: spec.name, existed: false, id: roleId })

        if (spec.appIds.length > 0) {
          await setRoleApps(client, roleId, spec.appIds, spec.name)
        }
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} role(s) to OneLogin account ${domain}: ${deployed.join(', ')}`,
      artifacts: { domain, deployedRoles: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Role deployment failed after ${deployed.length} of ${specs.length} role(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { domain, deployedRoles: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/** List every role in the account, following Link-header pagination. */
export async function listRoles(client: OneLoginClient): Promise<LiveRole[]> {
  const res = await client.getAll<LiveRole>('/api/2/roles')
  if (!res.ok) {
    throw new Error(`Failed to list roles: ${oneLoginErrorMessage({ status: res.status, ok: res.ok, body: res.body, linkHeader: null })}`)
  }
  return res.items
}

/**
 * Normalize a OneLogin id-array response: OneLogin's own Set Role Apps
 * response shape is `[{"id":1}, {"id":2}]` (an array of objects), while some
 * list-style endpoints return bare integers - accept either.
 */
export function normalizeIdArray(raw: unknown): number[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((v) => (typeof v === 'number' ? v : typeof v === 'object' && v && 'id' in v ? Number((v as { id: unknown }).id) : NaN))
    .filter((n) => Number.isInteger(n))
}

/** GET /api/2/roles/{id}/apps - the role's current assigned app ids. */
export async function getRoleApps(client: OneLoginClient, roleId: number): Promise<number[]> {
  const res = await client.request('GET', `/api/2/roles/${roleId}/apps`)
  if (!res.ok) return []
  return normalizeIdArray(parseJson<unknown>(res.body))
}

/** PUT /api/2/roles/{id}/apps - full replace of the role's assigned apps. */
export async function setRoleApps(client: OneLoginClient, roleId: number, appIds: number[], roleName: string): Promise<void> {
  const res = await client.request('PUT', `/api/2/roles/${roleId}/apps`, { body: appIds })
  if (!res.ok) {
    throw new Error(`Failed to set assigned apps for role "${roleName}": ${oneLoginErrorMessage(res)}`)
  }
}
