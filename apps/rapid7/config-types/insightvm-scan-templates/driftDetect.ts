import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildInsightVMClient } from '../../lib/insightvm'
import { listTemplates } from './deploy'
import { extractTemplateSpecs, templateKey, type LiveScanTemplate } from './validate'

/**
 * Detect drift between the deployed scan templates and the live console. Re-finds
 * each declared template by its string `id` and diffs the managed name and
 * description; a missing template is critical drift. The template config JSON is
 * not deep-diffed (server-normalized checks/policies).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildInsightVMClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractTemplateSpecs(ctx.deployedConfig).filter((s) => s.templateId && s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listTemplates(client)
    const byId = new Map<string, LiveScanTemplate>(live.filter((t) => t.id != null).map((t) => [t.id as string, t]))

    for (const spec of specs) {
      const found = byId.get(templateKey(spec))
      if (!found) {
        diffs.push({ field: spec.templateId, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      if ((found.name ?? '') !== spec.name) {
        diffs.push({ field: `${spec.templateId}.name`, expected: spec.name, actual: found.name ?? 'not set', severity: 'warning' })
      }
      if (spec.description && (found.description ?? '') !== spec.description) {
        diffs.push({ field: `${spec.templateId}.description`, expected: spec.description, actual: found.description ?? 'not set', severity: 'info' })
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
