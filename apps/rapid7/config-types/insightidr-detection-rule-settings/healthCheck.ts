import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildInsightIDRClient } from '../../lib/insightidr'
import { indexRulesByName, listDetectionRules, resolveRuleByName } from '../../lib/insightidr-rules'
import { extractRuleSettingSpecs } from './validate'

/**
 * Health check for detection rule settings:
 *   1. InsightIDR reachability + API-key validity (listing detection rules)
 *   2. Every declared rule resolves and its live action / priority match the
 *      desired settings
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildInsightIDRClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'insightidr_credential', passed: false, message: built.error }] }
  }
  const { client, baseUrl } = built

  const start = Date.now()
  let rulesByName: ReturnType<typeof indexRulesByName> | null = null
  try {
    rulesByName = indexRulesByName(await listDetectionRules(client))
    checks.push({ name: 'insightidr_reachable', passed: true, message: `InsightIDR reachable at ${baseUrl}`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 'insightidr_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (rulesByName) {
    for (const spec of extractRuleSettingSpecs(ctx.canvas).filter((s) => s.ruleName && s.ruleAction)) {
      const resolved = resolveRuleByName(rulesByName, spec.ruleName)
      if ('error' in resolved) {
        checks.push({ name: `rule:${spec.ruleName}`, passed: false, message: resolved.error })
        continue
      }
      const liveAction = (resolved.rule.rule?.rule_action ?? '').trim()
      const livePriority = (resolved.rule.rule?.priority_level ?? '').trim()
      const actionOk = liveAction === spec.ruleAction
      const priorityOk = !spec.priorityLevel || livePriority === spec.priorityLevel
      const passed = actionOk && priorityOk
      checks.push({
        name: `rule:${spec.ruleName}`,
        passed,
        message: passed
          ? `Rule "${spec.ruleName}" matches (${liveAction}${spec.priorityLevel ? `, ${livePriority}` : ''})`
          : `Rule "${spec.ruleName}" is ${liveAction || 'unknown'}${spec.priorityLevel ? `/${livePriority || 'unknown'}` : ''}, expected ${spec.ruleAction}${spec.priorityLevel ? `/${spec.priorityLevel}` : ''}`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
