import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildAkamaiClient } from '../../lib/akamaiApi'
import { activationsPath, deactivationsPath } from './_shared'

/**
 * Undo an EdgeWorker Activation deploy from rollbackData.previous (written by
 * deploy()). Unlike Network List Activation, the EdgeWorkers API exposes a
 * REAL deactivation resource (a separate endpoint, not a flag on the same
 * call), so this genuinely undoes the promotion rather than being a
 * documented no-op:
 *   - a target this deploy ACTIVATED, that had a PRIOR effective version →
 *     re-activate that prior version (POST .../activations).
 *   - a target this deploy ACTIVATED, that had NO prior effective version →
 *     deactivate the version we activated (POST .../deactivations), returning
 *     the EdgeWorker to "never activated" on that network.
 *   - a target that was SKIPPED (already active / left alone in-flight) →
 *     nothing to undo.
 */

interface PriorEntry {
  edgeWorkerName: string
  edgeWorkerId: number
  network: string
  priorEffectiveVersion: string | null
  activatedVersion: string | null
  outcome: string
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const data = (ctx.rollbackData ?? {}) as { previous?: PriorEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const built = buildAkamaiClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  let reactivated = 0
  let deactivated = 0
  let skipped = 0

  try {
    for (const entry of [...previous].reverse()) {
      if (entry.outcome !== 'activated' || entry.activatedVersion == null) {
        skipped++
        continue
      }

      const label = `${entry.edgeWorkerName} → ${entry.network}`

      if (entry.priorEffectiveVersion != null) {
        const res = await client.request('POST', activationsPath(entry.edgeWorkerId), {
          body: { network: entry.network, version: entry.priorEffectiveVersion },
        })
        if (!res.ok) throw new Error(`re-activate "${label}" (v${entry.priorEffectiveVersion}) → HTTP ${res.status}: ${res.body.slice(0, 200)}`)
        reactivated++
      } else {
        const res = await client.request('POST', deactivationsPath(entry.edgeWorkerId), {
          body: { network: entry.network, version: entry.activatedVersion },
        })
        if (!res.ok) throw new Error(`deactivate "${label}" (v${entry.activatedVersion}) → HTTP ${res.status}: ${res.body.slice(0, 200)}`)
        deactivated++
      }
    }

    return {
      success: true,
      message: `Rolled back EdgeWorker activations: ${reactivated} re-activated to prior version, ${deactivated} deactivated${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
