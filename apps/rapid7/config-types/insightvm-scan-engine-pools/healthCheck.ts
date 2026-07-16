import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildInsightVMClient } from '../../lib/insightvm'
import { listPools } from './deploy'
import { extractPoolSpecs, poolKey } from './validate'

/**
 * Health check for scan engine pool configuration:
 *   1. InsightVM console reachability + credential validity (a paged /scan_engine_pools list)
 *   2. Every declared pool still exists (matched by name)
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
  let live: import('./validate').LivePool[] | null = null
  try {
    live = await listPools(client)
    checks.push({ name: 'insightvm_reachable', passed: true, message: `InsightVM console reachable at ${consoleUrl}`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 'insightvm_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (live) {
    const keys = new Set(live.filter((p) => p.name).map((p) => poolKey({ name: p.name as string })))
    for (const spec of extractPoolSpecs(ctx.canvas).filter((s) => s.name)) {
      const present = keys.has(poolKey(spec))
      checks.push({
        name: `pool:${spec.name}`,
        passed: present,
        message: present ? `Scan engine pool "${spec.name}" is present` : `Scan engine pool "${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
