import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildXrayClient, xrayErrorMessage } from '../../lib/xrayApi'
import { restorableWatchBody } from './_shared'
import { watchPath, type WatchRollbackEntry } from './deploy'

/**
 * Roll back Xray watches using the state captured during deploy:
 *   - watches that were CREATED are deleted (`DELETE /api/v2/watches/{name}`).
 *   - watches that were UPDATED are restored to their captured full prior body
 *     (`PUT /api/v2/watches/{name}`) — Xray's PUT is a full replace, so the
 *     entire prior watch (scope + assigned policies) is replayed as-is.
 * Processed in reverse deploy order, matching the platform's rollback convention.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildXrayClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previous = (ctx.rollbackData as { previous?: WatchRollbackEntry[] } | null)?.previous
  if (!previous || previous.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previous].reverse()) {
      if (!entry.existed) {
        const res = await client.deleteResource(watchPath(entry.name))
        if (!res.ok && res.status !== 404) {
          throw new Error(`Failed to delete watch "${entry.name}": ${xrayErrorMessage(res)}`)
        }
      } else if (entry.prior) {
        await client.putJson(watchPath(entry.name), restorableWatchBody(entry.prior))
      }
      reverted.push(entry.name)
    }

    return { success: true, message: `Rolled back ${reverted.length} Xray watch${reverted.length === 1 ? '' : 'es'}: ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previous.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
