import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildInsightIDRClient } from '../../lib/insightidr'
import { indexRulesByName, listDetectionRules, resolveRuleByName } from '../../lib/insightidr-rules'
import { listExceptionsForRule } from './deploy'
import { exceptionLabel, extractExceptionSpecs } from './validate'

/**
 * Detect drift between the deployed exception configuration and live InsightIDR.
 * Exceptions are CREATE/skip only, so drift is presence: each declared exception
 * must still exist under its parent rule by name; a missing one (or an
 * unresolvable parent rule) is critical drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildInsightIDRClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractExceptionSpecs(ctx.deployedConfig).filter((s) => s.ruleName && s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const rulesByName = indexRulesByName(await listDetectionRules(client))
    const namesByRule = new Map<string, Set<string>>()

    for (const spec of specs) {
      const resolved = resolveRuleByName(rulesByName, spec.ruleName)
      if ('error' in resolved) {
        diffs.push({ field: exceptionLabel(spec), expected: 'exists', actual: resolved.error, severity: 'critical' })
        continue
      }
      const ruleRrn = resolved.rule.rrn as string
      let names = namesByRule.get(ruleRrn)
      if (!names) {
        const live = await listExceptionsForRule(client, ruleRrn)
        names = new Set(live.map((e) => (e.name ?? '').trim().toLowerCase()).filter(Boolean))
        namesByRule.set(ruleRrn, names)
      }
      if (!names.has(spec.name.trim().toLowerCase())) {
        diffs.push({ field: exceptionLabel(spec), expected: 'exists', actual: 'missing', severity: 'critical' })
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
