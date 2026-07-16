import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildInsightVMClient } from '../../lib/insightvm'
import { listSites } from './deploy'
import { extractSiteSpecs, siteKey } from './validate'

/**
 * Health check for site configuration:
 *   1. InsightVM console reachability + credential validity (a paged /sites list)
 *   2. Every declared site (by name) still exists
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildInsightVMClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'insightvm_credential', passed: false, message: built.error }] }
  }
  const { client, consoleUrl } = built

  const start = Date.now()
  let live: import('./validate').LiveSite[] | null = null
  try {
    live = await listSites(client)
    checks.push({ name: 'insightvm_reachable', passed: true, message: `InsightVM console reachable at ${consoleUrl}`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 'insightvm_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (live) {
    const keys = new Set(live.filter((s) => s.name).map((s) => siteKey({ name: s.name as string })))
    for (const spec of extractSiteSpecs(ctx.canvas).filter((s) => s.name)) {
      const present = keys.has(siteKey(spec))
      checks.push({
        name: `site:${spec.name}`,
        passed: present,
        message: present ? `Site "${spec.name}" is present` : `Site "${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
