import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { deleteQueue, reconfigureTrafficShaper, searchQueues, setQueue, type LiveQueue, type QueueBody } from '../../lib/trafficShaperApi'
import { buildOpnsenseClient } from '../../lib/opnsenseApi'
import { queueKey } from './_shared'

export interface RollbackEntry {
  itemId?: string
  key: string
  existed: boolean
  uuid?: string
  prior?: QueueBody
}

/**
 * Roll back OPNsense traffic-shaper queues using the state deploy captured:
 * queues created THIS deploy (existed: false) are removed; queues that were
 * updated (existed: true) are restored to their prior body (including the
 * prior `pipe` uuid, captured verbatim — no re-resolution needed). Applies
 * once at the end.
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
    const live = await searchQueues(client)
    const liveByKey = new Map<string, LiveQueue>(live.filter((q) => q.description).map((q) => [queueKey(q.description as string), q]))

    for (const entry of [...entries].reverse()) {
      const found = liveByKey.get(entry.key)

      if (entry.existed && entry.prior) {
        if (!found) {
          skipped++
          continue
        }
        await setQueue(client, found.uuid, entry.prior)
        restored++
      } else if (!entry.existed) {
        if (!found) {
          skipped++
          continue
        }
        await deleteQueue(client, found.uuid)
        removed++
      }
    }

    if (restored + removed > 0) {
      await reconfigureTrafficShaper(client)
    }

    return {
      success: true,
      message:
        `Rolled back ${entries.length} OPNsense traffic-shaper queue(s): ${removed} removed, ${restored} restored` +
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
