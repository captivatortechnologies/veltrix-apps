import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildInsightIDRClient } from '../../lib/insightidr'
import { indexRulesByName, listDetectionRules, resolveRuleByName } from '../../lib/insightidr-rules'
import { extractRuleSettingSpecs } from './validate'

/**
 * Detect drift between the deployed rule settings and live InsightIDR. Each
 * declared rule must still resolve and carry the deployed rule action / priority;
 * a mismatch is warning drift, an unresolvable rule is critical.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildInsightIDRClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractRuleSettingSpecs(ctx.deployedConfig).filter((s) => s.ruleName && s.ruleAction)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const rulesByName = indexRulesByName(await listDetectionRules(client))

    for (const spec of specs) {
      const resolved = resolveRuleByName(rulesByName, spec.ruleName)
      if ('error' in resolved) {
        diffs.push({ field: spec.ruleName, expected: 'exists', actual: resolved.error, severity: 'critical' })
        continue
      }
      const liveAction = (resolved.rule.rule?.rule_action ?? '').trim()
      const livePriority = (resolved.rule.rule?.priority_level ?? '').trim()
      if (liveAction !== spec.ruleAction) {
        diffs.push({ field: `${spec.ruleName}.rule_action`, expected: spec.ruleAction, actual: liveAction || 'not set', severity: 'warning' })
      }
      if (spec.priorityLevel && livePriority !== spec.priorityLevel) {
        diffs.push({ field: `${spec.ruleName}.priority_level`, expected: spec.priorityLevel, actual: livePriority || 'not set', severity: 'warning' })
      }
    }
  } catch (error) {
    diffs.push({
      field: 'insightidr',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
