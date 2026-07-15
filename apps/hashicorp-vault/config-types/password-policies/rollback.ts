import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient, vaultErrorMessage } from '../../lib/vault'
import type { PasswordPolicyRollbackEntry } from './deploy'

/**
 * Roll back password generation policies using the state captured during deploy:
 *   - policies this deploy CREATED are deleted (DELETE /sys/policies/password/{name},
 *     tolerating a 404 as already-gone)
 *   - policies this deploy UPDATED are restored to their prior HCL body via the
 *     same upsert (POST /sys/policies/password/{name})
 *
 * Rollback keys on the stable name. Deleting a created password policy is
 * disruptive: any secret engine (e.g. a database dynamic role) that references
 * the policy by name to generate passwords loses it — subsequent password
 * generation for that engine fails until the reference is fixed.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: PasswordPolicyRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  const deleted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this policy — delete it. 404 means it is already gone,
        // which is the desired end state.
        const res = await client.request('DELETE', `/sys/policies/password/${encodeURIComponent(entry.name)}`)
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete password policy "${entry.name}": ${vaultErrorMessage(res)}`)
        }
        deleted.push(entry.name)
      } else if (entry.priorPolicy !== undefined) {
        // Deploy updated this policy — restore the captured prior HCL via upsert.
        const res = await client.request('POST', `/sys/policies/password/${encodeURIComponent(entry.name)}`, {
          body: { policy: entry.priorPolicy },
        })
        if (!res.ok) {
          throw new Error(`Failed to restore password policy "${entry.name}": ${vaultErrorMessage(res)}`)
        }
      }

      reverted.push(entry.name)
    }

    const deleteNote = deleted.length
      ? ` Note: deleted ${deleted.length} newly-created policy(ies) (${deleted.join(', ')}) — any secret engine referencing one by name for password generation loses it.`
      : ''
    return {
      success: true,
      message: `Rolled back ${reverted.length} password policy(ies): ${reverted.join(', ')}.${deleteNote}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} policy(ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
