import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { searchRoutes, type LiveRoute } from '../../lib/staticRoutesApi'
import { buildOpnsenseClient } from '../../lib/opnsenseApi'
import { extractRouteSpecs, routeKey } from './_shared'

/**
 * Health check for OPNsense static-routes configuration: API reachability +
 * credential validity (searchroute), then every declared route (by network)
 * still exists. Read-only.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildOpnsenseClient(ctx.component.hostname, ctx.component.port, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'opnsense_credential', passed: false, message: built.error }] }
  }
  const { client, host } = built

  const specs = extractRouteSpecs(ctx.canvas).filter((s) => s.network)
  let live: LiveRoute[] = []
  const started = Date.now()

  try {
    live = await searchRoutes(client)
    checks.push({
      name: 'opnsense_reachable',
      passed: true,
      message: `Reached the OPNsense API at ${host}`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'opnsense_reachable',
      passed: false,
      message: error instanceof Error ? error.message : 'searchroute failed',
      latencyMs: Date.now() - started,
    })
  }

  if (checks[0]?.passed) {
    const keys = new Set(live.filter((r) => r.network).map((r) => routeKey(r.network as string)))
    for (const spec of specs) {
      const present = keys.has(routeKey(spec.network))
      checks.push({
        name: `route:${spec.network}`,
        passed: present,
        message: present ? `Route "${spec.network}" is present` : `Route "${spec.network}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
