import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildXsoarClient, xsoarErrorMessage } from '../../lib/xsoar'
import type { ListRollbackEntry } from './deploy'

/**
 * Roll back lists using the state captured during deploy:
 *   - lists that were created are deleted (POST /lists/delete { id })
 *   - lists that were updated are restored (POST /lists/save) to their prior body
 * A list already deleted out-of-band (404) is treated as success.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildXsoarClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ListRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        const res = await client.request('POST', '/lists/delete', { body: { id: entry.id } })
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete list "${entry.name}": ${xsoarErrorMessage(res)}`)
        }
      } else if (entry.prior) {
        const body: Record<string, unknown> = {
          id: entry.id,
          name: entry.name,
          data: entry.prior.data ?? '',
          type: entry.prior.type ?? 'plain_text',
          tags: entry.prior.tags ?? [],
        }
        if (typeof entry.prior.version === 'number') body.version = entry.prior.version
        const res = await client.request('POST', '/lists/save', { body })
        if (!res.ok) {
          throw new Error(`Failed to restore list "${entry.name}": ${xsoarErrorMessage(res)}`)
        }
      }
      reverted.push(entry.name)
    }

    return { success: true, message: `Rolled back ${reverted.length} list(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
