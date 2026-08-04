import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildDatadogClient } from '../../lib/datadogApi'
import { getLogIndex, listLogIndexes } from './deploy'
import { extractLogIndexSpecs } from './_shared'

/**
 * Health check for Log Index configuration:
 *   1. Datadog reachability + credential validity — an index list read
 *   2. Every declared index exists (direct GET by name — its own identity)
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
    await listLogIndexes(client)
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
    const specs = extractLogIndexSpecs(ctx.canvas).filter((s) => s.name)
    for (const spec of specs) {
      const label = spec.name
      try {
        const found = await getLogIndex(client, spec.name)
        checks.push({ name: `index:${label}`, passed: !!found, message: found ? `Index "${label}" is present` : `Index "${label}" is missing` })
      } catch (error) {
        checks.push({ name: `index:${label}`, passed: false, message: error instanceof Error ? error.message : 'Check failed' })
      }
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  return { healthy: passedCount === checks.length, score: checks.length ? passedCount / checks.length : 0, checks }
}
