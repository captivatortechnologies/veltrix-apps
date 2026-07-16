import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildInsightVMClient } from '../../lib/insightvm'
import { listTemplates } from './deploy'
import { extractTemplateSpecs, templateKey, type LiveScanTemplate } from './validate'

/**
 * Health check for scan template configuration:
 *   1. InsightVM console reachability + credential validity (a paged
 *      /scan_templates list)
 *   2. Every declared template (by its string id) still exists
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
  let live: LiveScanTemplate[] | null = null
  try {
    live = await listTemplates(client)
    checks.push({ name: 'insightvm_reachable', passed: true, message: `InsightVM console reachable at ${consoleUrl}`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 'insightvm_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (live) {
    const ids = new Set(live.filter((t) => t.id != null).map((t) => t.id as string))
    for (const spec of extractTemplateSpecs(ctx.canvas).filter((s) => s.templateId && s.name)) {
      const present = ids.has(templateKey(spec))
      checks.push({
        name: `scan_template:${spec.templateId}`,
        passed: present,
        message: present ? `Scan template "${spec.templateId}" is present` : `Scan template "${spec.templateId}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
