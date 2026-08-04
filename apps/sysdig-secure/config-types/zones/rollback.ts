import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSysdigClient, type SysdigZone } from '../../lib/sysdigApi'

/**
 * Undo a zones deploy from rollbackData.previous.
 *   created → DELETE the zone we added
 *   updated → PUT the prior zone body back onto the same id
 *   deleted → POST the prior zone body to re-create it (a new id is assigned)
 *   noop    → nothing to undo
 */
type ZoneAction = 'created' | 'updated' | 'deleted' | 'noop'

interface RollbackEntry {
  name: string
  action: ZoneAction
  zoneId: number | null
  prior: SysdigZone | null
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const data = (ctx.rollbackData ?? {}) as { previous?: RollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const built = buildSysdigClient(ctx.component?.hostname ?? null, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  let restored = 0
  let removed = 0
  let recreated = 0
  let skipped = 0

  try {
    for (const entry of previous) {
      switch (entry.action) {
        case 'created':
          if (entry.zoneId != null) {
            await client.deleteZone(entry.zoneId)
            removed++
          } else {
            skipped++
          }
          break
        case 'updated':
          if (entry.zoneId != null && entry.prior) {
            await client.updateZone(entry.zoneId, { ...entry.prior, id: entry.zoneId })
            restored++
          } else {
            skipped++
          }
          break
        case 'deleted':
          if (entry.prior) {
            const { id: _id, ...body } = entry.prior
            await client.createZone(body as SysdigZone)
            recreated++
          } else {
            skipped++
          }
          break
        default:
          skipped++
      }
    }

    return {
      success: true,
      message: `Rolled back zones: ${restored} restored, ${recreated} re-created, ${removed} removed${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
