import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildExabeamClient, exabeamErrorMessage } from '../../lib/exabeam'
import type { RuleRollbackEntry } from './deploy'

/**
 * Roll back correlation rules using the state captured during deploy:
 *   - rules this deploy CREATED are deleted (DELETE /rules/{ruleId}). A 404
 *     means it is already gone, which is fine.
 *   - rules this deploy UPDATED are PUT back to their captured prior body.
 *
 * Rollback is keyed on the rule id Exabeam assigned, never on the name.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildExabeamClient(ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { entries?: RuleRollbackEntry[] })?.entries
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  let deleted = 0
  let restored = 0

  try {
    for (const entry of previousState) {
      if (!entry.ruleId) continue

      if (!entry.existed) {
        // Deploy created this rule — remove it.
        const del = await client.request('DELETE', `/correlation-rules/v2/rules/${encodeURIComponent(entry.ruleId)}`)
        if (!del.ok && del.status !== 404) {
          throw new Error(`Failed to delete rule "${entry.name}": ${exabeamErrorMessage(del)}`)
        }
        deleted++
      } else if (entry.prior) {
        // Deploy updated this rule — restore its captured prior body.
        const res = await client.request('PUT', `/correlation-rules/v2/rules/${encodeURIComponent(entry.ruleId)}`, {
          body: entry.prior,
        })
        if (!res.ok) {
          throw new Error(`Failed to restore rule "${entry.name}": ${exabeamErrorMessage(res)}`)
        }
        restored++
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} correlation rule(s): ${deleted} deleted, ${restored} restored.`,
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
