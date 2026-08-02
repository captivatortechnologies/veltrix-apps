import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildDatadogClient } from '../../lib/datadogApi'
import { listRules } from './deploy'
import { extractRuleSpecs, findRuleByName } from './_shared'

/**
 * Health check for Security Monitoring Rule configuration:
 *   1. Datadog reachability + credential validity — a rule list read
 *      (GET /api/v2/security_monitoring/rules?page[size]=1)
 *   2. Every declared rule (by name) still exists in the organization
 * Score is the fraction of passed checks (0-1).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheck[] = []

  const built = buildDatadogClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'datadog_credential', passed: false, message: built.error }] }
  }
  const { client, baseUrl } = built

  const started = Date.now()
  let live: Awaited<ReturnType<typeof listRules>> = []
  let reachable = false
  try {
    live = await listRules(client)
    reachable = true
    checks.push({ name: 'datadog_reachable', passed: true, message: `Datadog reachable at ${baseUrl}`, latencyMs: Date.now() - started })
  } catch (error) {
    checks.push({
      name: 'datadog_reachable',
      passed: false,
      message: error instanceof Error ? error.message : 'Could not reach Datadog',
      latencyMs: Date.now() - started,
    })
  }

  if (reachable) {
    const specs = extractRuleSpecs(ctx.canvas).filter((s) => s.name && s.message)
    for (const spec of specs) {
      const found = findRuleByName(live, spec.name)
      checks.push({
        name: `rule:${spec.name}`,
        passed: !!found,
        message: found ? `Rule "${spec.name}" is present` : `Rule "${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  return {
    healthy: passedCount === checks.length,
    score: checks.length ? passedCount / checks.length : 0,
    checks,
  }
}
