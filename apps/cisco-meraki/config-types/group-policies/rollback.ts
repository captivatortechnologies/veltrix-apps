import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildMerakiClient, deleteGroupPolicy, updateGroupPolicy } from '../../lib/merakiApi'
import { buildGroupPolicyBody } from './_shared'
import type { GroupPolicyRollbackEntry } from './deploy'

/**
 * Roll back group policies using the state captured during deploy:
 *   - policies that were created are deleted (DELETE .../groupPolicies/{id})
 *   - policies that were updated are restored to their captured prior body
 *     (PUT .../groupPolicies/{id})
 *
 * Delete does not pass Meraki's optional `force` query parameter — see
 * lib/merakiApi.ts `deleteGroupPolicy` for why — so a rollback that needs to
 * remove a policy still actively assigned to clients may fail; that failure
 * surfaces as a rollback error rather than being silently forced through.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildMerakiClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous = (ctx.rollbackData as { previous?: GroupPolicyRollbackEntry[] } | undefined)?.previous
  if (!previous || previous.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previous].reverse()) {
      const label = `${entry.networkId}/${entry.name}`
      if (!entry.existed) {
        if (entry.groupPolicyId) {
          await deleteGroupPolicy(client, entry.networkId, entry.groupPolicyId)
        }
      } else if (entry.groupPolicyId && entry.prior) {
        await updateGroupPolicy(client, entry.networkId, entry.groupPolicyId, buildGroupPolicyBody(entry.prior.name ?? entry.name, entry.prior))
      }
      reverted.push(label)
    }
    return { success: true, message: `Rolled back ${reverted.length} group polic${reverted.length === 1 ? 'y' : 'ies'}: ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previous.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
