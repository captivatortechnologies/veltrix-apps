import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildPagerDutyClient, pagerDutyErrorMessage } from '../../lib/pagerdutyApi'
import { actionRestoreBody } from './_shared'
import type { AutomationActionRollbackEntry } from './deploy'

/**
 * Undo an automation-actions deploy from rollbackData.previousState (written by
 * deploy()), in reverse order:
 *   - an action that was CREATED is deleted (DELETE /automation_actions/actions/{id}),
 *     which also drops every association made to it — nothing else to undo
 *   - an action that was UPDATED is restored (PUT) to its prior body, then has
 *     only the team/service associations THIS deploy added removed (DELETE
 *     .../teams/{id} and .../services/{id}) — associations that pre-existed
 *     the deploy are left untouched, matching this app's Tags config type
 * Applied over the PagerDuty REST API v2.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildPagerDutyClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: AutomationActionRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: true, message: 'Nothing to roll back.' }
  }

  const reverted: string[] = []
  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `/automation_actions/actions/${encodeURIComponent(entry.id)}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete automation action "${entry.name}": ${pagerDutyErrorMessage(res)}`)
          }
        }
      } else if (entry.id) {
        if (entry.prior) {
          const body = { action: actionRestoreBody(entry.prior) }
          const res = await client.request('PUT', `/automation_actions/actions/${encodeURIComponent(entry.id)}`, { body })
          if (!res.ok) {
            throw new Error(`Failed to restore automation action "${entry.name}": ${pagerDutyErrorMessage(res)}`)
          }
        }

        for (const teamId of entry.addedTeamIds) {
          const res = await client.request(
            'DELETE',
            `/automation_actions/actions/${encodeURIComponent(entry.id)}/teams/${encodeURIComponent(teamId)}`,
          )
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to remove automation action "${entry.name}" team association "${teamId}": ${pagerDutyErrorMessage(res)}`)
          }
        }

        for (const serviceId of entry.addedServiceIds) {
          const res = await client.request(
            'DELETE',
            `/automation_actions/actions/${encodeURIComponent(entry.id)}/services/${encodeURIComponent(serviceId)}`,
          )
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to remove automation action "${entry.name}" service association "${serviceId}": ${pagerDutyErrorMessage(res)}`)
          }
        }
      }
      reverted.push(entry.name)
    }

    return { success: true, message: `Rolled back ${reverted.length} automation action(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
