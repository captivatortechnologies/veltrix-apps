import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildTenableClient, tenableErrorMessage } from '../../lib/tenable'
import type { RecastRollbackEntry } from './deploy'

/**
 * Roll back recast rules using the state captured during deploy:
 *   - rules that were created are deleted (DELETE /v1/recast/rules/{rule_id})
 *   - rules that were updated are restored (PUT) to their prior body
 *
 * Rollback keys on the stable rule_id captured at deploy time — never the
 * rule_name — so restoring a rule whose fields the deployment changed still
 * targets the exact rule. The restore body is the FULL prior state (Tenable's
 * PUT replaces rather than merges).
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
        // Deploy updated this rule — restore the captured prior body in full
        // (resource_type, rule_value and filter are all required by the API).
        const restore: Record<string, unknown> = {
          rule_name: entry.prior.rule_name ?? entry.name,
          resource_type: entry.prior.resource_type,
          rule_value: entry.prior.rule_value ?? { action: 'ACCEPT' },
          filter: entry.prior.filter ?? {},
        }
        if (entry.prior.description !== undefined) restore.description = entry.prior.description
        // expires_at/disabled_details are restored explicitly (including
        // null/absent) so a value the deployment set is cleared back to prior.
        if (entry.prior.expires_at !== undefined) restore.expires_at = entry.prior.expires_at
        if (entry.prior.disabled_details !== undefined) restore.disabled_details = entry.prior.disabled_details

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
