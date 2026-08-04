import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildJumpCloudClient, jumpCloudErrorMessage } from '../../lib/jumpcloudApi'
import type { IpListRollbackEntry } from './deploy'

/**
 * Undo an IP Lists deploy from rollbackData.previousState (written by deploy):
 *   - a list this deploy CREATED is deleted (DELETE /iplists/{id}; 404 tolerated)
 *   - a list this deploy UPDATED is restored (PUT /iplists/{id}) to its prior
 *     managed body (name / description / ips)
 *
 * Applied over the JumpCloud API v2 (/iplists).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const previousState = (ctx.rollbackData as { previousState?: IpListRollbackEntry[] })?.previousState
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
        const res = await client.request('DELETE', `/iplists/${encodeURIComponent(entry.id)}`)
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete IP List "${entry.name}": ${jumpCloudErrorMessage(res)}`)
        }
      } else if (entry.prior) {
        const res = await client.request('PUT', `/iplists/${encodeURIComponent(entry.id)}`, { body: entry.prior })
        if (!res.ok) throw new Error(`Failed to restore IP List "${entry.name}": ${jumpCloudErrorMessage(res)}`)
      }

      reverted.push(entry.name)
    }

    return { success: true, message: `Rolled back ${reverted.length} IP List(s): ${reverted.join(', ')}.` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} list(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
