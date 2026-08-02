import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildDatadogClient } from '../../lib/datadogApi'
import { listMonitors } from './deploy'
import { extractMonitorSpecs, findMonitorByName } from './_shared'

/**
 * Health check for Monitor configuration:
 *   1. Datadog reachability + credential validity — a monitor list read
 *      (GET /api/v1/monitor)
 *   2. Every declared monitor (by name) still exists
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
  let live: Awaited<ReturnType<typeof listMonitors>> = []
  let reachable = false
  try {
    live = await listMonitors(client)
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
    const specs = extractMonitorSpecs(ctx.canvas).filter((s) => s.name && s.type && s.query)
    for (const spec of specs) {
      const found = findMonitorByName(live, spec.name)
      checks.push({
        name: `monitor:${spec.name}`,
        passed: !!found,
        message: found ? `Monitor "${spec.name}" is present` : `Monitor "${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  return { healthy: passedCount === checks.length, score: checks.length ? passedCount / checks.length : 0, checks }
}
