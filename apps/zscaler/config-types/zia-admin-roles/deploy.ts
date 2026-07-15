import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildZscalerClient,
  parseJson,
  zscalerErrorMessage,
  type ZscalerClient,
} from '../../lib/zscaler'
import {
  extractAdminRoleSpecs,
  parseRoleObject,
  type AdminRoleSpec,
  type LiveAdminRole,
} from './validate'

export interface AdminRoleRollbackEntry {
  name: string
  existed: boolean
  id?: number
  /** The full prior live object, PUT back verbatim on rollback of an update. */
  prior?: LiveAdminRole
}

/**
 * Deploy ZIA admin roles via the Zscaler OneAPI.
 *
 * Identity is the NAME (ZIA has no upsert): list /adminRoles, match by name,
 * then PUT an existing role or POST a new one. ZIA STAGES every write — nothing
 * takes effect until activation — so this writes all roles, then calls
 * activate() ONCE at the end. If activation fails the writes remain staged and
 * rollbackData is returned so the platform can revert them.
 *
 * BUILT-IN (predefined) admin roles are read-only: if a name matches a live role
 * whose `isNameL10nTag` is true, deploy throws so the author renames rather than
 * attempting to overwrite a built-in. Built-ins are never deleted.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, vanity } = built

  const specs = extractAdminRoleSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: AdminRoleRollbackEntry[] = []
  const createdIds: number[] = []
  const deployed: string[] = []

  try {
    const existing = await listAdminRoles(client)
    const byName = new Map(existing.filter((r) => r.name).map((r) => [r.name as string, r]))

    for (const spec of specs) {
      const live = byName.get(spec.name)

      if (live && live.isNameL10nTag === true) {
        throw new Error(
          `"${spec.name}" is a built-in admin role and cannot be modified — rename your role to manage a custom one`,
        )
      }

      if (live && live.id != null) {
        rollbackState.push({ name: spec.name, existed: true, id: live.id, prior: live })
        const res = await client.zia('PUT', `/adminRoles/${live.id}`, { body: buildAdminRolePayload(spec) })
        if (!res.ok) {
          throw new Error(`Failed to update admin role "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
      } else {
        const res = await client.zia('POST', '/adminRoles', { body: buildAdminRolePayload(spec) })
        if (!res.ok) {
          throw new Error(`Failed to create admin role "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
        const created = parseJson<LiveAdminRole>(res.body)
        if (created?.id == null) {
          throw new Error(`Admin role "${spec.name}" was created but the API returned no id`)
        }
        rollbackState.push({ name: spec.name, existed: false, id: created.id })
        createdIds.push(created.id)
      }

      deployed.push(spec.name)
    }

    // ZIA changes are staged — push them to production once, after all writes.
    const act = await client.activate()
    if (!act.ok) {
      return {
        success: false,
        message: `Staged ${deployed.length} ZIA admin role(s) but activation failed: ${zscalerErrorMessage(
          act,
        )}. The changes are saved but not active — re-run to retry activation.`,
        artifacts: { vanity, deployedRoles: deployed },
        rollbackData: { previousState: rollbackState, createdIds },
      }
    }

    return {
      success: true,
      message: `Deployed and activated ${deployed.length} ZIA admin role(s) on tenant "${vanity}": ${deployed.join(
        ', ',
      )}`,
      artifacts: { vanity, deployedRoles: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Admin role deployment failed after ${deployed.length} of ${specs.length} role(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { vanity, deployedRoles: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/**
 * List all ZIA admin roles; throws on a non-OK response.
 *
 * /adminRoles returns a plain (unpaged) array. ziaGetAll appends page/pageSize
 * query params and follows pages, which works for most collections but can come
 * back empty or non-array for this endpoint's shape — so when the paged read
 * yields nothing, fall back to a direct GET and parse the array. The full
 * objects are needed (not /adminRoles/lite) to read `isNameL10nTag`.
 */
export async function listAdminRoles(client: ZscalerClient): Promise<LiveAdminRole[]> {
  const res = await client.ziaGetAll<LiveAdminRole>('/adminRoles')
  if (res.ok && res.items.length > 0) return res.items

  const direct = await client.zia('GET', '/adminRoles')
  if (direct.ok) {
    const parsed = parseJson<LiveAdminRole[]>(direct.body)
    if (Array.isArray(parsed)) return parsed
  }

  if (!res.ok) {
    throw new Error(
      `Failed to list admin roles: ${zscalerErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  if (!direct.ok) {
    throw new Error(`Failed to list admin roles: ${zscalerErrorMessage(direct)}`)
  }
  return []
}

/** Find an admin role by name; null when absent. */
export async function findAdminRole(client: ZscalerClient, name: string): Promise<LiveAdminRole | null> {
  const all = await listAdminRoles(client)
  return all.find((r) => r.name === name) ?? null
}

function buildAdminRolePayload(spec: AdminRoleSpec): Record<string, unknown> {
  const roleJson = spec.roleJson ? parseRoleObject(spec.roleJson) ?? {} : {}
  // Advanced permissionsAccess maps come from role_json; name and rank are the
  // first-class fields and always win over any same-named JSON keys.
  return { ...roleJson, name: spec.name, rank: spec.rank }
}
