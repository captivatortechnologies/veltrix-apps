import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient, vaultErrorMessage } from '../../lib/vault'
import type { MfaMethodRollbackEntry } from './deploy'

/**
 * Roll back login MFA methods using the state captured during deploy:
 *   - methods this deploy CREATED are deleted
 *     (DELETE /identity/mfa/method/{type}/{method_id})
 *   - methods this deploy UPDATED are restored to their prior NON-SECRET body
 *     (POST /identity/mfa/method/{type}/{method_id})
 *
 * TWO CAVEATS worth stating plainly:
 *   1. DELETING A METHOD REFERENCED BY A LOGIN-ENFORCEMENT BREAKS LOGINS for
 *      every principal that enforcement covers — the enforcement keeps pointing
 *      at a now-missing method_id. Rollback only ever deletes methods DEPLOY
 *      ITSELF CREATED, but if a login-enforcement was pointed at one of those new
 *      method_ids in the meantime, removing it will block those logins.
 *   2. WRITE-ONLY SECRETS CANNOT BE RESTORED. Vault never returns duo/okta/pingid
 *      secrets on GET, so deploy could not capture the previous values. Rollback
 *      restores only the non-secret config of an updated method; its secrets
 *      remain whatever the rolled-back deploy set (Vault keeps an omitted secret
 *      in place on update).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: MfaMethodRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  const deleted: string[] = []
  let restoredWithoutSecrets = false

  try {
    for (const entry of previousState) {
      const label = entry.methodName

      if (!entry.existed) {
        // Deploy CREATED this method — delete it. 404 means it is already gone,
        // which is the desired end state.
        if (entry.methodId) {
          const res = await client.request('DELETE', `/identity/mfa/method/${entry.type}/${entry.methodId}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete MFA method "${label}" (${entry.type}): ${vaultErrorMessage(res)}`)
          }
          deleted.push(label)
        }
      } else if (entry.methodId && entry.priorBody) {
        // Deploy UPDATED this method — restore the captured prior NON-SECRET body.
        // The secrets cannot be restored (write-only, never read back), so they
        // are intentionally NOT part of the restore payload.
        const res = await client.request(
          'POST',
          `/identity/mfa/method/${entry.type}/${entry.methodId}`,
          { body: entry.priorBody },
        )
        if (!res.ok) {
          throw new Error(`Failed to restore MFA method "${label}" (${entry.type}): ${vaultErrorMessage(res)}`)
        }
        if (entry.type !== 'totp') restoredWithoutSecrets = true
      }

      reverted.push(label)
    }

    const deleteNote = deleted.length
      ? ` WARNING: deleted ${deleted.length} newly-created method(s) (${deleted.join(', ')}) — if a login-enforcement referenced any of them, those logins will fail until it is updated.`
      : ''
    const secretNote = restoredWithoutSecrets
      ? ' Note: prior secret settings could NOT be restored on updated methods (secrets are write-only) — only the non-secret config was reverted.'
      : ''
    return {
      success: true,
      message: `Rolled back ${reverted.length} MFA method(s): ${reverted.join(', ')}.${deleteNote}${secretNote}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} method(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
