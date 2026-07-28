import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildIntuneClient } from '../../lib/intune'
import { listAssignmentFilters } from './deploy'
import { extractFilterSpecs, filterKey } from './validate'

/**
 * Health check for assignment filters:
 *   1. Graph reachability + token/permission validity (a filters list)
 *   2. Every declared filter still exists
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildIntuneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'intune_credential', passed: false, message: built.error }] }
  }
  const { client, graphHost } = built

  const start = Date.now()
  let live: Awaited<ReturnType<typeof listAssignmentFilters>> | null = null
  try {
    live = await listAssignmentFilters(client)
    checks.push({ name: 'graph_reachable', passed: true, message: `Microsoft Graph reachable at ${graphHost}`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 'graph_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (live) {
    const names = new Set(live.filter((f) => f.displayName).map((f) => filterKey(f.displayName as string)))
    for (const spec of extractFilterSpecs(ctx.canvas).filter((s) => s.name)) {
      const present = names.has(filterKey(spec.name))
      checks.push({
        name: `filter:${spec.name}`,
        passed: present,
        message: present ? `Assignment filter "${spec.name}" is present` : `Assignment filter "${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
