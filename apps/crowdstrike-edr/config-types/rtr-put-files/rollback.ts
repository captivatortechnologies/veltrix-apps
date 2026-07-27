import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import { deletePutFile, type PutFileRollbackEntry } from './deploy'

/**
 * Roll back RTR put-files using the state captured during deploy:
 *   - put-files that were created are deleted
 *   - put-files that were replaced (delete+recreate) have the newly created
 *     file deleted; the original bytes CANNOT be restored (the RTR Admin API
 *     never returns a put-file's content), so the operator must re-upload the
 *     original in the Falcon console — this is surfaced in the message
 *   - put-files that were left untouched (idempotent, no content change) need
 *     no action
 *
 * Delete works over JSON + query params today; recreate would run through the
 * multipart-only create (see the caveat in deploy.ts).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: PutFileRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  const unrestorable: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this put-file — remove it. 404 means it was never
        // created (or already removed), which is the desired state.
        if (entry.id) {
          await deletePutFile(client, entry.id)
        }
      } else if (entry.replaced && entry.id) {
        // Deploy replaced a pre-existing put-file. Delete the file it created;
        // the original content is unrecoverable via the API.
        await deletePutFile(client, entry.id)
        unrestorable.push(entry.name)
      }
      // existed && !replaced → deploy left it untouched; nothing to reverse.

      reverted.push(entry.name)
    }

    const note =
      unrestorable.length > 0
        ? ` Note: the original content of ${unrestorable.join(
            ', ',
          )} cannot be restored automatically (the RTR Admin API does not return put-file bytes) — re-upload the original file in the Falcon console.`
        : ''
    return {
      success: true,
      message: `Rolled back ${reverted.length} RTR put-file(s): ${reverted.join(', ')}.${note}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} put-file(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
