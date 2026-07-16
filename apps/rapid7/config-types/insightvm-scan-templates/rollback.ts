import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildInsightVMClient, insightVMErrorMessage } from '../../lib/insightvm'
import type { TemplateRollbackEntry } from './deploy'

/**
 * Roll back scan templates using the state captured during deploy:
 *   - templates that were created are deleted (DELETE /scan_templates/{id})
 *   - templates that were updated are restored (PUT) to their prior document
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildInsightVMClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: TemplateRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        const res = await client.request('DELETE', `/scan_templates/${encodeURIComponent(entry.templateId)}`)
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete scan template "${entry.label}": ${insightVMErrorMessage(res)}`)
        }
      } else if (entry.prior) {
        // Full-replace restore: PUT the entire prior template document back.
        const res = await client.request('PUT', `/scan_templates/${encodeURIComponent(entry.templateId)}`, {
          body: entry.prior,
        })
        if (!res.ok) throw new Error(`Failed to restore scan template "${entry.label}": ${insightVMErrorMessage(res)}`)
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} scan template(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
