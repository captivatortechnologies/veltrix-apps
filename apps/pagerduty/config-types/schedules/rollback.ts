import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildPagerDutyClient, pagerDutyErrorMessage } from '../../lib/pagerdutyApi'
import { buildScheduleBody, type ScheduleSpec } from './_shared'
import type { ScheduleRollbackEntry } from './deploy'

/**
 * Undo a schedules deploy from rollbackData.previousState (written by deploy()),
 * in reverse order:
 *   - a schedule that was CREATED is deleted (DELETE /schedules/{id})
 *   - a schedule that was UPDATED is restored (PUT) to its prior body
 * Applied over the PagerDuty REST API v2.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildPagerDutyClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ScheduleRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: true, message: 'Nothing to roll back.' }
  }

  const reverted: string[] = []
  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `/schedules/${encodeURIComponent(entry.id)}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete schedule "${entry.name}": ${pagerDutyErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        const p = entry.prior
        // Restore the prior body verbatim (name / time_zone / layers).
        const restoreSpec: ScheduleSpec = {
          itemName: entry.name,
          name: String(p.name ?? entry.name),
          timeZone: String(p.time_zone ?? ''),
          layersJson: '',
        }
        const body = { schedule: buildScheduleBody(restoreSpec, p.schedule_layers ?? []) }
        const res = await client.request('PUT', `/schedules/${encodeURIComponent(entry.id)}`, { body })
        if (!res.ok) throw new Error(`Failed to restore schedule "${entry.name}": ${pagerDutyErrorMessage(res)}`)
      }
      reverted.push(entry.name)
    }

    return { success: true, message: `Rolled back ${reverted.length} schedule(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
