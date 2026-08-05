import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildPingOneClient, pingOneErrorMessage } from '../../lib/pingOne'
import { buildGroupBody, type GroupRollbackEntry } from './deploy'

/**
 * Roll back groups using the state captured during deploy:
 *   - groups that were created are deleted (DELETE /groups/{id}, tolerate 404)
 *   - groups that were updated are restored (PUT) to their prior writable
 *     state (name/description/population/userFilter/externalId/customData)
 *
 * Never touches a group this deploy did not create or change.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildPingOneClient(ctx.component.hostname, ctx.credential, ctx.settings)
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
        // Deploy created this group - remove it. 404 means it is already gone.
        if (entry.id) {
          const res = await client.request('DELETE', `/groups/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete group "${entry.name}": ${pingOneErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this group - restore the captured prior writable state.
        const res = await client.request('PUT', `/groups/${entry.id}`, { body: buildGroupBody(entry.prior) })
        if (!res.ok) {
          throw new Error(`Failed to restore group "${entry.name}": ${pingOneErrorMessage(res)}`)
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
