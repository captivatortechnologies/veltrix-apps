import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildS1Client } from '../../lib/s1'
import { getPolicy } from './deploy'
import { coerceValue, extractPolicySettingSpecs, getNestedPath } from './validate'

/**
 * Health check for agent policy configuration:
 *   1. SentinelOne API reachability + the scope's policy is readable
 *   2. Every declared setting currently matches the enforced value
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildS1Client(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 's1_credential', passed: false, message: built.error }] }
  }
  const { client, consoleUrl } = built

  const pp = client.policyPath()
  if (pp.error || !pp.path) {
    return { healthy: false, score: 0, checks: [{ name: 's1_scope', passed: false, message: pp.error ?? 'scope not configured' }] }
  }
  const path = pp.path

  const start = Date.now()
  let policy: Record<string, unknown> | null = null
  try {
    policy = await getPolicy(client, path)
    checks.push({ name: 's1_reachable', passed: true, message: `Policy readable at ${consoleUrl} (${client.currentScope} scope)`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 's1_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (policy) {
    const specs = extractPolicySettingSpecs(ctx.canvas).filter((s) => s.key && s.rawValue.trim() !== '')
    for (const spec of specs) {
      const actual = getNestedPath(policy, spec.key)
      const expected = coerceValue(spec.rawValue, spec.valueType)
      const matches = actual === expected
      checks.push({
        name: `setting:${spec.key}`,
        passed: matches,
        message: matches ? `"${spec.key}" is ${String(expected)}` : `"${spec.key}" is ${String(actual)}, expected ${String(expected)}`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
