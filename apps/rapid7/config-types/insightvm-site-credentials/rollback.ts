import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildInsightVMClient, insightVMErrorMessage } from '../../lib/insightvm'
import type { SiteCredentialRollbackEntry } from './deploy'

/**
 * Roll back site credentials using the state captured during deploy:
 *   - credentials that were created are deleted (DELETE /sites/{siteId}/site_credentials/{id})
 *   - credentials that were updated are restored (PUT) to their prior NON-secret
 *     fields (name / description / account minus password)
 *
 * ⚠ LIMITATION: the account password is WRITE-ONLY and is never read back, so a
 * restored credential cannot have its ORIGINAL secret re-applied — it keeps the
 * secret set at update time. Only the non-secret fields are reverted.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildInsightVMClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: SiteCredentialRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id != null) {
          const res = await client.request('DELETE', `/sites/${entry.siteId}/site_credentials/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete credential "${entry.label}": ${insightVMErrorMessage(res)}`)
          }
        }
      } else if (entry.id != null && entry.prior) {
        const p = entry.prior
        const restore: Record<string, unknown> = { name: p.name, description: p.description ?? '' }
        // account minus password — the write-only secret cannot be restored.
        if (p.account !== undefined) restore.account = p.account
        const res = await client.request('PUT', `/sites/${entry.siteId}/site_credentials/${entry.id}`, { body: restore })
        if (!res.ok) throw new Error(`Failed to restore credential "${entry.label}": ${insightVMErrorMessage(res)}`)
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} site credential(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
