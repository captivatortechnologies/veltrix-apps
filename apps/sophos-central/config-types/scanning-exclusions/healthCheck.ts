import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { checkSophosReachable, buildSophosClient } from '../../lib/sophosCentral'
import { listScanningExclusions } from '../../lib/sophosApi'
import { extractScanningExclusionSpecs, scanningExclusionKey } from './_shared'

/**
 * Health check for scanning exclusion configuration:
 *   1. Sophos Central API reachability + service principal validity
 *   2. Every declared (type, value) pair still exists as a live exclusion
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

  const specs = extractScanningExclusionSpecs(ctx.canvas).filter((s) => s.type && s.value)
  const started = Date.now()
  try {
    const live = await listScanningExclusions(client)
    const liveKeys = new Set(live.map((e) => scanningExclusionKey(e.type, e.value)))
    for (const spec of specs) {
      const label = `${spec.type}:${spec.value}`
      const present = liveKeys.has(scanningExclusionKey(spec.type, spec.value))
      checks.push({
        name: `scanning-exclusion:${label}`,
        passed: present,
        message: present ? `Scanning exclusion "${label}" is present.` : `Scanning exclusion "${label}" is missing.`,
        latencyMs: Date.now() - started,
      })
    }
  } catch (error) {
    checks.push({
      name: 'scanning-exclusions:list',
      passed: false,
      message: error instanceof Error ? error.message : 'Failed to list scanning exclusions',
      latencyMs: Date.now() - started,
    })
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
