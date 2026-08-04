import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildDatadogClient, datadogErrorMessage } from '../../lib/datadogApi'
import { sloToBody } from './_shared'
import type { SloRollbackEntry } from './deploy'

const SLO_PATH = '/api/v1/slo'

/**
 * Roll back SLOs using the state captured during deploy:
 *   - SLOs that were CREATED are deleted (DELETE .../{id}; 404 tolerated)
 *   - SLOs that were UPDATED are restored (PUT, full-replace) to their
 *     captured prior state.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildDatadogClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: SloRollbackEntry[] } | null)?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `${SLO_PATH}/${encodeURIComponent(entry.id)}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete SLO "${entry.label}": ${datadogErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        const body = sloToBody(entry.prior)
        const res = await client.request('PUT', `${SLO_PATH}/${encodeURIComponent(entry.id)}`, { body })
        if (!res.ok) throw new Error(`Failed to restore SLO "${entry.label}": ${datadogErrorMessage(res)}`)
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} SLO(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
