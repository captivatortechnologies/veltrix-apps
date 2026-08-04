import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildPagerDutyClient, pagerDutyErrorMessage } from '../../lib/pagerdutyApi'
import { buildOrchestrationPathBody, type OrchestrationCatchAll, type OrchestrationSet } from './_shared'
import type { ServiceOrchestrationRollbackEntry } from './deploy'

/**
 * Undo a service-orchestrations deploy from rollbackData.previousState (written
 * by deploy()), in reverse order: restore each service's orchestration_path and
 * active flag to exactly what was read immediately before this deploy overwrote
 * them (PagerDuty's own empty baseline if nothing was configured yet). There is
 * no create/delete branch — a Service Orchestration is a singleton content
 * replace, so rollback is always a PUT. Applied over the PagerDuty REST API v2.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildPagerDutyClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ServiceOrchestrationRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: true, message: 'Nothing to roll back.' }
  }

  const reverted: string[] = []
  try {
    for (const entry of [...previousState].reverse()) {
      const sets: OrchestrationSet[] = Array.isArray(entry.priorPath?.sets) ? entry.priorPath.sets : []
      const catchAll: OrchestrationCatchAll = entry.priorPath?.catch_all ?? { actions: {} }
      const body = buildOrchestrationPathBody(sets, catchAll)

      const putRes = await client.request('PUT', `/event_orchestrations/services/${encodeURIComponent(entry.serviceId)}`, { body })
      if (!putRes.ok) {
        throw new Error(`Failed to restore service orchestration for "${entry.service}": ${pagerDutyErrorMessage(putRes)}`)
      }

      const activeRes = await client.request('PUT', `/event_orchestrations/services/${encodeURIComponent(entry.serviceId)}/active`, {
        body: { active: entry.priorActive },
      })
      if (!activeRes.ok) {
        throw new Error(`Failed to restore active state for service orchestration "${entry.service}": ${pagerDutyErrorMessage(activeRes)}`)
      }

      reverted.push(entry.service)
    }

    return { success: true, message: `Rolled back ${reverted.length} service orchestration(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
