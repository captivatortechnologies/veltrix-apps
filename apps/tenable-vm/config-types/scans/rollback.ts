import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildTenableClient, tenableErrorMessage } from '../../lib/tenable'
import type { ScanRollbackEntry } from './deploy'

/**
 * Roll back scans using the state captured during deploy:
 *   - scans this deploy created are deleted (DELETE /scans/{id})
 *   - scans this deploy updated are PUT back to their captured prior settings
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ScanRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this scan — remove it. 404 means it was never created
        // (or already removed), which is the desired end state.
        if (entry.id !== undefined) {
          const res = await client.request('DELETE', `/scans/${entry.id}`)
          if (!res.ok && res.status !== 404) {
            throw new Error(`Failed to delete scan "${entry.name}": ${tenableErrorMessage(res)}`)
          }
        }
      } else if (entry.id !== undefined && entry.prior?.settings) {
        // Deploy updated this scan — restore the captured prior settings.
        const res = await client.request('PUT', `/scans/${entry.id}`, {
          body: { settings: entry.prior.settings },
        })
        if (!res.ok) {
          throw new Error(`Failed to restore scan "${entry.name}": ${tenableErrorMessage(res)}`)
        }
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} scan(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} scan(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
