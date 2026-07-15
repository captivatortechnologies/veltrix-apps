import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient, vaultErrorMessage } from '../../lib/vault'
import type { EnforcementRollbackEntry } from './deploy'

/**
 * Roll back login-MFA enforcements using the state captured during deploy:
 *   - enforcements this deploy CREATED are deleted (DELETE
 *     /identity/mfa/login-enforcement/{name}, tolerating a 404 as already-gone)
 *   - enforcements this deploy UPDATED are restored to their prior authored body
 *     via the same upsert (POST /identity/mfa/login-enforcement/{name})
 *
 * Rollback keys on the stable name. Deleting an enforcement REMOVES MFA from the
 * logins it covered — those logins can then authenticate WITHOUT MFA, which
 * weakens security. The result message calls this out plainly.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: EnforcementRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  const deleted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy CREATED this enforcement — delete it. 404 means it is already
        // gone, which is the desired end state.
        const res = await client.request(
          'DELETE',
          `/identity/mfa/login-enforcement/${encodeURIComponent(entry.name)}`,
        )
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete login-MFA enforcement "${entry.name}": ${vaultErrorMessage(res)}`)
        }
        deleted.push(entry.name)
      } else if (entry.priorState) {
        // Deploy UPDATED this enforcement — restore the captured prior body via upsert.
        const res = await client.request(
          'POST',
          `/identity/mfa/login-enforcement/${encodeURIComponent(entry.name)}`,
          {
            body: {
              mfa_method_ids: entry.priorState.mfa_method_ids,
              auth_method_types: entry.priorState.auth_method_types,
              auth_method_accessors: entry.priorState.auth_method_accessors,
              identity_group_ids: entry.priorState.identity_group_ids,
              identity_entity_ids: entry.priorState.identity_entity_ids,
            },
          },
        )
        if (!res.ok) {
          throw new Error(`Failed to restore login-MFA enforcement "${entry.name}": ${vaultErrorMessage(res)}`)
        }
      }

      reverted.push(entry.name)
    }

    const deletedNote = deleted.length
      ? ` WARNING: deleted ${deleted.length} newly-created enforcement(s) (${deleted.join(', ')}) — the logins they covered no longer require MFA and can authenticate WITHOUT it.`
      : ''
    return {
      success: true,
      message: `Rolled back ${reverted.length} login-MFA enforcement(s): ${reverted.join(', ')}.${deletedNote}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} enforcement(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
