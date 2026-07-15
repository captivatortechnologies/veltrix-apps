import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildTenableClient, tenableErrorMessage } from '../../lib/tenable'
import type { ScannerGroupRollbackEntry } from './deploy'

/**
 * Roll back scanner groups using the state captured during deploy:
 *   - groups this deploy created are deleted (DELETE /scanner-groups/{id})
 *   - groups this deploy renamed are PUT back to their captured prior name
 *
 * Deleting a scanner group removes the load-balancing pool; the member scanners
 * themselves are unaffected (membership is managed separately). Rollback is
 * keyed on the numeric id captured at deploy, never the name.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ScannerGroupRollbackEntry[] })
    ?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this group — remove it. 404 means it was never created
        // (or already removed), which is the desired end state.
        if (entry.id !== undefined) {
          const res = await client.request('DELETE', `/scanner-groups/${entry.id}`)
          if (!res.ok && res.status !== 404) {
            throw new Error(`Failed to delete scanner group "${entry.name}": ${tenableErrorMessage(res)}`)
          }
        }
      } else if (entry.id !== undefined && entry.prior?.name !== undefined) {
        // Deploy renamed this group — restore the captured prior name.
        const res = await client.request('PUT', `/scanner-groups/${entry.id}`, {
          body: { name: entry.prior.name },
        })
        if (!res.ok) {
          throw new Error(`Failed to restore scanner group "${entry.name}": ${tenableErrorMessage(res)}`)
        }
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} scanner group(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} scanner group(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
