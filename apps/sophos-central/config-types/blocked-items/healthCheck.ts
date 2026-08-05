import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { checkSophosReachable, buildSophosClient } from '../../lib/sophosCentral'
import { listBlockedItems } from '../../lib/sophosApi'
import { blockedItemKey, extractBlockedItemSpecs } from './_shared'

/**
 * Health check for blocked item configuration:
 *   1. Sophos Central API reachability + service principal validity
 *   2. Every declared SHA256 still exists as a live blocked item
 * Score is the percentage of passed checks (0-100).
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

  const specs = extractBlockedItemSpecs(ctx.canvas).filter((s) => s.sha256)
  const started = Date.now()
  try {
    const live = await listBlockedItems(client)
    const liveHashes = new Set(live.filter((i) => i.properties?.sha256).map((i) => blockedItemKey(i.properties.sha256)))
    for (const spec of specs) {
      const present = liveHashes.has(blockedItemKey(spec.sha256))
      checks.push({
        name: `blocked-item:${spec.sha256}`,
        passed: present,
        message: present ? `Blocked item "${spec.sha256}" is present.` : `Blocked item "${spec.sha256}" is missing.`,
        latencyMs: Date.now() - started,
      })
    }
  } catch (error) {
    checks.push({
      name: 'blocked-items:list',
      passed: false,
      message: error instanceof Error ? error.message : 'Failed to list blocked items',
      latencyMs: Date.now() - started,
    })
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
