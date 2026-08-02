import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildDatadogClient, datadogErrorMessage } from '../../lib/datadogApi'
import { attributesToBody, toUpdatePayload } from './_shared'
import type { SuppressionRollbackEntry } from './deploy'

const SUPPRESSIONS_PATH = '/api/v2/security_monitoring/configuration/suppressions'

/**
 * Roll back Suppression Rules using the state captured during deploy:
 *   - rules that were CREATED are deleted (DELETE .../{id}; 404 tolerated)
 *   - rules that were UPDATED are restored (PATCH, with the full captured
 *     attribute set) to their prior state.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildDatadogClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: SuppressionRollbackEntry[] } | null)?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `${SUPPRESSIONS_PATH}/${encodeURIComponent(entry.id)}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete suppression "${entry.label}": ${datadogErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior?.attributes) {
        const body = attributesToBody(entry.prior.attributes)
        const res = await client.request('PATCH', `${SUPPRESSIONS_PATH}/${encodeURIComponent(entry.id)}`, {
          body: toUpdatePayload(entry.id, body),
        })
        if (!res.ok) throw new Error(`Failed to restore suppression "${entry.label}": ${datadogErrorMessage(res)}`)
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} Suppression Rule(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
