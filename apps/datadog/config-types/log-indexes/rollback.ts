import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildDatadogClient, datadogErrorMessage } from '../../lib/datadogApi'
import { indexToBody } from './_shared'
import type { LogIndexRollbackEntry } from './deploy'

const INDEXES_PATH = '/api/v1/logs/config/indexes'

/**
 * Roll back Log Indexes using the state captured during deploy:
 *   - indexes that were CREATED are deleted
 *     (DELETE /api/v1/logs/config/indexes/{name}; 404 tolerated)
 *   - indexes that were UPDATED are restored (PUT, full-replace) to their
 *     captured prior body.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildDatadogClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: LogIndexRollbackEntry[] } | null)?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        const res = await client.request('DELETE', `${INDEXES_PATH}/${encodeURIComponent(entry.name)}`)
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete index "${entry.name}": ${datadogErrorMessage(res)}`)
        }
      } else if (entry.prior) {
        const body = indexToBody(entry.prior)
        const res = await client.request('PUT', `${INDEXES_PATH}/${encodeURIComponent(entry.name)}`, { body })
        if (!res.ok) throw new Error(`Failed to restore index "${entry.name}": ${datadogErrorMessage(res)}`)
      }
      reverted.push(entry.name)
    }

    return { success: true, message: `Rolled back ${reverted.length} Log Index(es): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
