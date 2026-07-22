import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage, type OktaClient } from '../../lib/okta'
import { getUserById, reconcileLifecycle, type UserRollbackEntry } from './deploy'
import { ACTIVE_LIKE_STATUSES, type UserStatus } from './validate'

/**
 * Roll back users from the state captured during deploy. Safe-by-design, mirrors
 * the deploy guarantees:
 *   - users this deploy CREATED are DEACTIVATED (deprovisioned), never deleted —
 *     rollback stays reversible and can never destroy an account.
 *   - users this deploy UPDATED have their prior profile restored and their prior
 *     lifecycle state re-applied (best-effort).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: UserRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this user — deactivate it (NEVER delete).
        if (entry.id) {
          const res = await client.request('POST', `/users/${entry.id}/lifecycle/deactivate`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to deactivate created user "${entry.login}": ${oktaErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this user — restore the captured prior profile.
        const res = await client.request('POST', `/users/${entry.id}`, {
          body: { profile: entry.prior.profile },
        })
        if (!res.ok) {
          throw new Error(`Failed to restore user "${entry.login}": ${oktaErrorMessage(res)}`)
        }
        // Best-effort restore of the prior lifecycle state.
        const target = mapLiveStatusToTarget(entry.prior.status)
        if (target) {
          const live = await getUserById(client, entry.id)
          await reconcileLifecycle(client, entry.id, entry.login, live?.status ?? 'STAGED', target, false)
        }
      }

      reverted.push(entry.login)
    }

    return { success: true, message: `Rolled back ${reverted.length} user(s): ${reverted.join(', ')}.` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} user(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}

/** Map a captured live Okta status onto a reconcilable desired target (or null
 *  when it cannot be cleanly re-applied, e.g. STAGED/PROVISIONED). */
function mapLiveStatusToTarget(status: string): UserStatus | null {
  if (status === 'SUSPENDED') return 'SUSPENDED'
  if (status === 'DEPROVISIONED') return 'DEACTIVATED'
  if (ACTIVE_LIKE_STATUSES.includes(status) && status !== 'PROVISIONED') return 'ACTIVE'
  return null
}
