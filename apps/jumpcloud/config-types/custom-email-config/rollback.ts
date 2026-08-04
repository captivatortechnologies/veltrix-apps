import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildJumpCloudClient, jumpCloudErrorMessage } from '../../lib/jumpcloudApi'
import type { CustomEmailRollbackEntry } from './deploy'

/**
 * Undo a Custom Email deploy from rollbackData.previousState (written by deploy):
 *   - an override this deploy CREATED is deleted (DELETE /customemails/{type};
 *     404 tolerated — restores JumpCloud's default template)
 *   - an override this deploy UPDATED is restored (PUT /customemails/{type}) to
 *     its prior managed body
 *
 * Applied over the JumpCloud API v2 (/customemails).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const previousState = (ctx.rollbackData as { previousState?: CustomEmailRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: true, message: 'Nothing to roll back.' }
  }

  const built = buildJumpCloudClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const reverted: string[] = []
  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        const res = await client.request('DELETE', `/customemails/${encodeURIComponent(entry.type)}`)
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete Custom Email "${entry.type}": ${jumpCloudErrorMessage(res)}`)
        }
      } else if (entry.prior) {
        const res = await client.request('PUT', `/customemails/${encodeURIComponent(entry.type)}`, { body: entry.prior })
        if (!res.ok) throw new Error(`Failed to restore Custom Email "${entry.type}": ${jumpCloudErrorMessage(res)}`)
      }

      reverted.push(entry.type)
    }

    return { success: true, message: `Rolled back ${reverted.length} Custom Email override(s): ${reverted.join(', ')}.` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} override(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
