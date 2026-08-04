import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildJumpCloudClient, jumpCloudErrorMessage, JUMPCLOUD_API_BASE } from '../../lib/jumpcloudApi'
import type { RadiusServerRollbackEntry } from './deploy'

/**
 * Undo a RADIUS Servers deploy from rollbackData.previousState (written by
 * deploy):
 *   - a server this deploy CREATED is deleted (DELETE /radiusservers/{id};
 *     404 tolerated)
 *   - a server this deploy UPDATED is restored (PUT /radiusservers/{id}) to its
 *     prior managed body, including the true prior shared secret (JumpCloud's
 *     GET response includes it, so it was captured verbatim at deploy time)
 *
 * Applied over the JumpCloud API v1 (/radiusservers).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const previousState = (ctx.rollbackData as { previousState?: RadiusServerRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: true, message: 'Nothing to roll back.' }
  }

  const built = buildJumpCloudClient(ctx.credential, ctx.settings, { baseUrl: JUMPCLOUD_API_BASE })
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const reverted: string[] = []
  try {
    for (const entry of previousState) {
      if (!entry.id) {
        reverted.push(entry.name)
        continue
      }

      if (!entry.existed) {
        const res = await client.request('DELETE', `/radiusservers/${encodeURIComponent(entry.id)}`)
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete RADIUS Server "${entry.name}": ${jumpCloudErrorMessage(res)}`)
        }
      } else if (entry.prior) {
        const res = await client.request('PUT', `/radiusservers/${encodeURIComponent(entry.id)}`, { body: entry.prior })
        if (!res.ok) throw new Error(`Failed to restore RADIUS Server "${entry.name}": ${jumpCloudErrorMessage(res)}`)
      }

      reverted.push(entry.name)
    }

    return { success: true, message: `Rolled back ${reverted.length} RADIUS Server(s): ${reverted.join(', ')}.` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} server(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
