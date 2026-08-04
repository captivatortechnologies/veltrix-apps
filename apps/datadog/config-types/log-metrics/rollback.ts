import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildDatadogClient, datadogErrorMessage } from '../../lib/datadogApi'
import { attributesToUpdateBody, toUpdatePayload } from './_shared'
import type { LogMetricRollbackEntry } from './deploy'

const METRICS_PATH = '/api/v2/logs/config/metrics'

/**
 * Roll back Log-Based Metrics using the state captured during deploy:
 *   - metrics that were CREATED are deleted (DELETE .../{id}; 404 tolerated)
 *   - metrics that were UPDATED are restored (PATCH, mutable fields only —
 *     aggregation_type/path are create-only and were never changed) to their
 *     captured prior state.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildDatadogClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: LogMetricRollbackEntry[] } | null)?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        const res = await client.request('DELETE', `${METRICS_PATH}/${encodeURIComponent(entry.id)}`)
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete metric "${entry.id}": ${datadogErrorMessage(res)}`)
        }
      } else if (entry.prior?.attributes) {
        const body = attributesToUpdateBody(entry.prior.attributes)
        const res = await client.request('PATCH', `${METRICS_PATH}/${encodeURIComponent(entry.id)}`, { body: toUpdatePayload(body) })
        if (!res.ok) throw new Error(`Failed to restore metric "${entry.id}": ${datadogErrorMessage(res)}`)
      }
      reverted.push(entry.id)
    }

    return { success: true, message: `Rolled back ${reverted.length} Log-Based Metric(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
