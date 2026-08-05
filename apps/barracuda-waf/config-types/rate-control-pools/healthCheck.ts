import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildBarracudaClient } from '../../lib/barracudaWaf'
import { extractRateControlPoolSpecs, listRateControlPools, rateControlPoolKey, type LiveRateControlPool } from './validate'

/**
 * Health check for Rate Control Pools:
 *   1. Barracuda WAF-as-a-Service reachability + credential/Application validity
 *   2. Every declared pool still exists and its max_active_requests matches
 * Score is the percentage of passed checks (0-100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildBarracudaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'barracuda_credential', passed: false, message: built.error }] }
  }
  const { client, appName } = built

  const specs = extractRateControlPoolSpecs(ctx.canvas).filter((s) => s.name)
  const start = Date.now()
  let live: LiveRateControlPool[] | null = null

  try {
    live = await listRateControlPools(client, appName)
    checks.push({ name: 'barracuda_reachable', passed: true, message: `Barracuda WAF-as-a-Service reachable — Application "${appName}"`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 'barracuda_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (live) {
    const byKey = new Map(live.filter((p) => p.name).map((p) => [rateControlPoolKey(p.name as string), p]))
    for (const spec of specs) {
      const found = byKey.get(rateControlPoolKey(spec.name))
      if (!found) {
        checks.push({ name: `pool:${spec.name}`, passed: false, message: `Rate Control Pool "${spec.name}" is missing` })
        continue
      }
      const matches = (found.max_active_requests ?? 100) === spec.maxActiveRequests
      checks.push({
        name: `pool:${spec.name}`,
        passed: matches,
        message: matches
          ? `Rate Control Pool "${spec.name}" is present (max_active_requests=${spec.maxActiveRequests})`
          : `Rate Control Pool "${spec.name}" max_active_requests drifted`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passedCount / checks.length) * 100) : 0
  return { healthy: passedCount === checks.length, score, checks }
}
