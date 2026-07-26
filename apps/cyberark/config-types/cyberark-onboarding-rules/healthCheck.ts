import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildCyberArkClient } from '../../lib/cyberark'
import { mapRules } from './deploy'
import { extractOnboardingRuleSpecs, ruleKey, type LiveOnboardingRule } from './validate'

/**
 * Health check for onboarding-rule configuration:
 *   1. PVWA reachability + logon (a /AutomaticOnboardingRules list)
 *   2. Every declared rule (by name) still exists
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildCyberArkClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'cyberark_credential', passed: false, message: built.error }] }
  }
  const { client, pvwaUrl } = built

  const start = Date.now()
  let byKey: Map<string, LiveOnboardingRule> | null = null
  try {
    byKey = await mapRules(client)
    checks.push({ name: 'cyberark_reachable', passed: true, message: `PVWA reachable at ${pvwaUrl}`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 'cyberark_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (byKey) {
    for (const spec of extractOnboardingRuleSpecs(ctx.canvas).filter((s) => s.ruleName)) {
      const present = byKey.has(ruleKey(spec))
      checks.push({
        name: `rule:${spec.ruleName}`,
        passed: present,
        message: present ? `Rule "${spec.ruleName}" is present` : `Rule "${spec.ruleName}" is missing`,
      })
    }
  }

  await client.logoff()
  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passedCount / checks.length) * 100) : 0
  return { healthy: passedCount === checks.length, score, checks }
}
