import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildDatadogClient, datadogErrorMessage } from '../../lib/datadogApi'
import { monitorToBody } from './_shared'
import type { MonitorRollbackEntry } from './deploy'

const MONITOR_PATH = '/api/v1/monitor'

/**
 * Roll back Monitors using the state captured during deploy:
 *   - monitors that were CREATED are deleted (DELETE /api/v1/monitor/{id};
 *     404 tolerated). `force=true` is intentionally NOT passed — if the
 *     monitor is now referenced by an SLO or composite monitor, the delete
 *     fails with a clear error rather than silently forcing it through.
 *   - monitors that were UPDATED are restored (PUT, full-replace) to their
 *     captured prior body. No optimistic-concurrency token is documented for
 *     this API, so the captured prior body is replayed as-is.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildDatadogClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: MonitorRollbackEntry[] } | null)?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (typeof entry.id === 'number') {
          const res = await client.request('DELETE', `${MONITOR_PATH}/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete monitor "${entry.label}": ${datadogErrorMessage(res)}`)
          }
        }
      } else if (typeof entry.id === 'number' && entry.prior) {
        const body = monitorToBody(entry.prior)
        const res = await client.request('PUT', `${MONITOR_PATH}/${entry.id}`, { body })
        if (!res.ok) throw new Error(`Failed to restore monitor "${entry.label}": ${datadogErrorMessage(res)}`)
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} Monitor(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
