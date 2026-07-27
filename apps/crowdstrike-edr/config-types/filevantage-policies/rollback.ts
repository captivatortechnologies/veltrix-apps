import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconFailure } from '../../lib/falcon'
import { updateFileVantage } from '../../lib/filevantageAdapter'
import {
  FILEVANTAGE_POLICY_ENDPOINTS,
  POLICIES_HOST_GROUPS_PATH,
  POLICIES_RULE_GROUPS_PATH,
  policyGroupAction,
  type FileVantagePolicyRollbackEntry,
} from './deploy'

/**
 * Roll back FileVantage policies using the state captured during deploy:
 *   - policies that were created are disabled then deleted (a policy is disabled
 *     first so it can be removed cleanly)
 *   - policies that were updated are patched back to their prior name,
 *     description, and enablement, with the deployment's exact host-group and
 *     rule-group assignment deltas reversed and the prior rule-group order
 *     restored
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: FileVantagePolicyRollbackEntry[] })
    ?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this policy — remove it. Disable first, then delete;
        // 404 on delete means it never finished creating or is already gone,
        // which is the desired state.
        if (entry.id) {
          try {
            await updateFileVantage(client, FILEVANTAGE_POLICY_ENDPOINTS, {
              id: entry.id,
              enabled: false,
            })
          } catch {
            // Best effort — the policy may already be disabled or missing.
          }
          const res = await client.request('DELETE', FILEVANTAGE_POLICY_ENDPOINTS.entity, {
            query: { ids: entry.id },
          })
          const deleteFailure = res.status === 404 ? null : falconFailure(res)
          if (deleteFailure) {
            throw new Error(`Failed to delete policy "${entry.name}": ${deleteFailure}`)
          }
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this policy — restore the captured prior values.
        const restore: Record<string, unknown> = {
          id: entry.id,
          description: entry.prior.description ?? '',
        }
        if (entry.prior.name !== undefined) restore.name = entry.prior.name
        if (entry.prior.enabled !== undefined) restore.enabled = entry.prior.enabled
        await updateFileVantage(client, FILEVANTAGE_POLICY_ENDPOINTS, restore)

        // Reverse exactly the assignment changes the deployment recorded.
        for (const groupId of entry.prior.hostGroupsAdded ?? []) {
          await policyGroupAction(client, POLICIES_HOST_GROUPS_PATH, entry.id, 'unassign', [groupId])
        }
        for (const groupId of entry.prior.hostGroupsRemoved ?? []) {
          await policyGroupAction(client, POLICIES_HOST_GROUPS_PATH, entry.id, 'assign', [groupId])
        }
        for (const groupId of entry.prior.ruleGroupsAdded ?? []) {
          await policyGroupAction(client, POLICIES_RULE_GROUPS_PATH, entry.id, 'unassign', [groupId])
        }
        for (const groupId of entry.prior.ruleGroupsRemoved ?? []) {
          await policyGroupAction(client, POLICIES_RULE_GROUPS_PATH, entry.id, 'assign', [groupId])
        }

        // Restore the prior rule-group precedence order.
        const priorOrder = entry.prior.ruleGroupsPriorOrder ?? []
        if (priorOrder.length >= 2) {
          await policyGroupAction(client, POLICIES_RULE_GROUPS_PATH, entry.id, 'precedence', priorOrder)
        }
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} FileVantage policy(ies): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} policy(ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
