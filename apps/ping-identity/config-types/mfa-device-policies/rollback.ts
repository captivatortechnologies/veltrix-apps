import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildPingOneClient, pingOneErrorMessage } from '../../lib/pingOne'
import type { MfaPolicyRollbackEntry } from './deploy'

/**
 * Roll back MFA device authentication policies using the state captured
 * during deploy:
 *   - policies this deploy CREATED are deleted (a 404 means it is already
 *     gone, which is fine).
 *   - policies this deploy UPDATED are PUT back to their captured prior body.
 * Rollback is keyed on the policy id PingOne returned, never on the name.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildPingOneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: MfaPolicyRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this policy - remove it.
        if (entry.id) {
          const del = await client.request('DELETE', `/deviceAuthenticationPolicies/${entry.id}`)
          if (!del.ok && del.status !== 404) {
            throw new Error(`Failed to delete MFA device policy "${entry.name}": ${pingOneErrorMessage(del)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this policy - restore its captured prior body.
        const res = await client.request('PUT', `/deviceAuthenticationPolicies/${entry.id}`, { body: entry.prior })
        if (!res.ok) {
          throw new Error(`Failed to restore MFA device policy "${entry.name}": ${pingOneErrorMessage(res)}`)
        }
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} MFA device authentication policy(ies): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} polic${
        previousState.length === 1 ? 'y' : 'ies'
      }: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
