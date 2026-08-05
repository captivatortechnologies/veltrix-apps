import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildInsightVMClient } from '../../lib/insightvm'
import { listSonarQueries } from './deploy'
import { extractSonarQuerySpecs, sonarQueryKey, type LiveSonarQuery } from './validate'

/**
 * Health check for Sonar query configuration:
 *   1. InsightVM console reachability + credential validity (a /sonar_queries list)
 *   2. Every declared query (by name) still exists
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
  let live: LiveSonarQuery[] | null = null
  try {
    live = await listSonarQueries(client)
    checks.push({ name: 'insightvm_reachable', passed: true, message: `InsightVM console reachable at ${consoleUrl}`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 'insightvm_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (live) {
    const keys = new Set(live.filter((q) => q.name).map((q) => sonarQueryKey({ name: q.name as string })))
    for (const spec of extractSonarQuerySpecs(ctx.canvas).filter((s) => s.name)) {
      const present = keys.has(sonarQueryKey(spec))
      checks.push({
        name: `sonar_query:${spec.name}`,
        passed: present,
        message: present ? `Sonar query "${spec.name}" is present` : `Sonar query "${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
