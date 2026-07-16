import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildXsoarClient, xsoarErrorMessage } from '../../lib/xsoar'
import type { JobRollbackEntry } from './deploy'

/**
 * Roll back jobs using the state captured during deploy:
 *   - jobs that were created are deleted (DELETE /jobs/{id})
 *   - jobs that were updated are restored (POST /jobs) to their prior body
 * A job already deleted out-of-band (404) is treated as success.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildXsoarClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: JobRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `/jobs/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete job "${entry.name}": ${xsoarErrorMessage(res)}`)
          }
        }
      } else if (entry.prior) {
        const res = await client.request('POST', '/jobs', { body: entry.prior })
        if (!res.ok) {
          throw new Error(`Failed to restore job "${entry.name}": ${xsoarErrorMessage(res)}`)
        }
      }
      reverted.push(entry.name)
    }

    return { success: true, message: `Rolled back ${reverted.length} job(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
