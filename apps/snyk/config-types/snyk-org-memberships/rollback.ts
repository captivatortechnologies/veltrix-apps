import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient, snykErrorMessage } from '../../lib/snyk'
import type { MembershipRollbackEntry } from './deploy'

/**
 * Roll back org memberships using the state captured during deploy:
 *   - memberships this deploy created are removed (DELETE by id; a 404 is
 *     tolerated because the membership may already be gone)
 *   - memberships that were updated (role changed) are restored to their prior
 *     role
 * Never touches a membership this deploy did not create or modify.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildSnykClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built
  if (!client.hasOrg) {
    return { success: false, message: 'No Snyk organization id set — cannot roll back org memberships.' }
  }

  const previousState = (ctx.rollbackData as { previousState?: MembershipRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.membershipId) {
          const res = await client.rest('DELETE', `${client.restOrgPath()}/memberships/${entry.membershipId}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to remove membership for user "${entry.userId}": ${snykErrorMessage(res)}`)
          }
        }
      } else if (entry.membershipId && entry.priorRoleId) {
        const res = await client.rest('PATCH', `${client.restOrgPath()}/memberships/${entry.membershipId}`, {
          body: {
            data: {
              id: entry.membershipId,
              type: 'org_membership',
              relationships: { role: { data: { id: entry.priorRoleId, type: 'org_role' } } },
            },
          },
        })
        if (!res.ok) throw new Error(`Failed to restore membership role for user "${entry.userId}": ${snykErrorMessage(res)}`)
      }
      reverted.push(entry.userId)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} membership(s): ${reverted.join(', ') || 'none'}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
