import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildTeleportClient, teleportErrorMessage } from '../../lib/teleport'
import type { TrustedClusterRollbackEntry } from './deploy'

/**
 * Roll back trusted clusters using the state captured during deploy:
 *   - trusted clusters this deploy CREATED are deleted (DELETE /v1/webapi/trustedcluster/{name}, tolerating a 404)
 *   - trusted clusters this deploy UPDATED are restored to their prior content (PUT /v1/webapi/trustedcluster/{name})
 *
 * Deleting a created trusted cluster tears down that federation relationship.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildTeleportClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: TrustedClusterRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        const res = await client.request('DELETE', `/v1/webapi/trustedcluster/${encodeURIComponent(entry.name)}`)
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete trusted cluster "${entry.name}": ${teleportErrorMessage(res)}`)
        }
      } else if (entry.priorContent !== undefined) {
        const res = await client.request('PUT', `/v1/webapi/trustedcluster/${encodeURIComponent(entry.name)}`, {
          body: { content: entry.priorContent },
        })
        if (!res.ok) throw new Error(`Failed to restore trusted cluster "${entry.name}": ${teleportErrorMessage(res)}`)
      }
      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} trusted cluster(s): ${reverted.join(', ')}. Note: deleting a created trusted cluster tears down that federation relationship.`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
