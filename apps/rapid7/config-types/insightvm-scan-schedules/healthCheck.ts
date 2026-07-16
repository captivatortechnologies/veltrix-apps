import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildInsightVMClient } from '../../lib/insightvm'
import { listSchedules, resolveSiteId } from './deploy'
import { extractScheduleSpecs } from './validate'

/**
 * Health check for scan schedule configuration:
 *   1. InsightVM console reachability (site list)
 *   2. Every declared schedule (site, schedule name) still exists
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildInsightVMClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'insightvm_credential', passed: false, message: built.error }] }
  }
  const { client, consoleUrl } = built

  const specs = extractScheduleSpecs(ctx.canvas).filter((s) => s.siteName && s.scheduleName)
  const siteIds = new Map<string, number>()

  const start = Date.now()
  let reachable = false
  try {
    await resolveSiteIfAny(client, specs, siteIds)
    reachable = true
    checks.push({ name: 'insightvm_reachable', passed: true, message: `InsightVM console reachable at ${consoleUrl}`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 'insightvm_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (reachable) {
    const schedulesBySite = new Map<number, Set<string>>()
    for (const spec of specs) {
      try {
        const siteId = await resolveSiteId(client, spec.siteName, siteIds)
        let names = schedulesBySite.get(siteId)
        if (!names) {
          const live = await listSchedules(client, siteId)
          names = new Set(live.map((s) => s.scanName).filter((n): n is string => typeof n === 'string'))
          schedulesBySite.set(siteId, names)
        }
        const present = names.has(spec.scheduleName)
        checks.push({
          name: `schedule:${spec.scheduleName} @ ${spec.siteName}`,
          passed: present,
          message: present ? `Schedule "${spec.scheduleName}" is present` : `Schedule "${spec.scheduleName}" is missing`,
        })
      } catch (error) {
        checks.push({ name: `schedule:${spec.scheduleName} @ ${spec.siteName}`, passed: false, message: error instanceof Error ? error.message : 'Check failed' })
      }
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}

/** Warm the site-id cache (and prove reachability) via a single site list. */
async function resolveSiteIfAny(
  client: import('../../lib/insightvm').InsightVMClient,
  specs: ReturnType<typeof extractScheduleSpecs>,
  siteIds: Map<string, number>,
): Promise<void> {
  if (specs.length > 0) {
    await resolveSiteId(client, specs[0].siteName, siteIds)
  } else {
    const res = await client.getAll('/sites')
    if (!res.ok) throw new Error(`InsightVM console not reachable (HTTP ${res.status})`)
  }
}
