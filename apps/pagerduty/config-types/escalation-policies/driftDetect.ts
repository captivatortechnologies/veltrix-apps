import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildPagerDutyClient } from '../../lib/pagerdutyApi'
import { extractPolicySpecs, findPolicy, parseEscalationRules } from './_shared'
import { listPolicies } from './deploy'

/**
 * Detect drift between the deployed escalation-policies configuration and the live
 * PagerDuty account. Re-finds each declared policy by its `name`:
 *   - a missing policy is CRITICAL drift
 *   - a changed loop count (num_loops) is WARNING drift
 *   - a changed number of escalation rules is INFO drift
 *
 * We report presence + these two STABLE scalars and intentionally do NOT deep-diff
 * the rule/target arrays: PagerDuty expands targets into full APIObjects (summary,
 * self, html_url, …) whose server-normalized shape never matches the compact
 * { type, id } a user typed, so a structural diff would flag constant false drift.
 * Best-effort — an unreadable account raises no false drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildPagerDutyClient(ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractPolicySpecs(ctx.deployedConfig).filter((s) => s.name && s.rulesJson.trim())
  if (specs.length === 0) return { hasDrift: false, diffs }

  let live
  try {
    live = await listPolicies(client)
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read policies, no drift asserted
  }

  for (const spec of specs) {
    const match = findPolicy(live, spec.name)
    if (!match) {
      diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    if (spec.numLoops != null && typeof match.num_loops === 'number' && match.num_loops !== spec.numLoops) {
      diffs.push({ field: `${spec.name}.num_loops`, expected: spec.numLoops, actual: match.num_loops, severity: 'warning' })
    }

    const expectedRules = parseEscalationRules(spec.rulesJson).rules
    const actualCount = Array.isArray(match.escalation_rules) ? match.escalation_rules.length : 0
    if (expectedRules && expectedRules.length !== actualCount) {
      diffs.push({
        field: `${spec.name}.escalation_rules`,
        expected: `${expectedRules.length} rule(s)`,
        actual: `${actualCount} rule(s)`,
        severity: 'info',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
