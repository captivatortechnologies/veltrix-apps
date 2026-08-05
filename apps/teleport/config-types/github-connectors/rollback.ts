import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildTeleportClient, teleportErrorMessage } from '../../lib/teleport'
import type { GithubConnectorRollbackEntry } from './deploy'

/**
 * Roll back GitHub connectors using the state captured during deploy:
 *   - connectors this deploy CREATED are deleted (DELETE /v1/webapi/github/{name}, tolerating a 404)
 *   - connectors this deploy UPDATED are restored to their prior content (PUT /v1/webapi/github/{name})
 *
 * Deleting a created connector removes that SSO login path for any user relying on it.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildTeleportClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: GithubConnectorRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        const res = await client.request('DELETE', `/v1/webapi/github/${encodeURIComponent(entry.name)}`)
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete connector "${entry.name}": ${teleportErrorMessage(res)}`)
        }
      } else if (entry.priorContent !== undefined) {
        const res = await client.request('PUT', `/v1/webapi/github/${encodeURIComponent(entry.name)}`, {
          body: { content: entry.priorContent },
        })
        if (!res.ok) throw new Error(`Failed to restore connector "${entry.name}": ${teleportErrorMessage(res)}`)
      }
      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} connector(s): ${reverted.join(', ')}. Note: deleting a created connector removes that SSO login path for any user relying on it.`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} connector(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
