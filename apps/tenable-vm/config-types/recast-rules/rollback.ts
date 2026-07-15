import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildTenableClient, tenableErrorMessage } from '../../lib/tenable'
import type { RecastRollbackEntry } from './deploy'

/**
 * Roll back recast rules using the state captured during deploy:
 *   - rules that were created are deleted (DELETE /v1/recast/rules/{rule_id})
 *   - rules that were updated are restored (PUT) to their prior body
 *
 * Rollback keys on the stable rule_id captured at deploy time — never the
 * (resource_type, plugin, action) tuple — so restoring a rule whose fields the
 * deployment changed still targets the exact rule.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: RecastRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      const label = entry.name

      if (!entry.existed) {
        // Deploy created this rule — remove it. 404 means it is already gone
        // (or was never created), which is the desired end state.
        if (entry.ruleId) {
          const res = await client.request('DELETE', `/v1/recast/rules/${entry.ruleId}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete rule "${label}": ${tenableErrorMessage(res)}`)
          }
        }
      } else if (entry.ruleId && entry.prior) {
        // Deploy updated this rule — restore the captured prior body.
        const restore: Record<string, unknown> = {}
        if (entry.prior.resource_type !== undefined) restore.resource_type = entry.prior.resource_type
        if (entry.prior.rule_value !== undefined && entry.prior.rule_value !== null) {
          restore.rule_value = entry.prior.rule_value
        }
        if (entry.prior.filter !== undefined && entry.prior.filter !== null) {
          restore.filter = entry.prior.filter
        }
        // expires_at is restored explicitly (including null) so an expiry the
        // deployment set is cleared back to the prior state.
        if (entry.prior.expires_at !== undefined) restore.expires_at = entry.prior.expires_at

        const res = await client.request('PUT', `/v1/recast/rules/${entry.ruleId}`, { body: restore })
        if (!res.ok) {
          throw new Error(`Failed to restore rule "${label}": ${tenableErrorMessage(res)}`)
        }
      }

      reverted.push(label)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} recast rule(s): ${reverted.join(', ')}.`,
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
