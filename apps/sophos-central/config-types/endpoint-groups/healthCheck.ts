import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { checkSophosReachable, buildSophosClient } from '../../lib/sophosCentral'
import { listEndpointGroups } from '../../lib/sophosApi'
import { endpointGroupKey, extractEndpointGroupSpecs } from './_shared'

/**
 * Health check for endpoint group configuration:
 *   1. Sophos Central API reachability + service principal validity
 *   2. Every declared group name still exists as a live endpoint group
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildSophosClient(ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'sophos_credential', passed: false, message: built.error }] }
  }
  const { client } = built

  const reachability = await checkSophosReachable(client)
  checks.push(reachability)
  if (!reachability.passed) return { healthy: false, score: 0, checks }

  const specs = extractEndpointGroupSpecs(ctx.canvas).filter((s) => s.name)
  const started = Date.now()
  try {
    const live = await listEndpointGroups(client)
    const liveNames = new Set(live.filter((g) => g.name).map((g) => endpointGroupKey(g.name)))
    for (const spec of specs) {
      const present = liveNames.has(endpointGroupKey(spec.name))
      checks.push({
        name: `endpoint-group:${spec.name}`,
        passed: present,
        message: present ? `Endpoint group "${spec.name}" is present.` : `Endpoint group "${spec.name}" is missing.`,
        latencyMs: Date.now() - started,
      })
    }
  } catch (error) {
    checks.push({
      name: 'endpoint-groups:list',
      passed: false,
      message: error instanceof Error ? error.message : 'Failed to list endpoint groups',
      latencyMs: Date.now() - started,
    })
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
