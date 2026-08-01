import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildPagerDutyClient, pagerDutyErrorMessage } from '../../lib/pagerdutyApi'
import { buildPolicyBody, type EscalationPolicySpec } from './_shared'
import type { EscalationPolicyRollbackEntry } from './deploy'

/**
 * Undo an escalation-policies deploy from rollbackData.previousState (written by
 * deploy()), in reverse order:
 *   - a policy that was CREATED is deleted (DELETE /escalation_policies/{id})
 *   - a policy that was UPDATED is restored (PUT) to its prior body
 * Applied over the PagerDuty REST API v2.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildPagerDutyClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: EscalationPolicyRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: true, message: 'Nothing to roll back.' }
  }

  const reverted: string[] = []
  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `/escalation_policies/${encodeURIComponent(entry.id)}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete escalation policy "${entry.name}": ${pagerDutyErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        const p = entry.prior
        // Restore the prior body verbatim (name/description/num_loops/rules).
        const restoreSpec: EscalationPolicySpec = {
          itemName: entry.name,
          name: String(p.name ?? entry.name),
          description: String(p.description ?? ''),
          numLoops: typeof p.num_loops === 'number' ? p.num_loops : null,
          rulesJson: '',
        }
        const body = { escalation_policy: buildPolicyBody(restoreSpec, p.escalation_rules ?? []) }
        const res = await client.request('PUT', `/escalation_policies/${encodeURIComponent(entry.id)}`, { body })
        if (!res.ok) throw new Error(`Failed to restore escalation policy "${entry.name}": ${pagerDutyErrorMessage(res)}`)
      }
      reverted.push(entry.name)
    }

    return { success: true, message: `Rolled back ${reverted.length} escalation policy(ies): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
