import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildTenableClient, tenableErrorMessage } from '../../lib/tenable'
import type { ProfileRollbackEntry } from './deploy'

/**
 * Roll back profiles using the state captured during deploy:
 *   - profiles that were created are deleted (DELETE /sensors/profiles/{sensorType}/{uuid})
 *   - profiles that were updated are restored (PUT) to their captured prior body
 *
 * Rollback is keyed on the stable uuid the API returned at deploy time, never
 * on the name. The captured prior body is replayed verbatim except the
 * identity/read-only keys (profile_uuid, uuid, created, updated), which are
 * path-bound or server-assigned rather than settable.
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
          const res = await client.request('DELETE', `/sensors/profiles/${entry.sensorType}/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete profile "${entry.name}": ${tenableErrorMessage(res)}`)
          }
        }
      } else if (entry.id !== undefined && entry.prior) {
        // Deploy updated this profile — restore the captured prior body. Strip
        // the identity/read-only keys, which are addressed by the path or set by
        // the server, not settable in the request body.
        const restore: Record<string, unknown> = { ...entry.prior }
        delete restore.profile_uuid
        delete restore.uuid
        delete restore.created
        delete restore.updated

        const res = await client.request('PUT', `/sensors/profiles/${entry.sensorType}/${entry.id}`, {
          body: restore,
        })
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
