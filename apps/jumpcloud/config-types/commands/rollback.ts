import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildJumpCloudClient, jumpCloudErrorMessage, JUMPCLOUD_API_BASE } from '../../lib/jumpcloudApi'
import type { CommandRollbackEntry } from './deploy'

/**
 * Undo a Commands deploy from rollbackData.previousState (written by deploy):
 *   - a command this deploy CREATED is deleted (DELETE /commands/{id}; 404 tolerated)
 *   - a command this deploy UPDATED is restored (PUT /commands/{id}) to its
 *     prior managed body
 *
 * Applied over the JumpCloud API v1 (/commands).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const previousState = (ctx.rollbackData as { previousState?: CommandRollbackEntry[] })?.previousState
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
        const res = await client.request('DELETE', `/commands/${encodeURIComponent(entry.id)}`)
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete Command "${entry.name}": ${jumpCloudErrorMessage(res)}`)
        }
      } else if (entry.prior) {
        const res = await client.request('PUT', `/commands/${encodeURIComponent(entry.id)}`, { body: entry.prior })
        if (!res.ok) throw new Error(`Failed to restore Command "${entry.name}": ${jumpCloudErrorMessage(res)}`)
      }

      reverted.push(entry.name)
    }

    return { success: true, message: `Rolled back ${reverted.length} Command(s): ${reverted.join(', ')}.` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} command(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
