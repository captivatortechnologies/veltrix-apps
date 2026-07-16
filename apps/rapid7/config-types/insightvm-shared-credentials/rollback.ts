import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildInsightVMClient, insightVMErrorMessage } from '../../lib/insightvm'
import type { CredentialRollbackEntry } from './deploy'

/**
 * Roll back shared credentials using the state captured during deploy:
 *   - credentials that were created are deleted (DELETE /shared_credentials/{id})
 *   - credentials that were updated are restored (PUT) to their prior state
 *
 * ⚠ SECRET LIMITATION: the account password/key is write-only and the API masks
 * it on read, so it is NEVER captured during deploy. An UPDATED credential can
 * therefore only be restored to its prior NON-secret fields (name, description,
 * account minus password). The credential keeps whatever password the deploy set
 * — the secret from before the update cannot be recovered and must be re-entered
 * by an operator if the old value is required.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildInsightVMClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: CredentialRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id != null) {
          const res = await client.request('DELETE', `/shared_credentials/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete credential "${entry.label}": ${insightVMErrorMessage(res)}`)
          }
        }
      } else if (entry.id != null && entry.prior) {
        const p = entry.prior
        // Restore NON-secret fields only. The write-only password is intentionally
        // absent from `p.account` and cannot be restored (see the header note).
        const restore: Record<string, unknown> = { name: p.name }
        if (p.description !== undefined) restore.description = p.description
        if (p.account !== undefined) restore.account = p.account
        const res = await client.request('PUT', `/shared_credentials/${entry.id}`, { body: restore })
        if (!res.ok) throw new Error(`Failed to restore credential "${entry.label}": ${insightVMErrorMessage(res)}`)
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} shared credential(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
