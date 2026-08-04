import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildJumpCloudClient, jumpCloudErrorMessage } from '../../lib/jumpcloudApi'
import type { SoftwareAppRollbackEntry } from './deploy'

/**
 * Undo a Software Apps deploy from rollbackData.previousState (written by
 * deploy):
 *   - an app this deploy CREATED is deleted (DELETE /softwareapps/{id}; 404 tolerated)
 *   - an app this deploy UPDATED is restored (PUT /softwareapps/{id}) to its
 *     prior managed body (displayName / settings)
 *
 * Applied over the JumpCloud API v2 (/softwareapps).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const previousState = (ctx.rollbackData as { previousState?: SoftwareAppRollbackEntry[] })?.previousState
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
        reverted.push(entry.displayName)
        continue
      }

      if (!entry.existed) {
        const res = await client.request('DELETE', `/softwareapps/${encodeURIComponent(entry.id)}`)
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete Software App "${entry.displayName}": ${jumpCloudErrorMessage(res)}`)
        }
      } else if (entry.prior) {
        const res = await client.request('PUT', `/softwareapps/${encodeURIComponent(entry.id)}`, { body: entry.prior })
        if (!res.ok) throw new Error(`Failed to restore Software App "${entry.displayName}": ${jumpCloudErrorMessage(res)}`)
      }

      reverted.push(entry.displayName)
    }

    return { success: true, message: `Rolled back ${reverted.length} Software App(s): ${reverted.join(', ')}.` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} app(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
