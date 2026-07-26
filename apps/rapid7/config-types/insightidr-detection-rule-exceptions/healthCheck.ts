import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildInsightIDRClient } from '../../lib/insightidr'
import { indexRulesByName, listDetectionRules, resolveRuleByName } from '../../lib/insightidr-rules'
import { listExceptionsForRule } from './deploy'
import { extractExceptionSpecs } from './validate'

/**
 * Health check for detection rule exception configuration:
 *   1. InsightIDR reachability + API-key validity (listing detection rules)
 *   2. Every declared exception (rule name, exception name) still exists
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
    // Cache exception name sets per resolved rule RRN to avoid duplicate calls.
    const namesByRule = new Map<string, Set<string>>()
    for (const spec of extractExceptionSpecs(ctx.canvas).filter((s) => s.ruleName && s.name)) {
      const resolved = resolveRuleByName(rulesByName, spec.ruleName)
      if ('error' in resolved) {
        checks.push({ name: `exception:${spec.name}`, passed: false, message: resolved.error })
        continue
      }
      const ruleRrn = resolved.rule.rrn as string
      let names = namesByRule.get(ruleRrn)
      if (!names) {
        try {
          const live = await listExceptionsForRule(client, ruleRrn)
          names = new Set(live.map((e) => (e.name ?? '').trim().toLowerCase()).filter(Boolean))
        } catch {
          names = new Set()
        }
        namesByRule.set(ruleRrn, names)
      }
      const present = names.has(spec.name.trim().toLowerCase())
      checks.push({
        name: `exception:${spec.name} on ${spec.ruleName}`,
        passed: present,
        message: present ? `Exception "${spec.name}" is present` : `Exception "${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
