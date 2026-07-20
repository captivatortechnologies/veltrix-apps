import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage } from '../../lib/okta'
import { type DeviceAssuranceRollbackEntry } from './deploy'

/**
 * Roll back device assurance policies using the state captured during deploy:
 *   - policies this deploy CREATED are deleted. Okta returns 409 if the policy is
 *     still mapped to an Authentication Policy — that error is surfaced clearly so
 *     the operator can unmap it first. A 404 means it is already gone.
 *   - policies this deploy UPDATED are PUT back to their captured prior body.
 *
 * Rollback is keyed on the policy id Okta returned, never on the name. There is no
 * lifecycle to restore.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: DeviceAssuranceRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    // Undo in reverse so later changes are reverted before earlier ones.
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        // Deploy created this policy — remove it.
        if (entry.id) {
          const del = await client.request('DELETE', `/device-assurances/${entry.id}`)
          if (!del.ok && del.status !== 404) {
            throw new Error(
              `Failed to delete device assurance policy "${entry.name}": ${oktaErrorMessage(del)}. Okta will not delete a policy that is still mapped to an Authentication Policy — remove that mapping first, then retry the rollback.`,
            )
          }
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this policy — restore its captured prior body.
        const res = await client.request('PUT', `/device-assurances/${entry.id}`, { body: entry.prior })
        if (!res.ok) {
          throw new Error(`Failed to restore device assurance policy "${entry.name}": ${oktaErrorMessage(res)}`)
        }
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} device assurance policy(ies): ${reverted.join(', ')}.`,
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
