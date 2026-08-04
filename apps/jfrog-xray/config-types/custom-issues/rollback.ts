import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildXrayClient, xrayErrorMessage } from '../../lib/xrayApi'
import { customIssueWritePath, type CustomIssueRollbackEntry } from './deploy'
import { restorableIssueBody } from './_shared'

/**
 * Roll back Xray custom issues using the state captured during deploy:
 *   - issues that were CREATED are deleted (`DELETE /api/v1/events/{id}`).
 *   - issues that were UPDATED are restored to their captured full prior body
 *     (`PUT /api/v1/events/{id}`) — this endpoint is a full replace, so the
 *     entire prior issue is replayed as-is.
 * Processed in reverse deploy order, matching the platform's rollback convention.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildXrayClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previous = (ctx.rollbackData as { previous?: CustomIssueRollbackEntry[] } | null)?.previous
  if (!previous || previous.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previous].reverse()) {
      if (!entry.existed) {
        const res = await client.deleteResource(customIssueWritePath(entry.id))
        if (!res.ok && res.status !== 404) {
          throw new Error(`Failed to delete custom issue "${entry.id}": ${xrayErrorMessage(res)}`)
        }
      } else if (entry.prior) {
        const res = await client.request('PUT', customIssueWritePath(entry.id), restorableIssueBody(entry.prior))
        if (!res.ok) throw new Error(`Failed to restore custom issue "${entry.id}": ${xrayErrorMessage(res)}`)
      }
      reverted.push(entry.id)
    }

    return { success: true, message: `Rolled back ${reverted.length} Xray custom issue(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previous.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
