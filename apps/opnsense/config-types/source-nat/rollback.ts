import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  applyFilterModule,
  buildOpnsenseClient,
  deleteSourceNatRule,
  searchSourceNatRules,
  setSourceNatRule,
  SOURCE_NAT_MODULE,
  type LiveSourceNatRule,
  type SourceNatRuleBody,
} from '../../lib/opnsenseApi'

export interface RollbackEntry {
  /** The canvas item's own stable id — see deploy.ts's module doc. */
  itemId: string
  description: string
  existed: boolean
  uuid?: string
  prior?: SourceNatRuleBody
}

/**
 * Roll back OPNsense source NAT rules using the state deploy captured: rules
 * created THIS deploy (existed: false) are removed (delRule); rules that
 * were updated (existed: true) are restored to their prior body (setRule).
 * Re-verifies each uuid still exists live before touching it. Applies once at
 * the end over everything this rollback touched.
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
    const live = await searchSourceNatRules(client)
    const liveByUuid = new Map<string, LiveSourceNatRule>(live.map((r) => [r.uuid, r]))

    for (const entry of [...entries].reverse()) {
      if (!entry.uuid) {
        skipped++
        continue
      }
      const found = liveByUuid.get(entry.uuid)
      if (!found) {
        skipped++
        continue
      }

      if (entry.existed && entry.prior) {
        await setSourceNatRule(client, entry.uuid, entry.prior)
        restored++
      } else if (!entry.existed) {
        await deleteSourceNatRule(client, entry.uuid)
        removed++
      }
    }

    if (restored + removed > 0) {
      await applyFilterModule(client, SOURCE_NAT_MODULE)
    }

    return {
      success: true,
      message:
        `Rolled back ${entries.length} OPNsense source NAT rule(s): ${removed} removed, ${restored} restored` +
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
