import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient, elasticErrorMessage } from '../../lib/elastic'
import { buildTimelineBody, getTimelineTemplate } from './deploy'
import { definitionOf } from './validate'
import type { TimelineTemplateRollbackEntry } from './deploy'

/**
 * Roll back timeline templates using the state captured during deploy:
 *   - templates that were CREATED are deleted (DELETE /api/timeline body
 *     `{ savedObjectIds: [id] }`); already-gone is tolerated.
 *   - templates that were UPDATED are restored (PATCH) to their prior body.
 *     PATCH requires the CURRENT optimistic-concurrency `version` token, which
 *     deploy already advanced — so this RE-FETCHES the template first to get
 *     the version to patch against, rather than reusing the stale pre-deploy
 *     token (which Kibana would reject as a conflict).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildElasticClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: TimelineTemplateRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      const label = entry.templateTimelineId

      if (!entry.existed) {
        if (!entry.savedObjectId) {
          reverted.push(label)
          continue
        }
        const res = await client.kibana('DELETE', '/api/timeline', { body: { savedObjectIds: [entry.savedObjectId] } })
        if (!res.ok) {
          throw new Error(`Failed to delete timeline template "${label}": ${elasticErrorMessage(res)}`)
        }
      } else if (entry.prior) {
        // Re-fetch to get the CURRENT version token — the one captured before
        // deploy is now stale (deploy's own PATCH advanced it).
        const current = await getTimelineTemplate(client, label)
        if (!current?.savedObjectId || !current.version) {
          throw new Error(`Could not re-fetch timeline template "${label}" to restore it (it may have been deleted manually)`)
        }

        const priorVersion = current.templateTimelineVersion ?? entry.prior.templateTimelineVersion ?? 1
        const restoreBody = {
          ...buildTimelineBody(
            {
              sectionName: label,
              templateTimelineId: label,
              title: entry.prior.title ?? label,
              description: entry.prior.description,
            },
            definitionOf(entry.prior),
            priorVersion + 1,
          ),
        }

        const res = await client.kibana('PATCH', '/api/timeline', {
          body: { timeline: restoreBody, timelineId: current.savedObjectId, version: current.version },
        })
        if (!res.ok) {
          throw new Error(`Failed to restore timeline template "${label}": ${elasticErrorMessage(res)}`)
        }
      }

      reverted.push(label)
    }

    return { success: true, message: `Rolled back ${reverted.length} timeline template(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} template(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
