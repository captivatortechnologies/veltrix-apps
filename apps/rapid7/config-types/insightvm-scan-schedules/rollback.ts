import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildInsightVMClient, insightVMErrorMessage } from '../../lib/insightvm'
import type { ScheduleRollbackEntry } from './deploy'

/**
 * Roll back scan schedules using the state captured during deploy:
 *   - schedules that were created are deleted (DELETE /scan_schedules/{id})
 *   - schedules that were updated are restored (PUT) to their prior body
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildInsightVMClient(ctx.component.hostname, ctx.credential, ctx.settings)
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
        if (entry.id != null) {
          const res = await client.request('DELETE', `/scan_schedules/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete schedule "${entry.label}": ${insightVMErrorMessage(res)}`)
          }
        }
      } else if (entry.id != null && entry.prior) {
        const p = entry.prior
        const restore: Record<string, unknown> = { scanName: p.scanName, enabled: p.enabled ?? true }
        if (p.scanTemplateId !== undefined) restore.scanTemplateId = p.scanTemplateId
        if (p.start !== undefined) restore.start = p.start
        if (p.duration !== undefined) restore.duration = p.duration
        if (p.repeat !== undefined) restore.repeat = p.repeat
        const res = await client.request('PUT', `/scan_schedules/${entry.id}`, { body: restore })
        if (!res.ok) throw new Error(`Failed to restore schedule "${entry.label}": ${insightVMErrorMessage(res)}`)
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
