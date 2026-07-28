import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildIntuneClient } from '../../lib/intune'
import { listRemediations } from './deploy'
import { extractRemediationSpecs, remediationKey } from './validate'

/**
 * Health check for device remediations:
 *   1. Graph reachability + token/permission validity (a deviceHealthScripts list)
 *   2. Every declared remediation still exists (matched by displayName)
 * Score is the percentage of passed checks (0-100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildIntuneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'intune_credential', passed: false, message: built.error }] }
  }
  const { client, graphHost } = built

  const start = Date.now()
  let live: Awaited<ReturnType<typeof listRemediations>> | null = null
  try {
    live = await listRemediations(client)
    checks.push({ name: 'graph_reachable', passed: true, message: `Microsoft Graph reachable at ${graphHost}`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 'graph_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (live) {
    const names = new Set(live.filter((r) => r.displayName).map((r) => remediationKey(r.displayName as string)))
    for (const spec of extractRemediationSpecs(ctx.canvas).filter((s) => s.name)) {
      const present = names.has(remediationKey(spec.name))
      checks.push({
        name: `remediation:${spec.name}`,
        passed: present,
        message: present ? `Device remediation "${spec.name}" is present` : `Device remediation "${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
