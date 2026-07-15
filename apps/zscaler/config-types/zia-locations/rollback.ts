import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient, zscalerErrorMessage } from '../../lib/zscaler'
import type { LocationRollbackEntry } from './deploy'

/**
 * Roll back ZIA locations using the state captured during deploy:
 *   - locations that were created are deleted (DELETE /locations/{id})
 *   - locations that were updated are restored (PUT) to their prior body — the
 *     whole prior object is replayed so server-managed fields survive the revert
 * Reverting is itself a staged change, so this activates once at the end.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: LocationRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    // Reverse order so newer changes are undone first.
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id != null) {
          const res = await client.zia('DELETE', `/locations/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete location "${entry.name}": ${zscalerErrorMessage(res)}`)
          }
        }
      } else if (entry.id != null && entry.prior) {
        const restore = { ...entry.prior, name: entry.prior.name ?? entry.name, id: entry.id }
        const res = await client.zia('PUT', `/locations/${entry.id}`, { body: restore })
        if (!res.ok) {
          throw new Error(`Failed to restore location "${entry.name}": ${zscalerErrorMessage(res)}`)
        }
      }
      reverted.push(entry.name)
    }

    const act = await client.activate()
    if (!act.ok) {
      return {
        success: false,
        message: `Reverted ${reverted.length} location(s) but activation failed: ${zscalerErrorMessage(
          act,
        )}. Re-run rollback to retry activation.`,
      }
    }

    return {
      success: true,
      message: `Rolled back and activated ${reverted.length} ZIA location(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} location(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
