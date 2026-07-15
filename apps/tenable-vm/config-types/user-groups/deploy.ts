import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildTenableClient,
  parseJson,
  tenableErrorMessage,
  type TenableClient,
} from '../../lib/tenable'
import { extractUserGroupSpecs, type LiveUserGroup, type UserGroupSpec } from './validate'

export interface UserGroupRollbackEntry {
  name: string
  existed: boolean
  /** Numeric group id — the stable key rollback deletes/restores on. */
  id?: number
  prior?: { name?: string }
}

/**
 * Deploy user groups to a Tenable tenant via the Groups API.
 *
 * A user group is identified by an int `id` (also a `uuid`); its NAME is the
 * logical identity. This config type manages the NAME ONLY — membership is
 * handled by separate endpoints and is never touched here. For each declared
 * group:
 *   - GET  /groups            — list, then match on name
 *   - PUT  /groups/{id}       — reconcile an existing group (capture prior name)
 *   - POST /groups            — create a missing group (capture the new id)
 *
 * The name is both the identity and the only managed attribute, so when a group
 * is found by name it is already correct; the PUT is an idempotent reconcile and
 * exists mainly so the group is recorded as PRE-EXISTING (so rollback restores
 * rather than deletes it). A canvas rename does not match the old group, so it
 * is created anew under the new name and the old group is left intact.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractUserGroupSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: UserGroupRollbackEntry[] = []
  const createdIds: number[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await findUserGroup(client, spec.name)

      if (existing && existing.id != null) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: existing.id,
          prior: { name: existing.name },
        })

        const res = await client.request('PUT', `/groups/${existing.id}`, {
          body: { name: spec.name },
        })
        if (!res.ok) {
          throw new Error(`Failed to update user group "${spec.name}": ${tenableErrorMessage(res)}`)
        }
      } else {
        const res = await client.request('POST', '/groups', { body: { name: spec.name } })
        if (!res.ok) {
          throw new Error(`Failed to create user group "${spec.name}": ${tenableErrorMessage(res)}`)
        }
        const created = parseJson<LiveUserGroup>(res.body)
        if (created?.id == null) {
          throw new Error(`User group "${spec.name}" was created but the API returned no group id`)
        }
        rollbackState.push({ name: spec.name, existed: false, id: created.id })
        createdIds.push(created.id)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} user group(s) to Tenable tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedUserGroups: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `User group deployment failed after ${deployed.length} of ${specs.length} group(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedUserGroups: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/**
 * Find a user group by its name; null when absent.
 * GET /groups returns the full group list for the tenant.
 */
export async function findUserGroup(
  client: TenableClient,
  name: string,
): Promise<LiveUserGroup | null> {
  const res = await client.request('GET', '/groups')
  if (!res.ok) {
    throw new Error(`Failed to list user groups while resolving "${name}": ${tenableErrorMessage(res)}`)
  }
  const groups = parseJson<{ groups?: LiveUserGroup[] }>(res.body)?.groups ?? []
  // The name is the logical key — match it exactly (case-sensitive).
  return groups.find((g) => g.name === name) ?? null
}
