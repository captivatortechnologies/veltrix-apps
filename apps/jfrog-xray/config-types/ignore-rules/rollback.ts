import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildXrayClient } from '../../lib/xrayApi'
import { ignoreRulePath, IGNORE_RULES_PATH, type IgnoreRuleEntry } from './deploy'

/**
 * Roll back Xray ignore rules using the state captured during deploy. Xray has
 * no update endpoint for ignore rules, so "restoring" a rule always means
 * re-CREATING it (with a NEW server-assigned id — the original id cannot be
 * revived):
 *   - "created":   delete the rule this deploy created.
 *   - "replaced":  delete the NEW rule; re-create the OLD rule's body.
 *   - "removed":   re-create the rule this deploy deleted during reconciliation.
 *   - "unchanged": nothing to do.
 * Processed in reverse deploy order, matching the platform's rollback convention.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildXrayClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const entries = (ctx.rollbackData as { entries?: IgnoreRuleEntry[] } | null)?.entries
  if (!entries || entries.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  let deleted = 0
  let recreated = 0

  try {
    for (const entry of [...entries].reverse()) {
      if (entry.action === 'unchanged') continue

      if (entry.action === 'created' && entry.ruleId) {
        const res = await client.deleteResource(ignoreRulePath(entry.ruleId))
        if (!res.ok && res.status !== 404) throw new Error(`Failed to delete ignore rule ${entry.ruleId}: HTTP ${res.status}`)
        deleted++
        continue
      }

      if (entry.action === 'replaced' && entry.ruleId) {
        const res = await client.deleteResource(ignoreRulePath(entry.ruleId))
        if (!res.ok && res.status !== 404) throw new Error(`Failed to delete ignore rule ${entry.ruleId}: HTTP ${res.status}`)
        deleted++
      }

      if ((entry.action === 'replaced' || entry.action === 'removed') && entry.previous) {
        const res = await client.request('POST', IGNORE_RULES_PATH, entry.previous.body)
        if (!res.ok) throw new Error(`Failed to re-create ignore rule: HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        recreated++
      }
    }

    return { success: true, message: `Rolled back ignore rules: ${deleted} deleted, ${recreated} re-created` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${deleted} deleted / ${recreated} re-created: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
