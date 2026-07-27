import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconFailure } from '../../lib/falcon'
import {
  convergeRuleGroup,
  deleteRuleGroup,
  getRuleGroupById,
  type FirewallRuleGroupRollbackEntry,
} from './deploy'

/**
 * Roll back firewall rule groups using the state captured during deploy:
 *   - groups that were created are deleted (which removes their rules)
 *   - groups that were updated are converged back to their prior top-level
 *     fields and prior rule set via the same JSON-patch diff mechanism deploy
 *     uses (the group is re-read first for its current tracking token)
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: FirewallRuleGroupRollbackEntry[] })
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
          const res = await deleteRuleGroup(client, entry.id)
          const deleteFailure = res.status === 404 ? null : falconFailure(res)
          if (deleteFailure) {
            throw new Error(`Failed to delete rule group "${entry.name}": ${deleteFailure}`)
          }
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this group — converge it back to the captured prior
        // state. Re-read it first so the diff PATCH carries the current tracking.
        const current = await getRuleGroupById(client, entry.id)
        if (current) {
          await convergeRuleGroup(
            client,
            current,
            {
              name: entry.prior.name ?? entry.name,
              description: entry.prior.description ?? '',
              enabled: entry.prior.enabled ?? false,
            },
            entry.prior.rules,
          )
        }
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} firewall rule group(s): ${reverted.join(', ')}`,
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
