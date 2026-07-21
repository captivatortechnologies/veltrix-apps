import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage, type OktaClient } from '../../lib/okta'
import { getCurrentMemberIds, type GroupRollbackEntry } from './deploy'

/**
 * Roll back groups using the state captured during deploy:
 *   - groups that were created are deleted (DELETE /groups/{id}, tolerate 404)
 *   - groups that were updated are restored (PUT) to their prior profile, and —
 *     only when this deploy managed membership — their prior static member set
 *     is restored as well.
 *
 * Deleting a created group removes it (and its membership) entirely, so no
 * separate membership rollback is needed for created groups.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: GroupRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this group — remove it. 404 means it is already gone.
        if (entry.id) {
          const res = await client.request('DELETE', `/groups/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete group "${entry.name}": ${oktaErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this group — restore the captured prior profile.
        const res = await client.request('PUT', `/groups/${entry.id}`, {
          body: { profile: { name: entry.prior.name, description: entry.prior.description } },
        })
        if (!res.ok) {
          throw new Error(`Failed to restore group "${entry.name}": ${oktaErrorMessage(res)}`)
        }

        // Restore the prior static member set only if this deploy managed it.
        if (entry.managedMembership && entry.priorMembers) {
          await restoreMembership(client, entry.id, entry.name, entry.priorMembers)
        }
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} group(s): ${reverted.join(', ')}.`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} group(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}

/** Converge a group's static membership back to the captured prior member set. */
async function restoreMembership(
  client: OktaClient,
  groupId: string,
  name: string,
  priorMembers: string[],
): Promise<void> {
  const desired = new Set(priorMembers)
  // null = group not found (404); treat as empty so rollback still attempts to
  // restore the prior members rather than crashing on the read.
  const current = (await getCurrentMemberIds(client, groupId)) ?? []
  const currentSet = new Set(current)

  // Re-add members that were present before the deploy.
  for (const userId of priorMembers) {
    if (!currentSet.has(userId)) {
      const res = await client.request('PUT', `/groups/${groupId}/users/${userId}`)
      if (!res.ok) {
        throw new Error(`Failed to restore member ${userId} of group "${name}": ${oktaErrorMessage(res)}`)
      }
    }
  }

  // Remove members the deploy added that were not there before.
  for (const userId of current) {
    if (!desired.has(userId)) {
      const res = await client.request('DELETE', `/groups/${groupId}/users/${userId}`)
      if (res.status !== 404 && !res.ok) {
        throw new Error(`Failed to remove member ${userId} of group "${name}": ${oktaErrorMessage(res)}`)
      }
    }
  }
}
