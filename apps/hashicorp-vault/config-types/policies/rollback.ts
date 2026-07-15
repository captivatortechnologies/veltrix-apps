import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient, vaultErrorMessage } from '../../lib/vault'
import type { PolicyRollbackEntry } from './deploy'
import { isDefaultPolicy, isRootPolicy } from './validate'

/**
 * Roll back ACL policies using the state captured during deploy:
 *   - policies this deploy CREATED are deleted (DELETE /sys/policies/acl/{name},
 *     tolerating a 404 as already-gone)
 *   - policies this deploy UPDATED are restored to their prior HCL body via the
 *     same upsert (POST /sys/policies/acl/{name})
 *
 * Rollback keys on the stable (lowercased) name. It NEVER touches `root` and
 * never DELETEs `default` — those are protected. Deleting a created policy is
 * destructive: any token relying on it loses those grants.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: PolicyRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      // The root policy is never managed — leave it untouched no matter what.
      if (isRootPolicy(entry.name)) continue

      if (!entry.existed) {
        // Deploy created this policy — delete it. `default` can never be a created
        // policy (it always exists), but guard against ever deleting it anyway.
        if (isDefaultPolicy(entry.name)) continue
        const res = await client.request('DELETE', `/sys/policies/acl/${encodeURIComponent(entry.name)}`)
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete policy "${entry.name}": ${vaultErrorMessage(res)}`)
        }
      } else if (entry.priorPolicy !== undefined) {
        // Deploy updated this policy — restore the captured prior HCL via upsert.
        const res = await client.request('POST', `/sys/policies/acl/${encodeURIComponent(entry.name)}`, {
          body: { policy: entry.priorPolicy },
        })
        if (!res.ok) {
          throw new Error(`Failed to restore policy "${entry.name}": ${vaultErrorMessage(res)}`)
        }
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} policy(ies): ${reverted.join(', ')}. Note: deleting a created policy removes it from Vault — any token relying on it loses those grants.`,
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
