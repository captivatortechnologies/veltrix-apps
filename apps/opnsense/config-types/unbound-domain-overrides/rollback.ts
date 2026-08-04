import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { deleteDomainOverride, reconfigureUnbound, searchDomainOverrides, setDomainOverride, type DomainOverrideBody, type LiveDomainOverride } from '../../lib/unboundApi'
import { buildOpnsenseClient } from '../../lib/opnsenseApi'
import { domainOverrideKey } from './_shared'

export interface RollbackEntry {
  itemId?: string
  key: string
  existed: boolean
  uuid?: string
  prior?: DomainOverrideBody
}

/**
 * Roll back OPNsense Unbound domain overrides using the state deploy
 * captured: overrides created THIS deploy (existed: false) are removed;
 * overrides that were updated (existed: true) are restored to their prior
 * body. Re-found by their current domain, not a possibly-stale uuid.
 * Applies once at the end (restarts Unbound).
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
    const live = await searchDomainOverrides(client)
    const liveByKey = new Map<string, LiveDomainOverride>(live.filter((d) => d.domain).map((d) => [domainOverrideKey(d.domain as string), d]))

    for (const entry of [...entries].reverse()) {
      const found = liveByKey.get(entry.key)

      if (entry.existed && entry.prior) {
        if (!found) {
          skipped++
          continue
        }
        await setDomainOverride(client, found.uuid, entry.prior)
        restored++
      } else if (!entry.existed) {
        if (!found) {
          skipped++
          continue
        }
        await deleteDomainOverride(client, found.uuid)
        removed++
      }
    }

    if (restored + removed > 0) {
      await reconfigureUnbound(client)
    }

    return {
      success: true,
      message:
        `Rolled back ${entries.length} OPNsense domain override(s): ${removed} removed, ${restored} restored` +
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
