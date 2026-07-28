import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildFalconClient,
  falconErrorMessage,
  falconFailure,
  parseEnvelope,
  type FalconClient,
} from '../../lib/falcon'
import {
  bindingLabel,
  extractRoleMappingSpecs,
  partitionRoles,
  type LiveRole,
} from './validate'

// =============================================================================
// Deploy MSSP (Flight Control) role mappings.
//
// REQUIRES PARENT-CID CREDENTIALS: the Flight Control API is only available to
// the parent CID of an MSSP tenant, and the API client must carry the "Flight
// Control (MSSP)" scope. On a non-MSSP tenant every call returns 403.
//
// A role mapping binds a user group ↔ a CID group ↔ a set of role ids:
//   - GET    /mssp/queries/mssp-roles/v1?user_group_id=…&cid_group_id=…  find the binding
//   - GET    /mssp/entities/mssp-roles/v1?ids=<ug>:<cg>                  read its role ids
//   - POST   /mssp/entities/mssp-roles/v1   grant  {user_group_id, cid_group_id, role_ids}
//   - DELETE /mssp/entities/mssp-roles/v1   revoke {user_group_id, cid_group_id, role_ids}
//
// GOTCHA — the grant (POST addRole) is ADDITIVE: it only adds the role_ids in
// the body and never revokes roles already present. So converging to EXACTLY
// the declared set means diffing the declared role ids against the live set and
// EXPLICITLY revoking (DELETE) the extras. This deploy adds the missing roles
// and revokes the extra roles, recording both deltas so rollback reverses them.
// There is no PATCH on this collection (create/read/delete only).
// =============================================================================

export const MSSP_ROLES_QUERY = '/mssp/queries/mssp-roles/v1'
export const MSSP_ROLES_ENTITY = '/mssp/entities/mssp-roles/v1'

/** Role deltas this deploy applied to one binding, so rollback can reverse them. */
export interface RoleMappingRollbackEntry {
  userGroupId: string
  cidGroupId: string
  /** Whether the binding already had any roles before this deploy. */
  existed: boolean
  /** The full role-id set the binding had before this deploy (for reference). */
  previousRoleIds: string[]
  /** Role ids this deploy granted. */
  added: string[]
  /** Role ids this deploy revoked. */
  revoked: string[]
}

/**
 * Deploy role mappings. For each declared binding, read the live role ids and
 * converge to exactly the declared set — grant the missing ids, revoke the
 * extras (the grant is additive, so extras must be revoked explicitly).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractRoleMappingSpecs(ctx.canvas).filter((s) => s.userGroupId && s.cidGroupId)
  const rollbackState: RoleMappingRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const live = await getLiveRoles(client, spec.userGroupId, spec.cidGroupId)
      const { toAdd, toRevoke } = partitionRoles(spec.roleIds, live.roleIds)

      // Record the intended deltas before mutating so a partially-applied
      // convergence still rolls back exactly what it touched.
      rollbackState.push({
        userGroupId: spec.userGroupId,
        cidGroupId: spec.cidGroupId,
        existed: live.exists,
        previousRoleIds: live.roleIds,
        added: toAdd,
        revoked: toRevoke,
      })

      await addRoles(client, spec.userGroupId, spec.cidGroupId, toAdd)
      await revokeRoles(client, spec.userGroupId, spec.cidGroupId, toRevoke)

      deployed.push(bindingLabel(spec.userGroupId, spec.cidGroupId))
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} MSSP role mapping(s) to Falcon tenant at ${baseUrl}: ${deployed.join('; ')}`,
      artifacts: { baseUrl, deployedMappings: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `MSSP role mapping deployment failed after ${deployed.length} of ${specs.length} mapping(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedMappings: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers ---

/** Encode an id list into the path — the FalconClient serializer can't repeat `ids=`. */
function idsPath(base: string, ids: string[]): string {
  const qs = ids.map((id) => `ids=${encodeURIComponent(id)}`).join('&')
  return qs ? `${base}?${qs}` : base
}

/** Flatten role ids off role resources — tolerates singular `role_id` or `role_ids[]`. */
export function collectRoleIds(resources: LiveRole[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const push = (value: unknown): void => {
    if (typeof value === 'string' && value && !seen.has(value)) {
      seen.add(value)
      out.push(value)
    }
  }
  for (const resource of resources) {
    if (Array.isArray(resource.role_ids)) resource.role_ids.forEach(push)
    push(resource.role_id)
  }
  return out
}

export interface LiveRoleMapping {
  /** True when the binding has any role assigned in the tenant. */
  exists: boolean
  /** The live role ids on the binding. */
  roleIds: string[]
  /** First live role resource (best-effort source for drift attribution). */
  resource?: LiveRole
}

/**
 * Read the live role ids for a (user group, CID group) binding. Queries the
 * binding's link id(s), then reads the role resources to flatten the role ids.
 */
export async function getLiveRoles(
  client: FalconClient,
  userGroupId: string,
  cidGroupId: string,
): Promise<LiveRoleMapping> {
  const queryRes = await client.request('GET', MSSP_ROLES_QUERY, {
    query: { user_group_id: userGroupId, cid_group_id: cidGroupId, limit: 500 },
  })
  if (!queryRes.ok) {
    throw new Error(
      `Failed to search role mapping (${bindingLabel(userGroupId, cidGroupId)}): ${falconErrorMessage(queryRes)}`,
    )
  }
  const linkIds = (parseEnvelope<string>(queryRes.body)?.resources ?? []).filter(
    (id): id is string => typeof id === 'string',
  )
  if (linkIds.length === 0) return { exists: false, roleIds: [] }

  const getRes = await client.request('GET', idsPath(MSSP_ROLES_ENTITY, linkIds))
  if (!getRes.ok) {
    throw new Error(
      `Failed to read role mapping (${bindingLabel(userGroupId, cidGroupId)}): ${falconErrorMessage(getRes)}`,
    )
  }
  const resources = parseEnvelope<LiveRole>(getRes.body)?.resources ?? []
  return { exists: true, roleIds: collectRoleIds(resources), resource: resources[0] }
}

/** Grant role ids on a binding (additive). No-op for an empty list. */
export async function addRoles(
  client: FalconClient,
  userGroupId: string,
  cidGroupId: string,
  roleIds: string[],
): Promise<void> {
  if (roleIds.length === 0) return
  const res = await client.request('POST', MSSP_ROLES_ENTITY, {
    body: { resources: [{ user_group_id: userGroupId, cid_group_id: cidGroupId, role_ids: roleIds }] },
  })
  const failure = falconFailure(res)
  if (failure) {
    throw new Error(`Failed to grant role(s) for mapping (${bindingLabel(userGroupId, cidGroupId)}): ${failure}`)
  }
}

/** Revoke role ids from a binding. No-op for an empty list. */
export async function revokeRoles(
  client: FalconClient,
  userGroupId: string,
  cidGroupId: string,
  roleIds: string[],
): Promise<void> {
  if (roleIds.length === 0) return
  const res = await client.request('DELETE', MSSP_ROLES_ENTITY, {
    body: { resources: [{ user_group_id: userGroupId, cid_group_id: cidGroupId, role_ids: roleIds }] },
  })
  const failure = falconFailure(res)
  if (failure) {
    throw new Error(`Failed to revoke role(s) for mapping (${bindingLabel(userGroupId, cidGroupId)}): ${failure}`)
  }
}
