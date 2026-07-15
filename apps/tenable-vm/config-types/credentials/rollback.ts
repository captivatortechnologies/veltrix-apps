import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildTenableClient, tenableErrorMessage } from '../../lib/tenable'
import type { CredentialRollbackEntry } from './deploy'

/**
 * Roll back credentials using the state captured during deploy:
 *   - credentials that were created are deleted (DELETE /credentials/{uuid})
 *   - credentials that were updated are restored (PUT) to their prior
 *     NON-SECRET body (name / description / type)
 *
 * SECRET-BEARING LIMITATION: the per-type `settings` object holds write-only
 * secrets that Tenable never returns on read, so the deploy could not capture
 * the previous secret values. Rollback therefore CANNOT restore the prior
 * secrets on an updated credential — it restores only the non-secret metadata,
 * and the settings pushed by the rolled-back deploy remain in place. Rolling
 * back a NEWLY-CREATED credential fully removes it (secrets and all).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: CredentialRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  // Track whether any updated credential had its (non-secret) metadata restored
  // while its secrets could not be reverted, so the message can be honest.
  let restoredWithoutSecrets = false

  try {
    for (const entry of previousState) {
      const label = entry.name

      if (!entry.existed) {
        // Deploy created this credential — remove it. 404 means it is already
        // gone (or was never created), which is the desired end state.
        if (entry.uuid) {
          const res = await client.request('DELETE', `/credentials/${entry.uuid}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete credential "${label}": ${tenableErrorMessage(res)}`)
          }
        }
      } else if (entry.uuid && entry.prior) {
        // Deploy updated this credential — restore the captured prior NON-SECRET
        // body. The secret settings CANNOT be restored (write-only, never read
        // back), so they are intentionally NOT part of the restore payload.
        const restore: Record<string, unknown> = {}
        if (entry.prior.name !== undefined) restore.name = entry.prior.name
        if (entry.prior.type !== undefined) restore.type = entry.prior.type
        if (entry.prior.description !== undefined) restore.description = entry.prior.description

        const res = await client.request('PUT', `/credentials/${entry.uuid}`, { body: restore })
        if (!res.ok) {
          throw new Error(`Failed to restore credential "${label}": ${tenableErrorMessage(res)}`)
        }
        restoredWithoutSecrets = true
      }

      reverted.push(label)
    }

    const secretNote = restoredWithoutSecrets
      ? ' Note: prior secret settings could NOT be restored on updated credentials (secrets are write-only) — only name/description/type were reverted.'
      : ''
    return {
      success: true,
      message: `Rolled back ${reverted.length} credential(s): ${reverted.join(', ')}.${secretNote}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} credential(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
