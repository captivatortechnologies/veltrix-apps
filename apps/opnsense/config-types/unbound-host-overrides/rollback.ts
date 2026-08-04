import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { deleteHostOverride, reconfigureUnbound, searchHostOverrides, setHostOverride, type HostOverrideBody, type LiveHostOverride } from '../../lib/unboundApi'
import { buildOpnsenseClient } from '../../lib/opnsenseApi'
import { hostOverrideKey } from './_shared'

export interface RollbackEntry {
  itemId?: string
  /** The (hostname, domain) composite key — see _shared.ts's hostOverrideKey. */
  key: string
  existed: boolean
  uuid?: string
  prior?: HostOverrideBody
}

/**
 * Roll back OPNsense Unbound host overrides using the state deploy captured:
 * overrides created THIS deploy (existed: false) are removed; overrides that
 * were updated (existed: true) are restored to their prior body. Re-found by
 * their current (hostname, domain) key, not a possibly-stale uuid. Applies
 * once at the end (restarts Unbound — see deploy.ts's module doc).
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
    const live = await searchHostOverrides(client)
    const liveByKey = new Map<string, LiveHostOverride>(
      live.filter((h) => h.hostname && h.domain).map((h) => [hostOverrideKey(h.hostname as string, h.domain as string), h]),
    )

    for (const entry of [...entries].reverse()) {
      const found = liveByKey.get(entry.key)

      if (entry.existed && entry.prior) {
        if (!found) {
          skipped++
          continue
        }
        await setHostOverride(client, found.uuid, entry.prior)
        restored++
      } else if (!entry.existed) {
        if (!found) {
          skipped++
          continue
        }
        await deleteHostOverride(client, found.uuid)
        removed++
      }
    }

    if (restored + removed > 0) {
      await reconfigureUnbound(client)
    }

    return {
      success: true,
      message:
        `Rolled back ${entries.length} OPNsense host override(s): ${removed} removed, ${restored} restored` +
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
