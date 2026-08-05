import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOneLoginClient, oneLoginErrorMessage } from '../../lib/oneLogin'
import { buildMappingBody, sortMappings, type MappingRollbackEntry } from './deploy'

/**
 * Roll back user mappings using the state captured during deploy:
 *   - mappings that were created are deleted (DELETE /api/2/mappings/{id}, tolerate 404)
 *   - mappings that were updated are restored (PUT) to their prior writable
 *     state (match/enabled/conditions/actions)
 *   - the account's FULL mapping order is restored to exactly what it was
 *     before this deploy (`originalFullOrder`, captured pre-deploy) via
 *     PUT /api/2/mappings/sort - safe because the ids just deleted above are
 *     never in that captured order in the first place.
 *
 * Never touches a mapping this deploy did not create, change, or reorder.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildOneLoginClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const rollbackData = ctx.rollbackData as
    | { previousState?: MappingRollbackEntry[]; originalFullOrder?: number[] }
    | undefined
  const previousState = rollbackData?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `/api/2/mappings/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete mapping "${entry.name}": ${oneLoginErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        const res = await client.request('PUT', `/api/2/mappings/${entry.id}`, { body: buildMappingBody(entry.prior) })
        if (!res.ok) {
          throw new Error(`Failed to restore mapping "${entry.name}": ${oneLoginErrorMessage(res)}`)
        }
      }

      reverted.push(entry.name)
    }

    if (rollbackData?.originalFullOrder && rollbackData.originalFullOrder.length > 0) {
      await sortMappings(client, rollbackData.originalFullOrder)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} user mapping(s): ${reverted.join(', ')}.`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} mapping(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
