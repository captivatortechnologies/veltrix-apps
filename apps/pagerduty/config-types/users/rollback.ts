import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildPagerDutyClient, pagerDutyErrorMessage } from '../../lib/pagerdutyApi'
import { userRestoreBody } from './_shared'
import type { UserRollbackEntry } from './deploy'

/**
 * Undo a users deploy from rollbackData.previousState (written by deploy()), in
 * reverse order:
 *   - a user that was CREATED is deleted (DELETE /users/{id}) — this deletes the
 *     PagerDuty user account, which is the intentional, expected rollback of a
 *     user this app created
 *   - a user that was UPDATED is restored (PUT) to their prior body
 * Applied over the PagerDuty REST API v2.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildPagerDutyClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: UserRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: true, message: 'Nothing to roll back.' }
  }

  const reverted: string[] = []
  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `/users/${encodeURIComponent(entry.id)}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete user "${entry.email}": ${pagerDutyErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        const body = { user: userRestoreBody(entry.prior) }
        const res = await client.request('PUT', `/users/${encodeURIComponent(entry.id)}`, { body })
        if (!res.ok) throw new Error(`Failed to restore user "${entry.email}": ${pagerDutyErrorMessage(res)}`)
      }
      reverted.push(entry.email)
    }

    return { success: true, message: `Rolled back ${reverted.length} user(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
