import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildQualysClient, qualysWriteError, type QualysParams } from '../../lib/qualys'
import { SCHEDULE_PATH, type ScheduleRollbackEntry } from './deploy'

/**
 * Roll back scan schedules using the state captured during deploy:
 *   - schedules that were created are deleted (action=delete)
 *   - schedules that were updated are best-effort restored (action=update) to
 *     their prior title / active flag / option profile. The classic list API
 *     does not expose a schedule's full timing in a re-submittable form, so the
 *     recurrence itself is not restored — created schedules roll back cleanly.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildQualysClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ScheduleRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.post(SCHEDULE_PATH, { action: 'delete', id: entry.id })
          const failed = qualysWriteError(res)
          if (failed && res.status !== 404) {
            throw new Error(`Failed to delete scan schedule "${entry.label}": ${failed}`)
          }
        }
      } else if (entry.id && entry.prior) {
        const p = entry.prior
        const params: QualysParams = {
          action: 'update',
          id: entry.id,
          scan_title: p.title,
          active: p.active ? 1 : 0,
        }
        if (p.optionProfileTitle) params.option_title = p.optionProfileTitle
        const res = await client.post(SCHEDULE_PATH, params)
        const failed = qualysWriteError(res)
        if (failed) throw new Error(`Failed to restore scan schedule "${entry.label}": ${failed}`)
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} scan schedule(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
