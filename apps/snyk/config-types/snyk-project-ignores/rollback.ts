import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient, snykErrorMessage } from '../../lib/snyk'
import type { IgnoreRollbackEntry } from './deploy'

/**
 * Roll back project ignores using the state captured during deploy (in reverse
 * order):
 *   - an issue that had NO ignore before is un-ignored via DELETE (a 404 is
 *     tolerated because it may already be gone)
 *   - an issue that had a prior ignore is restored by PUTting its prior rules
 *     back; when the prior rules could not be captured, it is left as-is rather
 *     than risk destroying an ignore that cannot be reconstructed
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildSnykClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built
  if (!client.hasOrg) {
    return { success: false, message: 'No Snyk organization id set — cannot roll back project ignores.' }
  }

  const previousState = (ctx.rollbackData as { previousState?: IgnoreRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  const skipped: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      const base = `${client.v1OrgPath()}/project/${entry.projectId}/ignore/${encodeURIComponent(entry.issueId)}`
      if (!entry.existedBefore) {
        const res = await client.v1('DELETE', base)
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to remove ignore for issue "${entry.issueId}": ${snykErrorMessage(res)}`)
        }
        reverted.push(entry.issueId)
      } else if (entry.priorRules && entry.priorRules.length > 0) {
        const res = await client.v1('PUT', base, { body: entry.priorRules })
        if (!res.ok) {
          throw new Error(`Failed to restore ignore for issue "${entry.issueId}": ${snykErrorMessage(res)}`)
        }
        reverted.push(entry.issueId)
      } else {
        // Prior ignore existed but its rules could not be reconstructed — leave
        // the live ignore in place rather than destroy an unrecoverable rule.
        skipped.push(entry.issueId)
      }
    }

    const parts = [`${reverted.length} reverted`]
    if (skipped.length) parts.push(`${skipped.length} left in place (prior rules unavailable)`)
    return { success: true, message: `Rolled back project ignores: ${parts.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
