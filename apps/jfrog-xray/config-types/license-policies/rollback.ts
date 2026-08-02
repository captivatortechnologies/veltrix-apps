import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildXrayClient, xrayErrorMessage } from '../../lib/xrayApi'
import { deletePolicy, putPolicy, restorablePolicyBody, type PolicyRollbackEntry } from '../../lib/xrayPolicies'
import type { XrayLicenseCriteria } from './_shared'

/**
 * Roll back Xray license policies using the state captured during deploy:
 *   - policies that were CREATED are deleted (`DELETE /api/v2/policies/{name}`);
 *     this fails (HTTP 400) if the policy has since been bound to a watch.
 *   - policies that were UPDATED are restored to their captured full prior body
 *     (`PUT /api/v2/policies/{name}`) — Xray's PUT has no partial-update mode, so
 *     the entire prior policy (all rules) is replayed as-is.
 * Processed in reverse deploy order, matching the platform's rollback convention.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildXrayClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previous = (ctx.rollbackData as { previous?: PolicyRollbackEntry<XrayLicenseCriteria>[] } | null)?.previous
  if (!previous || previous.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previous].reverse()) {
      if (!entry.existed) {
        const res = await deletePolicy(client, entry.name)
        if (!res.ok && res.status !== 404) {
          throw new Error(`Failed to delete policy "${entry.name}": ${xrayErrorMessage(res)}`)
        }
      } else if (entry.prior) {
        await putPolicy(client, entry.name, restorablePolicyBody(entry.prior))
      }
      reverted.push(entry.name)
    }

    return { success: true, message: `Rolled back ${reverted.length} Xray license polic${reverted.length === 1 ? 'y' : 'ies'}: ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previous.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
