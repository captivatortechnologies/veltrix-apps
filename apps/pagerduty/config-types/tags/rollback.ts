import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildPagerDutyClient, pagerDutyErrorMessage } from '../../lib/pagerdutyApi'
import type { TagRollbackEntry } from './deploy'

/**
 * Undo a tags deploy from rollbackData.previousState (written by deploy()), in
 * reverse order:
 *   - a tag that was CREATED is deleted (DELETE /tags/{id}), which cascades every
 *     assignment made to it — nothing else to undo
 *   - a tag that PRE-EXISTED is left in place; only the assignments THIS deploy
 *     added are removed (POST /{entity_type}/{id}/change_tags with { remove }),
 *     leaving pre-existing assignments and the tag itself untouched
 * Applied over the PagerDuty REST API v2.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildPagerDutyClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: TagRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: true, message: 'Nothing to roll back.' }
  }

  const reverted: string[] = []
  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `/tags/${encodeURIComponent(entry.id)}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete tag "${entry.label}": ${pagerDutyErrorMessage(res)}`)
          }
        }
      } else if (entry.id) {
        for (const assignment of entry.addedAssignments) {
          const res = await client.request(
            'POST',
            `/${assignment.entity_type}/${encodeURIComponent(assignment.entity_id)}/change_tags`,
            { body: { remove: [{ type: 'tag_reference', id: entry.id }] } },
          )
          if (!res.ok) {
            throw new Error(
              `Failed to remove tag "${entry.label}" from ${assignment.entity_type} "${assignment.entity_id}": ${pagerDutyErrorMessage(res)}`,
            )
          }
        }
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} tag(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
