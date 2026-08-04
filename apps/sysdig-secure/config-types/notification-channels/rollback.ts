import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSysdigClient, type SysdigNotificationChannel } from '../../lib/sysdigApi'

/**
 * Undo a notification-channels deploy from rollbackData.previous.
 *   created → DELETE the channel we added
 *   updated → PUT the prior channel body back onto the same id
 *   deleted → POST the prior channel body to re-create it (a new id is assigned)
 *   noop    → nothing to undo
 */
type ChannelAction = 'created' | 'updated' | 'deleted' | 'noop'

interface RollbackEntry {
  name: string
  action: ChannelAction
  channelId: number | null
  prior: SysdigNotificationChannel | null
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
          if (entry.channelId != null) {
            await client.deleteNotificationChannel(entry.channelId)
            removed++
          } else {
            skipped++
          }
          break
        case 'updated':
          if (entry.channelId != null && entry.prior) {
            await client.updateNotificationChannel(entry.channelId, { ...entry.prior, id: entry.channelId })
            restored++
          } else {
            skipped++
          }
          break
        case 'deleted':
          if (entry.prior) {
            const { id: _id, version: _version, ...body } = entry.prior
            await client.createNotificationChannel(body as SysdigNotificationChannel)
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
      message: `Rolled back notification channels: ${restored} restored, ${recreated} re-created, ${removed} removed${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
