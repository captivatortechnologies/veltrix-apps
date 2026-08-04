import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildXrayClient, xrayErrorMessage } from '../../lib/xrayApi'
import { curationPolicyPath, type CurationRollbackEntry } from './deploy'
import { restorablePolicy } from './_shared'

/**
 * Roll back JFrog Curation policies using the state captured during deploy:
 *   - policies that were CREATED are deleted (`DELETE /api/v1/curation/policies/{policy_id}`).
 *   - policies that were UPDATED are restored to their captured prior editable
 *     fields (`PUT /api/v1/curation/policies/{policy_id}`) — waivers/label_waivers
 *     are replayed WITH their captured "id" so Xray retains them rather than
 *     treating them as newly-added (see Xray's documented waiver semantics).
 * Processed in reverse deploy order, matching the platform's rollback convention.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildXrayClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previous = (ctx.rollbackData as { previous?: CurationRollbackEntry[] } | null)?.previous
  if (!previous || previous.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previous].reverse()) {
      if (!entry.existed) {
        const res = await client.deleteResource(curationPolicyPath(entry.policyId))
        if (!res.ok && res.status !== 404) {
          throw new Error(`Failed to delete curation policy "${entry.name}": ${xrayErrorMessage(res)}`)
        }
      } else if (entry.prior) {
        const res = await client.request('PUT', curationPolicyPath(entry.policyId), restorablePolicy(entry.prior))
        if (!res.ok) throw new Error(`Failed to restore curation policy "${entry.name}": ${xrayErrorMessage(res)}`)
      }
      reverted.push(entry.name)
    }

    return { success: true, message: `Rolled back ${reverted.length} curation polic${reverted.length === 1 ? 'y' : 'ies'}: ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previous.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
