import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { deleteRoute, reconfigureRoutes, searchRoutes, setRoute, type LiveRoute, type RouteBody } from '../../lib/staticRoutesApi'
import { buildOpnsenseClient } from '../../lib/opnsenseApi'
import { routeKey } from './_shared'

export interface RollbackEntry {
  itemId?: string
  key: string
  existed: boolean
  uuid?: string
  prior?: RouteBody
}

/**
 * Roll back OPNsense static routes using the state deploy captured: routes
 * created THIS deploy (existed: false) are removed; routes that were
 * updated (existed: true) are restored to their prior body. Re-found by
 * their current network. Applies once at the end.
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
    const live = await searchRoutes(client)
    const liveByKey = new Map<string, LiveRoute>(live.filter((r) => r.network).map((r) => [routeKey(r.network as string), r]))

    for (const entry of [...entries].reverse()) {
      const found = liveByKey.get(entry.key)

      if (entry.existed && entry.prior) {
        if (!found) {
          skipped++
          continue
        }
        await setRoute(client, found.uuid, entry.prior)
        restored++
      } else if (!entry.existed) {
        if (!found) {
          skipped++
          continue
        }
        await deleteRoute(client, found.uuid)
        removed++
      }
    }

    if (restored + removed > 0) {
      await reconfigureRoutes(client)
    }

    return {
      success: true,
      message:
        `Rolled back ${entries.length} OPNsense static route(s): ${removed} removed, ${restored} restored` +
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
