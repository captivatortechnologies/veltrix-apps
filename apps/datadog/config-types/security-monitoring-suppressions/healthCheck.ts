import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildDatadogClient } from '../../lib/datadogApi'
import { listSuppressions } from './deploy'
import { extractSuppressionSpecs, findSuppressionByName } from './_shared'

/**
 * Health check for Suppression Rule configuration:
 *   1. Datadog reachability + credential validity — a suppression list read
 *      (GET /api/v2/security_monitoring/configuration/suppressions)
 *   2. Every declared suppression (by name) still exists
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
  let live: Awaited<ReturnType<typeof listSuppressions>> = []
  let reachable = false
  try {
    live = await listSuppressions(client)
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
    const specs = extractSuppressionSpecs(ctx.canvas).filter((s) => s.name && s.ruleQuery)
    for (const spec of specs) {
      const found = findSuppressionByName(live, spec.name)
      checks.push({
        name: `suppression:${spec.name}`,
        passed: !!found,
        message: found ? `Suppression "${spec.name}" is present` : `Suppression "${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  return { healthy: passedCount === checks.length, score: checks.length ? passedCount / checks.length : 0, checks }
}
