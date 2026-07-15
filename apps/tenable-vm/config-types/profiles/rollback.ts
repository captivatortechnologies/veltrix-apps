import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildTenableClient, tenableErrorMessage } from '../../lib/tenable'
import type { ProfileRollbackEntry } from './deploy'

/**
 * Roll back profiles using the state captured during deploy:
 *   - profiles that were created are deleted (DELETE /profiles/{id})
 *   - profiles that were updated are restored (PUT) to their captured prior body
 *
 * Rollback is keyed on the stable id/uuid the API returned at deploy time, never
 * on the name. The captured prior body is replayed verbatim except the id/uuid,
 * which are path-bound (and typically read-only) rather than settable.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ProfileRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this profile — remove it. 404 means it is already gone
        // (or was never created), which is the desired end state.
        if (entry.id !== undefined) {
          const res = await client.request('DELETE', `/profiles/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete profile "${entry.name}": ${tenableErrorMessage(res)}`)
          }
        }
      } else if (entry.id !== undefined && entry.prior) {
        // Deploy updated this profile — restore the captured prior body. Strip
        // the identity keys, which are addressed by the path, not the body.
        const restore: Record<string, unknown> = { ...entry.prior }
        delete restore.id
        delete restore.uuid

        const res = await client.request('PUT', `/profiles/${entry.id}`, { body: restore })
        if (!res.ok) {
          throw new Error(`Failed to restore profile "${entry.name}": ${tenableErrorMessage(res)}`)
        }
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} profile(s): ${reverted.join(', ')}.`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} profile(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
