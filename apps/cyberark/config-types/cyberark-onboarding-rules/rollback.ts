import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCyberArkClient, cyberArkErrorMessage } from '../../lib/cyberark'
import type { LiveOnboardingRule } from './validate'
import type { OnboardingRuleRollbackEntry } from './deploy'

/**
 * Roll back onboarding rules using the state captured during deploy:
 *   - rules that were created are deleted (DELETE /AutomaticOnboardingRules/{id})
 *   - rules that were updated are restored (PUT) to their prior field values.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildCyberArkClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: OnboardingRuleRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.ruleId !== undefined) {
          const res = await client.request('DELETE', `/AutomaticOnboardingRules/${entry.ruleId}/`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete rule "${entry.label}": ${cyberArkErrorMessage(res)}`)
          }
        }
      } else if (entry.ruleId !== undefined && entry.prior) {
        const res = await client.request('PUT', `/AutomaticOnboardingRules/${entry.ruleId}/`, { body: buildRestoreBody(entry.prior) })
        if (!res.ok) throw new Error(`Failed to restore rule "${entry.label}": ${cyberArkErrorMessage(res)}`)
      }
      reverted.push(entry.label)
    }

    await client.logoff()
    return { success: true, message: `Rolled back ${reverted.length} onboarding rule(s): ${reverted.join(', ')}` }
  } catch (error) {
    await client.logoff()
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}

/** Rebuild the full PUT body from a captured live rule (a full replace on restore). */
function buildRestoreBody(prior: LiveOnboardingRule): Record<string, unknown> {
  const body: Record<string, unknown> = {
    RuleName: prior.RuleName ?? '',
    RuleDescription: prior.RuleDescription ?? '',
    TargetPlatformId: prior.TargetPlatformId ?? '',
    TargetSafeName: prior.TargetSafeName ?? '',
    SystemTypeFilter: prior.SystemTypeFilter ?? 'Windows',
    MachineTypeFilter: prior.MachineTypeFilter ?? 'Any',
    AccountCategoryFilter: prior.AccountCategoryFilter ?? 'Any',
    IsAdminIDFilter: prior.IsAdminIDFilter ?? false,
    UserNameMethod: prior.UserNameMethod ?? 'Equals',
    AddressMethod: prior.AddressMethod ?? 'Equals',
  }
  if (prior.UserNameFilter) body.UserNameFilter = prior.UserNameFilter
  if (prior.AddressFilter) body.AddressFilter = prior.AddressFilter
  return body
}
