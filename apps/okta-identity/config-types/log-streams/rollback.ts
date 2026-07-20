import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage } from '../../lib/okta'
import { getLogStreamById, reconcileStreamStatus, type LogStreamRollbackEntry } from './deploy'

/**
 * Roll back log streams using the state captured during deploy:
 *   - streams this deploy CREATED are deleted (Okta deletes a stream directly —
 *     no deactivate-before-delete is required). A 404 means it is already gone.
 *   - streams this deploy UPDATED are PUT back to their captured prior body, then
 *     returned to their prior lifecycle status.
 *
 * Because a stream's type/settings are immutable and its Splunk token is write-
 * only and immutable, an UPDATE never changed those values — so restoring the
 * captured prior (type/name/settings, no secret) is a faithful revert; the live
 * token is untouched throughout.
 *
 * Rollback is keyed on the stream id Okta returned, never on the name.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: LogStreamRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    // Undo in reverse so later changes are reverted before earlier ones.
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        // Deploy created this stream — remove it (404 = already gone).
        if (entry.id) {
          const del = await client.request('DELETE', `/logStreams/${entry.id}`)
          if (!del.ok && del.status !== 404) {
            throw new Error(`Failed to delete log stream "${entry.name}": ${oktaErrorMessage(del)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this stream — restore its captured prior body, then its
        // prior lifecycle status.
        const res = await client.request('PUT', `/logStreams/${entry.id}`, { body: entry.prior })
        if (!res.ok) {
          throw new Error(`Failed to restore log stream "${entry.name}": ${oktaErrorMessage(res)}`)
        }
        const live = await getLogStreamById(client, entry.id)
        await reconcileStreamStatus(client, entry.id, live?.status, entry.priorStatus)
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} log stream(s): ${reverted.join(', ')}.`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} stream(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
