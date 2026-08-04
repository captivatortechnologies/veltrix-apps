import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildPagerDutyClient, pagerDutyErrorMessage } from '../../lib/pagerdutyApi'
import { businessServiceRestoreBody } from './_shared'
import type { BusinessServiceRollbackEntry } from './deploy'

/**
 * Undo a business services deploy from rollbackData.previousState (written by
 * deploy()), in reverse order:
 *   - an item that was CREATED is deleted (DELETE /business_services/{id})
 *   - an item that was UPDATED is restored (PUT) to its prior body, restoring its
 *     prior team reference (by id) when the API had returned one
 * Applied over the PagerDuty REST API v2.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildPagerDutyClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: BusinessServiceRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: true, message: 'Nothing to roll back.' }
  }

  const reverted: string[] = []
  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `/business_services/${encodeURIComponent(entry.id)}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete business service "${entry.name}": ${pagerDutyErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        const body = { business_service: businessServiceRestoreBody(entry.prior) }
        const res = await client.request('PUT', `/business_services/${encodeURIComponent(entry.id)}`, { body })
        if (!res.ok) {
          throw new Error(`Failed to restore business service "${entry.name}": ${pagerDutyErrorMessage(res)}`)
        }
      }
      reverted.push(entry.name)
    }

    return { success: true, message: `Rolled back ${reverted.length} business service(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
