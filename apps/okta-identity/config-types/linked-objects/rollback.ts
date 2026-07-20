import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage } from '../../lib/okta'
import { type LinkedObjectRollbackEntry } from './deploy'

const LINKED_OBJECTS_PATH = '/meta/schemas/user/linkedObjects'

/**
 * Roll back linked-object definitions using the state captured during deploy.
 * Only definitions this deploy CREATED (existed === false) are removed, via
 * DELETE /meta/schemas/user/linkedObjects/{primaryName} — deleting either side's
 * name removes the WHOLE definition (and every user link that used it). A 404 is
 * tolerated (the definition is already gone). Definitions that were left
 * unchanged (a matching one deploy skipped) are never touched, because deploy
 * never modified them.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: LinkedObjectRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      // Only remove definitions this deploy created; matched/unchanged ones are
      // left alone because deploy never modified them.
      if (!entry.existed) {
        const del = await client.request(
          'DELETE',
          `${LINKED_OBJECTS_PATH}/${encodeURIComponent(entry.primaryName)}`,
        )
        if (!del.ok && del.status !== 404) {
          throw new Error(
            `Failed to delete linked-object definition "${entry.primaryName}": ${oktaErrorMessage(del)}`,
          )
        }
      }
      reverted.push(entry.primaryName)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} linked-object definition(s): ${reverted.join(', ')}. Definitions created by the deployment were deleted, removing every user link that used them.`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} definition(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
