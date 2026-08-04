import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSysdigClient, type SysdigPostureControl } from '../../lib/sysdigApi'

/**
 * Undo a posture-controls deploy from rollbackData.previous.
 *   created → DELETE the control we added
 *   updated → POST the prior control body back with the same id (restore)
 *   deleted → POST the prior control body with no id (re-create; a new id is assigned)
 *   noop    → nothing to undo
 */
type ControlAction = 'created' | 'updated' | 'deleted' | 'noop'

interface RollbackEntry {
  name: string
  action: ControlAction
  controlId: string | null
  prior: SysdigPostureControl | null
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
          if (entry.controlId) {
            await client.deletePostureControlById(entry.controlId)
            removed++
          } else {
            skipped++
          }
          break
        case 'updated':
          if (entry.controlId && entry.prior) {
            await client.createOrUpdatePostureControl({ ...entry.prior, id: entry.controlId })
            restored++
          } else {
            skipped++
          }
          break
        case 'deleted':
          if (entry.prior) {
            const { id: _id, ...body } = entry.prior
            await client.createOrUpdatePostureControl(body as SysdigPostureControl)
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
      message: `Rolled back posture controls: ${restored} restored, ${recreated} re-created, ${removed} removed${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
