import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildInsightVMClient, insightVMErrorMessage } from '../../lib/insightvm'
import type { ReportConfigRollbackEntry } from './deploy'

/**
 * Roll back report configurations using the state captured during deploy:
 *   - reports that were created are deleted (DELETE /reports/{id})
 *   - reports that were updated are restored (PUT) to their prior document
 *
 * This only ever touches the report CONFIGURATION — it never deletes generated
 * report output (history), which is unaffected by rollback.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildInsightVMClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ReportConfigRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id != null) {
          const res = await client.request('DELETE', `/reports/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete report "${entry.label}": ${insightVMErrorMessage(res)}`)
          }
        }
      } else if (entry.id != null && entry.prior) {
        const res = await client.request('PUT', `/reports/${entry.id}`, { body: entry.prior })
        if (!res.ok) throw new Error(`Failed to restore report "${entry.label}": ${insightVMErrorMessage(res)}`)
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} report configuration(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
