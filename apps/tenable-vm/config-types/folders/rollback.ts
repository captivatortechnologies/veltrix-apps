import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildTenableClient, tenableErrorMessage } from '../../lib/tenable'
import type { FolderRollbackEntry } from './deploy'

/**
 * Roll back folders using the state captured during deploy:
 *   - folders that were created are deleted (DELETE /folders/{id})
 *   - folders that pre-existed are restored (PUT) to their prior name
 *
 * Rollback is keyed on the stable numeric id (never the name). Restoring a
 * pre-existing folder is a no-op when its name never changed — which, for a
 * name-only object, it did not — but issuing it keeps the pattern symmetric and
 * guarantees a folder that pre-existed is left exactly as it was found.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: FolderRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      const label = entry.name

      if (!entry.existed) {
        // Deploy created this folder — remove it. 404 means it is already gone
        // (or was never created), which is the desired end state.
        if (typeof entry.id === 'number') {
          const res = await client.request('DELETE', `/folders/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete folder "${label}": ${tenableErrorMessage(res)}`)
          }
        }
      } else if (typeof entry.id === 'number' && entry.prior) {
        // Deploy adopted a pre-existing folder — restore its prior name.
        const restore: Record<string, unknown> = {}
        if (entry.prior.name !== undefined) restore.name = entry.prior.name
        if (Object.keys(restore).length > 0) {
          const res = await client.request('PUT', `/folders/${entry.id}`, { body: restore })
          if (!res.ok) {
            throw new Error(`Failed to restore folder "${label}": ${tenableErrorMessage(res)}`)
          }
        }
      }

      reverted.push(label)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} folder(s): ${reverted.join(', ')}.`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} folder(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
