import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildRunzeroUrl, buildAuthHeader, resolveRunzeroToken, runzeroRequest, sendJson, MISSING_CREDENTIAL_MESSAGE } from '../../lib/runzeroApi'
import { taskUpdateFromPrior, type ScanTaskRollbackEntry } from './_shared'

/**
 * Undo a scan-tasks deploy from rollbackData.previous (written by deploy):
 *   - a task that was CREATED (existed:false) is stopped (POST /org/tasks/{id}/stop) — runZero
 *     has no delete-a-task verb, so stop cancels a newly-scheduled recurring scan. A completed
 *     one-off scan cannot be un-run; stop is tolerated (404/terminal states are not failures).
 *   - a task that was UPDATED (existed:true) is restored to its prior body (PATCH /org/tasks/{id}).
 * Entries are reverted in reverse order. Applied over the runZero console REST API.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: ScanTaskRollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!resolveRunzeroToken(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const base = buildRunzeroUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)
  const timeoutMs = timeoutFrom(settings)

  let restored = 0
  let stopped = 0
  let left = 0
  try {
    for (const entry of [...previous].reverse()) {
      if (!entry.taskId) {
        left++
        continue
      }
      if (!entry.existed) {
        const res = await runzeroRequest(`${base}/org/tasks/${encodeURIComponent(entry.taskId)}/stop`, { method: 'POST', headers, timeoutMs })
        // A one-off scan that already finished cannot be stopped — tolerate 4xx here.
        if (res.status >= 500) {
          throw new Error(`Failed to stop scan task "${entry.name}": HTTP ${res.status}`)
        }
        stopped++
      } else if (entry.prior) {
        await sendJson('PATCH', `${base}/org/tasks/${encodeURIComponent(entry.taskId)}`, headers, taskUpdateFromPrior(entry.prior), timeoutMs)
        restored++
      } else {
        left++
      }
    }
    return {
      success: true,
      message: `Rolled back scan tasks: ${restored} restored, ${stopped} stopped${left ? `, ${left} left in place` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}

function timeoutFrom(settings: Record<string, unknown>): number | undefined {
  const raw = settings?.request_timeout_seconds
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw * 1000 : undefined
}
