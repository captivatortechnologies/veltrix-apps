import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient, elasticErrorMessage } from '../../lib/elastic'
import { stripServerFields } from './validate'
import type { RuleRollbackEntry } from './deploy'

/**
 * Roll back detection rules using the state captured during deploy:
 *   - rules that were created are deleted
 *     (DELETE /api/detection_engine/rules?rule_id={rule_id}; 404 tolerated)
 *   - rules that were updated are restored (PUT) to their captured prior body
 *
 * The prior body is replayed through the same field-stripping as a deploy
 * (server-managed fields removed, `version` never sent) so the restore is a
 * clean full-replace back to the previous state. Only CUSTOM rules are ever in
 * the rollback set — deploy fails before capturing anything when a rule_id
 * collides with an Elastic prebuilt rule.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildElasticClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: RuleRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      const label = entry.ruleId

      if (!entry.existed) {
        // Deploy created this rule — remove it. 404 means it is already gone (or
        // was never created), which is the desired end state.
        const res = await client.kibana('DELETE', '/api/detection_engine/rules', {
          query: { rule_id: entry.ruleId },
        })
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete rule "${label}": ${elasticErrorMessage(res)}`)
        }
      } else if (entry.prior) {
        // Deploy updated this rule — restore the captured prior body via a
        // full-replace PUT (matched by the rule_id carried in the body).
        const body = stripServerFields(entry.prior)
        delete body.version
        body.rule_id = entry.ruleId

        const res = await client.kibana('PUT', '/api/detection_engine/rules', { body })
        if (!res.ok) {
          throw new Error(`Failed to restore rule "${label}": ${elasticErrorMessage(res)}`)
        }
      }

      reverted.push(label)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} detection rule(s): ${reverted.join(', ')}.`,
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
