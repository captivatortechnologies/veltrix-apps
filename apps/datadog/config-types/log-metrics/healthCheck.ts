import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildDatadogClient } from '../../lib/datadogApi'
import { getLogMetric, listLogMetrics } from './deploy'
import { extractLogMetricSpecs } from './_shared'

/**
 * Health check for Log-Based Metric configuration:
 *   1. Datadog reachability + credential validity — a metric list read
 *   2. Every declared metric exists (direct GET by id — its own identity)
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
  let reachable = false
  try {
    await listLogMetrics(client)
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
    const specs = extractLogMetricSpecs(ctx.canvas).filter((s) => s.id)
    for (const spec of specs) {
      const label = spec.id
      try {
        const found = await getLogMetric(client, spec.id)
        checks.push({ name: `metric:${label}`, passed: !!found, message: found ? `Metric "${label}" is present` : `Metric "${label}" is missing` })
      } catch (error) {
        checks.push({ name: `metric:${label}`, passed: false, message: error instanceof Error ? error.message : 'Check failed' })
      }
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  return { healthy: passedCount === checks.length, score: checks.length ? passedCount / checks.length : 0, checks }
}
