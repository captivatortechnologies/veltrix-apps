import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildAkamaiClient } from '../../lib/akamaiApi'
import { edgeWorkerPath } from './_shared'

/**
 * Undo an EdgeWorkers deploy from rollbackData.previous (written by deploy()):
 *   - an EdgeWorker that PRE-EXISTED → PUT its prior groupId/resourceTierId back.
 *   - an EdgeWorker we CREATED (prior === null) → DELETE it (fails if it has
 *     active versions/activations — this config type never touches versions,
 *     so that would only happen if something else activated it in the
 *     interim; the failure surfaces as a rollback error).
 */

interface PriorEntry {
  name: string
  edgeWorkerId: number | null
  existed: boolean
  prior: { groupId: number; resourceTierId: number } | null
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const data = (ctx.rollbackData ?? {}) as { previous?: PriorEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const built = buildAkamaiClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  let restored = 0
  let deleted = 0
  let skipped = 0

  try {
    for (const entry of [...previous].reverse()) {
      if (entry.edgeWorkerId == null) {
        skipped++
        continue
      }
      if (entry.prior) {
        const res = await client.request('PUT', edgeWorkerPath(entry.edgeWorkerId), {
          body: { name: entry.name, groupId: entry.prior.groupId, resourceTierId: entry.prior.resourceTierId },
        })
        if (!res.ok) throw new Error(`PUT "${entry.name}" → HTTP ${res.status}: ${res.body.slice(0, 200)}`)
        restored++
      } else {
        const res = await client.request('DELETE', edgeWorkerPath(entry.edgeWorkerId))
        if (!res.ok && res.status !== 404) throw new Error(`DELETE "${entry.name}" → HTTP ${res.status}: ${res.body.slice(0, 200)}`)
        deleted++
      }
    }
    return { success: true, message: `Rolled back EdgeWorkers: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
