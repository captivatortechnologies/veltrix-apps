import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import { deleteLookupFile, writeLookupFile, type LookupRollbackEntry } from './deploy'

/**
 * Roll back Next-Gen SIEM lookup files using the state captured during deploy:
 *   - files that were created are deleted
 *   - files that were updated are restored to their prior CSV content
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: LookupRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  const unrestorable: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this file — remove it. A 404 means it never finished
        // creating or is already gone, which is the desired state.
        await deleteLookupFile(client, entry.filename, entry.searchDomain)
      } else if (typeof entry.prior?.content === 'string') {
        // Deploy updated this file — restore the captured prior content.
        await writeLookupFile(client, 'PATCH', entry.filename, entry.prior.content, entry.searchDomain)
      } else {
        // Prior content was not captured (the bulk-get did not return it) —
        // the file is left as deployed and flagged for manual review.
        unrestorable.push(entry.filename)
      }

      reverted.push(entry.filename)
    }

    const note =
      unrestorable.length > 0
        ? ` Note: prior CSV content was unavailable for ${unrestorable.join(
            ', ',
          )} — review these files in the Falcon console.`
        : ''
    return {
      success: true,
      message: `Rolled back ${reverted.length} Next-Gen SIEM lookup file(s): ${reverted.join(', ')}.${note}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} file(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
