import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildQualysClient } from '../../lib/qualys'
import { listReportTemplates } from './deploy'
import { extractReportTemplateSpecs, type LiveReportTemplate } from './validate'

/**
 * Health check for report template configuration:
 *   1. Qualys platform reachability + credential validity (one metadata list per declared type)
 *   2. Every declared report template still exists
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildQualysClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'qualys_credential', passed: false, message: built.error }] }
  }
  const { client, platformUrl } = built

  const specs = extractReportTemplateSpecs(ctx.canvas).filter((s) => s.templateType && s.title)
  const byType = new Map<string, Map<string, LiveReportTemplate>>()

  const start = Date.now()
  let reachable = true
  try {
    for (const templateType of new Set(specs.map((s) => s.templateType))) {
      const live = await listReportTemplates(client, templateType)
      byType.set(templateType, new Map(live.map((t) => [t.title.trim().toLowerCase(), t])))
    }
    checks.push({
      name: 'qualys_reachable',
      passed: true,
      message: `Qualys platform reachable at ${platformUrl}`,
      latencyMs: Date.now() - start,
    })
  } catch (error) {
    reachable = false
    checks.push({
      name: 'qualys_reachable',
      passed: false,
      message: error instanceof Error ? error.message : 'Check failed',
      latencyMs: Date.now() - start,
    })
  }

  if (reachable) {
    for (const spec of specs) {
      const label = `${spec.templateType}:${spec.title}`
      const present = byType.get(spec.templateType)?.has(spec.title.trim().toLowerCase()) ?? false
      checks.push({
        name: `report_template:${label}`,
        passed: present,
        message: present ? `Report template "${label}" is present` : `Report template "${label}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passedCount / checks.length) * 100) : 0
  return { healthy: passedCount === checks.length, score, checks }
}
