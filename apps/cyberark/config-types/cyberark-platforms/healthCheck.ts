import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildCyberArkClient } from '../../lib/cyberark'
import { mapPlatforms } from './deploy'
import { extractPlatformSpecs, platformKey, type LivePlatform } from './validate'

/**
 * Health check for platform configuration:
 *   1. PVWA reachability + logon (a /Platforms/Targets list)
 *   2. Every declared platform (by PlatformID) exists and its active state
 *      matches the spec.
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildCyberArkClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'cyberark_credential', passed: false, message: built.error }] }
  }
  const { client, pvwaUrl } = built

  const start = Date.now()
  let byKey: Map<string, LivePlatform> | null = null
  try {
    byKey = await mapPlatforms(client)
    checks.push({ name: 'cyberark_reachable', passed: true, message: `PVWA reachable at ${pvwaUrl}`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 'cyberark_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (byKey) {
    for (const spec of extractPlatformSpecs(ctx.canvas).filter((s) => s.platformId)) {
      const live = byKey.get(platformKey(spec))
      if (!live) {
        checks.push({ name: `platform:${spec.platformId}`, passed: false, message: `Platform "${spec.platformId}" is missing` })
        continue
      }
      const activeMatches = (live.Active ?? false) === spec.active
      checks.push({
        name: `platform:${spec.platformId}`,
        passed: activeMatches,
        message: activeMatches
          ? `Platform "${spec.platformId}" is present and ${spec.active ? 'active' : 'inactive'}`
          : `Platform "${spec.platformId}" is present but ${live.Active ? 'active' : 'inactive'} (expected ${spec.active ? 'active' : 'inactive'})`,
      })
    }
  }

  await client.logoff()
  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passedCount / checks.length) * 100) : 0
  return { healthy: passedCount === checks.length, score, checks }
}
