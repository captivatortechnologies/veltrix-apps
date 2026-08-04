import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildPagerDutyClient, pagerDutyErrorMessage, type PagerDutyClient } from '../../lib/pagerdutyApi'
import {
  buildOrchestrationPathBody,
  type LiveOrchestrationPath,
  type OrchestrationCatchAll,
  type OrchestrationSet,
} from './_shared'
import type { EventOrchestrationRollbackEntry } from './deploy'

/**
 * Undo an event-orchestrations deploy from rollbackData.previousState (written by
 * deploy()), in reverse order:
 *   - an orchestration that was CREATED is deleted (DELETE /event_orchestrations/{id}),
 *     which cascades to its Router/Global/Unrouted paths
 *   - an orchestration that was UPDATED has its Router (and Global/Unrouted, if
 *     this deploy declared them) restored via PUT to the exact body captured
 *     before the deploy, then its identity (name/description/team) restored
 * Applied over the PagerDuty REST API v2.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildPagerDutyClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: EventOrchestrationRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: true, message: 'Nothing to roll back.' }
  }

  const reverted: string[] = []
  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `/event_orchestrations/${encodeURIComponent(entry.id)}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete event orchestration "${entry.name}": ${pagerDutyErrorMessage(res)}`)
          }
        }
      } else if (entry.id) {
        if (entry.priorRouter) {
          await restoreOrchestrationPath(client, entry.id, 'router', entry.priorRouter, entry.name)
        }
        if (entry.globalDeclared && entry.priorGlobal) {
          await restoreOrchestrationPath(client, entry.id, 'global', entry.priorGlobal, entry.name)
        }
        if (entry.unroutedDeclared && entry.priorUnrouted) {
          await restoreOrchestrationPath(client, entry.id, 'unrouted', entry.priorUnrouted, entry.name)
        }
        if (entry.priorOrchestration) {
          const p = entry.priorOrchestration
          const body = {
            orchestration: {
              name: String(p.name ?? entry.name),
              ...(p.description ? { description: p.description } : {}),
              ...(p.team?.id ? { team: { id: p.team.id } } : {}),
            },
          }
          const res = await client.request('PUT', `/event_orchestrations/${encodeURIComponent(entry.id)}`, { body })
          if (!res.ok) throw new Error(`Failed to restore event orchestration "${entry.name}": ${pagerDutyErrorMessage(res)}`)
        }
      }
      reverted.push(entry.name)
    }

    return { success: true, message: `Rolled back ${reverted.length} event orchestration(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}

/** Restore a captured orchestration_path (Router/Global/Unrouted) verbatim via PUT. */
async function restoreOrchestrationPath(
  client: PagerDutyClient,
  orchestrationId: string,
  path: 'router' | 'global' | 'unrouted',
  prior: LiveOrchestrationPath,
  orchestrationName: string,
): Promise<void> {
  const sets: OrchestrationSet[] = Array.isArray(prior.sets) ? prior.sets : []
  const catchAll: OrchestrationCatchAll = prior.catch_all ?? { actions: {} }
  const body = buildOrchestrationPathBody(sets, catchAll)
  const res = await client.request('PUT', `/event_orchestrations/${encodeURIComponent(orchestrationId)}/${path}`, { body })
  if (!res.ok) {
    throw new Error(`Failed to restore the ${path} path for event orchestration "${orchestrationName}": ${pagerDutyErrorMessage(res)}`)
  }
}
