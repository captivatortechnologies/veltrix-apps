import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildDatadogClient } from '../../lib/datadogApi'
import { listRoles } from './deploy'
import { extractRoleSpecs, findRoleByName } from './_shared'

/**
 * Health check for Role configuration:
 *   1. Datadog reachability + credential validity — a role list read
 *   2. Every declared role (by name) still exists
 * Score is the fraction of passed checks (0-1). Does not re-verify individual
 * permission grants (that is driftDetect's job — a network-heavier,
 * per-role check better suited to a scheduled drift sweep).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheck[] = []

  const built = buildDatadogClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'datadog_credential', passed: false, message: built.error }] }
  }
  const { client, baseUrl } = built

  const started = Date.now()
  let live: Awaited<ReturnType<typeof listRoles>> = []
  let reachable = false
  try {
    live = await listRoles(client)
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
    const specs = extractRoleSpecs(ctx.canvas).filter((s) => s.name)
    for (const spec of specs) {
      const found = findRoleByName(live, spec.name)
      checks.push({
        name: `role:${spec.name}`,
        passed: !!found,
        message: found ? `Role "${spec.name}" is present` : `Role "${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  return { healthy: passedCount === checks.length, score: checks.length ? passedCount / checks.length : 0, checks }
}
