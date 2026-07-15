import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildS1Client, s1ErrorMessage } from '../../lib/s1'
import type { HashRollbackEntry } from './deploy'

/**
 * Roll back blocklist hashes using the state captured during deploy.
 *
 * Deploy is ADD/REMOVE only (restrictions have no update), so rollback only
 * removes the entries this deploy created (DELETE /restrictions with their ids).
 * Entries that already existed were skipped during deploy and are left untouched.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildS1Client(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: HashRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed && entry.id) {
        const res = await client.request('DELETE', '/restrictions', { body: { data: { ids: [entry.id] } } })
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to remove blocklist hash "${entry.label}": ${s1ErrorMessage(res)}`)
        }
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} blocklist hash(es): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
