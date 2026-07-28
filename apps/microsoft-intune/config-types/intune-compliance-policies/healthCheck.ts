import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildIntuneClient } from '../../lib/intune'
import { listCompliancePolicies } from './deploy'
import { extractComplianceSpecs, policyKey } from './validate'

/**
 * Health check for compliance policies:
 *   1. Graph reachability + token/permission validity (a policies list)
 *   2. Every declared policy still exists (matched by displayName)
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
  let live: Awaited<ReturnType<typeof listCompliancePolicies>> | null = null
  try {
    live = await listCompliancePolicies(client)
    checks.push({ name: 'graph_reachable', passed: true, message: `Microsoft Graph reachable at ${graphHost}`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 'graph_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (live) {
    const names = new Set(live.filter((p) => p.displayName).map((p) => policyKey(p.displayName as string)))
    for (const spec of extractComplianceSpecs(ctx.canvas).filter((s) => s.name)) {
      const present = names.has(policyKey(spec.name))
      checks.push({
        name: `policy:${spec.name}`,
        passed: present,
        message: present ? `Compliance policy "${spec.name}" is present` : `Compliance policy "${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
