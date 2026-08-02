import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { applyFilterModule, buildOpnsenseClient, deleteFilterRule, FILTER_MODULE, searchFilterRules, setFilterRule, type FilterRuleBody, type LiveFilterRule } from '../../lib/opnsenseApi'

export interface RollbackEntry {
  /** The canvas item's own stable id — see deploy.ts's module doc. */
  itemId: string
  description: string
  /** Whether this itemId was already tracked (setRule) vs newly created (addRule) THIS deploy. */
  existed: boolean
  uuid?: string
  prior?: FilterRuleBody
}

/**
 * Roll back OPNsense filter rules using the state deploy captured: rules
 * created THIS deploy (existed: false) are removed (delRule); rules that
 * were updated (existed: true) are restored to their prior body (setRule).
 * Re-verifies each uuid still exists live (searchRule) before touching it —
 * it may have been removed by hand outside this app. Applies once at the end
 * over everything this rollback touched (same stage-then-apply model as deploy).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const entries = (ctx.rollbackData as { entries?: RollbackEntry[] } | undefined)?.entries
  if (!entries || entries.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const built = buildOpnsenseClient(ctx.component.hostname, ctx.component.port, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  let restored = 0
  let removed = 0
  let skipped = 0

  try {
    const live = await searchFilterRules(client)
    const liveByUuid = new Map<string, LiveFilterRule>(live.map((r) => [r.uuid, r]))

    for (const entry of [...entries].reverse()) {
      if (!entry.uuid) {
        skipped++
        continue
      }
      const found = liveByUuid.get(entry.uuid)
      if (!found) {
        skipped++ // already gone
        continue
      }

      if (entry.existed && entry.prior) {
        await setFilterRule(client, entry.uuid, entry.prior)
        restored++
      } else if (!entry.existed) {
        await deleteFilterRule(client, entry.uuid)
        removed++
      }
    }

    if (restored + removed > 0) {
      await applyFilterModule(client, FILTER_MODULE)
    }

    return {
      success: true,
      message:
        `Rolled back ${entries.length} OPNsense filter rule(s): ${removed} removed, ${restored} restored` +
        `${skipped ? `, ${skipped} skipped (already changed outside this app)` : ''}.`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${removed} removed, ${restored} restored: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
