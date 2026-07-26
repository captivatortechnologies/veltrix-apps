import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCyberArkClient } from '../../lib/cyberark'
import { attachDriftActor, veltrixActorLogins } from '../lib/cyberarkAudit'
import { mapRules } from './deploy'
import { extractOnboardingRuleSpecs, ruleKey, type LiveOnboardingRule, type OnboardingRuleSpec } from './validate'

/**
 * Detect drift between the deployed onboarding-rule configuration and the live
 * PVWA. Re-finds each declared rule by name and diffs the managed fields (target
 * platform / safe, filters, methods, description); a missing rule is critical
 * drift.
 *
 * The rule object carries CreationTime / LastOnboardedTime but no actor identity,
 * and there is no per-rule activity endpoint, so rule diffs cannot be attributed
 * with the app's credentials — attribution is wired uniformly but resolves no
 * actor, so the drift view shows "—".
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildCyberArkClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractOnboardingRuleSpecs(ctx.deployedConfig).filter((s) => s.ruleName)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const byKey = await mapRules(client)

    for (const spec of specs) {
      const before = diffs.length
      const found = byKey.get(ruleKey(spec))
      if (!found) {
        diffs.push({ field: spec.ruleName, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      pushFieldDiffs(diffs, spec, found)

      // Uniform attribution wiring; no actor metadata is available for a rule, so
      // this resolves no actor (no extra API call).
      await attachDriftActor(client, diffs.slice(before), { excludeActorLogins })
    }
  } catch (error) {
    diffs.push({
      field: 'cyberark',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  await client.logoff()
  return { hasDrift: diffs.length > 0, diffs }
}

/** Diff each managed field of a rule against its live value. */
function pushFieldDiffs(diffs: DriftDiff[], spec: OnboardingRuleSpec, live: LiveOnboardingRule): void {
  const tag = spec.ruleName
  const compare = (
    field: string,
    expected: string | boolean,
    actual: string | boolean | undefined,
    severity: DriftDiff['severity'],
  ) => {
    const actualValue = actual ?? (typeof expected === 'boolean' ? false : '')
    if (actualValue !== expected) {
      diffs.push({ field: `${tag}.${field}`, expected, actual: actualValue, severity })
    }
  }

  compare('target_platform_id', spec.targetPlatformId, live.TargetPlatformId, 'warning')
  compare('target_safe_name', spec.targetSafeName, live.TargetSafeName, 'warning')
  compare('system_type_filter', spec.systemTypeFilter, live.SystemTypeFilter, 'warning')
  compare('machine_type_filter', spec.machineTypeFilter, live.MachineTypeFilter, 'info')
  compare('account_category_filter', spec.accountCategoryFilter, live.AccountCategoryFilter, 'info')
  compare('is_admin_id_filter', spec.isAdminIdFilter, live.IsAdminIDFilter, 'info')
  compare('user_name_filter', spec.userNameFilter, live.UserNameFilter, 'info')
  compare('address_filter', spec.addressFilter, live.AddressFilter, 'info')
  compare('rule_description', spec.ruleDescription, live.RuleDescription, 'info')
}
