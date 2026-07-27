import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import { deleteScript, restoreScript, type ScriptRollbackEntry } from './deploy'

/**
 * Roll back RTR custom scripts using the state captured during deploy:
 *   - scripts that were created are deleted
 *   - scripts that were updated are patched back to their prior values
 *
 * Create/update reversal runs through the multipart-only RTR Admin API (see the
 * caveat in deploy.ts); delete works over JSON + query params today.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ScriptRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this script — remove it. 404 means it was never
        // created (or already removed), which is the desired state.
        if (entry.id) {
          await deleteScript(client, entry.id)
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this script — restore the captured prior values.
        await restoreScript(client, entry.id, entry.name, entry.prior)
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} RTR script(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} script(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
