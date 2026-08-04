import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildDatadogClient } from '../../lib/datadogApi'
import { listArchives } from './deploy'
import { extractArchiveSpecs, findArchiveByName } from './_shared'

/**
 * Health check for Log Archive configuration:
 *   1. Datadog reachability + credential validity — an archive list read
 *   2. Every declared archive (by name) still exists
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
  let live: Awaited<ReturnType<typeof listArchives>> = []
  let reachable = false
  try {
    live = await listArchives(client)
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
    const specs = extractArchiveSpecs(ctx.canvas).filter((s) => s.name && s.query)
    for (const spec of specs) {
      const found = findArchiveByName(live, spec.name)
      checks.push({
        name: `archive:${spec.name}`,
        passed: !!found,
        message: found ? `Archive "${spec.name}" is present` : `Archive "${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  return { healthy: passedCount === checks.length, score: checks.length ? passedCount / checks.length : 0, checks }
}
