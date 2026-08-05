import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient, vaultErrorMessage } from '../../lib/vault'
import type { SentinelPolicyRollbackEntry } from './deploy'
import { sentinelKey } from './validate'

/**
 * Roll back Sentinel policies using the state captured during deploy:
 *   - policies this deploy CREATED are deleted (DELETE /sys/policies/{scope}/{name})
 *   - policies this deploy UPDATED are restored to their prior body,
 *     enforcement level and (for egp) paths (POST /sys/policies/{scope}/{name})
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: SentinelPolicyRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  const deleted: string[] = []

  try {
    for (const entry of previousState) {
      const key = sentinelKey(entry.scope, entry.name)

      if (!entry.existed) {
        // Deploy CREATED this policy — delete it. 404 means it is already gone,
        // which is the desired end state.
        const res = await client.request('DELETE', `/sys/policies/${entry.scope}/${encodeURIComponent(entry.name)}`)
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete Sentinel policy "${key}": ${vaultErrorMessage(res)}`)
        }
        deleted.push(key)
      } else if (entry.prior) {
        // Deploy UPDATED this policy — restore the prior body verbatim.
        const body: Record<string, unknown> = {
          policy: entry.prior.policy,
          enforcement_level: entry.prior.enforcementLevel,
        }
        if (entry.scope === 'egp' && entry.prior.paths) body.paths = entry.prior.paths

        const res = await client.request('POST', `/sys/policies/${entry.scope}/${encodeURIComponent(entry.name)}`, { body })
        if (!res.ok) {
          throw new Error(`Failed to restore Sentinel policy "${key}": ${vaultErrorMessage(res)}`)
        }
      }

      reverted.push(key)
    }

    const deleteNote = deleted.length ? ` Deleted ${deleted.length} newly-created polic(ies) (${deleted.join(', ')}).` : ''
    return {
      success: true,
      message: `Rolled back ${reverted.length} Sentinel polic(ies): ${reverted.join(', ')}.${deleteNote}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} polic(ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
