import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildIntuneClient } from '../../lib/intune'
import { listAsrPolicies } from './deploy'
import { extractAsrSpecs, policyKey } from './validate'

/**
 * Health check for ASR policies:
 *   1. Graph reachability + token/permission validity (a policies list)
 *   2. Every declared policy still exists
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
  let live: Awaited<ReturnType<typeof listAsrPolicies>> | null = null
  try {
    live = await listAsrPolicies(client)
    checks.push({ name: 'graph_reachable', passed: true, message: `Microsoft Graph reachable at ${graphHost}`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 'graph_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (live) {
    const names = new Set(live.filter((p) => p.name).map((p) => policyKey(p.name as string)))
    for (const spec of extractAsrSpecs(ctx.canvas).filter((s) => s.name)) {
      const present = names.has(policyKey(spec.name))
      checks.push({
        name: `policy:${spec.name}`,
        passed: present,
        message: present ? `ASR policy "${spec.name}" is present` : `ASR policy "${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
