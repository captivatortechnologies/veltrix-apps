import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconFailure } from '../../lib/falcon'
import {
  deleteRule,
  deleteRuleGroup,
  getRuleGroupById,
  patchRuleGroup,
  type RuleGroupRollbackEntry,
} from './deploy'

const ROLLBACK_COMMENT = 'Rolled back by Veltrix (crowdstrike-edr app)'

/**
 * Roll back custom IOA rule groups using the state captured during deploy:
 *   - groups that were created are deleted (which removes their rules)
 *   - groups that were updated have the rules this deploy created removed, then
 *     the group is patched back to its prior name/description/enabled/comment
 *     (the group's current version is re-read, since deleting rules bumps it)
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
        // creating or is already gone, which is the desired state.
        if (entry.id) {
          const res = await deleteRuleGroup(client, entry.id, ROLLBACK_COMMENT)
          const deleteFailure = res.status === 404 ? null : falconFailure(res)
          if (deleteFailure) {
            throw new Error(`Failed to delete rule group "${entry.name}": ${deleteFailure}`)
          }
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this group — first remove the rules it created.
        for (const instanceId of entry.createdRuleInstanceIds ?? []) {
          const res = await deleteRule(client, entry.id, instanceId, ROLLBACK_COMMENT)
          const deleteFailure = res.status === 404 ? null : falconFailure(res)
          if (deleteFailure) {
            throw new Error(
              `Failed to delete rule ${instanceId} in group "${entry.name}": ${deleteFailure}`,
            )
          }
        }

        // Restore the captured prior values. Deleting rules bumped the group
        // version, so re-read it for the PATCH's rulegroup_version.
        const current = await getRuleGroupById(client, entry.id)
        await patchRuleGroup(client, {
          id: entry.id,
          name: entry.prior.name ?? entry.name,
          description: entry.prior.description ?? '',
          enabled: entry.prior.enabled ?? false,
          comment: ROLLBACK_COMMENT,
          rulegroup_version: current?.version ?? entry.prior.version ?? 0,
        })
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} IOA rule group(s): ${reverted.join(', ')}`,
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
