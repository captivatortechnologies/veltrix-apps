import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconFailure } from '../../lib/falcon'
import type { FalconClient } from '../../lib/falcon'
import { updateFileVantage } from '../../lib/filevantageAdapter'
import { deleteRule, RULE_GROUP_ENDPOINTS, type RuleGroupRollbackEntry } from './deploy'

/**
 * Roll back FileVantage rule groups using the state captured during deploy:
 *   - groups that were created are deleted whole (which removes their rules)
 *   - groups that were updated have the rules THIS deploy created removed, then
 *     the group is patched back to its prior name/description
 *
 * Existing rules a deploy updated in place are not field-by-field restored
 * (documented Phase 1 limitation, matching custom-ioa-rule-groups).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: RuleGroupRollbackEntry[] })
    ?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this group — remove it. 404 means it never finished
        // creating or is already gone, which is the desired end state.
        if (entry.id) {
          await deleteGroupTolerant(client, entry.id, entry.name)
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this group — first remove the rules it created.
        for (const ruleId of entry.createdRuleIds ?? []) {
          const res = await deleteRule(client, entry.id, ruleId)
          const failure = res.status === 404 ? null : falconFailure(res)
          if (failure) {
            throw new Error(`Failed to delete rule ${ruleId} in group "${entry.name}": ${failure}`)
          }
        }

        // Restore the captured prior name/description.
        await updateFileVantage(client, RULE_GROUP_ENDPOINTS, {
          id: entry.id,
          name: entry.prior.name ?? entry.name,
          description: entry.prior.description ?? '',
        })
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} FileVantage rule group(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} group(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}

/**
 * Delete a whole rule group, tolerating 404 (already gone = desired state). The
 * shared adapter's delete throws on any non-2xx, so rollback issues its own
 * 404-tolerant DELETE against the same group entity endpoint.
 */
async function deleteGroupTolerant(client: FalconClient, id: string, name: string): Promise<void> {
  const res = await client.request(
    'DELETE',
    `${RULE_GROUP_ENDPOINTS.entity}?ids=${encodeURIComponent(id)}`,
  )
  const failure = res.status === 404 ? null : falconFailure(res)
  if (failure) {
    throw new Error(`Failed to delete rule group "${name}": ${failure}`)
  }
}
