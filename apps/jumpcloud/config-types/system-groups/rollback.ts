import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildJumpCloudClient, jumpCloudErrorMessage } from '../../lib/jumpcloudApi'
import type { SystemGroupRollbackEntry } from './deploy'

/**
 * Undo a System Groups deploy from rollbackData.previousState (written by deploy):
 *   - a group this deploy CREATED is deleted (DELETE /systemgroups/{id}; 404 tolerated)
 *   - a group this deploy UPDATED is restored (PUT /systemgroups/{id}) to its prior
 *     managed body (name / description)
 *
 * Applied over the JumpCloud API v2 (/systemgroups).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const previousState = (ctx.rollbackData as { previousState?: SystemGroupRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: true, message: 'Nothing to roll back.' }
  }

  const built = buildJumpCloudClient(ctx.credential, ctx.settings)
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
        // Deploy created this group — remove it. 404 means it is already gone.
        const res = await client.request('DELETE', `/systemgroups/${encodeURIComponent(entry.id)}`)
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete System Group "${entry.name}": ${jumpCloudErrorMessage(res)}`)
        }
      } else if (entry.prior) {
        // Deploy updated this group — restore the captured prior body.
        const res = await client.request('PUT', `/systemgroups/${encodeURIComponent(entry.id)}`, { body: entry.prior })
        if (!res.ok) throw new Error(`Failed to restore System Group "${entry.name}": ${jumpCloudErrorMessage(res)}`)
      }

      reverted.push(entry.name)
    }

    return { success: true, message: `Rolled back ${reverted.length} System Group(s): ${reverted.join(', ')}.` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} group(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
