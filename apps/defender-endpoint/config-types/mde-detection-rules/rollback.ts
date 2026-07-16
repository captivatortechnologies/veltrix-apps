// =============================================================================
// Roll back a detection-rule deploy via the Microsoft Graph BETA API.
//
// Undo runs in reverse order: rules this deploy CREATED are deleted (a 404 is
// tolerated — already gone), and rules it UPDATED are restored by PATCHing the
// captured pre-deploy state back on. It only touches rules the deploy recorded.
// =============================================================================

import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildMdeClient, mdeErrorMessage } from '../../lib/mde'
import { buildRuleBody, ruleToSpec } from './validate'
import type { DetectionRuleRollbackEntry } from './deploy'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildMdeClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  if (!client.graphAvailable) {
    return { success: false, message: 'Custom detection rules require Microsoft Graph, which is only available in the commercial cloud.' }
  }

  const previousState = (ctx.rollbackData as { previousState?: DetectionRuleRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id != null) {
          const res = await client.graph('DELETE', `/security/rules/detectionRules/${entry.id}`)
          if (res.status !== 404 && !res.ok) throw new Error(`Failed to delete detection rule "${entry.label}": ${mdeErrorMessage(res)}`)
        }
      } else if (entry.prior && entry.id != null) {
        const res = await client.graph('PATCH', `/security/rules/detectionRules/${entry.id}`, { body: buildRuleBody(ruleToSpec(entry.prior)) })
        if (!res.ok) throw new Error(`Failed to restore detection rule "${entry.label}": ${mdeErrorMessage(res)}`)
      }
      reverted.push(entry.label)
    }
    return { success: true, message: `Rolled back ${reverted.length} detection rule(s)` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
