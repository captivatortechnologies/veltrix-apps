import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildPingOneClient, pingOneErrorMessage } from '../../lib/pingOne'
import type { RiskPolicySetRollbackEntry } from './deploy'

/**
 * Roll back risk policy sets using the state captured during deploy:
 *   - sets this deploy CREATED are deleted.
 *   - sets this deploy UPDATED are PUT back to their captured prior body
 *     (already stripped of readOnly fields and each riskPolicies[].priority).
 *
 * Rollback is keyed on the set id PingOne returned, never on the name.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildPingOneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: RiskPolicySetRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this set - remove it. A 404 means it is already gone.
        if (entry.id) {
          const del = await client.request('DELETE', `/riskPolicySets/${entry.id}`)
          if (!del.ok && del.status !== 404) {
            throw new Error(`Failed to delete risk policy set "${entry.name}": ${pingOneErrorMessage(del)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this set - restore its captured prior body.
        const res = await client.request('PUT', `/riskPolicySets/${entry.id}`, { body: entry.prior })
        if (!res.ok) {
          throw new Error(`Failed to restore risk policy set "${entry.name}": ${pingOneErrorMessage(res)}`)
        }
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} risk policy set(s): ${reverted.join(', ')}.`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} risk policy set(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
