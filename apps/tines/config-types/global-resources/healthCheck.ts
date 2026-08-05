import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildTinesClient, tinesErrorMessage } from '../../lib/tinesApi'
import { extractGlobalResourceSpecs, findGlobalResource } from './_shared'
import { listGlobalResources } from './deploy'

/**
 * Health check for Global Resources configuration:
 *   1. Tines API reachability + auth (GET /api/v1/global_resources answers 2xx)
 *   2. every declared resource (by team + name) still exists in the tenant
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheck[] = []

  const built = buildTinesClient(ctx.component?.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'credential', passed: false, message: built.error }] }
  }
  const { client } = built

  const started = Date.now()
  let reachable = false
  try {
    const res = await client.request('GET', '/global_resources', { query: { per_page: 1 } })
    reachable = res.ok
    checks.push({
      name: 'tines_reachable',
      passed: res.ok,
      message: res.ok ? `Tines reachable (HTTP ${res.status}).` : `Tines returned HTTP ${res.status}: ${tinesErrorMessage(res)}`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'tines_reachable',
      passed: false,
      message: `Tines unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  if (reachable) {
    const specs = extractGlobalResourceSpecs(ctx.canvas).filter((s) => s.name && s.teamId)
    const cache = new Map<string, Awaited<ReturnType<typeof listGlobalResources>>>()
    for (const spec of specs) {
      try {
        let live = cache.get(spec.teamId)
        if (!live) {
          live = await listGlobalResources(client, spec.teamId)
          cache.set(spec.teamId, live)
        }
        const present = Boolean(findGlobalResource(live, spec.teamId, spec.name))
        checks.push({
          name: `resource:${spec.name}`,
          passed: present,
          message: present ? `Global Resource "${spec.name}" is present.` : `Global Resource "${spec.name}" is missing.`,
        })
      } catch (error) {
        checks.push({
          name: `resource:${spec.name}`,
          passed: false,
          message: `Could not list Global Resources: ${error instanceof Error ? error.message : 'error'}`,
        })
      }
    }
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
