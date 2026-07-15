import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient, vaultErrorMessage } from '../../lib/vault'
import type { QuotaRollbackEntry } from './deploy'

/**
 * Roll back rate limit quotas using the state captured during deploy:
 *   - quotas this deploy CREATED are deleted (DELETE /sys/quotas/rate-limit/{name})
 *   - quotas this deploy OVERWROTE are restored to their prior fields (POST .../{name})
 *
 * Deleting a quota whose path was EMPTY removes the GLOBAL rate limiter — that
 * leaves the whole Vault cluster's requests unthrottled again. Rollback only ever
 * deletes quotas DEPLOY ITSELF CREATED (existed:false), never a pre-existing one,
 * and the result message calls out any global limiter that was removed.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: QuotaRollbackEntry[] })?.previousState
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
        const res = await client.request('DELETE', `/sys/quotas/rate-limit/${entry.name}`)
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete rate limit quota "${entry.name}": ${vaultErrorMessage(res)}`)
        }
        // An empty path meant this was the global limiter — deleting it removes
        // global rate limiting from the entire cluster.
        if (entry.path === '') deletedGlobals.push(entry.name)
      } else if (entry.prior) {
        // Deploy OVERWROTE this quota — restore the captured prior fields. Vault
        // accepts the interval / block_interval seconds we read back as-is.
        const body: Record<string, unknown> = {}
        if (entry.prior.rate !== undefined) body.rate = entry.prior.rate
        if (entry.prior.path !== undefined) body.path = entry.prior.path
        if (entry.prior.interval !== undefined) body.interval = entry.prior.interval
        if (entry.prior.block_interval !== undefined) body.block_interval = entry.prior.block_interval
        if (entry.prior.role !== undefined) body.role = entry.prior.role

        const res = await client.request('POST', `/sys/quotas/rate-limit/${entry.name}`, { body })
        if (!res.ok) {
          throw new Error(`Failed to restore rate limit quota "${entry.name}": ${vaultErrorMessage(res)}`)
        }
      }

      reverted.push(entry.name)
    }

    const globalNote = deletedGlobals.length
      ? ` WARNING: deleted ${deletedGlobals.length} newly-created GLOBAL quota(s) (${deletedGlobals.join(', ')}) — ` +
        `this REMOVES global rate limiting from the entire Vault cluster, leaving those requests unthrottled.`
      : ''
    return {
      success: true,
      message: `Rolled back ${reverted.length} rate limit quota(s): ${reverted.join(', ')}.${globalNote}`,
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
