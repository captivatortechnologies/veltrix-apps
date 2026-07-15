import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage } from '../../lib/okta'
import { claimPath, type ClaimRollbackEntry } from './deploy'

/**
 * Roll back authorization-server claims using the state captured during deploy:
 *   - claims this deploy CREATED are deleted (claims have no lifecycle, so no
 *     deactivate-before-delete is required — a plain DELETE suffices). A 404 is
 *     tolerated (already gone).
 *   - claims this deploy UPDATED are PUT back to their captured prior body.
 *
 * Rollback is keyed on the claim id Okta returned and the parent authServerId,
 * never on the name.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ClaimRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      const label = `${entry.authServerId}:${entry.name}`

      if (!entry.existed) {
        // Deploy created this claim — delete it (404 = already deleted).
        if (entry.id) {
          const del = await client.request('DELETE', claimPath(entry.authServerId, entry.id))
          if (!del.ok && del.status !== 404) {
            throw new Error(`Failed to delete claim "${label}": ${oktaErrorMessage(del)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this claim — restore its captured prior body.
        const res = await client.request('PUT', claimPath(entry.authServerId, entry.id), { body: entry.prior })
        if (!res.ok) {
          throw new Error(`Failed to restore claim "${label}": ${oktaErrorMessage(res)}`)
        }
      }

      reverted.push(label)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} claim(s): ${reverted.join(', ')}. Claims created by the deployment were deleted; updated claims were restored to their prior definition.`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} claim(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
