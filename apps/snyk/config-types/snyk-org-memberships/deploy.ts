import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient, restResult, snykErrorMessage, type SnykClient } from '../../lib/snyk'
import { extractMembershipSpecs, membershipKey, type LiveMembership } from './validate'

export interface MembershipRollbackEntry {
  key: string
  userId: string
  existed: boolean
  /** Id of the live membership (set whether created or updated). */
  membershipId?: string
  /** The role id this user held before this deploy (only when the membership already existed). */
  priorRoleId?: string
}

/**
 * Deploy Snyk org memberships via the REST API.
 *
 * Identity is the user id: list /orgs/{org_id}/memberships, match on the
 * target user id, then PATCH the role of an existing membership or POST a new
 * one. A membership not declared in the canvas is left untouched — this config
 * type only manages what it declares and never prunes unmanaged memberships.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildSnykClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, host } = built
  if (!client.hasOrg) {
    return { success: false, message: 'No Snyk organization id set — configure the "Organization ID" app setting.' }
  }

  const specs = extractMembershipSpecs(ctx.canvas).filter((s) => s.userId && s.roleId)
  const rollbackState: MembershipRollbackEntry[] = []
  const created: string[] = []
  const updated: string[] = []
  const unchanged: string[] = []

  try {
    const existing = await listMemberships(client)
    const byUser = new Map(
      existing
        .filter((m) => m.relationships?.user?.data?.id)
        .map((m) => [membershipKey(m.relationships!.user!.data!.id as string), m]),
    )

    for (const spec of specs) {
      const key = membershipKey(spec.userId)
      const live = byUser.get(key)

      if (live && live.id) {
        const liveRoleId = live.relationships?.role?.data?.id
        rollbackState.push({ key, userId: spec.userId, existed: true, membershipId: live.id, priorRoleId: liveRoleId })

        if (liveRoleId && liveRoleId === spec.roleId) {
          unchanged.push(spec.userId)
          continue
        }

        const res = await client.rest('PATCH', `${client.restOrgPath()}/memberships/${live.id}`, {
          body: {
            data: {
              id: live.id,
              type: 'org_membership',
              relationships: { role: { data: { id: spec.roleId, type: 'org_role' } } },
            },
          },
        })
        if (!res.ok) throw new Error(`Failed to update membership role for user "${spec.userId}": ${snykErrorMessage(res)}`)
        updated.push(spec.userId)
      } else {
        const res = await client.rest('POST', `${client.restOrgPath()}/memberships`, {
          body: {
            data: {
              type: 'org_membership',
              relationships: {
                org: { data: { id: client.requireOrgId(), type: 'org' } },
                role: { data: { id: spec.roleId, type: 'org_role' } },
                user: { data: { id: spec.userId, type: 'user' } },
              },
            },
          },
        })
        if (!res.ok) throw new Error(`Failed to create membership for user "${spec.userId}": ${snykErrorMessage(res)}`)
        const createdMembership = restResult<{ id?: string }>(res)
        rollbackState.push({ key, userId: spec.userId, existed: false, membershipId: createdMembership?.id })
        created.push(spec.userId)
      }
    }

    const parts = [`${created.length} created`, `${updated.length} updated`]
    if (unchanged.length) parts.push(`${unchanged.length} unchanged`)
    return {
      success: true,
      message: `Snyk org memberships deployed to ${host}: ${parts.join(', ')}`,
      artifacts: { host, created, updated, unchanged },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Membership deployment failed after ${created.length + updated.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { host, created, updated, unchanged },
      rollbackData: { previousState: rollbackState },
    }
  }
}

/** List all memberships for the org; throws on a non-OK response. */
export async function listMemberships(client: SnykClient): Promise<LiveMembership[]> {
  const res = await client.restGetAll<LiveMembership>(`${client.restOrgPath()}/memberships`)
  if (!res.ok) {
    throw new Error(`Failed to list org memberships: ${snykErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}
