import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { checkSophosReachable, buildSophosClient } from '../../lib/sophosCentral'
import { listLocalSites } from '../../lib/sophosApi'
import { extractLocalSiteSpecs, localSiteKey } from './_shared'

/**
 * Health check for local site configuration:
 *   1. Sophos Central API reachability + service principal validity
 *   2. Every declared url still exists as a live local site
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

  const specs = extractLocalSiteSpecs(ctx.canvas).filter((s) => s.url)
  const started = Date.now()
  try {
    const live = await listLocalSites(client)
    const liveKeys = new Set(live.map((s) => localSiteKey(s.url)))
    for (const spec of specs) {
      const present = liveKeys.has(localSiteKey(spec.url))
      checks.push({
        name: `local-site:${spec.url}`,
        passed: present,
        message: present ? `Local site "${spec.url}" is present.` : `Local site "${spec.url}" is missing.`,
        latencyMs: Date.now() - started,
      })
    }
  } catch (error) {
    checks.push({
      name: 'local-sites:list',
      passed: false,
      message: error instanceof Error ? error.message : 'Failed to list local sites',
      latencyMs: Date.now() - started,
    })
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
