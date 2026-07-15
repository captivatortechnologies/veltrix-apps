import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient, zscalerErrorMessage } from '../../lib/zscaler'
import { getPolicySetId, type PolicyRuleRollbackEntry } from './deploy'

/**
 * Roll back ZPA policy rules using the state captured during deploy:
 *   - rules that were created are deleted (DELETE /policySet/{setId}/rule/{id})
 *   - rules that were updated are restored (PUT) to their prior body
 * The CRUD path is keyed by the policy set id, so each entry carries the set id
 * it resolved to; if that is ever missing it is re-resolved from the stored
 * policy type. ZPA changes are immediate, so no activation is needed.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: PolicyRuleRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  // Re-resolve set ids at most once per policy type, if any were not stored.
  const policySetCache = new Map<string, string>()

  try {
    for (const entry of [...previousState].reverse()) {
      const policySetId = entry.policySetId || (await getPolicySetId(client, entry.policyType, policySetCache))
      const label = `${entry.policyType}/${entry.name}`

      if (!entry.existed) {
        if (entry.ruleId != null) {
          const res = await client.zpa('DELETE', `/policySet/${policySetId}/rule/${entry.ruleId}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete policy rule "${label}": ${zscalerErrorMessage(res)}`)
          }
        }
      } else if (entry.ruleId != null && entry.prior) {
        const restore: Record<string, unknown> = {
          id: entry.ruleId,
          name: entry.prior.name ?? entry.name,
          description: entry.prior.description ?? '',
          policySetId,
          operator: 'AND',
          conditions: Array.isArray(entry.prior.conditions) ? entry.prior.conditions : [],
        }
        if (entry.prior.action) restore.action = entry.prior.action
        const res = await client.zpa('PUT', `/policySet/${policySetId}/rule/${entry.ruleId}`, { body: restore })
        if (!res.ok) {
          throw new Error(`Failed to restore policy rule "${label}": ${zscalerErrorMessage(res)}`)
        }
      }
      reverted.push(label)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} ZPA policy rule(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} rule(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
