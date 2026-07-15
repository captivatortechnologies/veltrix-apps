import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient } from '../../lib/zscaler'
import { listDlpEngines } from './deploy'
import { extractDlpEngineSpecs } from './validate'

/**
 * Detect drift between the deployed DLP engine configuration and the live tenant.
 * Re-finds each declared engine by name and diffs the managed scalar field (the
 * engine expression); a missing engine is critical drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractDlpEngineSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listDlpEngines(client)
    const byName = new Map(live.filter((e) => e.name).map((e) => [e.name as string, e]))

    for (const spec of specs) {
      const found = byName.get(spec.name)
      if (!found) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const liveExpression = (typeof found.engineExpression === 'string' ? found.engineExpression : '').trim()
      if (spec.engineExpression !== liveExpression) {
        diffs.push({
          field: `${spec.name}.engine_expression`,
          expected: spec.engineExpression || 'not set',
          actual: liveExpression || 'not set',
          severity: 'info',
        })
      }
    }
  } catch (error) {
    diffs.push({
      field: 'zia',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
