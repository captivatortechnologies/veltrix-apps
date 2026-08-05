import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { checkSophosReachable, buildSophosClient } from '../../lib/sophosCentral'
import { listAllowedItems, type SophosAllowedItem } from '../../lib/sophosApi'
import { allowedItemKey, extractAllowedItemSpecs, liveAllowedItemValue } from './_shared'

/**
 * Health check for allowed item configuration:
 *   1. Sophos Central API reachability + service principal validity
 *   2. Every declared (type, value) pair still exists as a live allowed item
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

  const specs = extractAllowedItemSpecs(ctx.canvas).filter((s) => s.type && s.value)
  const started = Date.now()
  try {
    const live: SophosAllowedItem[] = await listAllowedItems(client)
    const liveKeys = new Set(
      live.map((i) => (i.type && liveAllowedItemValue(i) ? allowedItemKey(i.type, liveAllowedItemValue(i)!) : null)).filter(Boolean),
    )
    for (const spec of specs) {
      const label = `${spec.type}:${spec.value}`
      const present = liveKeys.has(allowedItemKey(spec.type, spec.value))
      checks.push({
        name: `allowed-item:${label}`,
        passed: present,
        message: present ? `Allowed item "${label}" is present.` : `Allowed item "${label}" is missing.`,
        latencyMs: Date.now() - started,
      })
    }
  } catch (error) {
    checks.push({
      name: 'allowed-items:list',
      passed: false,
      message: error instanceof Error ? error.message : 'Failed to list allowed items',
      latencyMs: Date.now() - started,
    })
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
