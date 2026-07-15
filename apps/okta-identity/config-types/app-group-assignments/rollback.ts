import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage } from '../../lib/okta'
import type { AppGroupAssignmentRollbackEntry } from './deploy'

/**
 * Roll back app-group assignments using the state captured during deploy:
 *   - assignments this deploy CREATED (existed: false) are DELETEd (unassigned).
 *     A delete tolerates a 404 (already gone is the desired end state).
 *   - assignments this deploy UPDATED (existed: true) are PUT back to their
 *     captured prior body, restoring the prior priority/profile.
 *
 * Rollback is keyed on the (appId, groupId) pair captured with each entry — the
 * assignment id equals the groupId, so the path fully identifies it. There is no
 * lifecycle on an assignment, so no status to restore.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: AppGroupAssignmentRollbackEntry[] })
    ?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    // Undo in reverse so later changes are reverted before earlier ones.
    for (const entry of [...previousState].reverse()) {
      const label = `${entry.appId}:${entry.groupId}`

      if (!entry.existed) {
        // Deploy created this assignment — unassign it.
        const res = await client.request('DELETE', `/apps/${entry.appId}/groups/${entry.groupId}`)
        if (!res.ok && res.status !== 404) {
          throw new Error(`Failed to unassign "${label}": ${oktaErrorMessage(res)}`)
        }
      } else {
        // Deploy updated this assignment — restore its captured prior body. An
        // assign is an idempotent PUT, so replaying the prior priority/profile
        // reverts the change (an empty prior body is a valid bind with no
        // overrides).
        const res = await client.request('PUT', `/apps/${entry.appId}/groups/${entry.groupId}`, {
          body: entry.prior ?? {},
        })
        if (!res.ok) {
          throw new Error(`Failed to restore assignment "${label}": ${oktaErrorMessage(res)}`)
        }
      }

      reverted.push(label)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} app-group assignment(s): ${reverted.join(', ')}.`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} assignment(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
