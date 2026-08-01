import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSysdigClient, type SysdigList } from '../../lib/sysdigApi'

/**
 * Undo a Falco-lists deploy from rollbackData.previous (written by deploy()).
 * Per entry, reverse the action taken:
 *   created → DELETE the list we added
 *   updated → PUT the prior list body back onto the same id (restore)
 *   deleted → POST the prior list body to re-create it (a new id is assigned)
 *   noop    → nothing to undo
 * Applied over the Sysdig Secure REST API.
 */
type ListAction = 'created' | 'updated' | 'deleted' | 'noop'

interface RollbackEntry {
  name: string
  action: ListAction
  listId: number | null
  prior: SysdigList | null
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
          if (entry.listId != null) {
            await client.deleteFalcoList(entry.listId)
            removed++
          } else {
            skipped++
          }
          break
        case 'updated':
          if (entry.listId != null && entry.prior) {
            await client.updateFalcoList(entry.listId, { ...entry.prior, id: entry.listId })
            restored++
          } else {
            skipped++
          }
          break
        case 'deleted':
          if (entry.prior) {
            const { id: _id, version: _version, ...body } = entry.prior
            await client.createFalcoList(body as SysdigList)
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
      message: `Rolled back Falco lists: ${restored} restored, ${recreated} re-created, ${removed} removed${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
