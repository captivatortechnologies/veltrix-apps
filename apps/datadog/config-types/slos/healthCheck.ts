import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildDatadogClient } from '../../lib/datadogApi'
import { listSlos } from './deploy'
import { extractSloSpecs, findSloByName } from './_shared'

/**
 * Health check for SLO configuration:
 *   1. Datadog reachability + credential validity — an SLO list read
 *   2. Every declared SLO (by name) still exists
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
  let live: Awaited<ReturnType<typeof listSlos>> = []
  let reachable = false
  try {
    live = await listSlos(client)
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
    const specs = extractSloSpecs(ctx.canvas).filter((s) => s.name && s.type)
    for (const spec of specs) {
      const found = findSloByName(live, spec.name)
      checks.push({
        name: `slo:${spec.name}`,
        passed: !!found,
        message: found ? `SLO "${spec.name}" is present` : `SLO "${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  return { healthy: passedCount === checks.length, score: checks.length ? passedCount / checks.length : 0, checks }
}
