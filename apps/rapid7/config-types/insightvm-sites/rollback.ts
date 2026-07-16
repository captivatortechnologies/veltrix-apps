import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildInsightVMClient, insightVMErrorMessage } from '../../lib/insightvm'
import type { SiteRollbackEntry } from './deploy'

/**
 * Roll back sites using the state captured during deploy:
 *   - sites that were created are deleted (DELETE /sites/{id})
 *   - sites that were updated are restored (PUT) to their prior body
 *
 * The prior snapshot comes from the GET /sites summary, which carries name /
 * description / importance but not the scan targets, so an updated site is
 * restored on a best-effort basis (those top-level fields only).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildInsightVMClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: SiteRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id != null) {
          const res = await client.request('DELETE', `/sites/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete site "${entry.label}": ${insightVMErrorMessage(res)}`)
          }
        }
      } else if (entry.id != null && entry.prior) {
        const p = entry.prior
        const restore: Record<string, unknown> = {
          name: p.name,
          description: p.description ?? '',
          importance: p.importance ?? 'normal',
        }
        const res = await client.request('PUT', `/sites/${entry.id}`, { body: restore })
        if (!res.ok) throw new Error(`Failed to restore site "${entry.label}": ${insightVMErrorMessage(res)}`)
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} site(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
