import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildInsightIDRClient } from '../../lib/insightidr'
import { applyRuleEvents, type RuleSettingRollbackEntry } from './deploy'

/**
 * Roll back detection rule settings using the state captured during deploy: each
 * rule that was changed is restored to its prior rule action / priority via
 * POST /idr/v1/rules/update with the inverse SET events.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildInsightIDRClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: RuleSettingRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      const events = entry.restore.filter((e) => e.new_value)
      if (events.length === 0) continue
      try {
        await applyRuleEvents(client, entry.rrn, events)
      } catch (err) {
        throw new Error(`Failed to restore rule "${entry.label}": ${err instanceof Error ? err.message : 'Unknown error'}`)
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} detection rule(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
