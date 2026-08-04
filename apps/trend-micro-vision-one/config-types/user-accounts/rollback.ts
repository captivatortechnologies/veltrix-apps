import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildVisionOneClient, visionOneWriteError } from '../../lib/visionOneApi'
import { accountItemPath } from './_shared'
import type { AccountRollbackEntry } from './deploy'

/**
 * Undo a user-account deploy from rollbackData.previous (written by deploy()):
 * accounts we UPDATED are RESTORED to their prior role/status/description
 * (PATCH /iam/accounts/{id}); accounts we INVITED are REMOVED
 * (DELETE /iam/accounts/{id}). An invite whose id could not be resolved (the
 * invite response omitted it and the follow-up email lookup found nothing —
 * e.g. transient propagation delay) cannot be targeted for delete and is
 * reported as skipped rather than failing the whole rollback.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: AccountRollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for user-account rollback' }
  }

  const built = buildVisionOneClient(component?.hostname, credential, settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  let restored = 0
  let removed = 0
  let skipped = 0

  try {
    for (const entry of previous) {
      if (entry.prior) {
        const res = await client.patch(accountItemPath(entry.prior.id), {
          role: entry.prior.role,
          status: entry.prior.status,
          description: entry.prior.description,
        })
        const error = visionOneWriteError(res)
        if (error) return { success: false, message: `Rollback restore failed for ${entry.email}: ${error}` }
        restored++
      } else if (entry.createdId) {
        const res = await client.del(accountItemPath(entry.createdId))
        const error = visionOneWriteError(res)
        if (error) return { success: false, message: `Rollback remove failed for ${entry.email}: ${error}` }
        removed++
      } else {
        skipped++
      }
    }
    const skippedNote =
      skipped > 0 ? `, ${skipped} skipped (id could not be resolved after invite — remove manually in the console)` : ''
    return {
      success: true,
      message: `Rolled back user accounts: ${restored} restored, ${removed} removed${skippedNote}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
