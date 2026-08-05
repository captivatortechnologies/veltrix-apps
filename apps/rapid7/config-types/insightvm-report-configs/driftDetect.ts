import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildInsightVMClient } from '../../lib/insightvm'
import { listReportConfigs } from './deploy'
import { extractReportConfigSpecs, reportConfigKey, type LiveReportConfig } from './validate'

/**
 * Detect drift between the deployed report configurations and the live console.
 * Re-finds each declared report by its name and diffs the managed template and
 * format; a missing report is critical drift. The extra config JSON (frequency,
 * scope, email, storage, …) is not deep-diffed (server-normalized documents).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildInsightVMClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractReportConfigSpecs(ctx.deployedConfig).filter((s) => s.name && s.templateId && s.format)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listReportConfigs(client)
    const byKey = new Map<string, LiveReportConfig>(
      live.filter((r) => r.name).map((r) => [reportConfigKey({ name: r.name as string }), r]),
    )

    for (const spec of specs) {
      const found = byKey.get(reportConfigKey(spec))
      if (!found) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      if ((found.template ?? '') !== spec.templateId) {
        diffs.push({ field: `${spec.name}.template`, expected: spec.templateId, actual: found.template ?? 'not set', severity: 'warning' })
      }
      if ((found.format ?? '') !== spec.format) {
        diffs.push({ field: `${spec.name}.format`, expected: spec.format, actual: found.format ?? 'not set', severity: 'warning' })
      }
    }
  } catch (error) {
    diffs.push({
      field: 'insightvm',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
