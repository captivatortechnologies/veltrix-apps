import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildInsightVMClient } from '../../lib/insightvm'
import { listReportConfigs } from './deploy'
import { extractReportConfigSpecs, reportConfigKey, type LiveReportConfig } from './validate'

/**
 * Health check for report-configuration configuration:
 *   1. InsightVM console reachability + credential validity (a paged /reports list)
 *   2. Every declared report (by name) still exists
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
  let live: LiveReportConfig[] | null = null
  try {
    live = await listReportConfigs(client)
    checks.push({ name: 'insightvm_reachable', passed: true, message: `InsightVM console reachable at ${consoleUrl}`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 'insightvm_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (live) {
    const keys = new Set(live.filter((r) => r.name).map((r) => reportConfigKey({ name: r.name as string })))
    for (const spec of extractReportConfigSpecs(ctx.canvas).filter((s) => s.name && s.templateId && s.format)) {
      const present = keys.has(reportConfigKey(spec))
      checks.push({
        name: `report:${spec.name}`,
        passed: present,
        message: present ? `Report "${spec.name}" is present` : `Report "${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
