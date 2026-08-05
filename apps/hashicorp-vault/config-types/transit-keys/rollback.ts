import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient, vaultErrorMessage } from '../../lib/vault'
import type { TransitKeyRollbackEntry } from './deploy'
import { keyKey } from './validate'

/**
 * Roll back transit keys using the state captured during deploy:
 *   - keys this deploy CREATED are DELETED — see the destructiveness note below
 *   - keys this deploy TUNED are restored to their prior tunable config
 *     (POST {mount}/keys/{name}/config)
 *
 * DELETING A TRANSIT KEY PERMANENTLY DESTROYS ITS MATERIAL. Vault refuses to
 * delete a key unless `deletion_allowed` is currently true, so rollback FIRST
 * force-enables deletion_allowed on a key it is about to remove (safe here
 * specifically because THIS deploy created that key — removing it is exactly
 * what undoing the deploy means), then deletes it. A key this deploy only
 * TUNED is never deleted, and its write-once fields (exportable,
 * allow_plaintext_backup) are never restored if this deploy escalated them to
 * true — Vault does not allow reverting them, so the result message says so.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: TransitKeyRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  const destroyed: string[] = []

  try {
    for (const entry of previousState) {
      const key = keyKey(entry.mount, entry.name)

      if (!entry.existed) {
        // Deploy CREATED this key — force-enable deletion, then delete it.
        // This PERMANENTLY DESTROYS the key's material; 404 on delete means it
        // is already gone, which is the desired end state.
        const allowRes = await client.request('POST', `/${entry.mount}/keys/${entry.name}/config`, {
          body: { deletion_allowed: true },
        })
        if (!allowRes.ok && allowRes.status !== 404) {
          throw new Error(`Failed to enable deletion for transit key "${key}": ${vaultErrorMessage(allowRes)}`)
        }
        const res = await client.request('DELETE', `/${entry.mount}/keys/${entry.name}`)
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete transit key "${key}": ${vaultErrorMessage(res)}`)
        }
        destroyed.push(key)
      } else if (entry.priorConfig) {
        // Deploy TUNED this key — restore the captured prior tunables.
        // exportable / allow_plaintext_backup are intentionally NOT part of the
        // restore body: Vault does not allow reverting them once true, so if
        // this deploy escalated either, that escalation cannot be undone.
        const body: Record<string, unknown> = {}
        if (entry.priorConfig.deletion_allowed !== undefined) body.deletion_allowed = entry.priorConfig.deletion_allowed
        if (entry.priorConfig.min_decryption_version !== undefined) body.min_decryption_version = entry.priorConfig.min_decryption_version
        if (entry.priorConfig.min_encryption_version !== undefined) body.min_encryption_version = entry.priorConfig.min_encryption_version
        if (entry.priorConfig.auto_rotate_period !== undefined) body.auto_rotate_period = entry.priorConfig.auto_rotate_period

        const res = await client.request('POST', `/${entry.mount}/keys/${entry.name}/config`, { body })
        if (!res.ok) {
          throw new Error(`Failed to restore configuration for transit key "${key}": ${vaultErrorMessage(res)}`)
        }
      }

      reverted.push(key)
    }

    const destroyNote = destroyed.length
      ? ` WARNING: destroyed ${destroyed.length} newly-created key(s) (${destroyed.join(', ')}) — this PERMANENTLY DESTROYS their key material; anything encrypted under them can never be decrypted again.`
      : ''
    return {
      success: true,
      message: `Rolled back ${reverted.length} transit key(s): ${reverted.join(', ')}.${destroyNote}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} key(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
