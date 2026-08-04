import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildPagerDutyClient, pagerDutyErrorMessage } from '../../lib/pagerdutyApi'
import { extractServiceOrchestrationSpecs, findServiceId, parseOrchestrationSets } from './_shared'
import { getServiceOrchestrationPath, listServices } from './deploy'

/**
 * Health check for service-orchestrations configuration:
 *   1. PagerDuty API reachability + auth (GET /abilities answers 2xx with the key)
 *   2. every declared item's service still resolves by name, and its
 *      orchestration has the declared number of rule sets
 * Score is the fraction of passed checks (0–1).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheck[] = []

  const built = buildPagerDutyClient(ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'credential', passed: false, message: built.error }] }
  }
  const { client } = built

  const started = Date.now()
  let reachable = false
  try {
    const res = await client.request('GET', '/abilities')
    reachable = res.ok
    checks.push({
      name: 'pagerduty_reachable',
      passed: res.ok,
      message: res.ok ? `PagerDuty reachable (HTTP ${res.status}).` : `PagerDuty returned HTTP ${res.status}: ${pagerDutyErrorMessage(res)}`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'pagerduty_reachable',
      passed: false,
      message: `PagerDuty unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  if (reachable) {
    const specs = extractServiceOrchestrationSpecs(ctx.canvas).filter((s) => s.service && s.setsJson.trim())
    if (specs.length > 0) {
      try {
        const services = await listServices(client)
        for (const spec of specs) {
          const serviceId = findServiceId(services, spec.service)
          if (!serviceId) {
            checks.push({
              name: `service_orchestration:${spec.service}`,
              passed: false,
              message: `Service "${spec.service}" is missing.`,
            })
            continue
          }
          try {
            const path = await getServiceOrchestrationPath(client, serviceId, spec.service)
            const expectedSets = parseOrchestrationSets(spec.setsJson).sets
            const actualCount = Array.isArray(path.sets) ? path.sets.length : 0
            const matches = !expectedSets || expectedSets.length === actualCount
            checks.push({
              name: `service_orchestration:${spec.service}`,
              passed: matches,
              message: matches
                ? `Service orchestration for "${spec.service}" has ${actualCount} rule set(s), as declared.`
                : `Service orchestration for "${spec.service}" has ${actualCount} rule set(s); expected ${expectedSets?.length ?? 0}.`,
            })
          } catch (error) {
            checks.push({
              name: `service_orchestration:${spec.service}`,
              passed: false,
              message: `Could not read service orchestration for "${spec.service}": ${error instanceof Error ? error.message : 'error'}`,
            })
          }
        }
      } catch (error) {
        checks.push({
          name: 'services_readable',
          passed: false,
          message: `Could not list services: ${error instanceof Error ? error.message : 'error'}`,
        })
      }
    }
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
