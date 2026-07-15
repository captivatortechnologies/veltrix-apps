import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildS1Client, s1ErrorMessage } from '../../lib/s1'
import type { GroupRollbackEntry } from './deploy'

/**
 * Roll back groups using the state captured during deploy:
 *   - groups that were created are deleted (DELETE /groups/{id})
 *   - groups that were updated are restored (PUT /groups/{id}) to their prior body
 * The protected Default Group is never in the captured state (deploy refuses to
 * touch it), so rollback can never delete it. A group deleted out-of-band already
 * (404) is treated as success.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildS1Client(ctx.component.hostname, ctx.credential, ctx.settings)
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
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id != null) {
          const res = await client.request('DELETE', `/groups/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete group "${entry.name}": ${s1ErrorMessage(res)}`)
          }
        }
      } else if (entry.id != null && entry.prior) {
        const res = await client.request('PUT', `/groups/${entry.id}`, {
          body: { data: { name: entry.prior.name ?? entry.name, inherits: entry.prior.inherits ?? true } },
        })
        if (!res.ok) {
          throw new Error(`Failed to restore group "${entry.name}": ${s1ErrorMessage(res)}`)
        }
      }
      reverted.push(entry.name)
    }

    return { success: true, message: `Rolled back ${reverted.length} group(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
