import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSentinelClient, armErrorMessage, SENTINEL_API_VERSION } from '../../lib/sentinel'
import type { SourceControlRollbackEntry } from './deploy'

/**
 * Roll back source controls using the state captured during deploy: connections
 * this deploy created are deleted; connections it updated are restored to their
 * prior NON-SECRET properties via an unconditional PUT.
 *
 * ⚠ SECRET: the repositoryAccess credential is intentionally NOT replayed — it is
 * write-only and was never captured, so a restored connection keeps whatever
 * credential it already had on the service.
 *
 * ⚠ SIDE EFFECT: deleting a created source control also removes the webhook /
 * pipeline it provisioned in the external repository.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildSentinelClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: SourceControlRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  try {
    for (const entry of [...previousState].reverse()) {
      const path = client.sentinelPath(`/sourcecontrols/${entry.sourceControlId}`)
      if (!entry.existed) {
        const res = await client.request('DELETE', path, { apiVersion: SENTINEL_API_VERSION })
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete source control "${entry.displayName}": ${armErrorMessage(res)}`)
        }
      } else if (entry.prior) {
        // Restore prior non-secret properties; no repositoryAccess is sent.
        const res = await client.request('PUT', path, { apiVersion: SENTINEL_API_VERSION, body: { properties: entry.prior } })
        if (!res.ok) throw new Error(`Failed to restore source control "${entry.displayName}": ${armErrorMessage(res)}`)
      }
      reverted.push(entry.displayName)
    }
    return { success: true, message: `Rolled back ${reverted.length} source control(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
