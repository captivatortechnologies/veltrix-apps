import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient, vaultErrorMessage } from '../../lib/vault'
import type { LeaseCountQuotaRollbackEntry } from './deploy'

/**
 * Roll back lease count quotas using the state captured during deploy:
 *   - quotas this deploy CREATED are deleted (DELETE /sys/quotas/lease-count/{name})
 *   - quotas this deploy OVERWROTE are restored to their prior fields (POST .../{name})
 *
 * Deleting a quota whose path was EMPTY removes the GLOBAL lease count limiter —
 * that leaves the whole Vault cluster's leases uncapped again. Rollback only ever
 * deletes quotas DEPLOY ITSELF CREATED (existed:false), never a pre-existing one,
 * and the result message calls out any global limiter that was removed.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: LeaseCountQuotaRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  const deletedGlobals: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy CREATED this quota — delete it. 404 means it is already gone,
        // which is the desired end state.
        const res = await client.request('DELETE', `/sys/quotas/lease-count/${entry.name}`)
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete lease count quota "${entry.name}": ${vaultErrorMessage(res)}`)
        }
        // An empty path meant this was the global limiter — deleting it removes
        // global lease capping from the entire cluster.
        if (entry.path === '') deletedGlobals.push(entry.name)
      } else if (entry.prior) {
        // Deploy OVERWROTE this quota — restore the captured prior fields.
        const body: Record<string, unknown> = {}
        if (entry.prior.max_leases !== undefined) body.max_leases = entry.prior.max_leases
        if (entry.prior.path !== undefined) body.path = entry.prior.path
        if (entry.prior.role !== undefined) body.role = entry.prior.role
        if (entry.prior.inheritable !== undefined) body.inheritable = entry.prior.inheritable

        const res = await client.request('POST', `/sys/quotas/lease-count/${entry.name}`, { body })
        if (!res.ok) {
          throw new Error(`Failed to restore lease count quota "${entry.name}": ${vaultErrorMessage(res)}`)
        }
      }

      reverted.push(entry.name)
    }

    const globalNote = deletedGlobals.length
      ? ` WARNING: deleted ${deletedGlobals.length} newly-created GLOBAL quota(s) (${deletedGlobals.join(', ')}) — ` +
        `this REMOVES global lease count limiting from the entire Vault cluster, leaving leases uncapped there.`
      : ''
    return {
      success: true,
      message: `Rolled back ${reverted.length} lease count quota(s): ${reverted.join(', ')}.${globalNote}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} quota(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
